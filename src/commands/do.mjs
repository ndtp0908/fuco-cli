// `pe do "<viec>"` — giao 1 viec cho agent lam ngay trong project hien tai:
// model tu doc/sua file, chay lenh theo muc duyet (approval).
import readline from 'node:readline';
import { loadConfig, missingFields } from '../lib/config.mjs';
import { createToolRunner } from '../lib/tools.mjs';
import { runAgent, AGENT_SYSTEM, shellNote } from '../lib/agent.mjs';
import { currentTimeLine } from '../lib/now.mjs';
import { loadContextWithLessons, distillLessons, reviewAndSaveLessons } from '../lib/lessons.mjs';
import { VERSION } from '../lib/version.mjs';

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
  let json = false;
  let verifyCmd = '';
  const taskParts = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--yolo') { yolo = true; continue; }
    if (a === '--web') { web = true; continue; }
    if (a === '--json') { json = true; continue; }
    if (a === '--approval') { approval = Number(args[++i]); continue; }
    if (a === '--verify') { verifyCmd = String(args[++i] || ''); continue; }
    if (a.startsWith('--verify=')) { verifyCmd = a.slice('--verify='.length); continue; }
    taskParts.push(a);
  }
  const task = taskParts.join(' ').trim();
  if (!task) {
    console.error('Dùng: pe do "<việc cần làm>" [--yolo] [--approval 1|2|3] [--web] [--json] [--verify "<lệnh kiểm chứng>"]');
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

  // --- Che do JSON (dot25): app desktop goi pe lam agent tren may ---
  // stdout CHI co su kien JSONL (start/tool/result/note/text/approval/
  // done/error); moi log nguoi doc di stderr. Khi can duyet, pe phat su
  // kien "approval" roi CHO app tra loi qua stdin mot dong JSON:
  //   {"type":"approval-answer","id":"a1","decision":"yes"}
  // decision khac "yes" (hoac stdin dong) = tu choi. Che do nay khong
  // rut/luu bai hoc (de tranh prompt chen giua dong su kien).
  const emit = json ? (obj) => process.stdout.write(JSON.stringify(obj) + '\n') : null;
  const log = json ? (...a) => console.error(...a) : (...a) => console.log(...a);
  let jsonConfirm = null;
  if (json) {
    let seq = 0;
    const pending = new Map();
    const buffered = new Map();
    let stdinClosed = false;
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg = null;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg && msg.type === 'approval-answer' && msg.id) {
          const yes = msg.decision === 'yes' || msg.decision === true;
          if (pending.has(msg.id)) { pending.get(msg.id)(yes); pending.delete(msg.id); }
          else buffered.set(msg.id, yes);
        }
      }
    });
    process.stdin.on('end', () => {
      stdinClosed = true;
      for (const [, resolve] of pending) resolve(false);
      pending.clear();
    });
    jsonConfirm = (desc) => new Promise((resolve) => {
      const id = 'a' + (++seq);
      // Luon PHAT su kien approval (ke ca khi cau tra loi da duoc gui
      // truoc va dang nam trong buffer) de app thay du moi yeu cau.
      emit({ type: 'approval', id, kind: 'tool', desc });
      if (buffered.has(id)) { resolve(buffered.get(id)); buffered.delete(id); return; }
      if (stdinClosed) { resolve(false); return; }
      pending.set(id, resolve);
    });
    emit({ type: 'start', version: VERSION, cwd: process.cwd(), model: cfg.model, approval: level, task });
  }
  const onEvent = json
    ? (type, data) => {
        if (type === 'note') emit({ type: 'note', text: String(data) });
        else emit({ type, ...data });
      }
    : printAgentEvent;

  const ctx = await loadContextWithLessons();
  const runner = createToolRunner({ root: process.cwd(), approval: level, confirm: json ? jsonConfirm : makeConfirm() });
  const messages = [
    { role: 'system', content: AGENT_SYSTEM + `\n\n${shellNote()}` + `\n\n${currentTimeLine()}` + (ctx ? `\n\nNgữ cảnh project:\n${ctx.text}` : '') },
    { role: 'user', content: task },
  ];
  log(`pe do (mức duyệt ${level}${level === 3 ? ' — yolo' : ''}${web ? ', web: bật' : ''}${verifyCmd ? `, verify: ${verifyCmd}` : ''}): ${task}\n`);
  const sharedSeen = new Map();
  try {
    const first = await runAgent({ cfg, model: cfg.model, messages, runner, onEvent, web, seen: sharedSeen });
    if (json) emit({ type: 'text', text: first.text });
    else console.log(`\npe: ${first.text}`);
    const allIncidents = [...(first.incidents || [])];
    let finalText = first.text;
    let finalStopped = first.stopped;
    let verifyFailed = false;

    // KIEM CHUNG SAU KHI LAM (v0.9): chay lenh verify (vd build/test);
    // FAIL thi dua nguyen output ve cho agent sua tiep, toi da 2 vong.
    if (verifyCmd) {
      for (let round = 0; round <= 2; round++) {
        log(`\n[kiểm chứng] chạy: ${verifyCmd}`);
        const vres = String(await runner.run('run_bash', { command: verifyCmd }));
        if (vres.startsWith('Người dùng TỪ CHỐI')) {
          log('[kiểm chứng] bị từ chối duyệt — bỏ qua kiểm chứng.');
          break;
        }
        const vFail = vres.startsWith('LOI:') || /\nExit: [1-9]/.test(`\n${vres}`);
        log(vres.split('\n').slice(0, 6).join('\n'));
        if (!vFail) {
          log('[kiểm chứng] PASS ✓');
          break;
        }
        if (round === 2) {
          log('[kiểm chứng] Vẫn FAIL sau 2 vòng sửa — pé dừng lại tại đây, anh xem output lỗi ở trên.');
          verifyFailed = true;
          process.exitCode = 1;
          break;
        }
        log(`[kiểm chứng] FAIL — đưa lỗi về cho agent sửa tiếp (vòng ${round + 1}/2)...`);
        messages.push({
          role: 'user',
          content: `Lệnh kiểm chứng \`${verifyCmd}\` THẤT BẠI. Kết quả chạy:\n${vres.slice(0, 3000)}\n\nHãy sửa code để lệnh kiểm chứng này chạy thành công (Exit: 0).`,
        });
        const fix = await runAgent({ cfg, model: cfg.model, messages, runner, onEvent, seen: sharedSeen });
        if (fix.incidents) allIncidents.push(...fix.incidents);
        finalText = fix.text;
        finalStopped = fix.stopped;
        if (json) emit({ type: 'text', text: fix.text });
        else console.log(`\npe: ${fix.text}`);
      }
    }

    // Rut bai hoc: chi khi viec THANH CONG ma giua duong co loi da sua.
    // (Che do JSON bo qua: app se co co che rieng sau.)
    if (!json && allIncidents.length && !finalStopped && !verifyFailed) {
      try {
        const candidates = await distillLessons(cfg, { task, incidents: allIncidents, finalText });
        if (candidates.length) {
          console.log('\nTrong lúc làm việc pé có phạm lỗi rồi tự sửa được. Pé rút ra bài học sau — anh duyệt thì pé mới lưu lại cho lần sau:');
          await reviewAndSaveLessons({ candidates, ask: askYesNoShared });
        }
      } catch { /* rut bai hoc loi thi bo qua — khong chan viec chinh */ }
    }
    if (json) {
      emit({ type: 'done', ok: !finalStopped && !verifyFailed, stopped: finalStopped || null, verifyFailed });
      await new Promise((r) => setTimeout(r, 30));
      process.exit(process.exitCode || 0);
    }
  } catch (e) {
    if (json) {
      emit({ type: 'error', message: e.message });
      await new Promise((r) => setTimeout(r, 30));
      process.exit(1);
    }
    console.error(`Lỗi: ${e.message}`);
    process.exitCode = 1;
  }
}
