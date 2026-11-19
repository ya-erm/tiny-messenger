#!/usr/bin/env python3
"""Read one consistent SQLite snapshot; write a private cloud bootstrap file."""
import datetime
import json
import os
import sqlite3
from pathlib import Path

root = Path(__file__).resolve().parent.parent
output = root / '.secrets/yandex-cloud/bootstrap.json'
db = sqlite3.connect('file:' + str(root / 'data/messenger.db') + '?mode=ro', uri=True)
db.row_factory = sqlite3.Row
db.execute('PRAGMA query_only=ON')
db.execute('BEGIN')
tables = {table: [dict(row) for row in db.execute('SELECT * FROM "' + table + '"')] for table in [
    'User', 'Contact', 'Message', 'ChoiceOption', 'MessageReaction', 'MessageDeletion',
    'ReadState', 'HiddenConversation', 'Group', 'GroupMember', 'GroupMessage',
    'GroupMessageReaction', 'GroupMessageDeletion', 'Attachment', 'MutationOperation']}
db.close()
users = {user['id']: user for user in tables['User']}

def public_user(user):
    return {key: user[key] for key in ['id', 'name', 'nickname', 'avatarUrl', 'avatarBackground', 'createdAt'] if user.get(key) is not None}

def receipt(message, reader_id, chat_id):
    state = next((item for item in tables['ReadState'] if item['userId'] == reader_id and item['chatId'] == chat_id), {})
    if (state.get('lastReadAt') or '') >= message['sentAt']:
        return 'read'
    if (state.get('lastDeliveredAt') or '') >= message['sentAt']:
        return 'delivered'
    return 'sent'

def record(message, group=False):
    keys = ['id', 'fromUserId', 'senderName', 'text', 'sentAt', 'editedAt', 'replyToId'] + (['groupId'] if group else ['toUserId', 'kind'])
    result = {key: message[key] for key in keys if message.get(key) is not None}
    result['reactions'] = [{key: item[key] for key in ['userId', 'emoji']} for item in tables['GroupMessageReaction' if group else 'MessageReaction'] if item['messageId'] == message['id']]
    if not group:
        options = sorted([item for item in tables['ChoiceOption'] if item['messageId'] == message['id']], key=lambda item: item['position'])
        if options:
            result['options'] = [{'id': item['optionId'], 'label': item['label']} for item in options]
        if message.get('answerId'):
            result['answer'] = {'id': message['answerId'], 'label': message['answerLabel'], 'answeredAt': message['answeredAt']}
        result['status'] = 'answered' if result.get('answer') else receipt(message, message['toUserId'], message['fromUserId'])
    else:
        statuses = [receipt(message, member['userId'], message['groupId']) for member in tables['GroupMember'] if member['groupId'] == message['groupId'] and member['userId'] != message['fromUserId']]
        result['status'] = 'read' if statuses and all(value == 'read' for value in statuses) else 'delivered' if statuses and all(value != 'sent' for value in statuses) else 'sent'
    files = []
    for item in tables['Attachment']:
        if item['status'] != 'attached' or item['groupMessageId' if group else 'messageId'] != message['id']:
            continue
        content_type = item['contentType']
        preview = 'image' if content_type in ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'] else 'video' if content_type in ['video/mp4', 'video/webm', 'video/ogg'] else None
        files.append({'id': item['id'], 'originalName': item['originalName'], 'size': item['confirmedSize'] if item['confirmedSize'] is not None else item['requestedSize'], 'contentType': content_type, 'preview': preview})
    if files:
        result['attachments'] = files
    return result

messages = [record(item) for item in tables['Message']]
group_messages = [record(item, True) for item in tables['GroupMessage']]
groups = []
for item in tables['Group']:
    members = sorted([member for member in tables['GroupMember'] if member['groupId'] == item['id']], key=lambda member: member['seq'])
    groups.append({**{key: item[key] for key in ['id', 'name', 'ownerId', 'createdAt', 'updatedAt', 'avatarUrl', 'avatarBackground'] if item.get(key) is not None},
                   'members': [public_user(users[member['userId']]) for member in members]})

states = []
for user in tables['User']:
    uid = user['id']
    own_groups = [group for group in groups if any(member['id'] == uid for member in group['members'])]
    group_ids = {group['id'] for group in own_groups}
    own_messages = [message for message in messages if uid in [message['fromUserId'], message['toUserId']] and not any(mark['messageId'] == message['id'] and mark['userId'] == uid for mark in tables['MessageDeletion'])]
    own_group_messages = [message for message in group_messages if message['groupId'] in group_ids and not any(mark['messageId'] == message['id'] and mark['userId'] == uid for mark in tables['GroupMessageDeletion'])]
    # Resolve quote previews with the same reader's visibility boundary.
    accessible = {message['id']: message for message in own_messages + own_group_messages}
    def replies(source):
        result = []
        for message in source:
            item = dict(message)
            if item.get('replyToId'):
                original = accessible.get(item['replyToId'])
                item['reply'] = {'id': item['replyToId'], 'available': bool(original)}
                if original:
                    item['reply'].update({'senderName': original['senderName'], 'text': original['text'][:240]})
            result.append(item)
        return result
    states.append({'userId': uid,
        'contacts': [{'userId': item['userId'], 'user': public_user(users[item['userId']]), 'createdAt': item['createdAt'], 'updatedAt': item['updatedAt']} for item in tables['Contact'] if item['ownerId'] == uid],
        'messages': replies(own_messages), 'groups': own_groups, 'groupMessages': replies(own_group_messages),
        'hiddenPeerIds': [item['peerId'] for item in tables['HiddenConversation'] if item['ownerId'] == uid],
        'readStates': [{key: item[key] for key in ['chatId', 'lastDeliveredAt', 'lastReadAt'] if item.get(key) is not None} for item in tables['ReadState'] if item['userId'] == uid]})

snapshot = {'formatVersion': 1, 'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
            'users': tables['User'], 'userStates': states, 'messages': messages,
            'deletions': tables['MessageDeletion'], 'operations': [json.loads(item['body']) for item in tables['MutationOperation']]}
temporary = output.with_suffix('.tmp')
descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(descriptor, 'w') as stream:
    json.dump(snapshot, stream, ensure_ascii=False, separators=(',', ':'))
os.replace(temporary, output)
print(json.dumps({'users': len(users), 'messages': len(messages), 'groupMessages': len(group_messages), 'operations': len(snapshot['operations']), 'bytes': output.stat().st_size}))
