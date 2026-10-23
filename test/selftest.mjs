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
    const mockTasks = new Map();
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        // --- mock pe-worker (hang doi KV) ---
        if (req.url === '/task' || req.url.startsWith('/result/') || req.url === '/pending' || req.url === '/processing') {
          if (req.headers['x-agent-secret'] !== SECRET) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end('<html><head><title>404 Not Found</title></head><body>Not Found</body></html>');
          }
          if (req.url === '/task' && req.method === 'POST') {
            const id = 't_mock123456';
            mockTasks.set(id, { id, status: 'done', result: { answer: 'MOCK-ANSWER' } });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ task_id: id, status: 'queued' }));
          }
          if (req.url.startsWith('/result/')) {
            const id = req.url.split('/')[2];
            const t = mockTasks.get(id);
            res.writeHead(t ? 200 : 404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(t ? { status: t.status, result: t.result } : { ok: false }));
          }
          if (req.url === '/pending') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ pending: [] }));
          }
          if (req.url === '/processing') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ processing: [] }));
          }
        }
        if (req.headers['x-proxy-auth'] !== SECRET) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end('<html><head><title>404 Not Found</title></head><body>Not Found</body></html>');
        }
        if (req.url.startsWith('/api/models') && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ data: [{ id: FREE_MODEL }, { id: 'pro-model' }] }));
        }
        if (req.url.startsWith('/api/chat') && req.method === 'POST') {
          let parsed = null;
          try { parsed = JSON.parse(body); } catch {}
          const m = parsed?.model;
          const msgs = parsed?.messages || [];
          const lastContent = msgs.length ? msgs[msgs.length - 1].content : null;
          const sysText = msgs.filter((x) => x.role === 'system').map((x) => String(x.content || '')).join('\n');
          const allText = msgs.map((x) => (typeof x.content === 'string' ? x.content : JSON.stringify(x.content || ''))).join('\n');
          if (!m || !String(m).endsWith(':free')) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: { message: 'Access Denied: Only :free models allowed.' } }));
          }
          let reply = 'MOCK-REPLY-OK';
          if (sysText.includes('Ban tom tat cuoc hoi thoai')) {
            reply = 'TOM-TAT-X';
          } else 
          if (sysText.includes('cong cu sua file')) {
            const mm = String(lastContent || '').match(/```\n([\s\S]*?)\n```/);
            const fc = mm ? mm[1] : '';
            reply = '```\n' + fc.replace('ORIGINAL', 'EDITED') + '\n```';
          } else if (allText.includes('Ket qua tool') && allText.includes('Da sua')) {
            reply = 'AGENT-DONE';
          } else if (allText.includes('Ket qua tool') && allText.includes('ORIGINAL-CONTENT')) {
            reply = '```json\n{"tool": "edit_file", "args": {"path": "a.txt", "old_text": "ORIGINAL-CONTENT", "new_text": "EDITED-CONTENT"}}\n```';
          } else if (typeof lastContent === 'string' && lastContent.includes('MULTI-TOOL')) {
            reply = '{"tool": "read_file", "args": {"path": "a.txt"}}\n{"tool": "grep", "args": {"pattern": "x"}}';
          } else if (allText.includes('Ket qua tool') && allText.includes('y.txt')) {
            reply = 'LIST-DONE';
          } else if (typeof lastContent === 'string' && lastContent.includes('LIST-TASK')) {
            reply = '```json\n{"tool": "list_files", "args": {"pattern": "**/*.txt"}}\n```';
          } else if (typeof lastContent === 'string' && lastContent.includes('AGENT-TASK')) {
            reply = '```json\n{"tool": "read_file", "args": {"path": "a.txt"}}\n```';
          } else if (sysText.includes('CTX-MARKER-123')) {
            reply = 'CTX-OK';
          } else if (lastContent === 'ECHO-MODEL') {
            reply = 'MODEL=' + m;
          } else if (Array.isArray(lastContent)) {
            const textPart = lastContent.find((x) => x.type === 'text')?.text || '';
            const hasImg = lastContent.some((x) => x.type === 'image_url' && String(x.image_url?.url || '').startsWith('data:image/'));
            if (hasImg) reply = 'MOCK-IMAGE-OK';
            else if (textPart.includes('MARKER-FILE-CONTENT')) reply = 'MOCK-FILE-OK';
          } else if (typeof lastContent === 'string' && lastContent.includes('MARKER-FILE-CONTENT')) {
            reply = 'MOCK-FILE-OK';
          }
          if (parsed?.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const third = Math.max(1, Math.ceil(reply.length / 3));
            for (let i = 0; i < reply.length; i += third) {
              const chunk = reply.slice(i, i + third);
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
            }
            res.write('data: [DONE]\n\n');
            return res.end();
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

function runCli(args, env = {}, stdinData = '', opts = {}) {
  return new Promise((resolve) => {
    const p = spawn('node', [PE, ...args], {
      env: { ...process.env, ...env },
      cwd: opts.cwd || undefined,
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

  // 9. project context + config rieng theo project
  const projCtx = path.join(tmpHome, 'proj-ctx');
  await fs.mkdir(path.join(projCtx, '.pe'), { recursive: true });
  await fs.writeFile(path.join(projCtx, '.pe', 'context.md'), 'Ghi chu: CTX-MARKER-123');
  r = await runCli(['ask', 'hi'], menv, '', { cwd: projCtx });
  ok('ask tu nap .pe/context.md cua project', r.code === 0 && r.out.includes('CTX-OK'), `code=${r.code} out=${r.out.slice(0, 80)}`);

  const projCfg = path.join(tmpHome, 'proj-cfg');
  await fs.mkdir(path.join(projCfg, '.pe'), { recursive: true });
  await fs.writeFile(path.join(projCfg, '.pe', 'config.json'), JSON.stringify({ model: 'proj-model:free' }));
  // Khong dat PE_MODEL o env (env ghi de ca project — dung thiet ke)
  const menvNoModel = { PE_HOME: tmpHome, PE_WORKER_URL: mockUrl, PE_PROXY_SECRET: SECRET };
  r = await runCli(['ask', 'ECHO-MODEL'], menvNoModel, '', { cwd: projCfg });
  ok('.pe/config.json ghi de model', r.code === 0 && r.out.includes('MODEL=proj-model:free'), `code=${r.code} out=${r.out.slice(0, 80)}`);

  // 10. pe edit + pe undo
  const projEdit = path.join(tmpHome, 'proj-edit');
  await fs.mkdir(projEdit, { recursive: true });
  const ePath = path.join(projEdit, 'e.txt');
  await fs.writeFile(ePath, 'line1\nORIGINAL\nline3\n');
  r = await runCli(['edit', 'e.txt', 'thay ORIGINAL bang EDITED', '--yes'], menv, '', { cwd: projEdit });
  const afterEdit = await fs.readFile(ePath, 'utf8');
  ok('pe edit --yes ghi file da sua', r.code === 0 && afterEdit.includes('EDITED') && !afterEdit.includes('ORIGINAL'), `code=${r.code} file=${afterEdit.slice(0, 40)} out=${r.out.slice(0, 80)}`);
  r = await runCli(['undo', 'e.txt'], menv, '', { cwd: projEdit });
  const afterUndo = await fs.readFile(ePath, 'utf8');
  ok('pe undo khoi phuc ban cu', r.code === 0 && afterUndo.includes('ORIGINAL'), `code=${r.code} file=${afterUndo.slice(0, 40)}`);

  // 11. agent (pe do): doc file -> sua file -> tra loi xong
  const projAgent = path.join(tmpHome, 'proj-agent');
  await fs.mkdir(projAgent, { recursive: true });
  const aPath = path.join(projAgent, 'a.txt');
  await fs.writeFile(aPath, 'ORIGINAL-CONTENT');
  r = await runCli(['do', 'AGENT-TASK doc va sua a.txt'], { ...menv, PE_APPROVAL: '3' }, '', { cwd: projAgent });
  const afterAgent = await fs.readFile(aPath, 'utf8');
  ok('pe do agent doc+sua file, tra AGENT-DONE', r.code === 0 && r.out.includes('AGENT-DONE') && afterAgent === 'EDITED-CONTENT', `code=${r.code} file=${afterAgent} out=${r.out.slice(0, 120)}`);

  // 12. help cac lenh moi
  r = await runCli(['help', 'do'], { PE_HOME: tmpHome });
  ok('pe help do co muc duyet + vi du', r.code === 0 && r.out.includes('--yolo'), `code=${r.code}`);
  r = await runCli(['help', 'edit'], { PE_HOME: tmpHome });
  ok('pe help edit co --dry/--yes', r.code === 0 && r.out.includes('--dry'), `code=${r.code}`);

  // 13. chat: model tra 2 object JSON tran -> van chay duoc agent
  const projChat = path.join(tmpHome, 'proj-chat');
  await fs.mkdir(projChat, { recursive: true });
  await fs.writeFile(path.join(projChat, 'a.txt'), 'ORIGINAL-CONTENT');
  r = await runCli(['chat'], menv, 'MULTI-TOOL doc a.txt\n/exit\n', { cwd: projChat });
  ok('chat xu ly JSON tran nhieu object (agent chay tiep)', r.code === 0 && r.out.includes('AGENT-DONE'), `code=${r.code} out=${r.out.slice(0, 160)}`);

  // 14. list_files glob ** dung (bat loi replace an lan nhau truoc day)
  const projList = path.join(tmpHome, 'proj-list');
  await fs.mkdir(path.join(projList, 'sub'), { recursive: true });
  await fs.writeFile(path.join(projList, 'x.txt'), '1');
  await fs.writeFile(path.join(projList, 'sub', 'y.txt'), '2');
  await fs.writeFile(path.join(projList, 'z.md'), '3');
  r = await runCli(['do', 'LIST-TASK liet ke file txt'], { ...menv, PE_APPROVAL: '3' }, '', { cwd: projList });
  ok('list_files **/*.txt thay du 2 file (goc + sub)', r.code === 0 && r.out.includes('LIST-DONE') && r.out.includes('2 file:'), `code=${r.code} out=${r.out.slice(0, 140)}`);

  // 15. assign + result qua mock KV
  const menvKV = { ...menv, PE_PE_WORKER_URL: mockUrl };
  r = await runCli(['assign', 'ASSIGN-TEST xem giup'], menvKV);
  const mId = /t_[a-z0-9]+/.exec(r.out);
  ok('pe assign gui task vao hang doi', r.code === 0 && !!mId, `code=${r.code} out=${r.out.slice(0, 100)}`);
  if (mId) {
    r = await runCli(['result', mId[0]], menvKV);
    ok('pe result lay duoc dap an', r.code === 0 && r.out.includes('MOCK-ANSWER'), `code=${r.code} out=${r.out.slice(0, 100)}`);
  }
  r = await runCli(['tasks'], menvKV);
  ok('pe tasks chay duoc', r.code === 0 && r.out.includes('Hang doi'), `code=${r.code} out=${r.out.slice(0, 80)}`);

  // 16. sessions: chat luu phien, --resume noi tiep duoc
  const sessHome = path.join(tmpHome, 'sess-home');
  const { saveConfig: saveCfgFn } = await import('../src/lib/config.mjs');
  await saveCfgFn({ workerUrl: mockUrl, proxySecret: SECRET, model: FREE_MODEL }, sessHome);
  const menvSess = { PE_HOME: sessHome, PE_WORKER_URL: mockUrl, PE_PROXY_SECRET: SECRET, PE_MODEL: FREE_MODEL };
  r = await runCli(['chat'], menvSess, 'cau hoi mot\n/exit\n');
  const sessDir = path.join(sessHome, '.pe', 'sessions');
  let sessFiles = [];
  try { sessFiles = await fs.readdir(sessDir); } catch {}
  ok('chat tao phien luu o ~/.pe/sessions', r.code === 0 && sessFiles.length === 1, `code=${r.code} files=${sessFiles.length}`);
  if (sessFiles.length === 1) {
    const s1 = JSON.parse(await fs.readFile(path.join(sessDir, sessFiles[0]), 'utf8'));
    ok('phien co 2 tin (hoi + dap)', s1.messages.length === 2, `n=${s1.messages.length}`);
    r = await runCli(['chat', '--resume'], menvSess, 'cau hoi hai\n/exit\n');
    const s2 = JSON.parse(await fs.readFile(path.join(sessDir, sessFiles[0]), 'utf8'));
    ok('--resume noi tiep cung phien (4 tin)', r.code === 0 && s2.messages.length === 4, `code=${r.code} n=${s2.messages.length}`);
  }

  // 17. auto-compact: phien seed 16 tin + context limit nho -> tom tat
  const seedMsgs = [];
  for (let i = 0; i < 16; i++) seedMsgs.push({ role: i % 2 ? 'assistant' : 'user', content: 'tin ' + i + ' ' + 'x'.repeat(160) });
  const seed = { id: 's_seed', title: 'seed', cwd: tmpHome, model: FREE_MODEL, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), summary: null, messages: seedMsgs };
  await fs.mkdir(sessDir, { recursive: true });
  await fs.writeFile(path.join(sessDir, 's_seed.json'), JSON.stringify(seed));
  r = await runCli(['chat', '--resume', 's_seed'], { ...menvSess, PE_CONTEXT_LIMIT: '100' }, 'cau hoi moi\n/exit\n');
  const s3 = JSON.parse(await fs.readFile(path.join(sessDir, 's_seed.json'), 'utf8'));
  ok('auto-compact tom tat tin cu, giu 12 tin gan nhat', r.code === 0 && s3.summary && s3.summary.text === 'TOM-TAT-X' && s3.messages.length <= 14, `code=${r.code} summary=${JSON.stringify(s3.summary)} n=${s3.messages.length}`);

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
