#!/usr/bin/env python3
"""Package only the native Go API sources and embedded public data."""
from pathlib import Path
import hashlib
import json
import zipfile
import sys
root = Path(__file__).resolve().parent.parent
source = root / 'cloud/yandex/go'
output = root / 'cloud/yandex/dist/function-go.zip'
output.parent.mkdir(exist_ok=True)
files = sorted(p for p in source.glob('*.go') if not p.name.endswith('_test.go') and p.name != 'memory.go')
files += [source / name for name in ['go.mod', 'go.sum', 'animals.json', 'emojis.json', 'row-tables.json', 'LICENSE-emoji-regex.txt']]
manifest_path=output.with_name('function-go-manifest.json')
manifest={file.name:hashlib.sha256(file.read_bytes()).hexdigest() for file in files}
if '--check' in sys.argv:
    assert json.loads(manifest_path.read_text())==manifest, 'Go source differs from packaged candidate'
    with zipfile.ZipFile(output) as archive:
        assert sorted(archive.namelist())==sorted(manifest)
        assert all(hashlib.sha256(archive.read(name)).hexdigest()==digest for name,digest in manifest.items())
    print(json.dumps({'verified':True,'files':len(files)}))
    raise SystemExit(0)
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for file in files:
        assert file.is_file() and file.parent == source
        archive.write(file, file.name)
print(json.dumps({'files': len(files), 'bytes': output.stat().st_size, 'sha256': hashlib.sha256(output.read_bytes()).hexdigest()}))

manifest_path.write_text(json.dumps(manifest,sort_keys=True))
