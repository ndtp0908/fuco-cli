// `pe init` — wizard cau hinh lan dau: worker URL + proxy secret + model.
// Ghi vao ~/.pe/config.json, chmod 600.
import readline from 'node:readline';
import { DEFAULT_MODEL, loadConfig, normalizeUrl, saveConfig } from '../lib/config.mjs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { apiFetch } from '../lib/api.mjs';

function ask(rl, q, def) {
  const hint = def ? ` [${def}]` : '';
  return new Promise((resolve) => rl.question(`${q}${hint}: `, (a) => resolve(a.trim() || def || '')));
}

/** Nhap secret ma khong hien len man hinh. */
function askHidden(q) {
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

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('— pe init: cau hinh ket noi toi fuco-agent worker —\n');
    const cur = await loadConfig();
    const workerUrl = normalizeUrl(await ask(rl, 'Worker URL (vi du https://xxx.workers.dev)', cur.workerUrl || ''));
    rl.close();
    if (!workerUrl) {
      console.error('Huy: thieu worker URL.');
      process.exitCode = 2;
      return;
    }
    const proxySecret = await askHidden('Proxy secret (MY_SECRET tren worker)');
    if (!proxySecret) {
      console.error('Huy: thieu proxy secret.');
      process.exitCode = 2;
      return;
    }
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    const model = await ask(rl2, 'Model mac dinh (phai la model :free)', cur.model || DEFAULT_MODEL);
    rl2.close();

    const p = await saveConfig({ workerUrl, proxySecret, model }, undefined);
    console.log(`\nDa luu cau hinh vao ${p} (quyen 600, chi ban doc duoc).`);

    // Thu ket noi ngay de biet dung/sai lien.
    process.stdout.write('Dang thu ket noi toi worker... ');
    try {
      const data = await apiFetch({ workerUrl, proxySecret, model }, '/api/models', { timeoutMs: 20000 });
      const n = Array.isArray(data?.data) ? data.data.length : 0;
      console.log(`OK — worker tra loi, thay ${n} model.`);
    } catch (e) {
      console.log(`CHUA DUOC: ${e.message}`);
      console.log('Kiem tra lai URL/secret roi chay `pe doctor` de chan doan chi tiet.');
    }
    console.log('\nXong! Thu ngay:  pe ask "xin chao"');
  } catch (e) {
    try { rl.close(); } catch {}
    throw e;
  }
}

const CONTEXT_TEMPLATE = `# Ngu canh project

Viet o day nhung dieu pe can biet ve project nay: muc dich, stack cong nghe,
quy uoc code, lenh build/test, thu muc quan trong, dieu can tranh...
Pe se tu nap file nay vao moi cau hoi khi ban dung pe trong thu muc project
(hoac thu muc con cua no).
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
    console.log(`Da tao ${cfgPath} (model: ${cfg.model}, muc duyet: ${cfg.approval})`);
  } else {
    console.log(`Da co san ${cfgPath} — giu nguyen.`);
  }
  const ctxPath = path.join(dir, 'context.md');
  try {
    await fsp.stat(ctxPath);
    console.log(`Da co san ${ctxPath} — giu nguyen.`);
  } catch {
    await fsp.writeFile(ctxPath, CONTEXT_TEMPLATE, 'utf8');
    console.log(`Da tao ${ctxPath} — mo ra va viet ngu canh project vao do.`);
  }
  console.log('\nTu gio dung pe o thu muc nay (hoac thu muc con) se tu ap dung cau hinh + ngu canh tren.');
}

