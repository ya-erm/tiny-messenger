#!/usr/bin/env python3
"""Explicit allow-list: never archive local keys, snapshots or node_modules."""
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parent.parent
source = root / 'cloud/yandex'
output = source / 'dist'
output.mkdir(exist_ok=True)
files = [source / name for name in ['index.js', 'package.json', 'package-lock.json']]
files += sorted((source / 'src').glob('*.mjs'))
files += sorted((source / 'shared').glob('*.mjs'))
for file in files:
    assert file.is_file() and source in file.parents
with zipfile.ZipFile(output / 'function.zip', 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for file in files:
        archive.write(file, str(file.relative_to(source)))
print(json.dumps({'files': len(files), 'bytes': (output / 'function.zip').stat().st_size,
                  'sha256': hashlib.sha256((output / 'function.zip').read_bytes()).hexdigest()}))
