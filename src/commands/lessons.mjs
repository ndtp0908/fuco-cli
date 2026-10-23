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
    console.log('  (chua co bai hoc nao)');
    return;
  }
  scope.entries.forEach((e, i) => {
    console.log(`  ${i + 1}. (${e.date} · ${e.tag} · x${e.count}) ${e.loi}`);
    if (e.gocRe) console.log(`     Goc re: ${e.gocRe}`);
    console.log(`     Lan sau: ${e.lanSau}`);
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
        ? '\nCac bai hoc tren tu dong duoc nap vao system prompt moi phien (toi da 15 bai, uu tien bai tai pham nhieu).'
        : '\nChua co bai hoc nao. Bai hoc tu dong se duoc de xuat khi agent pham loi roi sua xong trong pe do / pe chat (anh duyet moi luu), hoac ghi tay: pe lessons add "..."'
    );
    return;
  }

  if (sub === 'add') {
    const global = args.includes('--global');
    const text = args.slice(1).filter((a) => a !== '--global').join(' ').trim();
    if (!text) {
      console.error('Dung: pe lessons add "<noi dung bai hoc>" [--global]');
      process.exitCode = 2;
      return;
    }
    const r = await saveLesson(
      { loi: 'Bai hoc ghi tay', gocRe: '', lanSau: text, tag: 'manual' },
      global ? 'global' : 'project'
    );
    console.log(
      r.action === 'merged'
        ? `Da gop vao bai hoc tuong tu (bay gio x${r.entry.count}) — ${r.file}`
        : `Da luu bai hoc moi (${global ? 'toan cuc' : 'project'}) — ${r.file}`
    );
    return;
  }

  if (sub === 'rm') {
    const scope = args[1];
    const idx = Number(args[2]);
    if (!['project', 'global'].includes(scope) || !Number.isInteger(idx) || idx < 1) {
      console.error('Dung: pe lessons rm <project|global> <so thu tu>');
      process.exitCode = 2;
      return;
    }
    const gone = await removeLesson(scope, idx);
    if (!gone) {
      console.error(`Khong co bai hoc so ${idx} o pham vi ${scope}.`);
      process.exitCode = 2;
      return;
    }
    console.log(`Da xoa bai hoc: ${gone.loi} / ${gone.lanSau}`);
    return;
  }

  console.error('Dung: pe lessons [list] | pe lessons add "<noi dung>" [--global] | pe lessons rm <project|global> <so>');
  process.exitCode = 2;
}
