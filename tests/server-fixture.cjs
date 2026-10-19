'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function startTestServer() {
  const root = path.resolve(__dirname, '..');
  const work = path.join(root, 'work');
  await fs.mkdir(work, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(work, 'server-test-'));
  const child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: root,
    env: { ...process.env, STUDY_PLAYER_PORT: '0', STUDY_PLAYER_NO_REUSE: '1',
      STUDY_PLAYER_RUNTIME: temporary, STUDY_PLAYER_CODEX: path.join(temporary, 'missing-cli') },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Test server startup timed out')); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Test server exited: ${code}`)); });
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  return { origin, async close() {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    if (!temporary.startsWith(work + path.sep)) throw new Error('Invalid test cleanup path');
    await fs.rm(temporary, { recursive: true, force: true });
  } };
}

module.exports = { startTestServer };
