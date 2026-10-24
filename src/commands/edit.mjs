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

const EDIT_SYSTEM = 'Bạn là công cụ sửa file. Người dùng đưa yêu cầu và toàn bộ nội dung file hiện tại. Hãy trả về DUY NHẤT 1 khối mã chứa TOÀN BỘ nội dung file sau khi sửa (không giải thích). Giữ nguyên phần không liên quan.';

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
    console.error('Dùng: pe edit <file> "<yêu cầu sửa>" [--yes] [--dry] [--model <id>]');
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
  const abs = path.resolve(file);
  let original;
  try {
    const st = await fs.stat(abs);
    if (st.size > 512 * 1024) throw new Error('file quá lớn (>512 KB)');
    original = await fs.readFile(abs, 'utf8');
    if (original.includes('\0')) throw new Error('file nhị phân');
  } catch (e) {
    console.error(`Không đọc được file: ${e.message}`);
    process.exitCode = 2;
    return;
  }
  const ctx = await loadContextWithLessons();
  const messages = [
    { role: 'system', content: EDIT_SYSTEM + `\n\n${currentTimeLine()}` + (ctx ? `\n\nNgữ cảnh project:\n${ctx.text}` : '') },
    { role: 'user', content: `Yêu cầu: ${instruction}\n\nFile ${path.basename(abs)} hiện tại:\n\`\`\`\n${original}\n\`\`\`` },
  ];
  // THU LAI 1 LAN (v0.9 tu chua): cau tra loi khong co khoi ```, noi
  // dung giong het file goc (model chua sua), hoac loi goi model tam
  // thoi -> mom lai van de cho model va xin tra loi lai dung dinh dang.
  process.stdout.write('Đang nghĩ cách sửa... ');
  let edited = null;
  let lastProblem = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { text } = await chatCompletion(cfg, { model: model || cfg.model, messages });
      const fenced = /```[^\n]*\n[\s\S]*?```/.test(text || '');
      const cand = extractEdited(text || '');
      if (!fenced) lastProblem = 'câu trả lời không chứa khối mã ```...``` nào';
      else if (cand.replace(/\s+$/, '') === original.replace(/\s+$/, '')) lastProblem = 'nội dung trả về giống hệt file gốc (model chưa sửa gì)';
      else { edited = cand; break; }
      if (attempt === 1) {
        console.log(`chưa đạt (${lastProblem}) — thử lại 1 lần...`);
        messages.push({ role: 'assistant', content: text || '' });
        messages.push({ role: 'user', content: `Nội dung bạn vừa trả về không đúng: ${lastProblem}. Hãy trả về lại TOÀN BỘ file đã sửa, chỉ gồm DUY NHẤT 1 khối \`\`\`...\`\`\`, không kèm giải thích bên ngoài khối.` });
        process.stdout.write('Đang nghĩ cách sửa (lần 2)... ');
      }
    } catch (e) {
      lastProblem = e.message;
      if (attempt === 1) {
        console.log(`lỗi (${e.message}) — thử lại 1 lần...`);
        process.stdout.write('Đang nghĩ cách sửa (lần 2)... ');
      }
    }
  }
  if (edited === null) {
    console.log('');
    console.error(`Không sửa được sau 2 lần thử: ${lastProblem}`);
    process.exitCode = 1;
    return;
  }
  console.log('xong.\n');
  console.log(`--- Diff đề xuất cho ${file} ---`);
  console.log(formatDiff(original, edited));
  console.log('-------------------------------');
  if (dry) {
    console.log('Chế độ --dry: chưa ghi file.');
    return;
  }
  let ok = yes;
  if (!ok) {
    if (!process.stdin.isTTY) {
      console.log('Không phải terminal tương tác — chạy lại với --yes để ghi, hoặc --dry để chỉ xem.');
      return;
    }
    ok = await askConfirm('Ghi file với nội dung mới này? (y/N) ');
  }
  if (!ok) {
    console.log('Đã huỷ, file giữ nguyên.');
    return;
  }
  await backupFile(abs);
  const out = original.endsWith('\n') && !edited.endsWith('\n') ? edited + '\n' : edited;
  await fs.writeFile(abs, out, 'utf8');
  console.log(`Đã ghi ${file}. (Muốn quay lại: pe undo ${file})`);
}

export async function runUndo(args = []) {
  let target = args[0];
  if (!target) {
    const latest = await latestBackup();
    if (!latest) {
      console.log('Chưa có bản backup nào để khôi phục.');
      return;
    }
    target = latest.file;
  }
  const abs = path.resolve(target);
  const entry = await restoreLatest(abs);
  if (!entry) {
    console.log(`Không có bản backup nào cho ${target}.`);
    return;
  }
  console.log(`Đã khôi phục ${target} về bản ${new Date(entry.at).toLocaleString('vi-VN')}.`);
}
