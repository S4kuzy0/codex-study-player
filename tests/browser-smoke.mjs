import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import fixture from './server-fixture.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await fixture.startTestServer();
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  .catch(async error => { await server.close(); throw error; });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
const requests = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('**/api/**', async route => {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === '/api/config' || pathname === '/api/reconnect') {
    await route.fulfill({ json: { app: 'study-player', version: '1.4.1', storage: 'dexie', healthy: true,
      ready: true, token: 'isolated-demo-token', message: '离线示例连接' } });
  } else if (pathname === '/api/ask') {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'answer',
      text: '这是合成的示例回答，用于核验独立对话和本地保存。' }) + '\n' });
  } else await route.fulfill({ status: 404, json: { error: 'Unknown demo endpoint' } });
});

try {
  await page.goto(server.origin);
  await page.waitForFunction(() => window.studyLibrary?.available);
  const video = await fs.readFile(path.join(root, 'tests', 'fixtures', 'synthetic.webm'));
  await page.locator('#file-input').setInputFiles({ name: 'local-study-demo.webm', mimeType: 'video/webm', buffer: Buffer.from(video) });
  await page.waitForFunction(async () => (await window.studyLibrary.list()).length === 1);
  await page.waitForFunction(() => document.querySelector('#video').readyState >= 2 || document.querySelector('#video').error);
  const media = await page.locator('#video').evaluate(video => ({ readyState: video.readyState,
    width: video.videoWidth, height: video.videoHeight, error: video.error?.message || null }));
  assert.equal(media.error, null, JSON.stringify(media));
  assert.ok(media.width > 0 && media.height > 0, 'Synthetic video must decode before UI assertions');
  await page.locator('#video').evaluate(async video => { video.muted = true; await video.play(); });
  await page.waitForFunction(() => document.querySelector('#video').currentTime >= 0.2);
  await page.locator('#video').evaluate(video => video.pause());
  await page.waitForFunction(() => !document.querySelector('#new-chat').disabled);
  await page.locator('#attach-frame').uncheck();
  await page.locator('#lesson-context').fill('这是离线合成演示，不含真实课堂或模型请求。');
  await page.locator('#question').fill('如何把当前问题保存在这个视频的对话中？');
  await page.locator('#ask').click();
  await page.waitForFunction(() => document.querySelector('#chat-messages').textContent.includes('合成的示例回答'));
  await page.evaluate(() => window.studyLibrary.flushed());
  assert.equal(requests.length, 1);
  await page.locator('#new-chat').click();
  await page.waitForFunction(() => !document.querySelector('#chat-messages').textContent.includes('合成的示例回答'));
  await page.locator('#question').fill('第二段对话应当保持独立。');
  await page.locator('#ask').click();
  await page.waitForFunction(() => document.querySelector('#chat-messages').textContent.includes('合成的示例回答'));
  assert.equal(requests.length, 2);
  assert.ok(!JSON.stringify(requests[1].history).includes(requests[0].question));
  await page.evaluate(() => window.studyLibrary.flushed());
  await page.locator('#question').blur();
  await fs.mkdir(path.join(root, 'docs', 'images'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'docs', 'images', 'player-demo.png') });

  await page.reload();
  await page.waitForFunction(() => document.querySelector('#video-name').textContent.includes('local-study-demo.webm'));
  await page.waitForFunction(() => document.querySelector('#chat-messages').textContent.includes('合成的示例回答'));
  assert.equal((await page.evaluate(() => window.studyLibrary.list())).length, 1);
  await page.locator('.project-more').first().click();
  await page.locator('#archive-video').click();
  await page.waitForFunction(async () => Boolean((await window.studyLibrary.list())[0].record.archivedAt));
  await page.locator('#library-archived').click();
  await page.locator('.project-more').first().click();
  await page.locator('#archive-video').click();
  await page.waitForFunction(async () => !(await window.studyLibrary.list())[0].record.archivedAt);
  await page.locator('#library-active').click();
  await page.locator('.project-more').first().click();
  await page.locator('#delete-video').click();
  await page.locator('#confirm-delete-video').click();
  await page.waitForFunction(() => !document.querySelector('#delete-video-dialog').open);
  await page.evaluate(() => window.studyLibrary.flushed());
  await page.waitForFunction(async () => (await window.studyLibrary.list()).length === 0);
  await page.reload();
  await page.waitForFunction(() => window.studyLibrary?.available);
  const remaining = await page.evaluate(() => window.studyLibrary.list());
  assert.equal(remaining.length, 0, 'Deleted projects after reload: ' + JSON.stringify(remaining));
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: import, persistence, conversation isolation, archive, restore, deletion, reload; 2 mocked requests, 0 real model requests.');
} finally {
  await browser.close();
  await server.close();
}
