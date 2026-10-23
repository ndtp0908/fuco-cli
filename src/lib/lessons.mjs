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
    const b = line.match(/^-\s*(Loi|Goc re|Lan sau)\s*:\s*(.*)$/);
    if (b) {
      if (b[1] === 'Loi') cur.loi = b[2].trim();
      else if (b[1] === 'Goc re') cur.gocRe = b[2].trim();
      else cur.lanSau = b[2].trim();
    }
  }
  if (cur) entries.push(cur);
  return entries.filter((e) => e.lanSau || e.loi);
}

export function formatLessonsFile(entries) {
  const head =
    '# Bai hoc kinh nghiem (pe lessons)\n' +
    '<!-- pe CLI quan ly file nay: `pe lessons` de xem/xoa, `/lesson <noi dung>` trong pe chat de ghi tay.\n' +
    '     Sua tay van duoc — giu nguyen cau truc ## ngay · tag · xN va 3 dong - Loi / - Goc re / - Lan sau. -->\n';
  const body = entries
    .map((e) =>
      [
        `\n## ${e.date || todayStr()} · ${e.tag || 'chung'} · x${e.count || 1}`,
        `- Loi: ${e.loi || ''}`,
        ...(e.gocRe ? [`- Goc re: ${e.gocRe}`] : []),
        `- Lan sau: ${e.lanSau || ''}`,
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
    const parts = [`${i + 1}. [${e.tag}${e.count > 1 ? ` x${e.count}` : ''}] Loi: ${e.loi}`];
    if (e.gocRe) parts.push(`Goc re: ${e.gocRe}`);
    parts.push(`Lan sau: ${e.lanSau}`);
    return parts.join(' | ');
  });
  const block = `Bai hoc kinh nghiem tu cac loi truoc day (PHAI tranh lap lai):\n${lines.join('\n')}`;
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

const DISTILL_SYSTEM = `${DISTILL_MARKER} — Ban la bo rut bai hoc cua pe CLI. Nguoi dung vua lam xong 1 viec trong do agent co pham loi nhung DA khac phuc duoc. Nhiem vu: rut ra cac bai hoc NGAN, TONG QUAT, dung duoc cho lan sau (khong ke lai dien bien, khong chua ten file/dong cu the neu khong can).

Tra ve DUY NHAT 1 mang JSON (khong giai thich, khong markdown):
[{"loi": "...", "gocRe": "...", "lanSau": "...", "tag": "run_bash|edit_file|read_file|grep|khac", "scope": "project|global"}]
- "lanSau" la cau lenh hanh dong cu the (bat dau bang dong tu).
- scope "global" chi khi bai hoc dung o moi project/moi may (moi truong, he dieu hanh, mang, cong cu); con lai "project".
- Toi da 3 bai hoc. Khong co bai hoc nao dang gia thi tra ve [].`;

/**
 * Goi model rut bai hoc tu danh sach su co (incidents) cua 1 luot agent
 * DA KET THUC THANH CONG. Tra ve mang entry (chua luu — cho duyet).
 */
export async function distillLessons(cfg, { task, incidents, finalText } = {}) {
  if (!incidents?.length) return [];
  const incText = incidents
    .map((i, n) => `${n + 1}. Tool ${i.tool} (${i.desc})\n   Loi: ${String(i.error || '').split('\n').slice(0, 4).join(' | ').slice(0, 400)}`)
    .join('\n');
  const messages = [
    { role: 'system', content: DISTILL_SYSTEM },
    {
      role: 'user',
      content: `Viec vua lam: ${task || '(khong ro)'}\n\nCac loi da gap roi sua xong:\n${incText}\n\nKet qua cuoi cua agent: ${String(finalText || '').slice(0, 600)}`,
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
    `  [Bai hoc ${idx + 1}/${total}] pham vi: ${e.scope === 'global' ? 'toan cuc (moi project)' : 'project nay'}`,
    `    Loi: ${e.loi || '(khong ro)'}`,
  ];
  if (e.gocRe) lines.push(`    Goc re: ${e.gocRe}`);
  lines.push(`    Lan sau: ${e.lanSau}`);
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
    const ok = await ask('  Luu bai hoc nay? (y/N) ');
    if (!ok) {
      console.log('  (bo qua)');
      continue;
    }
    const r = await saveLesson(e, e.scope, cwd);
    saved++;
    console.log(
      r.action === 'merged'
        ? `  Da gop vao bai hoc cu (bay gio x${r.entry.count}) — ${r.file}`
        : `  Da luu bai hoc moi — ${r.file}`
    );
  }
  return saved;
}
