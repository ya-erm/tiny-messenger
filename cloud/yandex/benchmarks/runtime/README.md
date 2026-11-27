Runtime comparison prototype
============================

This is a private, read-only experiment, separate from application channels.
The Go handler reads one user profile and at most 100 message-view records using
YDB Query Service and snapshot-read-only transactions. It returns counts and a
digest of identifiers, never message bodies. It does not implement Messenger
login, mutations, group access, attachments or replication.

The Node control loads the production dependency graph, then performs the same
two reads. Consequently this compares the current Node application bootstrap
with a small Go read prototype; it is not a language-only benchmark or a claim
about a complete Go migration. Both use 256 MiB, no provisioned instances and
the same database/dataset. Their SDKs and connection initialization differ.

Run from the configured project workspace. Management credentials and runtime
resource settings are read from ignored private deployment files. The runner
creates separate IAM-private functions with an additional benchmark key. No
API Gateway, public access binding or application DNS is created.

Build packages after generating the shared cloud modules:

```sh
node scripts/build-cloud-prototype.mjs
python3 scripts/package-cloud-prototype.py
python3 - <<'PY'
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
base = Path('cloud/yandex')
with ZipFile(base/'dist/benchmark-node.zip', 'w', ZIP_DEFLATED) as out:
    with ZipFile(base/'dist/function.zip') as source:
        for name in source.namelist():
            if not name.startswith('index.'):
                out.writestr(name, source.read(name))
    out.write(base/'benchmarks/runtime/node.mjs', 'benchmarks/runtime/node.mjs')
    out.writestr('index.js', 'exports.handler = async (e, c) => (await import("./benchmarks/runtime/node.mjs")).handler(e, c);\n')
with ZipFile(base/'dist/benchmark-go.zip', 'w', ZIP_DEFLATED) as out:
    for name in ['index.go', 'go.mod']:
        out.write(base/'benchmarks/runtime/go'/name, name)
PY
node scripts/runtime-benchmark.mjs prepare
```

`prepare node` or `prepare go` updates only that control. Managed Go compilation
can take several minutes and can time out; build time is separate from invocation
latency. Pinning the compatible SDK and split genproto modules avoids resolving
dependencies which require a newer Go compiler than the managed runtime.

Measurement commands:

```sh
node scripts/runtime-benchmark.mjs sample 1 reuse-first
node scripts/runtime-benchmark.mjs burst node 6
node scripts/runtime-benchmark.mjs burst go 6
node scripts/runtime-benchmark.mjs probe
```

The first command consumes freshly prepared versions. Omit `reuse-first` to
create another version before measuring. Additional source-based samples require
another managed build, including for copied Go versions.

The runtime generates a process identifier and marks its first invocation.
Multiple processes may receive alternating sequential requests: a different
process identifier alone does not indicate a cold call. Warm classification
requires a prior successful database read by that process. Parallel batches
include scheduler/queue effects and are reported separately from serial calls.
Compare counts and digests, and retain errors rather than silently retrying them
as successful cold samples. Do not report percentiles from a handful of samples.

The runner saves identifiers, credentials and raw measurements in the ignored
private deployment directory. Do not publish that state or signed build-log
URLs. These functions have no periodic invocations. `cleanup` removes only the
benchmark functions recorded in that state; `prepare` can recreate deleted ones.
