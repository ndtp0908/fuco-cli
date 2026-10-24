// Bai hoc kinh nghiem (v0.8): CLI tu rut bai hoc sau nhung loi DA SUA
// XONG trong luc agent lam viec (pham loi -> khac phuc -> chay xanh),
// luu vao lessons.md de cac phien sau nap lai vao system prompt va
// tranh lap lai loi cu. Hai pham vi:
//   - project: <project>/.pe/lessons.md — rieng cua codebase do.
//   - global:  ~/.pe/lessons.md (configDir) — moi truong, may, mang...
// Dinh dang markdown doc/sua tay duoc:
//
//   ## 2026-10-23 · run_bash · x2
//   - Loi: chay lenh build ma khong kiem tra exit code
//   - Goc re: ...
//   - Lan sau: ...
//
// (xN = so lan bai hoc tuong tu bi gap lai — dedup tang bo dem thay
// vi them dong moi; bo dem cang cao cang duoc uu tien nap lai.)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chatCompletion } from './api.mjs';
import { configDir, findProjectDir, loadProjectContext } from './config.mjs';

export const LESSONS_PROMPT_LIMIT = 15;
const LESSONS_PROMPT_CHARS = 6000;

/** Ngay hom nay dang YYYY-MM-DD theo gio dia phuong. */
export function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- duong dan ----------

export async function projectLessonsPath(cwd = process.cwd()) {
  const dir = await findProjectDir(cwd);
  return dir ? path.join(dir, '.pe', 'lessons.md') : null;
}

export function globalLessonsPath() {
  return path.join(configDir(), 'lessons.md');
}

export async function lessonsPathFor(scope, cwd = process.cwd()) {
  if (scope === 'global') return globalLessonsPath();
  return (await projectLessonsPath(cwd)) || globalLessonsPath();
}

// ---------- parse / format ----------

export function parseLessons(text) {
  const entries = [];
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      if (cur) entries.push(cur);
      const parts = h[1].split('·').map((s) => s.trim());
      cur = {
        date: parts[0] || '',
        tag: parts[1] || 'chung',
        count: 1,
        loi: '',
        gocRe: '',
        lanSau: '',
      };
      const cx = parts.slice(2).join(' ').match(/x(\d+)/i);
      if (cx) cur.count = Math.max(1, Number(cx[1]) || 1);
      continue;
    }
    if (!cur) continue;
    const b = line.match(/^-\s*(Loi|Lỗi|Goc re|Gốc rễ|Lan sau|Lần sau)\s*:\s*(.*)$/);
    if (b) {
      if (b[1] === 'Loi' || b[1] === 'Lỗi') cur.loi = b[2].trim();
      else if (b[1] === 'Goc re' || b[1] === 'Gốc rễ') cur.gocRe = b[2].trim();
      else cur.lanSau = b[2].trim();
    }
  }
  if (cur) entries.push(cur);
  return entries.filter((e) => e.lanSau || e.loi);
}

export function formatLessonsFile(entries) {
  const head =
    '# Bài học kinh nghiệm (pe lessons)\n' +
    '<!-- pe CLI quản lý file này: `pe lessons` để xem/xoá, `/lesson <nội dung>` trong pe chat để ghi tay.\n' +
    '     Sửa tay vẫn được — giữ nguyên cấu trúc ## ngày · tag · xN và 3 dòng - Lỗi / - Gốc rễ / - Lần sau. -->\n';
  const body = entries
    .map((e) =>
      [
        `\n## ${e.date || todayStr()} · ${e.tag || 'chung'} · x${e.count || 1}`,
        `- Lỗi: ${e.loi || ''}`,
        ...(e.gocRe ? [`- Gốc rễ: ${e.gocRe}`] : []),
        `- Lần sau: ${e.lanSau || ''}`,
      ].join('\n')
    )
    .join('\n');
  return head + body + '\n';
}

export async function readLessons(file) {
  if (!file) return [];
  try {
    return parseLessons(await fs.readFile(file, 'utf8'));
  } catch {
    return [];
  }
}

export async function writeLessons(file, entries) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, formatLessonsFile(entries), 'utf8');
}

// ---------- dedup ----------

function normTokens(s) {
  const clean = String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ');
  return new Set(clean.split(/\s+/).filter((w) => w.length > 1));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Tim bai hoc gan giong (theo Loi + Lan sau) — tra index hoac -1. */
export function findSimilarLesson(entries, entry) {
  const key = normTokens(`${entry.loi} ${entry.lanSau}`);
  let best = -1;
  let bestScore = 0;
  entries.forEach((e, i) => {
    const s = jaccard(key, normTokens(`${e.loi} ${e.lanSau}`));
    if (s > bestScore) { bestScore = s; best = i; }
  });
  return bestScore >= 0.55 ? best : -1;
}

/**
 * Them 1 bai hoc vao file (theo scope), tu dedup: bai gan giong bai cu
 * thi tang bo dem xN + cap nhat ngay thay vi them dong moi.
 * Tra { action: 'added' | 'merged', entry }.
 */
export async function saveLesson(entry, scope = 'project', cwd = process.cwd()) {
  const file = await lessonsPathFor(scope, cwd);
  const entries = await readLessons(file);
  const clean = {
    date: todayStr(),
    tag: entry.tag || 'chung',
    count: 1,
    loi: String(entry.loi || '').trim(),
    gocRe: String(entry.gocRe || '').trim(),
    lanSau: String(entry.lanSau || '').trim(),
  };
  const sim = findSimilarLesson(entries, clean);
  if (sim >= 0) {
    entries[sim].count = (entries[sim].count || 1) + 1;
    entries[sim].date = clean.date;
    if (clean.lanSau.length > (entries[sim].lanSau || '').length) entries[sim].lanSau = clean.lanSau;
    await writeLessons(file, entries);
    return { action: 'merged', entry: entries[sim], file };
  }
  entries.unshift(clean);
  await writeLessons(file, entries);
  return { action: 'added', entry: clean, file };
}

/** Xoa bai hoc theo so thu tu (1-based, nhu `pe lessons` in ra) trong 1 scope. */
export async function removeLesson(scope, idx1, cwd = process.cwd()) {
  const file = await lessonsPathFor(scope, cwd);
  const entries = await readLessons(file);
  if (idx1 < 1 || idx1 > entries.length) return null;
  const [gone] = entries.splice(idx1 - 1, 1);
  await writeLessons(file, entries);
  return gone;
}

/** Tat ca bai hoc 2 pham vi (de lenh `pe lessons` hien thi). */
export async function listAllLessons(cwd = process.cwd()) {
  const pPath = await projectLessonsPath(cwd);
  const gPath = globalLessonsPath();
  return {
    project: pPath ? { path: pPath, entries: await readLessons(pPath) } : null,
    global: { path: gPath, entries: await readLessons(gPath) },
  };
}

// ---------- nap vao system prompt ----------

/**
 * Khoi bai hoc chen vao system prompt: gop ca 2 pham vi, sap xep theo
 * bo dem tai pham giam dan roi ngay moi dan, lay toi da
 * LESSONS_PROMPT_LIMIT bai. Moi bai 1 dong gon.
 */
export async function lessonsPromptBlock(cwd = process.cwd()) {
  const all = await listAllLessons(cwd);
  const merged = [
    ...(all.project ? all.project.entries.map((e) => ({ ...e, scope: 'project' })) : []),
    ...all.global.entries.map((e) => ({ ...e, scope: 'global' })),
  ];
  if (!merged.length) return null;
  merged.sort((a, b) => (b.count - a.count) || String(b.date).localeCompare(String(a.date)));
  const lines = merged.slice(0, LESSONS_PROMPT_LIMIT).map((e, i) => {
    const parts = [`${i + 1}. [${e.tag}${e.count > 1 ? ` x${e.count}` : ''}] Lỗi: ${e.loi}`];
    if (e.gocRe) parts.push(`Gốc rễ: ${e.gocRe}`);
    parts.push(`Lần sau: ${e.lanSau}`);
    return parts.join(' | ');
  });
  const block = `Bài học kinh nghiệm từ các lỗi trước đây (PHẢI tránh lặp lại):\n${lines.join('\n')}`;
  return block.slice(0, LESSONS_PROMPT_CHARS);
}

/**
 * loadProjectContext + khoi bai hoc: cac lenh ask/chat/do/edit chi can
 * doi sang ham nay la bai hoc tu dong duoc nap moi phien.
 */
export async function loadContextWithLessons(cwd = process.cwd()) {
  const ctx = await loadProjectContext(cwd);
  const block = await lessonsPromptBlock(cwd);
  if (!block) return ctx;
  const paths = [ctx?.path, 'lessons.md'].filter(Boolean).join(' + ');
  return { path: paths, text: ctx ? `${ctx.text}\n\n${block}` : block };
}

// ---------- rut bai hoc tu loi da sua xong ----------

export const DISTILL_MARKER = 'PE-DISTILL v1';

const DISTILL_SYSTEM = `${DISTILL_MARKER} — Bạn là bộ rút bài học của pe CLI. Người dùng vừa làm xong 1 việc trong đó agent có phạm lỗi nhưng ĐÃ khắc phục được. Nhiệm vụ: rút ra các bài học NGẮN, TỔNG QUÁT, dùng được cho lần sau (không kể lại diễn biến, không chứa tên file/dòng cụ thể nếu không cần).

Trả về DUY NHẤT 1 mảng JSON (không giải thích, không markdown):
[{"loi": "...", "gocRe": "...", "lanSau": "...", "tag": "run_bash|edit_file|read_file|grep|khac", "scope": "project|global"}]
- "lanSau" là câu lệnh hành động cụ thể (bắt đầu bằng động từ).
- scope "global" chỉ khi bài học đúng ở mọi project/mọi máy (môi trường, hệ điều hành, mạng, công cụ); còn lại "project".
- Tối đa 3 bài học. Không có bài học nào đáng giá thì trả về [].`;

/**
 * Goi model rut bai hoc tu danh sach su co (incidents) cua 1 luot agent
 * DA KET THUC THANH CONG. Tra ve mang entry (chua luu — cho duyet).
 */
export async function distillLessons(cfg, { task, incidents, finalText } = {}) {
  if (!incidents?.length) return [];
  const incText = incidents
    .map((i, n) => `${n + 1}. Tool ${i.tool} (${i.desc})\n   Lỗi: ${String(i.error || '').split('\n').slice(0, 4).join(' | ').slice(0, 400)}`)
    .join('\n');
  const messages = [
    { role: 'system', content: DISTILL_SYSTEM },
    {
      role: 'user',
      content: `Việc vừa làm: ${task || '(không rõ)'}\n\nCác lỗi đã gặp rồi sửa xong:\n${incText}\n\nKết quả cuối của agent: ${String(finalText || '').slice(0, 600)}`,
    },
  ];
  const { text } = await chatCompletion(cfg, { model: cfg.model, messages, temperature: 0 });
  const m = String(text || '').match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(m[0]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((x) => x && typeof x === 'object' && String(x.lanSau || '').trim())
    .slice(0, 3)
    .map((x) => ({
      loi: String(x.loi || '').trim(),
      gocRe: String(x.gocRe || '').trim(),
      lanSau: String(x.lanSau || '').trim(),
      tag: String(x.tag || 'chung').trim() || 'chung',
      scope: x.scope === 'global' ? 'global' : 'project',
    }));
}

/** Dinh dang 1 bai hoc de in ra cho nguoi dung duyet. */
export function formatLessonForReview(e, idx, total) {
  const lines = [
    `  [Bài học ${idx + 1}/${total}] phạm vi: ${e.scope === 'global' ? 'toàn cục (mọi project)' : 'project này'}`,
    `    Lỗi: ${e.loi || '(không rõ)'}`,
  ];
  if (e.gocRe) lines.push(`    Gốc rễ: ${e.gocRe}`);
  lines.push(`    Lần sau: ${e.lanSau}`);
  return lines.join('\n');
}

/**
 * Duyet tung bai hoc qua ask(hoi) -> true/false; bai duoc duyet thi luu
 * ngay (saveLesson tu dedup). Tra so bai da luu.
 */
export async function reviewAndSaveLessons({ candidates, ask, cwd = process.cwd() }) {
  let saved = 0;
  for (let i = 0; i < candidates.length; i++) {
    const e = candidates[i];
    console.log(formatLessonForReview(e, i, candidates.length));
    const ok = await ask('  Lưu bài học này? (y/N) ');
    if (!ok) {
      console.log('  (bỏ qua)');
      continue;
    }
    const r = await saveLesson(e, e.scope, cwd);
    saved++;
    console.log(
      r.action === 'merged'
        ? `  Đã gộp vào bài học cũ (bây giờ x${r.entry.count}) — ${r.file}`
        : `  Đã lưu bài học mới — ${r.file}`
    );
  }
  return saved;
}
