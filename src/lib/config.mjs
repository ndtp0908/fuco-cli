// Quan ly cau hinh pe: ~/.pe/config.json (D5), bien moi truong ghi de khi co.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free'; // model free mac dinh, giong app
export const DEFAULT_PE_WORKER_URL = 'https://fuco-pe-agent.ndtphuoc2003.workers.dev'; // hang doi KV cua pe (assign)
export const DEFAULT_CONTEXT_LIMIT = 100000;
export const DEFAULT_FALLBACK_MODELS = ['google/gemma-4-31b-it:free', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free']; // model free du phong khi model chinh bi nghen (Goi B) // token uoc tinh cho auto-compact (model free pho bien 128k+)
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
  const peWorkerUrl = normalizeUrl(cleanStr(env.PE_PE_WORKER_URL) || cleanStr(file.peWorkerUrl) || DEFAULT_PE_WORKER_URL);
  const proxySecret = cleanStr(env.PE_PROXY_SECRET) || cleanStr(file.proxySecret);
  const contextLimit = Number(env.PE_CONTEXT_LIMIT) > 0 ? Number(env.PE_CONTEXT_LIMIT) : DEFAULT_CONTEXT_LIMIT;
  const fallbackModels = (cleanStr(env.PE_FALLBACK_MODELS)
    ? cleanStr(env.PE_FALLBACK_MODELS).split(',').map((x) => x.trim()).filter(Boolean)
    : (Array.isArray(file.fallbackModels) && file.fallbackModels.length ? file.fallbackModels : DEFAULT_FALLBACK_MODELS));
  const updateUrl = cleanStr(file.updateUrl);
  const model = cleanStr(env.PE_MODEL) || proj.model || cleanStr(file.model) || DEFAULT_MODEL;
  const approvalRaw = cleanStr(env.PE_APPROVAL) ?? proj.approval ?? file.approval;
  const approval = [1, 2, 3].includes(Number(approvalRaw)) ? Number(approvalRaw) : DEFAULT_APPROVAL;
  return {
    workerUrl, peWorkerUrl, proxySecret, model, approval, contextLimit, fallbackModels, updateUrl,
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

/** Tim file .muserules gan nhat khi di len tu startDir. */
export async function findClineRules(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (;;) {
    const cand = path.join(dir, '.muserules');
    try {
      const st = await fs.stat(cand);
      if (st.isFile()) return cand;
    } catch { /* chua co */ }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Bo nho project: .pe/context.md gan nhat + .muserules (neu co) — viet 1 cho,
 * ca pe lan Cline deu doc (Goi C6). Moi nguon toi da 32 KB.
 */
export async function loadProjectContext(startDir = process.cwd()) {
  const parts = [];
  const paths = [];
  const dir = await findProjectDir(startDir);
  if (dir) {
    const p = path.join(dir, '.pe', 'context.md');
    try {
      const raw = await fs.readFile(p, 'utf8');
      const text = raw.slice(0, 32 * 1024).trim();
      if (text) { parts.push(text); paths.push(p); }
    } catch { /* chi co config.json */ }
  }
  const rulesPath = await findClineRules(startDir);
  if (rulesPath) {
    try {
      const raw = await fs.readFile(rulesPath, 'utf8');
      const text = raw.slice(0, 32 * 1024).trim();
      if (text) { parts.push('Quy tac tu .muserules:\n' + text); paths.push(rulesPath); }
    } catch { /* bo qua */ }
  }
  if (!parts.length) return null;
  return { path: paths.join(' + '), text: parts.join('\n\n') };
}

/** Ghi config, chmod 600 vi chua secret. */
export async function saveConfig(obj, home) {
  const dir = configDir(home);
  const p = configPath(home);
  await fs.mkdir(dir, { recursive: true });
  const data = {
    workerUrl: normalizeUrl(obj.workerUrl || ''),
    peWorkerUrl: normalizeUrl(obj.peWorkerUrl || DEFAULT_PE_WORKER_URL),
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
