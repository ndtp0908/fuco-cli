// `pe backup` / `pe restore` — dong goi TOAN BO trang thai pe (cau hinh +
// cac phien chat + danh sach viec da giao) thanh 1 file ma hoa bang mat khau,
// mang sang may moi la khoi phuc duoc nguyen trang (De xuat 3).
// File .pebak chi la chuoi ma PE1.... (cung bo ma hoa voi ma ket noi).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { configDir, configPath } from '../lib/config.mjs';
import { sessionsDir } from '../lib/session.mjs';
import { encodeConnectCode, decodeConnectCode } from '../lib/connect.mjs';
import { askHidden } from './init.mjs';

async function readJsonSafe(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return null; }
}

function backupPassword() {
  return process.env.PE_BACKUP_PASSWORD || process.env.PE_CONNECT_PASSWORD || '';
}

export async function runBackup(args = []) {
  const home = process.env.PE_HOME || undefined;
  const dir = configDir(home);
  const cfg = await readJsonSafe(configPath(home));
  if (!cfg) {
    console.error('Chua co cau hinh de backup — chay `pe init` truoc.');
    process.exitCode = 2;
    return;
  }
  // Cac phien chat
  const sessions = {};
  try {
    for (const f of await fs.readdir(sessionsDir(home))) {
      if (!f.endsWith('.json')) continue;
      const s = await readJsonSafe(path.join(sessionsDir(home), f));
      if (s && s.id) sessions[s.id] = s;
    }
  } catch { /* chua co phien nao */ }
  const assigned = await readJsonSafe(path.join(dir, 'assigned.json'));

  const bundle = {
    kind: 'pe-backup',
    v: 1,
    createdAt: new Date().toISOString(),
    config: cfg,
    sessions,
    assigned: assigned || [],
  };
  const password = backupPassword() || (await askHidden('Dat mat khau cho file backup (it nhat 4 ky tu)'));
  let code;
  try {
    code = encodeConnectCode(bundle, password);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
    return;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const outIdx = args.indexOf('--out');
  const outPath = path.resolve(outIdx >= 0 ? args[outIdx + 1] : `pe-backup-${stamp}.pebak`);
  await fs.writeFile(outPath, code + '\n', 'utf8');
  const kb = Math.round(Buffer.byteLength(code) / 1024);
  console.log(`Da backup vao ${outPath} (${kb} KB): cau hinh + ${Object.keys(sessions).length} phien chat + ${bundle.assigned.length} viec da giao.`);
  console.log('De file nay len Drive/thu muc an toan — sang may moi chay: pe restore <file>');
}

export async function runRestore(args = []) {
  const file = args.find((a) => !a.startsWith('-'));
  if (!file) {
    console.error('Dung: pe restore <file.pebak> [--force]');
    process.exitCode = 2;
    return;
  }
  let code;
  try {
    code = (await fs.readFile(path.resolve(file), 'utf8')).trim();
  } catch {
    console.error(`Khong doc duoc file ${file}.`);
    process.exitCode = 2;
    return;
  }
  const password = backupPassword() || (await askHidden('Mat khau cua file backup'));
  let bundle;
  try {
    bundle = decodeConnectCode(code, password);
  } catch (e) {
    console.error(`Khong giai ma duoc: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  if (bundle?.kind !== 'pe-backup' || !bundle.config) {
    console.error('File nay khong phai backup cua pe (thieu config).');
    process.exitCode = 1;
    return;
  }
  const home = process.env.PE_HOME || undefined;
  const dir = configDir(home);
  const force = args.includes('--force');
  const existing = await readJsonSafe(configPath(home));
  if (existing && !force) {
    console.error('May nay DA co cau hinh pe — restore se ghi de. Them --force neu chac chan.');
    process.exitCode = 2;
    return;
  }
  await fs.mkdir(sessionsDir(home), { recursive: true });
  await fs.writeFile(configPath(home), JSON.stringify(bundle.config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  let n = 0;
  for (const s of Object.values(bundle.sessions || {})) {
    if (s?.id) {
      await fs.writeFile(path.join(sessionsDir(home), `${s.id}.json`), JSON.stringify(s, null, 2) + '\n', 'utf8');
      n++;
    }
  }
  if (Array.isArray(bundle.assigned)) {
    await fs.writeFile(path.join(dir, 'assigned.json'), JSON.stringify(bundle.assigned, null, 2) + '\n', 'utf8');
  }
  console.log(`Da khoi phuc: cau hinh (worker ${bundle.config.workerUrl || '?'}, model ${bundle.config.model || '?'}) + ${n} phien chat. Backup tao luc ${bundle.createdAt}.`);
  console.log('Kiem tra lai bang: pe doctor');
}
