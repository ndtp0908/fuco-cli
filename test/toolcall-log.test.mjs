// Test file log tool-call fail (khong phu thuoc mang that).
// Chay: node test/toolcall-log.test.mjs
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../src/lib/agent.mjs';
import { createToolRunner } from '../src/lib/tools.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}
async function tmpdir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
const exists = (p) => fs.stat(p).then(() => true).catch(() => false);
const read = (p) => fs.readFile(p, 'utf8').catch(() => '');

function startMock(script) {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const item = script.length ? script.shift() : { text: 'ok' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: item.text, tool_calls: [] } }] }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}
function cfgFor(port) {
  return { workerUrl: `http://127.0.0.1:${port}`, proxySecret: 'mock-secret', model: 'mock-model:free', fallbackModels: [] };
}

// --- 1. Du loai fail trong 1 luot: tool la + alias + tool loi ---
{
  const proj = await tmpdir('pe-log-mix-');
  const logFile = path.join(await tmpdir('pe-log-dir-'), 'fails.txt');
  process.env.PE_TOOLCALL_LOG = logFile;
  const { server, port } = await startMock([{ text: 'Xong.' }]);
  await runAgent({
    cfg: cfgFor(port), model: 'mock-model:free',
    messages: [{ role: 'user', content: 'test log' }],
    runner: createToolRunner({ root: proj, approval: 3 }),
    onEvent: () => {},
    firstReply: {
      text: '```json\n{"tool": "think", "args": {"about": "x"}}\n```\n```json\n{"tool": "shell", "args": {"command": "echo hi"}}\n```\n```json\n{"tool": "read_file", "args": {"path": "khong-co.txt"}}\n```',
      toolCalls: [],
    },
  });
  const log = await read(logFile);
  ok('log: co muc unknown-tool (think)', log.includes('unknown-tool') && log.includes('think'), log.slice(0, 300));
  ok('log: co muc alias-mapped shell -> run_bash', log.includes('alias-mapped') && log.includes('shell') && log.includes('run_bash'));
  ok('log: co muc tool-error (think + read_file loi)', log.includes('tool-error') && log.includes('khong-co.txt'));
  ok('log: ghi ten model', log.includes('mock-model:free'));
  server.close();
}

// --- 2. JSON cat do 2 lan -> extract-retry + extract-failed ---
{
  const logFile = path.join(await tmpdir('pe-log-dir-'), 'fails.txt');
  process.env.PE_TOOLCALL_LOG = logFile;
  const { server, port } = await startMock([
    { text: '```json\n{"tool": "read_file", "args": {"path": "a.cs", "content": "van cat' },
  ]);
  const r = await runAgent({
    cfg: cfgFor(port), model: 'mock-model:free',
    messages: [{ role: 'user', content: 'doc a.cs' }],
    runner: { run: async () => 'OK' },
    onEvent: () => {},
    firstReply: {
      text: '```json\n{"tool": "read_file", "args": {"path": "a.cs", "content": "cat do',
      toolCalls: [],
    },
  });
  const log = await read(logFile);
  ok('log: co extract-retry khi JSON cat do', log.includes('extract-retry'));
  ok('log: co extract-failed sau khi retry van hong', log.includes('extract-failed') && r.brokenJson === true);
  ok('log: extract-failed kem doan tho', log.includes('doan tho tu model'));
  server.close();
}

// --- 3. Dung loop -> co muc loop-stop ---
{
  const logFile = path.join(await tmpdir('pe-log-dir-'), 'fails.txt');
  process.env.PE_TOOLCALL_LOG = logFile;
  const { server, port } = await startMock([
    { text: '```json\n{"tool": "read_file", "args": {"path": "a.cs"}}\n```' },
    { text: '```json\n{"tool": "read_file", "args": {"path": "a.cs"}}\n```' },
    { text: '```json\n{"tool": "read_file", "args": {"path": "a.cs"}}\n```' },
    { text: '```json\n{"tool": "read_file", "args": {"path": "a.cs"}}\n```' },
  ]);
  const r = await runAgent({
    cfg: cfgFor(port), model: 'mock-model:free',
    messages: [{ role: 'user', content: 'doc a.cs' }],
    runner: { run: async () => 'KET-QUA-CO-DINH' },
    onEvent: () => {},
    firstReply: { text: '```json\n{"tool": "read_file", "args": {"path": "a.cs"}}\n```', toolCalls: [] },
  });
  const log = await read(logFile);
  ok('log: co loop-stop khi dung loop', r.stopped === 'loop' && log.includes('loop-stop'));
  server.close();
}

// --- 4. Chay tot -> khong tao file log (khong rac) ---
{
  const proj = await tmpdir('pe-log-clean-');
  await fs.writeFile(path.join(proj, 'a.cs'), 'ND-A');
  const logFile = path.join(await tmpdir('pe-log-dir-'), 'fails.txt');
  process.env.PE_TOOLCALL_LOG = logFile;
  const { server, port } = await startMock([{ text: 'Đã đọc xong.' }]);
  await runAgent({
    cfg: cfgFor(port), model: 'mock-model:free',
    messages: [{ role: 'user', content: 'doc a.cs' }],
    runner: createToolRunner({ root: proj, approval: 3 }),
    onEvent: () => {},
    firstReply: { text: '```json\n{"tool": "read_file", "args": {"path": "a.cs"}}\n```', toolCalls: [] },
  });
  ok('log: chay tot khong tao file', !(await exists(logFile)));
  server.close();
}

// --- 5. Fallback khong co PE_TOOLCALL_LOG -> ve PE_HOME/.pe/ ---
{
  delete process.env.PE_TOOLCALL_LOG;
  const home = await tmpdir('pe-log-home-');
  const prevHome = process.env.PE_HOME;
  process.env.PE_HOME = home;
  const proj = await tmpdir('pe-log-fb-');
  const { server, port } = await startMock([{ text: 'Xong.' }]);
  await runAgent({
    cfg: cfgFor(port), model: 'mock-model:free',
    messages: [{ role: 'user', content: 'test fallback' }],
    runner: createToolRunner({ root: proj, approval: 3 }),
    onEvent: () => {},
    firstReply: { text: '```json\n{"tool": "think", "args": {}}\n```', toolCalls: [] },
  });
  const fb = path.join(home, '.pe', 'pe-toolcall-failures.txt');
  const log = await read(fb);
  ok('log: fallback ve PE_HOME/.pe', log.includes('unknown-tool') && log.includes('think'), `fb=${fb}`);
  if (prevHome === undefined) delete process.env.PE_HOME;
  else process.env.PE_HOME = prevHome;
  server.close();
}

// --- 6. Args dai bi cat gon, khong phong file ---
{
  const logFile = path.join(await tmpdir('pe-log-dir-'), 'fails.txt');
  process.env.PE_TOOLCALL_LOG = logFile;
  const { server, port } = await startMock([{ text: 'Xong.' }]);
  const big = 'x'.repeat(5000);
  await runAgent({
    cfg: cfgFor(port), model: 'mock-model:free',
    messages: [{ role: 'user', content: 'test cat args' }],
    runner: { run: async () => 'LOI: loi gia de test cat' },
    onEvent: () => {},
    firstReply: { text: `{"tool": "write_file", "args": {"path": "a.txt", "content": "${big}"}}`, toolCalls: [] },
  });
  const log = await read(logFile);
  ok('log: args dai bi cat gon', log.includes('tong 5000 ky tu') && log.length < 3000, `len=${log.length}`);
  server.close();
}

delete process.env.PE_TOOLCALL_LOG;
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
