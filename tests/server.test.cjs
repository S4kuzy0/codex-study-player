'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startTestServer } = require('./server-fixture.cjs');
let server;
before(async () => { server = await startTestServer(); });
after(async () => { await server?.close(); });

test('serves the complete offline app but hides project and runtime files', async () => {
  for (const file of ['/', '/app.js', '/library.js', '/style.css', '/vendor/dexie/dexie.min.js']) {
    const response = await fetch(server.origin + file);
    assert.equal(response.status, 200, file);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
  for (const file of ['/LICENSE', '/package.json', '/work/runtime/AGENTS.md', '/vendor/%2e%2e/%2e%2e/package.json']) {
    assert.equal((await fetch(server.origin + file)).status, 404, file);
  }
  assert.equal((await fetch(server.origin + '/', { method: 'POST' })).status, 405);
});

test('rejects foreign origins and unexpected Host headers', async () => {
  assert.equal((await fetch(server.origin + '/api/config', { headers: { Origin: 'https://example.invalid' } })).status, 403);
  const status = await new Promise((resolve, reject) => {
    const request = http.get(server.origin + '/api/config', { headers: { Host: 'example.invalid' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject);
  });
  assert.equal(status, 403);
});

test('requires the current local token for API writes', async () => {
  const config = await (await fetch(server.origin + '/api/config')).json();
  assert.equal(config.app, 'study-player');
  assert.equal(config.healthy, true);
  assert.equal(config.ready, false);
  assert.equal((await fetch(server.origin + '/api/ask', { method: 'POST', body: '{}' })).status, 403);
  const headers = { 'X-Study-Token': config.token, 'Content-Type': 'application/json' };
  assert.equal((await fetch(server.origin + '/api/ask', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(server.origin + '/api/unknown', { method: 'POST', headers, body: '{}' })).status, 404);
});

test('missing CLI is reported without making a real model request', async () => {
  const config = await (await fetch(server.origin + '/api/config')).json();
  const response = await fetch(server.origin + '/api/ask', { method: 'POST',
    headers: { 'X-Study-Token': config.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'Synthetic test question' }) });
  assert.equal(response.status, 503);
  assert.ok((await response.json()).error);
});
