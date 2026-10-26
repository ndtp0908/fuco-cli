// Workflow test cho dot fix tool-call (khong phu thuoc mang that):
// mock worker tra loi theo kich ban, pe chay that tren project tam.
// Chay: node test/workflow.test.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from '../src/lib/agent.mjs';
import { createToolRunner } from '../src/lib/tools.mjs';

const PE_SCRIPT = fileURLToPath(new URL('../src/pe.mjs', import.meta.url));

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${extra}`); }
}

async function tmpdir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: item.text, tool_calls: [] } }] }));
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, bodies })));
}

function cfgFor(port) {
  return { workerUrl: `http://127.0.0.1:${port}`, proxySecret: 'mock-secret', model: 'mock-model:free', fallbackModels: [] };
}

// --- 1. pe chat that: plan-first + write_file newline that, roi cau tra loi co fence code ---
{
  const proj = await tmpdir('pe-wf-chat-');
  const home = await tmpdir('pe-wf-home-');
  const { server, port, bodies } = await startMock([
    { text: 'Được rồi, pé tạo file hello.txt ngay:\n```json\n{"tool": "write_file", "args": {"path": "hello.txt", "content": "dong mot\ndong hai\ndong ba"}}\n```\n' },
    { text: 'Đã tạo xong file hello.txt với 3 dòng.' },
    { text: 'Ví dụ code js:\n```js\nconsole.log("vd");\n```\nHết ví dụ.' },
  ]);
  const child = spawn(process.execPath, [PE_SCRIPT, 'chat'], {
    cwd: proj,
    env: { ...process.env, PE_HOME: home, PE_WORKER_URL: `http://127.0.0.1:${port}`, PE_PROXY_SECRET: 'mock-secret', PE_MODEL: 'mock-model:free' },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.stdin.write('tạo file hello.txt với nội dung chào\n');
  // doi luot 1 xong (file xuat hien) roi gui luot 2 + /exit
  for (let i = 0; i < 100 && !(await fs.stat(path.join(proj, 'hello.txt')).catch(() => null)); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  child.stdin.write('cho ví dụ code js\n');
  await new Promise((r) => setTimeout(r, 1500));
  child.stdin.write('/exit\n');
  const code = await Promise.race([
    new Promise((r) => child.on('close', r)),
    new Promise((r) => setTimeout(() => { child.kill(); r('timeout'); }, 30000)),
  ]);
  const content = await fs.readFile(path.join(proj, 'hello.txt'), 'utf8').catch(() => '');
  ok('chat: file duoc ghi that (khong phai chi in JSON)', content === 'dong mot\ndong hai\ndong ba', `content=${JSON.stringify(content)} out=${out.slice(0, 500)}`);
  ok('chat: transcript KHONG chua JSON tool tho', !out.includes('"tool": "write_file"'), `close=${code}`);
  ok('chat: co dong [tool] hien thi', out.includes('[tool]'), `out=${out.slice(0, 500)}`);
  ok('chat: cau tra loi co fence code van in day du', out.includes('console.log("vd")'), `out=${out.slice(0, 500)}`);
  void bodies;
  server.close();
}

// --- 2. Doc nhieu file: 1 luot plan co 3 read_file ---
{
  const proj = await tmpdir('pe-wf-read-');
  await fs.writeFile(path.join(proj, 'a.cs'), 'NOI-DUNG-A');
  await fs.writeFile(path.join(proj, 'b.cs'), 'NOI-DUNG-B');
  await fs.writeFile(path.join(proj, 'c.cs'), 'NOI-DUNG-C');
  const { server, port } = await startMock([{ text: 'Đã đọc xong cả 3 file.' }]);
  const tools = [];
  const r = await runAgent({
    cfg: cfgFor(port), model: 'mock-model:free',
    messages: [{ role: 'user', content: 'doc 3 file a, b, c' }],
    runner: createToolRunner({ root: proj, approval: 3 }),
    onEvent: (t, d) => { if (t === 'tool') tools.push(d.name + ':' + (d.args.path || '')); },
    firstReply: {
      text: 'Kế hoạch đọc:\n```json\n{"tool": "read_file", "args": {"path": "a.cs"}}\n```\n```json\n{"tool": "read_file", "args": {"path": "b.cs"}}\n```\n```json\n{"tool": "read_file", "args": {"path": "c.cs"}}\n```',
      toolCalls: [],
    },
  });
  ok('doc nhieu file: ca 3 call chay dung thu tu', tools.join(',') === 'read_file:a.cs,read_file:b.cs,read_file:c.cs', tools.join(','));
  ok('doc nhieu file: ket thuc binh thuong', r.stopped === null && r.text.includes('3 file'));
  server.close();
}

// --- 3. Code lien tuc: write roi edit qua 2 vong lap ---
{
  const proj = await tmpdir('pe-wf-code-');
  const { server, port } = await startMock([
    { text: '```json\n{"tool": "edit_file", "args": {"path": "app.cs", "old_text": "v1", "new_text": "v2"}}\n```' },
    { text: 'Đã viết rồi sửa xong app.cs.' },
  ]);
  const r = await runAgent({
    cfg: cfgFor(port), model: 'mock-model:free',
    messages: [{ role: 'user', content: 'tao app.cs roi doi v1 thanh v2' }],
    runner: createToolRunner({ root: proj, approval: 3 }),
    onEvent: () => {},
    firstReply: {
      text: '```json\n{"tool": "write_file", "args": {"path": "app.cs", "content": "ban v1"}}\n```',
      toolCalls: [],
    },
  });
  const content = await fs.readFile(path.join(proj, 'app.cs'), 'utf8').catch(() => '');
  ok('code lien tuc: write roi edit ra noi dung cuoi', content === 'ban v2', `content=${JSON.stringify(content)}`);
  ok('code lien tuc: ket thuc binh thuong', r.stopped === null);
  server.close();
}

// --- 4. JSON cat do -> retry 1 lan roi chay tool ---
{
  const proj = await tmpdir('pe-wf-broken-');
  await fs.writeFile(path.join(proj, 'a.cs'), 'NOI-DUNG-A');
  const { server, port, bodies } = await startMock([
    { text: '```json\n{"tool": "read_file", "args": {"path": "a.cs"}}\n```' },
    { text: 'Đã đọc xong.' },
  ]);
  const tools = [];
  const r = await runAgent({
    cfg: cfgFor(port), model: 'mock-model:free',
    messages: [{ role: 'user', content: 'doc a.cs' }],
    runner: createToolRunner({ root: proj, approval: 3 }),
    onEvent: (t, d) => { if (t === 'tool') tools.push(d.name); },
    firstReply: {
      text: '```json\n{"tool": "read_file", "args": {"path": "a.cs", "content": "cat do o day',
      toolCalls: [],
    },
  });
  const repairSent = bodies.some((b) => JSON.stringify(b.messages || []).includes('CẮT DỞ'));
  ok('JSON cat do: co gui lai yeu cau sua', repairSent);
  ok('JSON cat do: sau retry tool chay duoc', tools.join(',') === 'read_file', tools.join(','));
  ok('JSON cat do: ket thuc binh thuong', r.stopped === null);
  server.close();
}

// --- 5. Tool la -> loi tra ve model, model sua lai ---
{
  const proj = await tmpdir('pe-wf-unknown-');
  await fs.writeFile(path.join(proj, 'a.cs'), 'NOI-DUNG-A');
  const { server, port, bodies } = await startMock([
    { text: '```json\n{"tool": "read_file", "args": {"path": "a.cs"}}\n```' },
    { text: 'Đã đọc xong sau khi sửa tên tool.' },
  ]);
  const tools = [];
  const r = await runAgent({
    cfg: cfgFor(port), model: 'mock-model:free',
    messages: [{ role: 'user', content: 'doc a.cs' }],
    runner: createToolRunner({ root: proj, approval: 3 }),
    onEvent: (t, d) => { if (t === 'tool') tools.push(d.name); },
    firstReply: {
      text: '```json\n{"tool": "think", "args": {"about": "x"}}\n```',
      toolCalls: [],
    },
  });
  const loiFedBack = bodies.some((b) => JSON.stringify(b.messages || []).includes('không tồn tại'));
  ok('tool la: loi duoc dua lai cho model', loiFedBack);
  ok('tool la: model sua xong chay duoc tool that', tools.join(',') === 'think,read_file', tools.join(','));
  ok('tool la: ket thuc binh thuong', r.stopped === null);
  server.close();
}

// --- 6. Lap that: cung call + cung ket qua -> dung o stall ---
{
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
    firstReply: {
      text: '```json\n{"tool": "read_file", "args": {"path": "a.cs"}}\n```',
      toolCalls: [],
    },
  });
  ok('lap that: dung lai voi stopped=loop', r.stopped === 'loop', `stopped=${r.stopped} steps=${r.steps}`);
  server.close();
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
