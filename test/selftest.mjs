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
        if (req.url === '/pe-update.json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ version: '99.0.0', exeUrl: '', sha256: '', size: 0 }));
        }
        // --- mock pe-worker (hang doi KV) ---
        if (req.url === '/task' || req.url.startsWith('/result/') || req.url === '/pending' || req.url === '/processing') {
          if (req.headers['x-agent-secret'] !== SECRET) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end('<html><head><title>404 Not Found</title></head><body>Not Found</body></html>');
          }
          if (req.url === '/task' && req.method === 'POST') {
            const id = 't_mock123456';
            let parsedTask = null;
            try { parsedTask = JSON.parse(body); } catch {}
            const q = parsedTask?.input?.question || '';
            const result = q.includes('APPLY-TEST')
              ? { answer: 'da sua xong', files: [{ path: 'out.txt', content: 'APPLIED-CONTENT' }] }
              : { answer: 'MOCK-ANSWER' };
            mockTasks.set(id, { id, status: 'done', result });
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
          return res.end(JSON.stringify({ data: [{ id: FREE_MODEL }, { id: 'pro-model' }, { id: 'vis-model:free', architecture: { input_modalities: ['text', 'image'] } }] }));
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
          if (m === 'flaky-model:free') {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: { message: 'Rate limit exceeded' } }));
          }
          let reply = 'MOCK-REPLY-OK';
          if (sysText.includes('Bạn tóm tắt cuộc hội thoại')) {
            reply = 'TOM-TAT-X';
          } else 
          if (sysText.includes('công cụ sửa file')) {
            const mm = String(lastContent || '').match(/```\n([\s\S]*?)\n```/);
            const fc = mm ? mm[1] : '';
            reply = '```\n' + fc.replace('ORIGINAL', 'EDITED') + '\n```';
          } else if (allText.includes('LOOP-TASK')) {
            // Lap that: luc nao cung goi dung 1 tool giong het -> agent phai
            // tu phat hien lap va dung sau stallLimit lan trung.
            reply = '```json\n{"tool": "read_file", "args": {"path": "a.txt"}}\n```';
          } else if (allText.includes('PAGE-TASK')) {
            // Doc file dai theo doan: lan dau doc tu dau, cac lan sau doc
            // tiep theo "start" o footer cua ket qua tool gan nhat; doc
            // het (thay dong cuoi) thi tra loi xong.
            const lastStr = typeof lastContent === 'string' ? lastContent : '';
            const foot = lastStr.match(/Đọc tiếp: read_file \{"path": "big\.txt", "start": (\d+)\}/);
            if (foot) {
              reply = '```json\n' + JSON.stringify({ tool: 'read_file', args: { path: 'big.txt', start: Number(foot[1]) } }) + '\n```';
            } else if (lastStr.includes('LINE-2500')) {
              reply = 'PAGE-DONE';
            } else {
              reply = '```json\n{"tool": "read_file", "args": {"path": "big.txt"}}\n```';
            }
          } else if (allText.includes('Ket qua tool') && allText.includes('Đã sửa')) {
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
          // --- v0.8 lessons: distill + may trang thai loi->sua->xong ---
          if (sysText.includes('PE-DISTILL')) {
            reply = JSON.stringify([{ loi: 'Chay lenh false lam hong buoc sau', gocRe: 'Khong kiem tra exit code cua lenh truoc', lanSau: 'Kiem tra Exit: 0 sau moi lenh quan trong truoc khi lam tiep', tag: 'run_bash', scope: 'project' }]);
          }
          if (sysText.includes('Kiem tra Exit: 0 sau moi lenh quan trong')) reply = 'LESSON-INJECTED-OK';
          {
            // May trang thai LESSON: marker nam o tin user DAU (allText),
            // con trang thai Exit chi doc o tin CUOI (lastStr).
            const lastStr = typeof lastContent === 'string' ? lastContent : '';
            const hasMarker = allText.includes('LESSON-TASK') || allText.includes('LESSONCHAT');
            if (hasMarker && !sysText.includes('PE-DISTILL')) {
              if (lastStr.includes('Ket qua tool') && lastStr.includes('Exit: 0')) reply = 'LESSON-DONE';
              else if (lastStr.includes('Ket qua tool') && lastStr.includes('Exit: 1')) reply = '```json\n{"tool":"run_bash","args":{"command":"true"}}\n```';
              else if (!lastStr.includes('Ket qua tool')) reply = '```json\n{"tool":"run_bash","args":{"command":"false"}}\n```';
            }
          }
          // --- v0.9 tu chua: HEAL (model bo cuoc) + VERIFY + EDIT-RETRY ---
          {
            const lastStr2 = typeof lastContent === 'string' ? lastContent : '';
            if (lastStr2.includes('Vẫn còn lỗi chưa được xử lý')) {
              reply = '```json\n{"tool":"run_bash","args":{"command":"true"}}\n```';
            } else if (lastStr2.includes('HEAL-TASK')) {
              reply = '```json\n{"tool":"run_bash","args":{"command":"false"}}\n```';
            } else if (lastStr2.includes('Ket qua tool') && lastStr2.includes('Exit: 1') && allText.includes('HEAL-TASK')) {
              reply = 'GIVE-UP-TEXT';
            } else if (lastStr2.includes('Ket qua tool') && lastStr2.includes('Exit: 0') && allText.includes('HEAL-TASK')) {
              reply = 'HEAL-DONE';
            }
            if (lastStr2.includes('Lệnh kiểm chứng')) {
              reply = '```json\n{"tool":"write_file","args":{"path":"vdone.txt","content":"ok"}}\n```';
            } else if (lastStr2.includes('VERIFY-TASK')) {
              reply = 'WORK-DONE';
            } else if (lastStr2.includes('Ket qua tool') && allText.includes('Lệnh kiểm chứng')) {
              reply = 'FIXED-DONE';
            }
            if (sysText.includes('công cụ sửa file') && allText.includes('EDIT-RETRY-MARK')) {
              reply = allText.includes('trả về lại TOÀN BỘ')
                ? '```\nEDITED-LINE\n```'
                : 'GARBAGE-KHONG-DINH-DANG';
            }
          }
          if (parsed?.web === true) reply = 'WEB-FLAG-OK';
          if (parsed?.readUrl === 'https://example.com/bai-viet') reply = 'URL-FLAG-OK';
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
  ok('lenh la -> exit 2', r.code === 2 && r.err.includes('Lệnh lạ'), `code=${r.code}`);
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
  ok('sai secret -> bao 404 gia/auth', r.code === 1 && r.err.includes('404 giả'), `code=${r.code} err=${r.err.slice(0, 80)}`);

  r = await runCli(['ask', 'hi'], { ...menv, PE_WORKER_URL: 'http://127.0.0.1:1' });
  ok('worker khong toi duoc -> loi network', r.code === 1 && r.err.includes('Không nối được'), `code=${r.code}`);

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
  ok('ask --file khong ton tai -> loi ro rang', r.code === 2 && r.err.includes('Không tìm thấy'), `code=${r.code} err=${r.err.slice(0, 80)}`);

  // 7. help chi tiet tung lenh
  r = await runCli(['help', 'ask'], { PE_HOME: tmpHome });
  ok('pe help ask co --file/--image + vi du', r.code === 0 && r.out.includes('--image') && r.out.includes('Ví dụ'), `code=${r.code}`);
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

  // 14b. phat hien lap theo tien trien (v0.6): lap that thi dung som,
  // doc file dai phan trang thi KHONG bi cat ngang nhu ban cu (maxSteps 14)
  const projLoop = path.join(tmpHome, 'proj-loop');
  await fs.mkdir(projLoop, { recursive: true });
  await fs.writeFile(path.join(projLoop, 'a.txt'), 'LOOPFILE-CONTENT');
  r = await runCli(['do', 'LOOP-TASK doc a.txt'], { ...menv, PE_APPROVAL: '3' }, '', { cwd: projLoop });
  const loopCalls = (r.out.match(/đọc file a\.txt/g) || []).length;
  ok('agent tu phat hien lap that va dung som (<=6 luot goi trung)', r.code === 0 && r.out.includes('Phát hiện vòng lặp') && loopCalls > 0 && loopCalls <= 6, `code=${r.code} calls=${loopCalls} out=${r.out.slice(0, 140)}`);

  const projPage = path.join(tmpHome, 'proj-page');
  await fs.mkdir(projPage, { recursive: true });
  const bigLines = [];
  for (let i = 1; i <= 2500; i++) bigLines.push(`LINE-${i} ${'x'.repeat(50)}`);
  await fs.writeFile(path.join(projPage, 'big.txt'), bigLines.join('\n'));
  r = await runCli(['do', 'PAGE-TASK doc het big.txt'], { ...menv, PE_APPROVAL: '3' }, '', { cwd: projPage });
  const pageCalls = (r.out.match(/đọc file big\.txt/g) || []).length;
  ok('doc file 2500 dong phan trang chay het, khong bao lap oan', r.code === 0 && r.out.includes('PAGE-DONE') && !r.out.includes('Phát hiện vòng lặp') && pageCalls >= 5, `code=${r.code} calls=${pageCalls} out=${r.out.slice(0, 140)}`);

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
  ok('pe tasks chay duoc', r.code === 0 && r.out.includes('Hàng đợi'), `code=${r.code} out=${r.out.slice(0, 80)}`);

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
    // v0.10: sessions rm
    r = await runCli(['sessions', 'rm', 's_khong_co'], menvSess, '');
    const badRm = r.code === 2;
    r = await runCli(['sessions', 'rm', s2.id], menvSess, '');
    let afterRm = [];
    try { afterRm = await fs.readdir(sessDir); } catch {}
    ok('v0.10: sessions rm xoa dung phien + id la -> exit 2', badRm && r.code === 0 && r.out.includes('Đã xoá phiên') && afterRm.length === 0, `code=${r.code} files=${afterRm.length} out=${r.out.slice(0, 80)}`);
  }

  // 16b. v0.10: pe config — xem/set ngay trong CLI
  {
    const cfgHome = path.join(tmpHome, 'cfg-home');
    const cenv = { PE_HOME: cfgHome };
    r = await runCli(['config', 'set', 'model', 'x/test:free'], cenv, '');
    const setOk = r.code === 0;
    r = await runCli(['config', 'get', 'model'], cenv, '');
    const getOk = r.out.includes('x/test:free');
    r = await runCli(['config', 'set', 'approval', '9'], cenv, '');
    const badOk = r.code === 2;
    r = await runCli(['config'], cenv, '');
    ok('v0.10: pe config set/get + tong quan + chan gia tri sai', setOk && getOk && badOk && r.out.includes('Cấu hình toàn cục'), `set=${setOk} get=${getOk} bad=${badOk} out=${r.out.slice(0, 80)}`);
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

  // 18. Goi A1: connect export -> init --code o home moi
  r = await runCli(['connect', 'export'], { ...menv, PE_CONNECT_PASSWORD: 'matkhau1' });
  const codeM = /(PE1\.[A-Za-z0-9_-]+)/.exec(r.out);
  ok('connect export tao ma PE1.', r.code === 0 && !!codeM, `code=${r.code} out=${r.out.slice(0, 80)}`);
  if (codeM) {
    const homeB = path.join(tmpHome, 'home-b');
    r = await runCli(['init', '--code', codeM[1]], { PE_HOME: homeB, PE_CONNECT_PASSWORD: 'matkhau1' });
    let cfgB = null;
    try { cfgB = JSON.parse(await fs.readFile(path.join(homeB, '.pe', 'config.json'), 'utf8')); } catch {}
    ok('init --code nhap dung cau hinh (worker+secret+model)', r.code === 0 && cfgB && cfgB.workerUrl === mockUrl && cfgB.proxySecret === SECRET, `code=${r.code} cfg=${JSON.stringify(cfgB).slice(0, 100)}`);
    r = await runCli(['init', '--code', codeM[1]], { PE_HOME: path.join(tmpHome, 'home-c'), PE_CONNECT_PASSWORD: 'sai-roi' });
    ok('init --code sai mat khau bi chan', r.code === 1, `code=${r.code}`);
  }

  // 19. Goi B: fallback khi model chinh bi 429
  r = await runCli(['ask', 'hi'], { ...menv, PE_MODEL: 'flaky-model:free', PE_FALLBACK_MODELS: FREE_MODEL });
  ok('ask tu chuyen model du phong khi 429', r.code === 0 && r.out.includes('MOCK-REPLY-OK') && r.err.includes('dự phòng'), `code=${r.code} out=${r.out.slice(0, 60)} err=${r.err.slice(0, 80)}`);

  // 20. model list --vision
  r = await runCli(['model', 'list', '--vision'], menv);
  ok('model list --vision loc dung + tag [vision]', r.code === 0 && r.out.includes('vis-model:free') && r.out.includes('[vision]') && !r.out.includes(FREE_MODEL), `out=${r.out.slice(0, 100)}`);

  // 21. Goi A2: update --check thay ban moi
  r = await runCli(['update', '--check'], { ...menv, PE_UPDATE_URL: mockUrl + '/pe-update.json' });
  ok('update --check bao co ban moi 99.0.0', r.code === 0 && r.out.includes('99.0.0'), `code=${r.code} out=${r.out.slice(0, 100)}`);

  // 22. Goi A3: result --apply ghi file tu ket qua assign
  const projApply = path.join(tmpHome, 'proj-apply');
  await fs.mkdir(projApply, { recursive: true });
  r = await runCli(['assign', 'APPLY-TEST sua file'], menvKV);
  const mId2 = /t_[a-z0-9]+/.exec(r.out);
  if (mId2) {
    r = await runCli(['result', mId2[0], '--apply', '--yes'], menvKV, '', { cwd: projApply });
    let applied = '';
    try { applied = await fs.readFile(path.join(projApply, 'out.txt'), 'utf8'); } catch {}
    ok('result --apply ghi file APPLIED-CONTENT', r.code === 0 && applied === 'APPLIED-CONTENT', `code=${r.code} file=${applied} out=${r.out.slice(0, 100)}`);
  } else {
    ok('result --apply ghi file APPLIED-CONTENT', false, 'khong lay duoc task id');
  }

  // 23. Goi C: rules install + export + context tu .muserules
  const projRules = path.join(tmpHome, 'proj-rules');
  await fs.mkdir(projRules, { recursive: true });
  r = await runCli(['rules', 'install'], menv, '', { cwd: projRules });
  let rulesText = '';
  try { rulesText = await fs.readFile(path.join(projRules, '.muserules'), 'utf8'); } catch {}
  ok('rules install cai PE-CLINE-PACK', r.code === 0 && rulesText.includes('PE-CLINE-PACK'), `code=${r.code}`);
  r = await runCli(['init', '--project'], menv, '', { cwd: projRules });
  r = await runCli(['rules', 'export'], menv, '', { cwd: projRules });
  try { rulesText = await fs.readFile(path.join(projRules, '.muserules'), 'utf8'); } catch {}
  ok('rules export dong bo context.md sang .muserules', r.code === 0 && rulesText.includes('Ngữ cảnh project'), `code=${r.code}`);
  const projRules2 = path.join(tmpHome, 'proj-rules2');
  await fs.mkdir(projRules2, { recursive: true });
  await fs.writeFile(path.join(projRules2, '.muserules'), 'Quy tac rieng: CTX-MARKER-123');
  r = await runCli(['ask', 'hi'], menv, '', { cwd: projRules2 });
  ok('ask tu nap ca .muserules lam ngu canh', r.code === 0 && r.out.includes('CTX-OK'), `code=${r.code} out=${r.out.slice(0, 60)}`);

  // 24. Goi C7: chat tu noi phien theo project (cung cwd)
  const projSess = path.join(tmpHome, 'proj-sess');
  await fs.mkdir(projSess, { recursive: true });
  r = await runCli(['chat', '--new'], menvSess, 'cau mot\n/exit\n', { cwd: projSess });
  r = await runCli(['chat'], menvSess, 'cau hai\n/exit\n', { cwd: projSess });
  const sessFiles2 = (await fs.readdir(sessDir)).filter((f) => f.endsWith('.json'));
  let resumedOk = false;
  for (const f of sessFiles2) {
    const sj = JSON.parse(await fs.readFile(path.join(sessDir, f), 'utf8'));
    if (sj.cwd === projSess && sj.messages.length === 4) resumedOk = true;
  }
  ok('chat tu noi phien cua project (4 tin, khong tao phien thua)', r.code === 0 && resumedOk, `code=${r.code} files=${sessFiles2.length}`);

  // 25. De xuat 3: backup -> restore sang home moi
  const bakFile = path.join(tmpHome, 'test.pebak');
  r = await runCli(['backup', '--out', bakFile], { ...menvSess, PE_BACKUP_PASSWORD: 'pw-backup-1' });
  let bakOk = false;
  try { bakOk = (await fs.readFile(bakFile, 'utf8')).startsWith('PE1.'); } catch {}
  ok('backup tao file .pebak ma hoa', r.code === 0 && bakOk, `code=${r.code} out=${r.out.slice(0, 80)}`);
  const homeR = path.join(tmpHome, 'home-restore');
  r = await runCli(['restore', bakFile, '--force'], { PE_HOME: homeR, PE_BACKUP_PASSWORD: 'pw-backup-1' });
  let restoredCfg = null;
  try { restoredCfg = JSON.parse(await fs.readFile(path.join(homeR, '.pe', 'config.json'), 'utf8')); } catch {}
  let restoredSessions = 0;
  try { restoredSessions = (await fs.readdir(path.join(homeR, '.pe', 'sessions'))).filter((f) => f.endsWith('.json')).length; } catch {}
  ok('restore khoi phuc config + phien', r.code === 0 && restoredCfg?.proxySecret === SECRET && restoredSessions >= 1, `code=${r.code} sessions=${restoredSessions} out=${r.out.slice(0, 80)}`);
  r = await runCli(['restore', bakFile, '--force'], { PE_HOME: homeR, PE_BACKUP_PASSWORD: 'sai-pass' });
  ok('restore sai mat khau bi chan', r.code === 1, `code=${r.code}`);

  // 25b. grep bo ngoac boc + dong thoi gian chen system prompt (v0.6)
  {
    const { normalizeGrepPattern } = await import('../src/lib/tools.mjs');
    ok('grep bo ngoac kep boc ngoai', normalizeGrepPattern('"abc"') === 'abc', normalizeGrepPattern('"abc"'));
    ok('grep bo ngoac don boc ngoai', normalizeGrepPattern("'a b'") === 'a b', normalizeGrepPattern("'a b'"));
    ok('grep giu nguyen pattern co ngoac ben trong', normalizeGrepPattern('"a"b"') === '"a"b"', normalizeGrepPattern('"a"b"'));
    ok('grep giu nguyen pattern thuong', normalizeGrepPattern('a"b') === 'a"b', normalizeGrepPattern('a"b'));
    const { currentTimeLine } = await import('../src/lib/now.mjs');
    const tl = currentTimeLine(new Date(2026, 9, 23, 15, 4));
    ok('currentTimeLine co ngay/thang/nam dung', tl.includes('23/10/2026') && tl.includes('Thời gian hiện tại'), tl.slice(0, 80));
  }

  // 26. Goi y chung chi tu ky khi mang cong ty chan TLS
  {
    const { certHint } = await import('../src/lib/api.mjs');
    const e = new Error('x');
    e.cause = { code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'self-signed certificate in certificate chain' };
    ok('certHint bao NODE_EXTRA_CA_CERTS khi gap SELF_SIGNED_CERT_IN_CHAIN', certHint(e).includes('NODE_EXTRA_CA_CERTS'), certHint(e).slice(0, 60));
    ok('certHint rong voi loi thuong', certHint(new Error('boom')) === '', 'phai la chuoi rong');
  }

  // 27. --web: co web:true gui len worker (v0.7, WEB1)
  r = await runCli(['ask', '--web', 'WEB-TASK tin moi nhat'], menv);
  ok('ask --web gui web:true len worker', r.code === 0 && r.out.includes('WEB-FLAG-OK'), `code=${r.code} out=${r.out.slice(0, 80)}`);
  r = await runCli(['ask', 'WEB-TASK tin moi nhat'], menv);
  ok('ask khong --web thi khong co co web', r.code === 0 && r.out.includes('MOCK-REPLY-OK') && !r.out.includes('WEB-FLAG-OK'), `code=${r.code} out=${r.out.slice(0, 80)}`);
  r = await runCli(['chat'], menv, '/web on\nWEBCHAT cau hoi web\n/exit\n', { cwd: projChat });
  ok('chat /web on -> luot hoi co web:true', r.code === 0 && r.out.includes('Tìm kiếm web: BẬT') && r.out.includes('WEB-FLAG-OK'), `code=${r.code} out=${r.out.slice(0, 160)}`);
  r = await runCli(['do', 'WEBDO viec can web', '--web'], { ...menv, PE_APPROVAL: '3' }, '', { cwd: projLoop });
  ok('do --web gui web:true o lan goi dau', r.code === 0 && r.out.includes('WEB-FLAG-OK'), `code=${r.code} out=${r.out.slice(0, 120)}`);

  // 27b. Doc link (v0.11, URL1): dan link trong cau -> tu gui readUrl
  {
    const { extractFirstUrl } = await import('../src/lib/attach.mjs');
    ok('extractFirstUrl lay link giua cau', extractFirstUrl('doc trang https://example.com/bai-viet giup toi') === 'https://example.com/bai-viet', extractFirstUrl('doc trang https://example.com/bai-viet giup toi'));
    ok('extractFirstUrl cat dau cham cuoi cau', extractFirstUrl('xem https://a.b/c.') === 'https://a.b/c', extractFirstUrl('xem https://a.b/c.'));
    ok('extractFirstUrl khong link -> null', extractFirstUrl('khong co link nao') === null, 'phai null');
  }
  r = await runCli(['ask', 'doc trang https://example.com/bai-viet tom tat giup'], menv);
  ok('ask dan link -> gui readUrl len worker', r.code === 0 && r.out.includes('URL-FLAG-OK'), `code=${r.code} out=${r.out.slice(0, 80)}`);
  r = await runCli(['ask', 'cau hoi khong co link'], menv);
  ok('ask khong link -> khong co readUrl', r.code === 0 && r.out.includes('MOCK-REPLY-OK') && !r.out.includes('URL-FLAG-OK'), `code=${r.code} out=${r.out.slice(0, 80)}`);

  // 28. Lessons (v0.8): agent loi->sua->xong, distill, duyet y moi luu,
  // phien sau tu nap lai; dedup tang x2; pe lessons list/rm; /lesson.
  const projLesson = await fs.mkdtemp(path.join(os.tmpdir(), 'pe-proj-lesson-'));
  await fs.mkdir(path.join(projLesson, '.pe'), { recursive: true });
  await fs.writeFile(path.join(projLesson, '.pe', 'context.md'), 'LESSONCTX project\n');
  const lessonFile = path.join(projLesson, '.pe', 'lessons.md');
  r = await runCli(['do', 'LESSON-TASK sua loi build', '--yolo'], menv, 'y\n', { cwd: projLesson });
  let lessonText = '';
  try { lessonText = await fs.readFile(lessonFile, 'utf8'); } catch { /* chua co */ }
  ok('do loi->sua->xong: de xuat bai hoc + duyet y thi luu file', r.code === 0 && r.out.includes('Đã lưu bài học mới') && lessonText.includes('Kiem tra Exit: 0 sau moi lenh quan trong'), `code=${r.code} out=${r.out.slice(-300)} file=${lessonText.slice(0, 120)}`);
  r = await runCli(['ask', 'hoi thu xem'], menv, '', { cwd: projLesson });
  ok('phien sau: bai hoc tu nap vao system prompt', r.code === 0 && r.out.includes('LESSON-INJECTED-OK'), `code=${r.code} out=${r.out.slice(0, 120)}`);
  r = await runCli(['do', 'LESSON-TASK sua loi build', '--yolo'], menv, 'y\n', { cwd: projLesson });
  lessonText = await fs.readFile(lessonFile, 'utf8');
  ok('gap lai loi tuong tu: dedup gop 1 bai hoc thanh x2', r.code === 0 && lessonText.includes('x2') && (lessonText.match(/^## /gm) || []).length === 1, `file=${lessonText.slice(0, 200)}`);
  r = await runCli(['lessons'], menv, '', { cwd: projLesson });
  ok('pe lessons liet ke duoc bai hoc', r.code === 0 && r.out.includes('Kiem tra Exit: 0 sau moi lenh quan trong'), `code=${r.code}`);
  r = await runCli(['lessons', 'rm', 'project', '1'], menv, '', { cwd: projLesson });
  ok('pe lessons rm xoa duoc', r.code === 0 && r.out.includes('Đã xoá bài học'), `code=${r.code} out=${r.out.slice(0, 100)}`);
  lessonText = await fs.readFile(lessonFile, 'utf8');
  ok('sau rm: file khong con bai hoc do', !lessonText.includes('Kiem tra Exit: 0 sau moi lenh quan trong'), '');

  const projChatLesson = await fs.mkdtemp(path.join(os.tmpdir(), 'pe-proj-chatlesson-'));
  await fs.mkdir(path.join(projChatLesson, '.pe'), { recursive: true });
  await fs.writeFile(path.join(projChatLesson, '.pe', 'context.md'), 'CHATLESSONCTX\n');
  r = await runCli(['chat'], menv, '/lesson Khong dung ham X nua\n/exit\n', { cwd: projChatLesson });
  let chatLessonText = '';
  try { chatLessonText = await fs.readFile(path.join(projChatLesson, '.pe', 'lessons.md'), 'utf8'); } catch { /* chua co */ }
  ok('chat /lesson ghi tay luu ngay', r.code === 0 && r.out.includes('Đã lưu bài học') && chatLessonText.includes('Khong dung ham X nua'), `code=${r.code} out=${r.out.slice(0, 200)}`);

  const projChatRev = await fs.mkdtemp(path.join(os.tmpdir(), 'pe-proj-chatrev-'));
  await fs.mkdir(path.join(projChatRev, '.pe'), { recursive: true });
  await fs.writeFile(path.join(projChatRev, '.pe', 'context.md'), 'CHATREVCTX\n');
  r = await runCli(['chat'], { ...menv, PE_APPROVAL: '3' }, 'LESSONCHAT lam viec\ny\n/exit\n', { cwd: projChatRev });
  let revText = '';
  try { revText = await fs.readFile(path.join(projChatRev, '.pe', 'lessons.md'), 'utf8'); } catch { /* chua co */ }
  ok('chat: agent loi->sua xong thi de xuat bai hoc, go y la luu', r.code === 0 && r.out.includes('Bài học đề xuất') && r.out.includes('Đã lưu bài học') && revText.includes('Kiem tra Exit: 0 sau moi lenh quan trong'), `code=${r.code} out=${r.out.slice(-400)} file=${revText.slice(0, 120)}`);

  // 29. Tu chua (v0.9): heal khi model bo cuoc, edit thu lai, --verify.
  const projHeal = await fs.mkdtemp(path.join(os.tmpdir(), 'pe-proj-heal-'));
  r = await runCli(['do', 'HEAL-TASK chay thu', '--yolo'], menv, 'n\n', { cwd: projHeal });
  ok('agent bo cuoc khi con loi: heal tu them luot sua -> xong', r.code === 0 && r.out.includes('[tự chữa]') && r.out.includes('HEAL-DONE'), `code=${r.code} out=${r.out.slice(-260)}`);

  const projEditRetry = await fs.mkdtemp(path.join(os.tmpdir(), 'pe-proj-editretry-'));
  await fs.writeFile(path.join(projEditRetry, 'code.txt'), 'ORIGINAL-LINE\n');
  r = await runCli(['edit', 'code.txt', 'EDIT-RETRY-MARK sua dong nay', '--yes'], menv, '', { cwd: projEditRetry });
  const afterRetry = await fs.readFile(path.join(projEditRetry, 'code.txt'), 'utf8');
  ok('pe edit: lan 1 sai dinh dang -> thu lai lan 2 thanh cong', r.code === 0 && r.out.includes('thử lại 1 lần') && afterRetry.includes('EDITED-LINE'), `code=${r.code} out=${r.out.slice(0, 220)} file=${afterRetry.slice(0, 40)}`);

  const projVerify = await fs.mkdtemp(path.join(os.tmpdir(), 'pe-proj-verify-'));
  r = await runCli(['do', 'VERIFY-TASK lam viec', '--yolo', '--verify', 'test -f vdone.txt'], menv, '', { cwd: projVerify });
  let vExists = false;
  try { await fs.stat(path.join(projVerify, 'vdone.txt')); vExists = true; } catch { /* chua co */ }
  ok('do --verify: fail -> agent sua -> chay lai PASS', r.code === 0 && r.out.includes('[kiểm chứng] PASS') && vExists, `code=${r.code} out=${r.out.slice(-260)}`);
  r = await runCli(['do', 'VERIFY-TASK lam viec', '--yolo', '--verify', 'false'], menv, '', { cwd: projVerify });
  ok('do --verify: sua 2 vong van fail -> exit 1', r.code === 1 && r.out.includes('Vẫn FAIL sau 2 vòng sửa'), `code=${r.code} out=${r.out.slice(-220)}`);

  r = await runCli(['doctor'], menv);
  ok('doctor voi mock worker -> exit 0', r.code === 0 && r.out.includes('Tất cả đều ổn'), `code=${r.code}`);

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
