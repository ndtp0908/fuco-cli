// Regression test cho bug stream chat 0.12.2 (anh bao 2026-10-27):
// model free tra ve tool-call JSON TRAN, khong co \n cuoi dong —
// replyTurn chi xet cac dong DA HOAN TAT (co \n) nen dong cuoi khong
// bao gio bi nhan la tool: JSON in tho ra terminal, agent khong chay,
// khong co log fail (log chi ghi trong runAgent).
// Chay: node test/chat-stream-tail.test.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    let body = {};
    try { body = JSON.parse(raw); } catch { /* giu {} */ }
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

async function runChatCase({ name, script, userMsg, fileToCheck }) {
  const proj = await tmpdir('pe-tail-proj-');
  await fs.writeFile(path.join(proj, 'plan.md'), '# Ke hoach card_game\n');
  const home = await tmpdir('pe-tail-home-');
  const { server, port } = await startMock(script);
  const child = spawn(process.execPath, [PE_SCRIPT, 'chat'], {
    cwd: proj,
    env: {
      ...process.env, PE_HOME: home,
      PE_WORKER_URL: `http://127.0.0.1:${port}`, PE_PROXY_SECRET: 'mock-secret',
      PE_MODEL: 'mock-model:free', PE_APPROVAL: '3',
    },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.stdin.write(userMsg + '\n');
  for (let i = 0; i < 150 && !out.includes('[tool]'); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  child.stdin.write('/exit\n');
  const code = await Promise.race([
    new Promise((r) => child.on('close', r)),
    new Promise((r) => setTimeout(() => { child.kill(); r('timeout'); }, 30000)),
  ]);
  void fileToCheck;
  server.close();
  return { out, code };
}

// --- 1. JSON tool 1 dong duy nhat, KHONG co \n cuoi (dung ca anh gap) ---
{
  const { out, code } = await runChatCase({
    name: 'single-line',
    script: [
      { text: '{"tool": "list_files", "args": {"path": "."}}' },
      { text: 'Đã liệt kê xong thư mục.' },
    ],
    userMsg: 'liệt kê thư mục này',
  });
  ok('json 1 dong khong \\n cuoi: tool chay that', out.includes('[tool]'), `close=${code} out=${out.slice(0, 400)}`);
  ok('json 1 dong khong \\n cuoi: khong in JSON tho ra transcript', !out.includes('pe: {"tool"'), `out=${out.slice(0, 400)}`);
  ok('json 1 dong khong \\n cuoi: co cau tra loi cuoi', out.includes('Đã liệt kê xong'), `out=${out.slice(0, 400)}`);
}

// --- 2. Prose + JSON o dong cuoi, KHONG co \n cuoi ---
{
  const { out, code } = await runChatCase({
    name: 'prose-tail',
    script: [
      { text: 'Để pé liệt kê cho anh:\n{"tool": "list_files", "args": {"path": "."}}' },
      { text: 'Đã liệt kê xong thư mục.' },
    ],
    userMsg: 'liệt kê thư mục này',
  });
  ok('prose + json dong cuoi: tool chay that', out.includes('[tool]'), `close=${code} out=${out.slice(0, 400)}`);
  ok('prose + json dong cuoi: khong in JSON tho ra transcript', !out.includes('{"tool": "list_files"'), `out=${out.slice(0, 400)}`);
  ok('prose + json dong cuoi: co cau tra loi cuoi', out.includes('Đã liệt kê xong'), `out=${out.slice(0, 400)}`);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
