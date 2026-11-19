import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const config = Object.fromEntries((await readFile(new URL('../deploy/release.env', import.meta.url), 'utf8')).trim().split('\n').map(line => line.split('=')));
const ts = require(config.MESSENGER_DEPENDENCIES_DIR + '/typescript');
const source = await readFile(new URL('../src/lib/app-updates.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { createUpdateChecker } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

test('new version waits for an idle screen and reloads exactly once', async () => {
  let idle = false, reloads = 0;
  const remembered = [];
  const checker = createUpdateChecker({ currentVersion: '0.7.1', loadVersion: async () => '0.7.2', canReload: () => idle,
    rememberReload: version => { remembered.push(version); return true; }, reload: () => reloads++ });
  await checker.check(); checker.apply(); assert.equal(reloads, 0);
  idle = true; checker.apply(); checker.apply(); await checker.check();
  assert.equal(reloads, 1); assert.deepEqual(remembered, ['0.7.2']);
});
test('same version, invalid responses and unreachable server keep the application open', async () => {
  let value = '0.7.1', reloads = 0;
  const checker = createUpdateChecker({ currentVersion: '0.7.1', loadVersion: async () => { if (value === 'offline') throw Error('offline'); return value; }, canReload: () => true, rememberReload: () => true, reload: () => reloads++ });
  for (value of ['0.7.1', undefined, 'not-a-version', 'offline']) await checker.check();
  assert.equal(reloads, 0);
});
test('concurrent checks share one request and reload cooldown prevents a stale-shell loop', async () => {
  let finish, requests = 0, reloads = 0;
  const response = new Promise(resolve => { finish = resolve; });
  const checker = createUpdateChecker({ currentVersion: '0.7.1', loadVersion: () => { requests++; return response; }, canReload: () => true, rememberReload: () => false, reload: () => reloads++ });
  const first = checker.check(); await checker.check(); finish('0.7.2'); await first; checker.apply();
  assert.equal(requests, 1); assert.equal(reloads, 0);
});
