// Self-test khong phu thuoc mang that: dung mock worker mo phong dung hop dong
// cua fuco-agent-proxy (x-proxy-auth, 404 gia khi sai secret, chan model non-free).
import { spawn } from 'node:child_process';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PE = path.join(ROOT, 'src', 'pe.mjs');
const SECRET = 'test-secret-123';
const FREE_MODEL = 'some-model:free';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${extra}`); }
}

// ---- mock worker ----
function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.headers['x-proxy-auth'] !== SECRET) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end('<html><head><title>404 Not Found</title></head><body>Not Found</body></html>');
        }
        if (req.url.startsWith('/api/models') && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ data: [{ id: FREE_MODEL }, { id: 'pro-model' }] }));
        }
        if (req.url.startsWith('/api/chat') && req.method === 'POST') {
          let m = null;
          let lastContent = null;
          try {
            const parsed = JSON.parse(body);
            m = parsed.model;
            const msgs = parsed.messages || [];
            lastContent = msgs.length ? msgs[msgs.length - 1].content : null;
          } catch {}
          if (!m || !String(m).endsWith(':free')) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: { message: 'Access Denied: Only :free models allowed.' } }));
          }
          // Nhan dien dinh kem de test: anh -> MOCK-IMAGE-OK,
          // file/stdin co marker -> MOCK-FILE-OK.
          let reply = 'MOCK-REPLY-OK';
          if (Array.isArray(lastContent)) {
            const textPart = lastContent.find((x) => x.type === 'text')?.text || '';
            const hasImg = lastContent.some((x) => x.type === 'image_url' && String(x.image_url?.url || '').startsWith('data:image/'));
            if (hasImg) reply = 'MOCK-IMAGE-OK';
            else if (textPart.includes('MARKER-FILE-CONTENT')) reply = 'MOCK-FILE-OK';
          } else if (typeof lastContent === 'string' && lastContent.includes('MARKER-FILE-CONTENT')) {
            reply = 'MOCK-FILE-OK';
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: reply } }],
            model: m,
          }));
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>404 Not Found</title></head><body></body></html>');
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

function runCli(args, env = {}, stdinData = '') {
  return new Promise((resolve) => {
    const p = spawn('node', [PE, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => resolve({ code, out, err }));
    if (stdinData) p.stdin.write(stdinData);
    p.stdin.end();
  });
}

async function main() {
  console.log('pe selftest\n');

  // 1. config round-trip voi PE_HOME tam
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pe-test-'));
  const { saveConfig, loadConfig } = await import('../src/lib/config.mjs');
  const saved = await saveConfig({ workerUrl: 'https://x.workers.dev/', proxySecret: 's', model: 'm:free', approval: 2 }, tmpHome);
  ok('saveConfig tra ve path trong PE_HOME', saved.startsWith(tmpHome), saved);
  const raw = JSON.parse(await fs.readFile(saved, 'utf8'));
  ok('workerUrl duoc chuan hoa (bo / cuoi)', raw.workerUrl === 'https://x.workers.dev', raw.workerUrl);
  const cfg1 = await loadConfig(tmpHome);
  ok('loadConfig doc lai dung', cfg1.proxySecret === 's' && cfg1.model === 'm:free');
  process.env.PE_HOME = tmpHome;
  process.env.PE_MODEL = 'env-model:free';
  const cfg2 = await loadConfig(tmpHome);
  ok('PE_MODEL ghi de config file', cfg2.model === 'env-model:free', cfg2.model);
  delete process.env.PE_MODEL;
  delete process.env.PE_HOME;

  // 2. CLI co ban
  let r = await runCli(['--help'], { PE_HOME: tmpHome });
  ok('--help exit 0 va co huong dan', r.code === 0 && r.out.includes('pe ask'), `code=${r.code}`);
  r = await runCli(['lenh-la'], { PE_HOME: tmpHome });
  ok('lenh la -> exit 2', r.code === 2 && r.err.includes('Lenh la'), `code=${r.code}`);
  r = await runCli(['--version'], { PE_HOME: tmpHome });
  ok('--version in ra', r.code === 0 && /^\d+\.\d+\.\d+/.test(r.out.trim()), r.out.trim());

  // 3. ask thieu prompt -> usage
  r = await runCli(['ask'], { PE_HOME: tmpHome }, '');
  ok('ask khong prompt -> exit 2', r.code === 2, `code=${r.code}`);

  // 4. doctor khi chua co config -> exit 1, goi y pe init
  const emptyHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pe-empty-'));
  r = await runCli(['doctor'], { PE_HOME: emptyHome });
  ok('doctor thieu config -> exit 1 + goi y init', r.code === 1 && r.out.includes('pe init'), `code=${r.code}`);

  // 5. chong lai mock worker
  const { srv, port } = await startMock();
  const mockUrl = `http://127.0.0.1:${port}`;
  const menv = { PE_HOME: tmpHome, PE_WORKER_URL: mockUrl, PE_PROXY_SECRET: SECRET, PE_MODEL: FREE_MODEL };

  r = await runCli(['ask', 'xin chao'], menv);
  ok('ask qua mock worker -> tra loi', r.code === 0 && r.out.includes('MOCK-REPLY-OK'), `code=${r.code} out=${r.out.slice(0, 80)}`);

  r = await runCli(['ask', 'hi', '--model', 'pro-model'], menv);
  ok('ask model non-free -> loi ro rang', r.code === 1 && r.err.includes(':free'), `code=${r.code} err=${r.err.slice(0, 80)}`);

  r = await runCli(['ask', 'hi'], { ...menv, PE_PROXY_SECRET: 'sai' });
  ok('sai secret -> bao 404 gia/auth', r.code === 1 && r.err.includes('404 gia'), `code=${r.code} err=${r.err.slice(0, 80)}`);

  r = await runCli(['ask', 'hi'], { ...menv, PE_WORKER_URL: 'http://127.0.0.1:1' });
  ok('worker khong toi duoc -> loi network', r.code === 1 && r.err.includes('Khong noi duoc'), `code=${r.code}`);

  // 6. dinh kem file / anh / mention / stdin kem prompt
  const codePath = path.join(tmpHome, 'code.txt');
  await fs.writeFile(codePath, 'doan code co MARKER-FILE-CONTENT o giua');
  const pngPath = path.join(tmpHome, 'tiny.png');
  await fs.writeFile(pngPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'));

  r = await runCli(['ask', 'review file nay', '--file', codePath], menv);
  ok('ask --file gui kem noi dung file', r.code === 0 && r.out.includes('MOCK-FILE-OK'), `code=${r.code} out=${r.out.slice(0, 80)} err=${r.err.slice(0, 80)}`);

  r = await runCli(['ask', 'anh nay la gi', '--image', pngPath], menv);
  ok('ask --image gui part image_url data:', r.code === 0 && r.out.includes('MOCK-IMAGE-OK'), `code=${r.code} out=${r.out.slice(0, 80)} err=${r.err.slice(0, 80)}`);

  r = await runCli(['ask', `xem @${codePath} giup`], menv);
  ok('ask @mention tu doc file', r.code === 0 && r.out.includes('MOCK-FILE-OK'), `code=${r.code} out=${r.out.slice(0, 80)}`);

  r = await runCli(['ask', 'tom tat noi dung stdin'], menv, 'MARKER-FILE-CONTENT tu stdin');
  ok('ask prompt + stdin pipe gui kem stdin', r.code === 0 && r.out.includes('MOCK-FILE-OK'), `code=${r.code} out=${r.out.slice(0, 80)}`);

  r = await runCli(['ask', 'hi', '--file', path.join(tmpHome, 'khong-co.txt')], menv);
  ok('ask --file khong ton tai -> loi ro rang', r.code === 2 && r.err.includes('Khong tim thay'), `code=${r.code} err=${r.err.slice(0, 80)}`);

  // 7. help chi tiet tung lenh
  r = await runCli(['help', 'ask'], { PE_HOME: tmpHome });
  ok('pe help ask co --file/--image + vi du', r.code === 0 && r.out.includes('--image') && r.out.includes('Vi du'), `code=${r.code}`);
  r = await runCli(['ask', '--help'], { PE_HOME: tmpHome });
  ok('pe ask --help khong goi worker', r.code === 0 && r.out.includes('--file') && !r.out.includes('MOCK'), `code=${r.code}`);
  r = await runCli(['help', 'chat'], { PE_HOME: tmpHome });
  ok('pe help chat co /file /image', r.code === 0 && r.out.includes('/image'), `code=${r.code}`);

  // 8. chat: /file stage roi gui
  r = await runCli(['chat'], menv, `/file ${codePath}\nreview file vua gui\n/exit\n`);
  ok('chat /file + cau hoi -> worker nhan file', r.code === 0 && r.out.includes('MOCK-FILE-OK'), `code=${r.code} out=${r.out.slice(0, 120)}`);

  // 6b. stdin mo (khong EOF) + da co prompt -> khong duoc treo
  {
    const res = await new Promise((resolve) => {
      const proc = spawn('node', [PE, 'ask', 'xin chao'], {
        env: { ...process.env, ...menv },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      proc.stdout.on('data', (c) => (out += c));
      const to = setTimeout(() => { proc.kill(); resolve({ code: -1, out }); }, 8000);
      proc.on('close', (code) => { clearTimeout(to); resolve({ code, out }); });
      // co tinh KHONG end stdin
    });
    ok('ask co prompt khong treo vi stdin mo', res.code === 0 && res.out.includes('MOCK-REPLY-OK'), `code=${res.code}`);
  }

  r = await runCli(['doctor'], menv);
  ok('doctor voi mock worker -> exit 0', r.code === 0 && r.out.includes('Tat ca deu on'), `code=${r.code}`);

  r = await runCli(['model', 'list'], menv);
  ok('model list loc :free', r.code === 0 && r.out.includes(FREE_MODEL) && !r.out.includes('pro-model'), r.out.trim());

  r = await runCli(['model', 'new-model:free'], menv);
  ok('model <id> doi + luu', r.code === 0 && r.out.includes('new-model:free'), r.out.trim());
  const cfg3 = await loadConfig(tmpHome);
  ok('model moi da luu vao config', cfg3.model === 'new-model:free', cfg3.model);

  srv.close();
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(emptyHome, { recursive: true, force: true });

  console.log(`\n${passed} pass, ${failed} fail`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('SELFTEST CRASH:', e); process.exit(1); });
