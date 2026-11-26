import {readTestConfiguration,testOrigin} from "./config.mjs";
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const {directory,deployment,users}=await readTestConfiguration();
const clientOrigin=testOrigin('TM_TEST_CLIENT_ORIGIN'),cloudOrigin=testOrigin('TM_CLOUD_TEST_ORIGIN');
const primaryOrigins=(process.env.TM_TEST_PRIMARY_API_ORIGINS||'').split(',').filter(Boolean).map(value=>new URL(value).origin);
if(!primaryOrigins.length)throw Error('Set TM_TEST_PRIMARY_API_ORIGINS explicitly');
const candidate = process.env.TM_BROWSER_CANDIDATE || 'http://127.0.0.1:3107';
const realDomain = process.env.TM_BROWSER_REAL_DOMAIN === '1';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const contexts = [];
let cloudAvailable = true;
let blockedVps = 0;
const operations = [];
const errors = [];
try {
  const pages = [];
  for (const user of users) {
    const context = await browser.newContext({ serviceWorkers: 'block' }); contexts.push(context);
    await context.addInitScript(({ token }) => { localStorage.setItem('tiny-messenger:v1:token', token); localStorage.setItem('tiny-messenger:v2:channel', 'yandex-1'); }, { token: user.token });
    await context.route(clientOrigin+'/**', async route => {
      if (process.env.TM_BROWSER_PRODUCTION === '1') return route.continue();
      const original = new URL(route.request().url());
      const response = await route.fetch({ url: candidate + original.pathname + original.search });
      await route.fulfill({ response });
    });
    for(const origin of primaryOrigins)await context.route(origin+'/**',route=>{blockedVps++;return route.abort('internetdisconnected');});
    await context.route(cloudOrigin+'/**', async route => {
      if (!cloudAvailable) return route.abort('internetdisconnected');
      if (route.request().url().endsWith('/api/mutations')) operations.push(JSON.parse(route.request().postData()));
      if (realDomain) return route.continue();
      const original = new URL(route.request().url());
      try {
        const response = await route.fetch({ url: deployment.gatewayUrl + original.pathname + original.search, timeout: 20000 });
        await route.fulfill({ response });
      } catch { await route.abort().catch(() => {}); }
    });
    await context.route(deployment.gatewayUrl + '/**', async route => {
      if (!cloudAvailable) return route.abort('internetdisconnected');
      if (route.request().url().endsWith('/api/mutations')) operations.push(JSON.parse(route.request().postData()));
      return route.continue();
    });
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(clientOrigin+'/', { waitUntil: 'domcontentloaded' });
    await page.locator('.contact-row').first().waitFor({ timeout: 45000 });
    await page.locator('.contact-row').first().click();
    await page.getByRole('textbox', { name: 'Сообщение', exact: true }).waitFor();
  }
  const [a, b] = pages;
  const text = 'Браузер без VPS ' + Date.now();
  await a.getByRole('textbox', { name: 'Сообщение', exact: true }).fill(text);
  await a.getByRole('button', { name: 'Отправить', exact: true }).click();
  await a.waitForFunction(() => document.querySelector('textarea[aria-label="Сообщение"]')?.value === '', { timeout: 10000 });
  await b.locator('.message-stream').getByText(text, { exact: false }).waitFor({ timeout: 40000 });
  cloudAvailable = false;
  const offlineText = 'Сохранено без сети ' + Date.now();
  await a.getByRole('textbox', { name: 'Сообщение', exact: true }).fill(offlineText);
  await a.getByRole('button', { name: 'Отправить', exact: true }).click();
  await a.locator('.message-stream').getByText(offlineText, { exact: false }).waitFor();
  await a.getByText('В очереди', { exact: true }).first().waitFor();
  await a.reload({ waitUntil: 'domcontentloaded' });
  await a.locator('.contact-row').first().waitFor({ timeout: 35000 });
  await a.locator('.contact-row').first().click();
  await a.locator('.message-stream').getByText(offlineText, { exact: false }).waitFor();
  cloudAvailable = true;
  await b.locator('.message-stream').getByText(offlineText, { exact: false }).waitFor({ timeout: 45000 });
  assert.ok(blockedVps > 0, 'VPS requests were blocked');
  assert.equal(errors.length, 0, errors.join('; '));
  assert.equal(new Set(operations.filter(op => op.type === 'message.create' && op.message.text === offlineText).map(op => op.operationId)).size, 1);
  const result = { browserCloudExchange: true, vpsUnavailable: true, durableOfflineSend: true, restartAndRetry: true, stableOperationId: true, realDomain, runtimeErrors: errors.length };
  await writeFile(new URL('browser-test-result.json', directory), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
} catch (error) {
  for (const [index, context] of contexts.entries()) {
    const page = context.pages()[0];
    if (page) {
      await page.screenshot({ path: '/tmp/tm-cloud-browser-' + index + '.png' }).catch(() => {});
      // Only synthetic test accounts are present in these contexts.
      console.error('Remote browser check failed on synthetic page '+index);
    }
  }
  throw error;
} finally { for (const context of contexts) { await context.unrouteAll({ behavior: 'ignoreErrors' }); await context.close(); } await browser.close(); }
