// `pe edit <file> "<yeu cau>"` — sua 1 file theo yeu cau: xem diff, xac nhan,
// ghi kem backup (pe undo khoi phuc duoc). Dung cho quy trinh: pe sua -> anh review -> ap dung.
// `pe undo [file]` — khoi phuc ban truoc khi pe sua.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig, missingFields } from '../lib/config.mjs';
import { loadContextWithLessons } from '../lib/lessons.mjs';
import { chatCompletion } from '../lib/api.mjs';
import { formatDiff } from '../lib/diff.mjs';
import { backupFile, restoreLatest, latestBackup } from '../lib/backup.mjs';
import { currentTimeLine } from '../lib/now.mjs';

const EDIT_SYSTEM = 'Ban la cong cu sua file. Nguoi dung dua yeu cau va toan bo noi dung file hien tai. Hay tra ve DUY NHAT 1 khoi ma chua TOAN BO noi dung file sau khi sua (giai thich). Giu nguyen phan khong lien quan.';

function extractEdited(reply) {
  const m = reply.match(/```[^\n]*\n([\s\S]*?)```/);
  if (m) return m[1].replace(/\n$/, '');
  return reply.replace(/\n+$/, '');
}

function askConfirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => {
      rl.close();
      resolve(/^y(es)?$/i.test(a.trim()));
    });
  });
}

export async function runEdit(args = []) {
  const yes = args.includes('--yes') || args.includes('-y');
  const dry = args.includes('--dry');
  let model;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--yes' || a === '-y' || a === '--dry') continue;
    if (a === '--model') { model = args[++i]; continue; }
    if (a.startsWith('--model=')) { model = a.slice(8); continue; }
    pos.push(a);
  }
  const file = pos[0];
  const instruction = pos.slice(1).join(' ').trim();
  if (!file || !instruction) {
    console.error('Dung: pe edit <file> "<yeu cau sua>" [--yes] [--dry] [--model <id>]');
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
  const abs = path.resolve(file);
  let original;
  try {
    const st = await fs.stat(abs);
    if (st.size > 512 * 1024) throw new Error('file qua lon (>512 KB)');
    original = await fs.readFile(abs, 'utf8');
    if (original.includes('\0')) throw new Error('file nhi phan');
  } catch (e) {
    console.error(`Khong doc duoc file: ${e.message}`);
    process.exitCode = 2;
    return;
  }
  const ctx = await loadContextWithLessons();
  const messages = [
    { role: 'system', content: EDIT_SYSTEM + `\n\n${currentTimeLine()}` + (ctx ? `\n\nNgu canh project:\n${ctx.text}` : '') },
    { role: 'user', content: `Yeu cau: ${instruction}\n\nFile ${path.basename(abs)} hien tai:\n\`\`\`\n${original}\n\`\`\`` },
  ];
  // THU LAI 1 LAN (v0.9 tu chua): cau tra loi khong co khoi ```, noi
  // dung giong het file goc (model chua sua), hoac loi goi model tam
  // thoi -> mom lai van de cho model va xin tra loi lai dung dinh dang.
  process.stdout.write('Dang nghi cach sua... ');
  let edited = null;
  let lastProblem = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { text } = await chatCompletion(cfg, { model: model || cfg.model, messages });
      const fenced = /```[^\n]*\n[\s\S]*?```/.test(text || '');
      const cand = extractEdited(text || '');
      if (!fenced) lastProblem = 'cau tra loi khong chua khoi ma ```...``` nao';
      else if (cand.replace(/\s+$/, '') === original.replace(/\s+$/, '')) lastProblem = 'noi dung tra ve giong het file goc (model chua sua gi)';
      else { edited = cand; break; }
      if (attempt === 1) {
        console.log(`chua dat (${lastProblem}) — thu lai 1 lan...`);
        messages.push({ role: 'assistant', content: text || '' });
        messages.push({ role: 'user', content: `Noi dung ban vua tra ve khong dung: ${lastProblem}. Hay tra ve lai TOAN BO file da sua, chi gom DUY NHAT 1 khoi \`\`\`...\`\`\`, khong kem giai thich ben ngoai khoi.` });
        process.stdout.write('Dang nghi cach sua (lan 2)... ');
      }
    } catch (e) {
      lastProblem = e.message;
      if (attempt === 1) {
        console.log(`loi (${e.message}) — thu lai 1 lan...`);
        process.stdout.write('Dang nghi cach sua (lan 2)... ');
      }
    }
  }
  if (edited === null) {
    console.log('');
    console.error(`Khong sua duoc sau 2 lan thu: ${lastProblem}`);
    process.exitCode = 1;
    return;
  }
  console.log('xong.\n');
  console.log(`--- Diff de xuat cho ${file} ---`);
  console.log(formatDiff(original, edited));
  console.log('-------------------------------');
  if (dry) {
    console.log('Che do --dry: chua ghi file.');
    return;
  }
  let ok = yes;
  if (!ok) {
    if (!process.stdin.isTTY) {
      console.log('Khong phai terminal tuong tac — chay lai voi --yes de ghi, hoac --dry de chi xem.');
      return;
    }
    ok = await askConfirm('Ghi file voi noi dung moi nay? (y/N) ');
  }
  if (!ok) {
    console.log('Da huy, file giu nguyen.');
    return;
  }
  await backupFile(abs);
  const out = original.endsWith('\n') && !edited.endsWith('\n') ? edited + '\n' : edited;
  await fs.writeFile(abs, out, 'utf8');
  console.log(`Da ghi ${file}. (Muon quay lai: pe undo ${file})`);
}

export async function runUndo(args = []) {
  let target = args[0];
  if (!target) {
    const latest = await latestBackup();
    if (!latest) {
      console.log('Chua co ban backup nao de khoi phuc.');
      return;
    }
    target = latest.file;
  }
  const abs = path.resolve(target);
  const entry = await restoreLatest(abs);
  if (!entry) {
    console.log(`Khong co ban backup nao cho ${target}.`);
    return;
  }
  console.log(`Da khoi phuc ${target} ve ban ${new Date(entry.at).toLocaleString('vi-VN')}.`);
}
