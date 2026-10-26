// Edge case test cho dot fix tool-call (khong phu thuoc mang that).
// Chay: node test/edge.test.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractJsonToolCalls, looksLikeToolJson, runAgent } from '../src/lib/agent.mjs';
import { createToolRunner } from '../src/lib/tools.mjs';

const PE_SCRIPT = fileURLToPath(new URL('../src/pe.mjs', import.meta.url));
let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}
const calls = (t) => extractJsonToolCalls(t).map((c) => c.name);

// --- parser edge ---
ok('parser: rong/null', extractJsonToolCalls('').length === 0 && extractJsonToolCalls(null).length === 0);
ok('parser: prose thuan khong call', calls('Xin chào, hôm nay trời đẹp.').length === 0);
ok('parser: fence code js khong phai tool', calls('Ví dụ:\n```js\nconsole.log(1);\n```').length === 0);
{
  const t = '```json\n{"tool": "write_file", "args": {"path": "a.cs", "content": "if (x) { return; } // { }"}}\n```';
  const got = extractJsonToolCalls(t);
  ok('parser: ngoac trong chuoi khong lac', got.length === 1 && got[0].args.content === 'if (x) { return; } // { }', JSON.stringify(got));
}
{
  const t = '```json\n{"tool": "write_file", "args": {"path": "a.cs", "content": "noi \\"trich dan\\" day"}}\n```';
  const got = extractJsonToolCalls(t);
  ok('parser: escape quote trong chuoi', got.length === 1 && got[0].args.content === 'noi "trich dan" day', JSON.stringify(got));
}
{
  const t = '```json\n{"tool": "write_file", "args": {"path": "a.cs", "content": "tiếng Việt có dấu ồ ạt"}}\n```';
  const got = extractJsonToolCalls(t);
  ok('parser: unicode', got.length === 1 && got[0].args.content === 'tiếng Việt có dấu ồ ạt');
}
{
  const t = 'Ví dụ code:\n```js\nfoo();\n```\nGiờ làm thật:\n```json\n{"tool": "read_file", "args": {"path": "a.cs"}}\n```';
  ok('parser: fence code truoc, tool sau van lay duoc', calls(t).join(',') === 'read_file');
}
{
  const t = '```json\r\n{"tool": "read_file", "args": {"path": "a.cs"}}\r\n```';
  ok('parser: CRLF', calls(t).join(',') === 'read_file');
}
{
  const t = '```json\n{"tool": "read_file", "args": {"path": "a.cs"}}';
  ok('parser: fence khong dong van lay (can bang la du)', calls(t).join(',') === 'read_file');
}
{
  const t = '```JSON\n{"tool": "read_file", "args": {"path": "a.cs"}}\n```';
  ok('parser: fence JSON hoa van lay (qua scan tran)', calls(t).join(',') === 'read_file');
}
{
  const t = '  ```json\n  {"tool": "read_file", "args": {"path": "a.cs"}}\n  ```';
  ok('parser: fence thut dau dong', calls(t).join(',') === 'read_file');
}
ok('parser: thieu args -> loai', calls('```json\n{"tool": "read_file"}\n```').length === 0);
ok('parser: args khong phai object -> loai', calls('```json\n{"tool": "read_file", "args": "a.cs"}\n```').length === 0);
{
  const t = '```json\n{"tool": "read_file", "args": {"path": "a.cs", "meta": {"nested": true, "n": 1}}}\n```';
  const got = extractJsonToolCalls(t);
  ok('parser: args long object', got.length === 1 && got[0].args.meta?.nested === true && got[0].args.meta?.n === 1);
}
ok('parser: ten tool hoa/thieu gach duoi -> map', calls('```json\n{"tool": "Read_File", "args": {"path": "a.cs"}}\n```').join(',') === 'read_file'
  && calls('```json\n{"tool": "READFILE", "args": {"path": "a.cs"}}\n```').join(',') === 'read_file');
ok('parser: alias map ten, khong doan args', (() => {
  const got = extractJsonToolCalls('```json\n{"tool": "read", "args": {"file": "a.cs"}}\n```');
  return got.length === 1 && got[0].name === 'read_file' && got[0].args.file === 'a.cs';
})());
ok('parser: nhay don -> bao broken de retry', looksLikeToolJson("{'tool': 'read_file', 'args': {'path': 'a.cs'}}").broken === true);
ok('parser: JSON hong khong phai tool -> khong bao broken', looksLikeToolJson('{"foo": 1,}').broken === false);

// --- mock worker (co ho tro native tool_calls) ---
function startMock(script) {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* giu {} */ }
    bodies.push(body);
    const item = script.length ? script.shift() : { text: 'ok' };
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const t = item.text;
      const mid = Math.floor(t.length / 2);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t.slice(0, mid) } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t.slice(mid) } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      const msg = { content: item.text || '', tool_calls: (item.toolCalls || []).map((tc, i) => ({ id: `call_${i}`, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } })) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: msg }] }));
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, bodies })));
}
function cfgFor(port) {
  return { workerUrl: `http://127.0.0.1:${port}`, proxySecret: 'mock-secret', model: 'mock-model:free', fallbackModels: [] };
}
async function tmpdir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// --- trung call trong 1 luot: chi chay 1 lan ---
{
  const proj = await tmpdir('pe-edge-dup-');
  const { server, port } = await startMock([{ text: 'Xong.' }]);
  let runs = 0;
  const r = await runAgent({
    cfg: cfgFor(port), model: 'mock-model:free',
    messages: [{ role: 'user', content: 'ghi file 2 lan?' }],
    runner: { run: async () => { runs++; return 'OK'; } },
    onEvent: () => {},
    firstReply: {
      text: '```json\n{"tool": "write_file", "args": {"path": "a.txt", "content": "x"}}\n```\n```json\n{"tool": "write_file", "args": {"path": "a.txt", "content": "x"}}\n```',
      toolCalls: [],
    },
  });
  ok('agent: trung call 1 luot chi chay 1 lan', runs === 1 && r.stopped === null, `runs=${runs}`);
  server.close();
}

// --- native tool_calls van chay ---
{
  const proj = await tmpdir('pe-edge-native-');
  await fs.writeFile(path.join(proj, 'a.cs'), 'ND-A');
  const { server, port } = await startMock([{ text: 'Đã đọc native.' }]);
  const tools = [];
  const r = await runAgent({
    cfg: cfgFor(port), model: 'mock-model:free',
    messages: [{ role: 'user', content: 'doc a.cs' }],
    runner: createToolRunner({ root: proj, approval: 3 }),
    onEvent: (t, d) => { if (t === 'tool') tools.push(d.name); },
    firstReply: { text: '', toolCalls: [{ name: 'read_file', args: { path: 'a.cs' } }] },
  });
  ok('agent: native tool_calls van chay', tools.join(',') === 'read_file' && r.stopped === null);
  server.close();
}

// --- cap buoc: model doi call mai (args khac nhau) -> dung o cap ---
{
  const { server, port } = await startMock([
    { text: '```json\n{"tool": "read_file", "args": {"path": "f2"}}\n```' },
    { text: '```json\n{"tool": "read_file", "args": {"path": "f3"}}\n```' },
    { text: '```json\n{"tool": "read_file", "args": {"path": "f4"}}\n```' },
    { text: '```json\n{"tool": "read_file", "args": {"path": "f5"}}\n```' },
  ]);
  const r = await runAgent({
    cfg: cfgFor(port), model: 'mock-model:free',
    messages: [{ role: 'user', content: 'doc lien tuc' }],
    runner: { run: async (n, a) => `noi dung ${a.path}` },
    onEvent: () => {},
    maxSteps: 3,
    firstReply: { text: '```json\n{"tool": "read_file", "args": {"path": "f1"}}\n```', toolCalls: [] },
  });
  ok('agent: doi call mai -> dung o cap', r.stopped === 'cap' && r.steps === 3, `stopped=${r.stopped} steps=${r.steps}`);
  server.close();
}

// --- alias sai args: LOI tra ve, model sua lai ---
{
  const proj = await tmpdir('pe-edge-aliasargs-');
  await fs.writeFile(path.join(proj, 'a.cs'), 'ND-A');
  const { server, port, bodies } = await startMock([
    { text: '```json\n{"tool": "read_file", "args": {"path": "a.cs"}}\n```' },
    { text: 'Đã đọc sau khi sửa args.' },
  ]);
  const tools = [];
  const r = await runAgent({
    cfg: cfgFor(port), model: 'mock-model:free',
    messages: [{ role: 'user', content: 'doc a.cs' }],
    runner: createToolRunner({ root: proj, approval: 3 }),
    onEvent: (t, d) => { if (t === 'tool') tools.push(d.name); },
    firstReply: { text: '```json\n{"tool": "read", "args": {"file": "a.cs"}}\n```', toolCalls: [] },
  });
  const loiFedBack = bodies.some((b) => JSON.stringify(b.messages || []).includes('Thieu duong dan'));
  ok('agent: alias sai args -> LOI dua lai cho model', loiFedBack && tools.join(',') === 'read_file,read_file' && r.stopped === null, tools.join(','));
  server.close();
}

// --- chat: luot mo dau bang fence (khong prose) -> tool chay, khong lo JSON ---
{
  const proj = await tmpdir('pe-edge-chatfirst-');
  const home = await tmpdir('pe-edge-home-');
  const { server, port } = await startMock([
    { text: '```json\n{"tool": "write_file", "args": {"path": "second.txt", "content": "hello second"}}\n```' },
    { text: 'Đã tạo second.txt.' },
  ]);
  const child = spawn(process.execPath, [PE_SCRIPT, 'chat'], {
    cwd: proj,
    env: { ...process.env, PE_HOME: home, PE_WORKER_URL: `http://127.0.0.1:${port}`, PE_PROXY_SECRET: 'mock-secret', PE_MODEL: 'mock-model:free' },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.stdin.write('tạo file second.txt\n');
  for (let i = 0; i < 100 && !(await fs.stat(path.join(proj, 'second.txt')).catch(() => null)); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  child.stdin.write('/exit\n');
  await Promise.race([
    new Promise((r) => child.on('close', r)),
    new Promise((r) => setTimeout(() => { child.kill(); r('timeout'); }, 30000)),
  ]);
  const content = await fs.readFile(path.join(proj, 'second.txt'), 'utf8').catch(() => '');
  ok('chat: luot mo dau bang fence -> file ghi that', content === 'hello second', `content=${JSON.stringify(content)}`);
  ok('chat: luot mo dau bang fence -> khong lo JSON', !out.includes('"tool": "write_file"'), `out=${out.slice(0, 400)}`);
  server.close();
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
