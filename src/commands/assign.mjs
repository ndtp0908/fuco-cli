// `pe assign "<viec>"` — giao viec dai cho pe qua hang doi KV (pe-worker).
// Pe xu ly theo chu ky cron (08:00–16:30, T2–T7) — phu hop review/plan/research,
// khong phu hop vong lap sua-test lien tuc (viec do agent local lam nhanh hon).
// `pe tasks` — xem hang doi + viec da giao. `pe result <id>` — lay ket qua.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig, missingFields, configDir } from '../lib/config.mjs';
import { submitTask, getResult, getTask, listPending, listProcessing, resultText } from '../lib/queue.mjs';
import { collectAttachments } from '../lib/attach.mjs';
import { formatDiff } from '../lib/diff.mjs';
import { backupFile } from '../lib/backup.mjs';
import readline from 'node:readline';

const TYPES = ['ask', 'review', 'plan', 'analyze', 'research', 'transform'];

function assignedPath(home) {
  return path.join(configDir(home), 'assigned.json');
}

async function rememberAssigned(entry, home) {
  const p = assignedPath(home);
  let arr = [];
  try { arr = JSON.parse(await fs.readFile(p, 'utf8')); } catch { /* moi */ }
  arr.push(entry);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(arr.slice(-100), null, 2) + '\n', 'utf8');
}

async function loadAssigned(home) {
  try { return JSON.parse(await fs.readFile(assignedPath(home), 'utf8')); } catch { return []; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runAssign(args = []) {
  let type = 'ask';
  let wait = false;
  let timeoutMin = 30;
  const files = [];
  const parts = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--type') { type = args[++i]; continue; }
    if (a === '--file') { files.push(args[++i]); continue; }
    if (a === '--wait') { wait = true; continue; }
    if (a === '--timeout') { timeoutMin = Number(args[++i]) || 30; continue; }
    parts.push(a);
  }
  const text = parts.join(' ').trim();
  if (!text) {
    console.error('Dùng: pe assign "<việc>" [--type ask|review|plan|analyze|research|transform] [--file <path>]... [--wait]');
    process.exitCode = 2;
    return;
  }
  if (!TYPES.includes(type)) {
    console.error(`Type không hợp lệ: ${type}. Chọn 1 trong: ${TYPES.join(', ')}`);
    process.exitCode = 2;
    return;
  }
  const cfg = await loadConfig();
  const miss = missingFields(cfg);
  if (miss.length) {
    console.error(`Chưa cấu hình đủ: thiếu ${miss.join(', ')}. Chạy \`pe init\` trước.`);
    process.exitCode = 2;
    return;
  }
  let filePayload = [];
  if (files.length) {
    try {
      const att = await collectAttachments({ files });
      filePayload = att.textBlocks.map((b) => ({ name: b.label, content: b.text }));
    } catch (e) {
      console.error(`Lỗi đính kèm: ${e.message}`);
      process.exitCode = 2;
      return;
    }
  }
  const input = {
    question: text,
    source: 'pe-cli',
    ...(filePayload.length ? { files: filePayload } : {}),
  };
  let taskId;
  try {
    const r = await submitTask(cfg, { type, title: text.slice(0, 80), input });
    taskId = r.task_id;
  } catch (e) {
    console.error(`Lỗi: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  await rememberAssigned({ id: taskId, title: text.slice(0, 80), type, at: new Date().toISOString() });
  console.log(`Đã giao việc: ${taskId} (${type})`);
  console.log('Pé xử lý theo chu kỳ kiểm tra hàng đợi (08:00–21:30, T2–T7).');
  console.log(`Xem kết quả: pe result ${taskId}`);
  if (!wait) return;
  console.log(`Đang chờ kết quả (tối đa ${timeoutMin} phút, Ctrl+C để dừng chờ — việc vẫn chạy)...`);
  const deadline = Date.now() + timeoutMin * 60000;
  let lastStatus = '';
  for (;;) {
    await sleep(20000);
    let r;
    try {
      r = await getResult(cfg, taskId);
    } catch {
      continue; // loi mang tam thoi khi poll — thu lai vong sau
    }
    if (r.status !== lastStatus) {
      lastStatus = r.status;
      console.log(`  [${new Date().toLocaleTimeString('vi-VN')}] trạng thái: ${r.status}`);
    }
    if (r.status === 'done') {
      console.log('\n--- Kết quả từ pé ---\n');
      console.log(resultText(r.result));
      return;
    }
    if (r.status === 'failed') {
      console.error(`\nViệc thất bại: ${r.error || '(không rõ lý do)'}`);
      process.exitCode = 1;
      return;
    }
    if (Date.now() > deadline) {
      console.log(`\nHết ${timeoutMin} phút mà việc chưa xong. Xem lại sau: pe result ${taskId}`);
      return;
    }
  }
}

export async function runTasks() {
  const cfg = await loadConfig();
  const miss = missingFields(cfg);
  if (miss.length) {
    console.error(`Chưa cấu hình đủ: thiếu ${miss.join(', ')}.`);
    process.exitCode = 2;
    return;
  }
  try {
    const [pending, processing] = await Promise.all([listPending(cfg), listProcessing(cfg)]);
    console.log(`Hàng đợi hiện tại: ${pending.length} chờ, ${processing.length} đang xử lý`);
    for (const t of processing) console.log(`  [đang làm] ${t.id || t} — ${t.title || ''}`);
    for (const id of pending) console.log(`  [chờ]      ${id}`);
  } catch (e) {
    console.error(`Lỗi: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const mine = await loadAssigned();
  if (mine.length) {
    console.log('\nViec ban da giao gan day:');
    for (const t of mine.slice(-10).reverse()) {
      let st = '';
      try {
        const full = await getTask(cfg, t.id);
        st = full?.status || '';
      } catch { /* bo qua */ }
      console.log(`  ${t.id}  ${st.padEnd(10)} ${t.title}`);
    }
  }
}

function askYesNo(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); });
  });
}

/** Trich danh sach file tu ket qua assign ({files: [{path|name, content}]}). */
export function extractResultFiles(result) {
  const arr = Array.isArray(result?.files) ? result.files : [];
  return arr
    .filter((f) => f && typeof f.content === 'string' && (f.path || f.name))
    .map((f) => ({ path: String(f.path || f.name), content: f.content }));
}

export async function runResult(args = []) {
  const apply = args.includes('--apply');
  const yes = args.includes('--yes') || args.includes('-y');
  const id = args.find((a) => !a.startsWith('-'));
  if (!id) {
    console.error('Dùng: pe result <task_id> [--apply] [--yes]');
    process.exitCode = 2;
    return;
  }
  const cfg = await loadConfig();
  try {
    const r = await getResult(cfg, id);
    console.log(`Trạng thái: ${r.status}`);
    if (r.status === 'done') {
      console.log('\n--- Kết quả ---\n');
      console.log(resultText(r.result));
      const files = extractResultFiles(r.result);
      if (files.length && !apply) {
        console.log(`\n(Kết quả có ${files.length} file — chạy lại với --apply để ghi vào project hiện tại)`);
      }
      if (files.length && apply) {
        console.log('\n--- Áp dụng file vào project ---');
        const base = process.cwd();
        for (const f of files) {
          const abs = path.resolve(base, f.path);
          if (abs !== base && !abs.startsWith(base + path.sep)) {
            console.log(`Bỏ qua ${f.path}: đường dẫn ra ngoài project.`);
            continue;
          }
          let cur = '';
          try { cur = await fs.readFile(abs, 'utf8'); } catch { /* file moi */ }
          if (cur === f.content) { console.log(`${f.path}: nội dung đã giống, bỏ qua.`); continue; }
          console.log(`\n[${f.path}]`);
          console.log(formatDiff(cur, f.content));
          let ok = yes;
          if (!ok) {
            if (!process.stdin.isTTY) { console.log('Không phải terminal — dùng --yes để ghi.'); continue; }
            ok = await askYesNo('Ghi file này? (y/N) ');
          }
          if (!ok) { console.log('Bỏ qua.'); continue; }
          await backupFile(abs);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, f.content, 'utf8');
          console.log(`Đã ghi ${f.path} (có backup — pe undo khôi phục được).`);
        }
      }
    } else if (r.status === 'failed') {
      console.log(`Lỗi: ${r.error || '(không rõ)'}`);
    } else {
      console.log('Việc chưa xong — thử lại sau ít phút.');
    }
  } catch (e) {
    console.error(`Lỗi: ${e.message}`);
    process.exitCode = 1;
  }
}
