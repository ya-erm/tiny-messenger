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
            ['sentSeq', 'cursor', 'lastSuccess', 'lastError', 'failures']},
            'pendingOperations': connection.execute('SELECT count(*) FROM MutationOperation WHERE seq > ?', (state['sentSeq'],)).fetchone()[0]}))
finally:
    connection.close()
