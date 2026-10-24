// `pe config` — quản lý TOÀN BỘ cấu hình ngay trong CLI (v0.10), khỏi
// mò từng file trong thư mục:
//   pe config                  tổng quan: giá trị hiệu lực + nguồn của từng
//                              khoá (env / project / file / mặc định), kèm
//                              trạng thái các file context.md, lessons.md...
//   pe config get <khoá>       xem 1 giá trị hiệu lực (secret luôn che)
//   pe config set <khoá> <giá trị>          ghi vào config toàn cục
//   pe config set --project <khoá> <giá trị>  ghi vào .pe/config.json của
//                              project (chỉ model + approval)
//   pe config edit [global|project|context|lessons|rules]
//                              mở file tương ứng bằng editor ($PE_EDITOR,
//                              $EDITOR, hoặc notepad/vi) — tạo nếu chưa có
//   pe config path             in mọi đường dẫn quan trọng
// Ghi file theo kiểu đọc-sửa-ghi lại JSON gốc để KHÔNG làm mất các khoá
// phụ (fallbackModels, updateUrl...) mà saveConfig() không quản lý.
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  configDir, configPath, loadConfig, findProjectDir, loadProjectConfig,
  normalizeUrl, DEFAULT_MODEL, DEFAULT_APPROVAL, DEFAULT_PE_WORKER_URL,
} from '../lib/config.mjs';
import { sessionsDir } from '../lib/session.mjs';
import { globalLessonsPath, projectLessonsPath, readLessons } from '../lib/lessons.mjs';

const SETTABLE = ['workerUrl', 'peWorkerUrl', 'proxySecret', 'model', 'approval', 'fallbackModels', 'updateUrl'];
const ENV_OF = {
  workerUrl: 'PE_WORKER_URL',
  peWorkerUrl: 'PE_PE_WORKER_URL',
  proxySecret: 'PE_PROXY_SECRET',
  model: 'PE_MODEL',
  approval: 'PE_APPROVAL',
  fallbackModels: 'PE_FALLBACK_MODELS',
  updateUrl: 'PE_UPDATE_URL',
};

function maskSecret(v) {
  return v ? `•••••• (đã đặt, ${String(v).length} ký tự)` : '(chưa đặt)';
}

async function readJsonFile(p) {
  try {
    return { ok: true, data: JSON.parse(await fs.readFile(p, 'utf8')) };
  } catch {
    return { ok: false, data: {} };
  }
}

async function writeJsonFile(p, data) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  try { await fs.chmod(p, 0o600); } catch { /* Windows bỏ qua */ }
}

async function fileInfo(p) {
  if (!p) return null;
  try {
    const st = await fs.stat(p);
    return { path: p, size: st.size };
  } catch {
    return { path: p, size: -1 };
  }
}

function sourceOf(key, cfg, proj) {
  if (process.env[ENV_OF[key]]) return `env ${ENV_OF[key]}`;
  if ((key === 'model' || key === 'approval') && proj?.dir) {
    if (key === 'model' && proj.model) return 'project';
    if (key === 'approval' && proj.approval) return 'project';
  }
  return cfg._meta.fileExists ? 'file' : 'mặc định';
}

async function showOverview() {
  const cfg = await loadConfig();
  const proj = await loadProjectConfig();
  console.log(`Cấu hình toàn cục: ${cfg._meta.path}${cfg._meta.fileExists ? '' : ' (chưa có file — chạy "pe init")'}`);
  const rows = [
    ['workerUrl', cfg.workerUrl || '(chưa đặt)'],
    ['peWorkerUrl', cfg.peWorkerUrl || DEFAULT_PE_WORKER_URL],
    ['proxySecret', maskSecret(cfg.proxySecret)],
    ['model', cfg.model || DEFAULT_MODEL],
    ['approval', String(cfg.approval ?? DEFAULT_APPROVAL)],
    ['fallbackModels', (cfg.fallbackModels || []).join(', ')],
    ['updateUrl', cfg.updateUrl || '(mặc định trong bản build)'],
    ['contextLimit', `${cfg.contextLimit} token (chỉ đổi qua env PE_CONTEXT_LIMIT)`],
  ];
  for (const [k, v] of rows) {
    console.log(`  ${k.padEnd(15)} ${v}${ENV_OF[k] ? `   [nguồn: ${sourceOf(k, cfg, proj)}]` : ''}`);
  }

  if (proj.dir) {
    console.log(`\nProject: ${proj.dir}`);
    console.log(`  model (project)    ${proj.model || '(không ghi đè)'}`);
    console.log(`  approval (project) ${proj.approval ?? '(không ghi đè)'}`);
    const ctx = await fileInfo(path.join(proj.dir, '.pe', 'context.md'));
    const les = await projectLessonsPath();
    const lesEntries = await readLessons(les);
    const rules = await fileInfo(path.join(proj.dir, '.muserules'));
    console.log(`  .pe/context.md     ${ctx && ctx.size >= 0 ? `${ctx.size} byte — ${ctx.path}` : 'chưa có'}`);
    console.log(`  .pe/lessons.md     ${lesEntries.length ? `${lesEntries.length} bài học — ${les}` : 'chưa có bài học nào'}`);
    console.log(`  .muserules         ${rules && rules.size >= 0 ? `${rules.size} byte — ${rules.path}` : 'chưa có (pe rules install để tạo)'}`);
  } else {
    console.log('\nProject: (không ở trong project nào — không có thư mục .pe ở đây hoặc thư mục cha)');
  }
  await showPaths();
  console.log('\nSửa nhanh: pe config set <khoá> <giá trị> · Mở file sửa tay: pe config edit [global|project|context|lessons|rules]');
}

async function showPaths() {
  const dir = configDir();
  console.log('\nĐường dẫn quan trọng:');
  console.log(`  config toàn cục   ${configPath()}`);
  console.log(`  phiên chat        ${sessionsDir()}`);
  console.log(`  backup file       ${path.join(dir, 'backups')}`);
  console.log(`  bài học toàn cục  ${globalLessonsPath()}`);
  const projDir = await findProjectDir();
  if (projDir) console.log(`  thư mục .pe       ${path.join(projDir, '.pe')}`);
}

function validateAndNormalize(key, value) {
  switch (key) {
    case 'approval': {
      const n = Number(value);
      if (![1, 2, 3].includes(n)) throw new Error('approval phải là 1, 2 hoặc 3.');
      return n;
    }
    case 'model': {
      if (!String(value).endsWith(':free')) throw new Error('Bản này chỉ dùng model :free — id phải kết thúc bằng ":free".');
      return String(value).trim();
    }
    case 'workerUrl':
    case 'peWorkerUrl':
    case 'updateUrl':
      return normalizeUrl(String(value).trim());
    case 'fallbackModels':
      return String(value).split(',').map((x) => x.trim()).filter(Boolean);
    default:
      return String(value).trim();
  }
}

async function doSet(args) {
  let project = false;
  const rest = [];
  for (const a of args) {
    if (a === '--project') project = true;
    else rest.push(a);
  }
  const [key, ...valueParts] = rest;
  const value = valueParts.join(' ');
  if (!key || !value) {
    console.error('Dùng: pe config set [--project] <khoá> <giá trị>');
    console.error(`Khoá toàn cục: ${SETTABLE.join(', ')} · Khoá project: model, approval`);
    process.exitCode = 2;
    return;
  }
  let normalized;
  try {
    normalized = validateAndNormalize(key, value);
  } catch (e) {
    console.error(`Giá trị không hợp lệ: ${e.message}`);
    process.exitCode = 2;
    return;
  }

  if (project) {
    if (!['model', 'approval'].includes(key)) {
      console.error('Config project chỉ ghi đè được model và approval (secret không bao giờ để ở project).');
      process.exitCode = 2;
      return;
    }
    let dir = await findProjectDir();
    if (!dir) {
      dir = process.cwd();
      console.log(`(Chưa có project ở các thư mục cha — tạo .pe ngay tại ${dir})`);
    }
    const p = path.join(dir, '.pe', 'config.json');
    const { data } = await readJsonFile(p);
    data[key] = normalized;
    await writeJsonFile(p, data);
    console.log(`Đã đặt ${key} (project) = ${key === 'proxySecret' ? maskSecret(normalized) : normalized} — ${p}`);
    if (process.env[ENV_OF[key]]) console.log(`Lưu ý: env ${ENV_OF[key]} đang ghi đè giá trị này khi chạy.`);
    return;
  }

  if (!SETTABLE.includes(key)) {
    console.error(`Không rõ khoá "${key}". Khoá toàn cục: ${SETTABLE.join(', ')}`);
    process.exitCode = 2;
    return;
  }
  const p = configPath();
  const { data } = await readJsonFile(p);
  data[key] = normalized;
  await writeJsonFile(p, data);
  console.log(`Đã đặt ${key} = ${key === 'proxySecret' ? maskSecret(normalized) : normalized} — ${p}`);
  if (key === 'proxySecret') console.log('Lưu ý: giá trị vừa gõ có thể còn trong lịch sử terminal — lần sau nên dùng `pe init` hoặc `pe connect` để nhập kín.');
  if (process.env[ENV_OF[key]]) console.log(`Lưu ý: env ${ENV_OF[key]} đang ghi đè giá trị này khi chạy.`);
}

async function doEdit(target = 'global') {
  let file;
  if (target === 'global') {
    file = configPath();
    if (!(await fileInfo(file))?.size || (await fileInfo(file)).size < 0) {
      console.error('Chưa có config toàn cục — chạy `pe init` trước để tạo.');
      process.exitCode = 2;
      return;
    }
  } else if (target === 'project') {
    const dir = (await findProjectDir()) || process.cwd();
    file = path.join(dir, '.pe', 'config.json');
    if ((await fileInfo(file)).size < 0) await writeJsonFile(file, {});
  } else if (target === 'context') {
    const dir = await findProjectDir();
    if (!dir) { console.error('Chưa có project — chạy `pe init --project` trong thư mục project trước.'); process.exitCode = 2; return; }
    file = path.join(dir, '.pe', 'context.md');
    if ((await fileInfo(file)).size < 0) await fs.writeFile(file, '# Ngữ cảnh project\n\n(mô tả project, quy ước code, lưu ý quan trọng...)\n', 'utf8');
  } else if (target === 'lessons') {
    file = (await projectLessonsPath()) || globalLessonsPath();
    if ((await fileInfo(file)).size < 0) {
      const { writeLessons } = await import('../lib/lessons.mjs');
      await writeLessons(file, []);
    }
  } else if (target === 'rules') {
    const dir = (await findProjectDir()) || process.cwd();
    file = path.join(dir, '.muserules');
    if ((await fileInfo(file)).size < 0) await fs.writeFile(file, '', 'utf8');
  } else {
    console.error('Dùng: pe config edit [global|project|context|lessons|rules]');
    process.exitCode = 2;
    return;
  }
  const editor = process.env.PE_EDITOR || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
  console.log(`Mở ${file} bằng ${editor}...`);
  await new Promise((resolve) => {
    const child = spawn(editor, [file], { stdio: 'inherit', shell: editor.includes(' ') });
    child.on('error', (e) => { console.error(`Không mở được editor: ${e.message}`); process.exitCode = 1; resolve(); });
    child.on('close', () => resolve());
  });
}

export async function runConfig(args = []) {
  const sub = args[0];
  if (!sub || sub === 'list') return showOverview();
  if (sub === 'path') return showPaths();
  if (sub === 'get') {
    const key = args[1];
    if (!key) { console.error('Dùng: pe config get <khoá>'); process.exitCode = 2; return; }
    const cfg = await loadConfig();
    if (key === 'proxySecret') { console.log(maskSecret(cfg.proxySecret)); return; }
    if (!(key in cfg) || key === '_meta') { console.error(`Không rõ khoá "${key}". Xem tất cả: pe config`); process.exitCode = 2; return; }
    const v = cfg[key];
    console.log(Array.isArray(v) ? v.join(', ') : String(v ?? ''));
    return;
  }
  if (sub === 'set') return doSet(args.slice(1));
  if (sub === 'edit') return doEdit(args[1] || 'global');
  console.error('Dùng: pe config [list] | get <khoá> | set [--project] <khoá> <giá trị> | edit [global|project|context|lessons|rules] | path');
  process.exitCode = 2;
}
