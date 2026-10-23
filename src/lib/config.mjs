// Quan ly cau hinh pe: ~/.pe/config.json (D5), bien moi truong ghi de khi co.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free'; // model free mac dinh, giong app
export const DEFAULT_APPROVAL = 2; // D3: tu sua file trong project, hoi khi chay shell nguy hiem

export function configDir(home = process.env.PE_HOME || os.homedir()) {
  return path.join(home, '.pe');
}

export function configPath(home) {
  return path.join(configDir(home), 'config.json');
}

function cleanStr(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function normalizeUrl(u) {
  if (!u) return u;
  return u.trim().replace(/\/+$/, '');
}

/** Doc config file (neu co) + ap bien moi truong de len. */
export async function loadConfig(home) {
  const p = configPath(home);
  let file = {};
  let fileOk = false;
  try {
    const raw = await fs.readFile(p, 'utf8');
    file = JSON.parse(raw);
    fileOk = true;
  } catch {
    file = {};
  }
  const env = process.env;
  // Config theo project: .pe/config.json o thu muc hien tai (hoac thu muc cha)
  // ghi de model/approval cua config toan cuc. Secret KHONG doc tu project.
  const proj = await loadProjectConfig();
  const workerUrl = normalizeUrl(cleanStr(env.PE_WORKER_URL) || cleanStr(file.workerUrl));
  const proxySecret = cleanStr(env.PE_PROXY_SECRET) || cleanStr(file.proxySecret);
  const model = cleanStr(env.PE_MODEL) || proj.model || cleanStr(file.model) || DEFAULT_MODEL;
  const approvalRaw = cleanStr(env.PE_APPROVAL) ?? proj.approval ?? file.approval;
  const approval = [1, 2, 3].includes(Number(approvalRaw)) ? Number(approvalRaw) : DEFAULT_APPROVAL;
  return {
    workerUrl, proxySecret, model, approval,
    _meta: {
      path: p,
      fileExists: fileOk,
      projectDir: proj.dir,
      projectModel: proj.model,
      fromEnv: {
        workerUrl: !!cleanStr(env.PE_WORKER_URL),
        proxySecret: !!cleanStr(env.PE_PROXY_SECRET),
        model: !!cleanStr(env.PE_MODEL),
      },
    },
  };
}

/** Tim thu muc .pe gan nhat khi di len tu cwd (chua config.json hoac context.md). */
export async function findProjectDir(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (;;) {
    const cand = path.join(dir, '.pe');
    for (const name of ['config.json', 'context.md']) {
      try {
        const st = await fs.stat(path.join(cand, name));
        if (st.isFile()) return dir;
      } catch { /* chua co */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Doc .pe/config.json cua project (chi model + approval). */
export async function loadProjectConfig(startDir = process.cwd()) {
  const dir = await findProjectDir(startDir);
  if (!dir) return { dir: null };
  let data = {};
  try {
    data = JSON.parse(await fs.readFile(path.join(dir, '.pe', 'config.json'), 'utf8'));
  } catch { /* chi co context.md */ }
  return {
    dir,
    model: cleanStr(data.model),
    approval: [1, 2, 3].includes(Number(data.approval)) ? Number(data.approval) : undefined,
  };
}

/** Bo nho project: noi dung .pe/context.md gan nhat (toi da 32 KB). */
export async function loadProjectContext(startDir = process.cwd()) {
  const dir = await findProjectDir(startDir);
  if (!dir) return null;
  const p = path.join(dir, '.pe', 'context.md');
  try {
    const raw = await fs.readFile(p, 'utf8');
    const text = raw.slice(0, 32 * 1024).trim();
    return text ? { path: p, text } : null;
  } catch {
    return null;
  }
}

/** Ghi config, chmod 600 vi chua secret. */
export async function saveConfig(obj, home) {
  const dir = configDir(home);
  const p = configPath(home);
  await fs.mkdir(dir, { recursive: true });
  const data = {
    workerUrl: normalizeUrl(obj.workerUrl || ''),
    proxySecret: obj.proxySecret || '',
    model: obj.model || DEFAULT_MODEL,
    approval: [1, 2, 3].includes(Number(obj.approval)) ? Number(obj.approval) : DEFAULT_APPROVAL,
  };
  await fs.writeFile(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  try { await fs.chmod(p, 0o600); } catch { /* windows bo qua */ }
  return p;
}

/** Tra ve danh sach thieu de bao loi than thien. */
export function missingFields(cfg) {
  const miss = [];
  if (!cfg.workerUrl) miss.push('workerUrl (PE_WORKER_URL)');
  if (!cfg.proxySecret) miss.push('proxySecret (PE_PROXY_SECRET)');
  return miss;
}
