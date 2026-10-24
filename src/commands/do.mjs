// `pe do "<viec>"` — giao 1 viec cho agent lam ngay trong project hien tai:
// model tu doc/sua file, chay lenh theo muc duyet (approval).
import readline from 'node:readline';
import { loadConfig, missingFields } from '../lib/config.mjs';
import { createToolRunner } from '../lib/tools.mjs';
import { runAgent, AGENT_SYSTEM } from '../lib/agent.mjs';
import { currentTimeLine } from '../lib/now.mjs';
import { loadContextWithLessons, distillLessons, reviewAndSaveLessons } from '../lib/lessons.mjs';

export function printAgentEvent(type, data) {
  if (type === 'tool') console.log(`  [tool] ${data.desc} ...`);
  else if (type === 'result') console.log(`  [xong] ${data.summary}`);
  else if (type === 'note') console.log(data);
}

/** readline dung chung cho ca duyet tool va duyet bai hoc trong `pe do`. */
let sharedRl = null;
function doRl() {
  if (!sharedRl) sharedRl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return sharedRl;
}

/** Hoi xac nhan qua terminal; stdin khong phai TTY thi mac dinh tu choi. */
export function makeConfirm() {
  return (desc) => new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      console.log(`  [cần duyệt] ${desc} — không phải terminal nên từ chối (dùng --yolo hoặc chat để duyệt tay).`);
      resolve(false);
      return;
    }
    doRl().question(`  Cho phép ${desc}? (y/N) `, (a) => resolve(/^y(es)?$/i.test(a.trim())));
  });
}

/**
 * Hoi y/N cho viec LUU BAI HOC (khong nguy hiem nen doc ca stdin pipe:
 * nguoi dung go "y" la duyet; EOF/khong tra loi = khong luu).
 */
export function askYesNoShared(question) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const rl = doRl();
    rl.once('close', () => done(false));
    try {
      rl.question(question, (a) => done(/^y(es)?$/i.test(String(a).trim())));
    } catch {
      done(false);
    }
  });
}

export async function runDo(args = []) {
  let yolo = false;
  let approval;
  let web = false;
  let verifyCmd = '';
  const taskParts = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--yolo') { yolo = true; continue; }
    if (a === '--web') { web = true; continue; }
    if (a === '--approval') { approval = Number(args[++i]); continue; }
    if (a === '--verify') { verifyCmd = String(args[++i] || ''); continue; }
    if (a.startsWith('--verify=')) { verifyCmd = a.slice('--verify='.length); continue; }
    taskParts.push(a);
  }
  const task = taskParts.join(' ').trim();
  if (!task) {
    console.error('Dùng: pe do "<việc cần làm>" [--yolo] [--approval 1|2|3] [--web] [--verify "<lệnh kiểm chứng>"]');
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
  const level = yolo ? 3 : ([1, 2, 3].includes(approval) ? approval : cfg.approval);
  const ctx = await loadContextWithLessons();
  const runner = createToolRunner({ root: process.cwd(), approval: level, confirm: makeConfirm() });
  const messages = [
    { role: 'system', content: AGENT_SYSTEM + `\n\n${currentTimeLine()}` + (ctx ? `\n\nNgữ cảnh project:\n${ctx.text}` : '') },
    { role: 'user', content: task },
  ];
  console.log(`pe do (mức duyệt ${level}${level === 3 ? ' — yolo' : ''}${web ? ', web: bật' : ''}${verifyCmd ? `, verify: ${verifyCmd}` : ''}): ${task}\n`);
  const sharedSeen = new Map();
  try {
    const first = await runAgent({ cfg, model: cfg.model, messages, runner, onEvent: printAgentEvent, web, seen: sharedSeen });
    console.log(`\npe: ${first.text}`);
    const allIncidents = [...(first.incidents || [])];
    let finalText = first.text;
    let finalStopped = first.stopped;
    let verifyFailed = false;

    // KIEM CHUNG SAU KHI LAM (v0.9): chay lenh verify (vd build/test);
    // FAIL thi dua nguyen output ve cho agent sua tiep, toi da 2 vong.
    if (verifyCmd) {
      for (let round = 0; round <= 2; round++) {
        console.log(`\n[kiểm chứng] chạy: ${verifyCmd}`);
        const vres = String(await runner.run('run_bash', { command: verifyCmd }));
        if (vres.startsWith('Người dùng TỪ CHỐI')) {
          console.log('[kiểm chứng] bị từ chối duyệt — bỏ qua kiểm chứng.');
          break;
        }
        const vFail = vres.startsWith('LOI:') || /\nExit: [1-9]/.test(`\n${vres}`);
        console.log(vres.split('\n').slice(0, 6).join('\n'));
        if (!vFail) {
          console.log('[kiểm chứng] PASS ✓');
          break;
        }
        if (round === 2) {
          console.log('[kiểm chứng] Vẫn FAIL sau 2 vòng sửa — pé dừng lại tại đây, anh xem output lỗi ở trên.');
          verifyFailed = true;
          process.exitCode = 1;
          break;
        }
        console.log(`[kiểm chứng] FAIL — đưa lỗi về cho agent sửa tiếp (vòng ${round + 1}/2)...`);
        messages.push({
          role: 'user',
          content: `Lệnh kiểm chứng \`${verifyCmd}\` THẤT BẠI. Kết quả chạy:\n${vres.slice(0, 3000)}\n\nHãy sửa code để lệnh kiểm chứng này chạy thành công (Exit: 0).`,
        });
        const fix = await runAgent({ cfg, model: cfg.model, messages, runner, onEvent: printAgentEvent, seen: sharedSeen });
        if (fix.incidents) allIncidents.push(...fix.incidents);
        finalText = fix.text;
        finalStopped = fix.stopped;
        console.log(`\npe: ${fix.text}`);
      }
    }

    // Rut bai hoc: chi khi viec THANH CONG ma giua duong co loi da sua.
    if (allIncidents.length && !finalStopped && !verifyFailed) {
      try {
        const candidates = await distillLessons(cfg, { task, incidents: allIncidents, finalText });
        if (candidates.length) {
          console.log('\nTrong lúc làm việc pé có phạm lỗi rồi tự sửa được. Pé rút ra bài học sau — anh duyệt thì pé mới lưu lại cho lần sau:');
          await reviewAndSaveLessons({ candidates, ask: askYesNoShared });
        }
      } catch { /* rut bai hoc loi thi bo qua — khong chan viec chinh */ }
    }
  } catch (e) {
    console.error(`Lỗi: ${e.message}`);
    process.exitCode = 1;
  }
}
