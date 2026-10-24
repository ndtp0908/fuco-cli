// `pe rules` — hop nhat bo nho project giua pe va Cline (Goi C6):
//  - pe rules           trang thai .pe/context.md va .muserules
//  - pe rules install   cai bo quy tac Cline chuan (chong lap, chong goi sai tool) vao .muserules
//  - pe rules export    .pe/context.md  -> .muserules
//  - pe rules import    .muserules -> .pe/context.md
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { backupFile } from '../lib/backup.mjs';

export const CLINE_PACK = `
<!-- PE-CLINE-PACK v1 (cai boi: pe rules install) -->
## Working rules (from pe)

- Read the relevant files BEFORE editing; never guess file contents or APIs.
- One focused change at a time; verify (build/test/output) before claiming done.
- If the same approach fails twice, STOP — explain what you tried and ask, do not retry variations in a loop.
- If a tool call fails, read the error carefully; never repeat the identical failing call.
- Prefer small targeted edits (exact block replacement) over rewriting whole files.
- Ask when requirements are ambiguous and a wrong guess would be expensive to undo.
- Respect the project's existing style, naming and structure.
- Keep replies concise: summaries and diffs, not whole files.
- Project memory: read .pe/context.md at the start of a task if it exists.
- Project lessons: read .pe/lessons.md at the start of a task if it exists — past mistakes and how to avoid repeating them; the most-repeated lessons matter most.
<!-- /PE-CLINE-PACK -->
`;

async function exists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

export async function runRules(args = []) {
  const cwd = process.cwd();
  const ctxPath = path.join(cwd, '.pe', 'context.md');
  const rulesPath = path.join(cwd, '.muserules');
  const sub = args[0];

  if (!sub || sub === 'status') {
    const hasCtx = await exists(ctxPath);
    const hasRules = await exists(rulesPath);
    const lessonsPath = path.join(cwd, '.pe', 'lessons.md');
    const hasLessons = await exists(lessonsPath);
    console.log(`.pe/context.md : ${hasCtx ? 'có (' + (await fs.readFile(ctxPath, 'utf8')).length + ' ký tự)' : 'chưa có — pe init --project để tạo'}`);
    console.log(`.pe/lessons.md : ${hasLessons ? 'có (' + (await fs.readFile(lessonsPath, 'utf8')).length + ' ký tự) — xem: pe lessons' : 'chưa có — bài học sẽ được đề xuất khi agent phạm lỗi rồi sửa xong'}`);
    console.log(`.muserules    : ${hasRules ? 'có (' + (await fs.readFile(rulesPath, 'utf8')).length + ' ký tự)' : 'chưa có — pe rules install để cài bộ quy tắc chuẩn'}`);
    console.log('\npé tự nạp cả context.md, lessons.md và .muserules làm ngữ cảnh project. Đồng bộ: pe rules export | import (export kèm theo bài học)');
    return;
  }

  if (sub === 'install') {
    let cur = '';
    try { cur = await fs.readFile(rulesPath, 'utf8'); } catch { /* moi */ }
    if (cur.includes('PE-CLINE-PACK')) {
      console.log('.muserules đã có bộ quy tắc pé rồi — không cần cài lại.');
      return;
    }
    if (cur) await backupFile(rulesPath);
    await fs.writeFile(rulesPath, cur ? cur.replace(/\s+$/, '') + '\n' + CLINE_PACK : '# Quy tac cho Cline\n' + CLINE_PACK, 'utf8');
    console.log(`Đã cài bộ quy tắc vào ${rulesPath}${cur ? ' (nối thêm vào cuối file, có backup bản cũ)' : ''}.`);
    return;
  }

  if (sub === 'export') {
    if (!(await exists(ctxPath))) {
      console.error('Chưa có .pe/context.md — chạy pe init --project trước.');
      process.exitCode = 2;
      return;
    }
    if (await exists(rulesPath)) await backupFile(rulesPath);
    let text = await fs.readFile(ctxPath, 'utf8');
    // Kem theo bai hoc kinh nghiem (neu co) trong 1 section rieng co
    // marker — export lai thi thay the section cu, khong nhan doi.
    const lessonsPath = path.join(cwd, '.pe', 'lessons.md');
    let lessonNote = '';
    if (await exists(lessonsPath)) {
      const { readLessons } = await import('../lib/lessons.mjs');
      const entries = await readLessons(lessonsPath);
      if (entries.length) {
        const items = entries
          .map((e) => `- [${e.tag}${e.count > 1 ? ` x${e.count}` : ''}] Lỗi: ${e.loi} | Lần sau: ${e.lanSau}`)
          .join('\n');
        const section = `\n\n<!-- PE-LESSONS (đồng bộ bởi pe rules export) -->\n## Lessons learned (from pe — tránh lặp lại các lỗi này)\n\n${items}\n<!-- /PE-LESSONS -->\n`;
        text = text.replace(/<!-- PE-LESSONS[\s\S]*?<!-- \/PE-LESSONS -->/, '').replace(/\s+$/, '') + section;
        lessonNote = ` Kèm theo ${entries.length} bài học từ .pe/lessons.md.`;
      }
    }
    await fs.writeFile(rulesPath, text, 'utf8');
    console.log(`Đã đồng bộ .pe/context.md -> .muserules (${text.length} ký tự).${lessonNote} Từ giờ Cline và pé đọc chung 1 bộ nhớ.`);
    return;
  }

  if (sub === 'import') {
    if (!(await exists(rulesPath))) {
      console.error('Chưa có .muserules ở thư mục này.');
      process.exitCode = 2;
      return;
    }
    await fs.mkdir(path.join(cwd, '.pe'), { recursive: true });
    if (await exists(ctxPath)) await backupFile(ctxPath);
    const text = await fs.readFile(rulesPath, 'utf8');
    await fs.writeFile(ctxPath, text, 'utf8');
    console.log(`Đã đồng bộ .muserules -> .pe/context.md (${text.length} ký tự).`);
    return;
  }

  console.error('Dùng: pe rules [status|install|export|import]');
  process.exitCode = 2;
}
