// `pe lessons` — quan ly bai hoc kinh nghiem (v0.8):
//   pe lessons                 liet ke bai hoc (project + toan cuc)
//   pe lessons add "<noi dung>" [--global]   ghi tay 1 bai hoc (dong
//                              "Lan sau"), mac dinh vao project
//   pe lessons rm <project|global> <so>      xoa bai hoc theo so
// Bai hoc tu dong (agent pham loi -> sua xong -> rut) chi duoc luu khi
// nguoi dung duyet ngay trong pe do / pe chat — lenh nay de xem lai,
// ghi tay va don dep.
import { listAllLessons, removeLesson, saveLesson } from '../lib/lessons.mjs';

function printScope(label, scope) {
  if (!scope) return;
  console.log(`\n[${label}] ${scope.path}`);
  if (!scope.entries.length) {
    console.log('  (chưa có bài học nào)');
    return;
  }
  scope.entries.forEach((e, i) => {
    console.log(`  ${i + 1}. (${e.date} · ${e.tag} · x${e.count}) ${e.loi}`);
    if (e.gocRe) console.log(`     Gốc rễ: ${e.gocRe}`);
    console.log(`     Lần sau: ${e.lanSau}`);
  });
}

export async function runLessons(args = []) {
  const sub = args[0];

  if (!sub || sub === 'list') {
    const all = await listAllLessons();
    printScope('project', all.project);
    printScope('global', all.global);
    const total = (all.project?.entries.length || 0) + all.global.entries.length;
    console.log(
      total
        ? '\nCác bài học trên tự động được nạp vào system prompt mỗi phiên (tối đa 15 bài, ưu tiên bài tái phạm nhiều).'
        : '\nChưa có bài học nào. Bài học tự động sẽ được đề xuất khi agent phạm lỗi rồi sửa xong trong pe do / pe chat (anh duyệt mới lưu), hoặc ghi tay: pe lessons add "..."'
    );
    return;
  }

  if (sub === 'add') {
    const global = args.includes('--global');
    const text = args.slice(1).filter((a) => a !== '--global').join(' ').trim();
    if (!text) {
      console.error('Dùng: pe lessons add "<nội dung bài học>" [--global]');
      process.exitCode = 2;
      return;
    }
    const r = await saveLesson(
      { loi: 'Bài học ghi tay', gocRe: '', lanSau: text, tag: 'manual' },
      global ? 'global' : 'project'
    );
    console.log(
      r.action === 'merged'
        ? `Đã gộp vào bài học tương tự (bây giờ x${r.entry.count}) — ${r.file}`
        : `Đã lưu bài học mới (${global ? 'toàn cục' : 'project'}) — ${r.file}`
    );
    return;
  }

  if (sub === 'rm') {
    const scope = args[1];
    const idx = Number(args[2]);
    if (!['project', 'global'].includes(scope) || !Number.isInteger(idx) || idx < 1) {
      console.error('Dùng: pe lessons rm <project|global> <số thứ tự>');
      process.exitCode = 2;
      return;
    }
    const gone = await removeLesson(scope, idx);
    if (!gone) {
      console.error(`Không có bài học số ${idx} ở phạm vi ${scope}.`);
      process.exitCode = 2;
      return;
    }
    console.log(`Đã xoá bài học: ${gone.loi} / ${gone.lanSau}`);
    return;
  }

  console.error('Dùng: pe lessons [list] | pe lessons add "<nội dung>" [--global] | pe lessons rm <project|global> <số>');
  process.exitCode = 2;
}
