// `pe assign "<viec>"` — giao viec dai cho pe qua hang doi KV (pe-worker).
// Pe xu ly theo chu ky cron (08:00–16:30, T2–T7) — phu hop review/plan/research,
// khong phu hop vong lap sua-test lien tuc (viec do agent local lam nhanh hon).
// `pe tasks` — xem hang doi + viec da giao. `pe result <id>` — lay ket qua.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig, missingFields, configDir } from '../lib/config.mjs';
import { submitTask, getResult, getTask, listPending, listProcessing, resultText } from '../lib/queue.mjs';
import { collectAttachments } from '../lib/attach.mjs';

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
    console.error('Dung: pe assign "<viec>" [--type ask|review|plan|analyze|research|transform] [--file <path>]... [--wait]');
    process.exitCode = 2;
    return;
  }
  if (!TYPES.includes(type)) {
    console.error(`Type khong hop le: ${type}. Chon 1 trong: ${TYPES.join(', ')}`);
    process.exitCode = 2;
    return;
  }
  const cfg = await loadConfig();
  const miss = missingFields(cfg);
  if (miss.length) {
    console.error(`Chua cau hinh du: thieu ${miss.join(', ')}. Chay \`pe init\` truoc.`);
    process.exitCode = 2;
    return;
  }
  let filePayload = [];
  if (files.length) {
    try {
      const att = await collectAttachments({ files });
      filePayload = att.textBlocks.map((b) => ({ name: b.label, content: b.text }));
    } catch (e) {
      console.error(`Loi dinh kem: ${e.message}`);
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
    console.error(`Loi: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  await rememberAssigned({ id: taskId, title: text.slice(0, 80), type, at: new Date().toISOString() });
  console.log(`Da giao viec: ${taskId} (${type})`);
  console.log('Pe xu ly theo chu ky kiem tra hang doi (08:00–16:30, T2–T7).');
  console.log(`Xem ket qua: pe result ${taskId}`);
  if (!wait) return;
  console.log(`Dang cho ket qua (toi da ${timeoutMin} phut, Ctrl+C de dung cho — viec van chay)...`);
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
      console.log(`  [${new Date().toLocaleTimeString('vi-VN')}] trang thai: ${r.status}`);
    }
    if (r.status === 'done') {
      console.log('\n--- Ket qua tu pe ---\n');
      console.log(resultText(r.result));
      return;
    }
    if (r.status === 'failed') {
      console.error(`\nViec that bai: ${r.error || '(khong ro ly do)'}`);
      process.exitCode = 1;
      return;
    }
    if (Date.now() > deadline) {
      console.log(`\nHet ${timeoutMin} phut ma viec chua xong. Xem lai sau: pe result ${taskId}`);
      return;
    }
  }
}

export async function runTasks() {
  const cfg = await loadConfig();
  const miss = missingFields(cfg);
  if (miss.length) {
    console.error(`Chua cau hinh du: thieu ${miss.join(', ')}.`);
    process.exitCode = 2;
    return;
  }
  try {
    const [pending, processing] = await Promise.all([listPending(cfg), listProcessing(cfg)]);
    console.log(`Hang doi hien tai: ${pending.length} cho, ${processing.length} dang xu ly`);
    for (const t of processing) console.log(`  [dang lam] ${t.id || t} — ${t.title || ''}`);
    for (const id of pending) console.log(`  [cho]      ${id}`);
  } catch (e) {
    console.error(`Loi: ${e.message}`);
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

export async function runResult(args = []) {
  const id = args[0];
  if (!id) {
    console.error('Dung: pe result <task_id>');
    process.exitCode = 2;
    return;
  }
  const cfg = await loadConfig();
  try {
    const r = await getResult(cfg, id);
    console.log(`Trang thai: ${r.status}`);
    if (r.status === 'done') {
      console.log('\n--- Ket qua ---\n');
      console.log(resultText(r.result));
    } else if (r.status === 'failed') {
      console.log(`Loi: ${r.error || '(khong ro)'}`);
    } else {
      console.log('Viec chua xong — thu lai sau it phut.');
    }
  } catch (e) {
    console.error(`Loi: ${e.message}`);
    process.exitCode = 1;
  }
}
