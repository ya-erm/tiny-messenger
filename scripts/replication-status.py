#!/usr/bin/env python3
"""Read-only operational summary. Never print profiles, tokens or messages."""
import json, sqlite3
from pathlib import Path
root = Path(__file__).resolve().parent.parent
connection = sqlite3.connect('file:' + str(root / 'data/messenger.db') + '?mode=ro', uri=True)
try:
    for key, body in connection.execute('SELECT key, body FROM ReplicationState WHERE key LIKE ?', ('peer:%',)):
        state = json.loads(body)
        print(json.dumps({'peer': key[5:], **{field: state.get(field) for field in
            ['sentSeq', 'rowSeq', 'cursor', 'lastSuccess', 'lastError', 'failures', 'caughtUp', 'nextPoll']},
            'catchUpPendingOperations': connection.execute('SELECT count(*) FROM MutationOperation WHERE seq > ?', (state['sentSeq'],)).fetchone()[0],
            'catchUpPendingRows': connection.execute('SELECT count(*) FROM ReplicaChange WHERE seq > ?', (state.get('rowSeq', 0),)).fetchone()[0] if connection.execute("SELECT 1 FROM sqlite_master WHERE name='ReplicaChange'").fetchone() else None}))
    outgoing = connection.execute('SELECT body FROM ReplicationState WHERE key=?', ('bus:outgoing',)).fetchone()
    if outgoing:
        print(json.dumps({'busOutgoing': json.loads(outgoing[0])}))
finally:
    connection.close()
