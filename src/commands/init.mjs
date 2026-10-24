// `pe init` — wizard cau hinh lan dau: worker URL + proxy secret + model.
// Ghi vao ~/.pe/config.json, chmod 600.
import readline from 'node:readline';
import { DEFAULT_MODEL, DEFAULT_PE_WORKER_URL, loadConfig, normalizeUrl, saveConfig } from '../lib/config.mjs';
import { decodeConnectCode } from '../lib/connect.mjs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { apiFetch } from '../lib/api.mjs';

function ask(rl, q, def) {
  const hint = def ? ` [${def}]` : '';
  return new Promise((resolve) => rl.question(`${q}${hint}: `, (a) => resolve(a.trim() || def || '')));
}

/** Nhap secret ma khong hien len man hinh. */
export function askHidden(q) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(q + ': ');
    let buf = '';
    const done = (val) => {
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(false); } catch {}
      stdin.pause();
      stdout.write('\n');
      resolve(val);
    };
    const onData = (ch) => {
      const s = ch.toString('utf8');
      if (s === '\r' || s === '\n' || s === '\u0004') return done(buf);
      if (s === '\u0003') { stdout.write('\n'); process.exit(130); }
      if (s === '\u007f' || s === '\b') { buf = buf.slice(0, -1); return; }
      if (s >= ' ' && !s.startsWith('\u001b')) buf += s;
    };
    try { stdin.setRawMode(true); } catch {}
    stdin.resume();
    stdin.on('data', onData);
  });
}

export async function runInit(args = []) {
  if (args.includes('--project')) return runProjectInit();
  const codeIdx = args.indexOf('--code');
  if (codeIdx >= 0) return runImportCode(args[codeIdx + 1]);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('— pe init: cấu hình kết nối tới fuco-agent worker —\n');
    const cur = await loadConfig();
    const workerUrl = normalizeUrl(await ask(rl, 'Worker URL (ví dụ https://xxx.workers.dev)', cur.workerUrl || ''));
    rl.close();
    if (!workerUrl) {
      console.error('Huỷ: thiếu worker URL.');
      process.exitCode = 2;
      return;
    }
    const proxySecret = await askHidden('Proxy secret (MY_SECRET trên worker)');
    if (!proxySecret) {
      console.error('Huỷ: thiếu proxy secret.');
      process.exitCode = 2;
      return;
    }
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    const model = await ask(rl2, 'Model mặc định (phải là model :free)', cur.model || DEFAULT_MODEL);
    rl2.close();

    const p = await saveConfig({ workerUrl, proxySecret, model }, undefined);
    console.log(`\nĐã lưu cấu hình vào ${p} (quyền 600, chỉ bạn đọc được).`);

    // Thu ket noi ngay de biet dung/sai lien.
    process.stdout.write('Đang thử kết nối tới worker... ');
    try {
      const data = await apiFetch({ workerUrl, proxySecret, model }, '/api/models', { timeoutMs: 20000 });
      const n = Array.isArray(data?.data) ? data.data.length : 0;
      console.log(`OK — worker trả lời, thấy ${n} model.`);
    } catch (e) {
      console.log(`CHƯA ĐƯỢC: ${e.message}`);
      console.log('Kiểm tra lại URL/secret rồi chạy `pe doctor` để chẩn đoán chi tiết.');
    }
    console.log('\nXong! Thử ngay:  pe ask "xin chào"');
  } catch (e) {
    try { rl.close(); } catch {}
    throw e;
  }
}

const CONTEXT_TEMPLATE = `# Ngữ cảnh project

Viết ở đây những điều pé cần biết về project này: mục đích, stack công nghệ,
quy ước code, lệnh build/test, thư mục quan trọng, điều cần tránh...
Pé sẽ tự nạp file này vào mọi câu hỏi khi bạn dùng pé trong thư mục project
(hoặc thư mục con của nó).
`;

/** `pe init --project` — tao .pe/config.json + .pe/context.md ngay tai project hien tai. */
async function runProjectInit() {
  const cfg = await loadConfig();
  const dir = path.join(process.cwd(), '.pe');
  await fsp.mkdir(dir, { recursive: true });
  const cfgPath = path.join(dir, 'config.json');
  let existed = false;
  try { await fsp.stat(cfgPath); existed = true; } catch { /* chua co */ }
  if (!existed) {
    await fsp.writeFile(cfgPath, JSON.stringify({ model: cfg.model, approval: cfg.approval }, null, 2) + '\n', 'utf8');
    console.log(`Đã tạo ${cfgPath} (model: ${cfg.model}, mức duyệt: ${cfg.approval})`);
  } else {
    console.log(`Đã có sẵn ${cfgPath} — giữ nguyên.`);
  }
  const ctxPath = path.join(dir, 'context.md');
  try {
    await fsp.stat(ctxPath);
    console.log(`Đã có sẵn ${ctxPath} — giữ nguyên.`);
  } catch {
    await fsp.writeFile(ctxPath, CONTEXT_TEMPLATE, 'utf8');
    console.log(`Đã tạo ${ctxPath} — mở ra và viết ngữ cảnh project vào đó.`);
  }
  console.log('\nTừ giờ dùng pé ở thư mục này (hoặc thư mục con) sẽ tự áp dụng cấu hình + ngữ cảnh trên.');
}


/** `pe init --code <PE1...>` — nhap cau hinh tu ma ket noi (Goi A1). */
async function runImportCode(code) {
  if (!code) {
    console.error('Thiếu mã kết nối. Dùng: pe init --code <PE1...>');
    process.exitCode = 2;
    return;
  }
  const password = process.env.PE_CONNECT_PASSWORD || (await askHidden('Mật khẩu của mã kết nối'));
  let data;
  try {
    data = decodeConnectCode(code, password);
  } catch (e) {
    console.error(`Không giải mã được: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const p = await saveConfig({
    workerUrl: data.workerUrl || '',
    peWorkerUrl: data.peWorkerUrl || DEFAULT_PE_WORKER_URL,
    proxySecret: data.proxySecret || '',
    model: data.model || DEFAULT_MODEL,
    approval: [1, 2, 3].includes(Number(data.approval)) ? Number(data.approval) : 2,
  });
  console.log(`Đã nhập cấu hình từ mã kết nối vào ${p} (worker: ${data.workerUrl}, model: ${data.model || DEFAULT_MODEL}).`);
  process.stdout.write('Đang thử kết nối tới worker... ');
  try {
    const { apiFetch } = await import('../lib/api.mjs');
    const d = await apiFetch({ workerUrl: data.workerUrl, proxySecret: data.proxySecret }, '/api/models', { timeoutMs: 20000 });
    console.log(`OK — thấy ${Array.isArray(d?.data) ? d.data.length : 0} model. Xong, dùng ngay được!`);
  } catch (e) {
    console.log(`CHƯA ĐƯỢC: ${e.message}`);
  }
}
