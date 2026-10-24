// `pe chat` — tro chuyen lien tuc (REPL) voi pe qua fuco-agent worker.
// Co: streaming cau tra loi, dinh kem file/anh (/file /image @mention),
// che do agent dung tools trong project (mac dinh bat), duyet 3 muc, undo.
import readline from 'node:readline';
import fs from 'node:fs';
import { loadConfig, missingFields, saveConfig } from '../lib/config.mjs';
import { loadContextWithLessons, distillLessons, saveLesson, formatLessonForReview } from '../lib/lessons.mjs';
import { chatCompletionStream, listModels, freeOnly, PeError } from '../lib/api.mjs';
import { collectAttachments, expandMentions, buildUserContent, describeAttachments } from '../lib/attach.mjs';
import { createToolRunner } from '../lib/tools.mjs';
import { runAgent, AGENT_SYSTEM, extractJsonToolCall } from '../lib/agent.mjs';
import { restoreLatest, latestBackup } from '../lib/backup.mjs';
import { createSession, saveSession, loadSession, latestSession, listSessions } from '../lib/session.mjs';
import { maybeCompact, withSummary } from '../lib/compact.mjs';
import { currentTimeLine } from '../lib/now.mjs';
import path from 'node:path';

const BASE_SYSTEM = 'Bạn là pé — trợ lý của người dùng trong ứng dụng fuco-agent, giờ đang nói chuyện qua CLI. Trả lời ngắn gọn, đúng trọng tâm. Người dùng là coder (.NET/Angular).';

const HELP = `
Lệnh trong chat:
  /help            hiện trợ giúp này
  /model [id]      xem / đổi model (phải là :free; đổi là có lưu)
  /models          liệt kê model :free
  /file <path>     đính kèm file text/code cho tin nhắn TIẾP THEO
  /image <path>    đính kèm ảnh cho tin nhắn tiếp theo
  /attach          xem đính kèm đang chờ gửi
  /tools [on|off]  bật/tắt chế độ agent (dùng tools trong project)
  /web [on|off]    bật/tắt tìm kiếm web (worker tự tìm + chèn nguồn vào câu trả lời)
  /lesson <nd>     ghi tay 1 bài học kinh nghiệm (lưu ngay; từ phiên sau pé tự tránh lỗi đó)
  /approval [1|2|3]  mức duyệt tool: 1 hỏi tất cả, 2 vừa (mặc định), 3 tự do
  /undo [file]     khôi phục file về bản trước khi pé sửa
  /session         xem phiên chat hiện tại (id, số tin)
  /new             bắt đầu phiên mới (phiên cũ vẫn còn trong ~/.pe/sessions)\n  /clear           xoá lịch sử đoạn này + đính kèm đang chờ
  /exit            thoát (hoặc Ctrl+C)
Trong câu có thể gõ @đường-dẫn để đính kèm ngay file/ảnh đó.
`;

export async function runChat(args = [], input = process.stdin, output = process.stdout) {
  void args;
  const cfg = await loadConfig();
  const miss = missingFields(cfg);
  if (miss.length) {
    console.error(`Chưa cấu hình đủ: thiếu ${miss.join(', ')}. Chạy \`pe init\` trước.`);
    process.exitCode = 2;
    return;
  }
  const ctx = await loadContextWithLessons();
  let currentModel = cfg.model;
  let approval = cfg.approval;
  let toolsOn = true;
  let webOn = args.includes('--web');
  // Phien chat: --resume [id] mo lai phien cu; mac dinh tu noi phien cua
  // chinh project nay (Goi C7); --new ep tao phien moi.
  let session = null;
  let resumed = false;
  if (args[0] === '--resume') {
    session = args[1] ? await loadSession(args[1]) : await latestSession();
    if (!session) {
      console.error(args[1] ? `Không tìm thấy phiên ${args[1]}.` : 'Chưa có phiên chat nào để mở lại.');
      process.exitCode = 2;
      return;
    }
    resumed = true;
  } else if (args[0] !== '--new') {
    const mine = (await listSessions()).find((x) => x.cwd === process.cwd());
    if (mine && mine.messages.length) {
      session = mine;
      resumed = true;
    }
  }
  if (!session) session = await createSession({ cwd: process.cwd(), model: currentModel });
  if (resumed && session.model) currentModel = session.model;
  let history = session.messages; // user/assistant (khong chua system)
  let staged = { files: [], images: [] }; // dinh kem cho cho tin nhan tiep theo
  // Ban do tool da goi trong PHIEN nay (dung chung cho moi luot chat):
  // runAgent dung no de phat hien lap ca XUYEN LUOT — truoc day moi luot
  // go "tiep tuc" la bo dem buoc reset tu dau nen doc lai tu dau mai.
  const agentSeen = new Map();
  // Hang doi duyet bai hoc (v0.8): sau 1 luot agent co loi da sua xong,
  // pe de xuat bai hoc va cho duyet bang CHINH dong nhap tiep theo
  // (y = luu, n = bo qua, all = luu het) — khong dung rl.question vi
  // xung dot voi vong for-await chuyen doc dong cua chat.
  let lessonReview = null;

  const rl = readline.createInterface({ input, output, prompt: 'pe> ' });
  let rlClosed = false;
  rl.on('close', () => { rlClosed = true; });
  const safePrompt = () => { if (!rlClosed) { try { rl.prompt(); } catch { /* da dong */ } } };

  const confirm = (desc) => new Promise((resolve) => {
    if (rlClosed) {
      console.log(`  [cần duyệt] ${desc} — input đã đóng nên mặc định từ chối.`);
      resolve(false);
      return;
    }
    try {
      rl.question(`  Cho phép ${desc}? (y/N) `, (a) => resolve(/^y(es)?$/i.test(a.trim())));
    } catch {
      resolve(false);
    }
  });

  console.log(`pe chat — model: ${currentModel}${webOn ? ' | web: bật' : ''}${ctx ? `\nĐã nạp ngữ cảnh project: ${ctx.path}` : ''}`);
  console.log(resumed
    ? `Đã mở lại phiên ${session.id} của project này (${history.length} tin${session.summary ? ' + bản tóm tắt' : ''}). Gõ /new nếu muốn phiên mới.`
    : `Phiên mới: ${session.id} (tự lưu, mở lại bằng: pe chat --resume)`);
  console.log('Gõ "/help" để xem lệnh, "/exit" để thoát.\n');
  safePrompt();

  // Ctrl+C: dang co luot chay thi ngat luot (giu chat), dang ranh thi thoat em.
  let turnAbort = null;
  let exiting = false;
  const onSigint = async () => {
    if (turnAbort) {
      turnAbort.abort();
      return;
    }
    if (exiting) return;
    exiting = true;
    try { await saveSession(session); } catch { /* bo qua */ }
    console.log('\n(Đã lưu phiên — tạm biệt!)');
    process.exit(0);
  };
  process.on('SIGINT', onSigint);

  const buildSystem = () => {
    let s = withSummary(BASE_SYSTEM, session.summary);
    s += `\n\n${currentTimeLine()}`;
    if (ctx) s += `\n\nNgữ cảnh project:\n${ctx.text}`;
    if (toolsOn) s += `\n\n${AGENT_SYSTEM}`;
    return s;
  };

  /**
   * Tra loi 1 luot:
   * - toolsOn: stream truoc KHONG tools, giu dem — neu la loi goi tool dang JSON
   *   thi chuyen sang vong lap agent; khong phai thi in truc tiep (streaming that).
   * - tat tools: stream truc tiep.
   */
  async function replyTurn(signal) {
    const messages = [{ role: 'system', content: buildSystem() }, ...history];
    if (!toolsOn) {
      let buf = '';
      await chatCompletionStream(cfg, {
        model: currentModel,
        messages,
        signal,
        web: webOn,
        onToken: (t) => { buf += t; output.write(t); },
      });
      output.write('\n');
      return { text: buf, incidents: [], stopped: null };
    }
    let buf = '';
    let decided = false; // true = chac chan khong phai tool JSON -> da in truc tiep
    try {
      await chatCompletionStream(cfg, {
        model: currentModel,
        messages,
        signal,
        web: webOn,
        onToken: (t) => {
          buf += t;
          if (!decided) {
            const head = buf.replace(/^\s+/, '');
            if (head.length >= 24 || head.includes('\n')) {
              if (head.startsWith('{') || head.startsWith('```')) {
                // Co the la loi goi tool — giu im lang, doi het stream roi xu ly.
              } else {
                decided = true;
                output.write(buf);
              }
            }
          } else {
            output.write(t);
          }
        },
      });
    } catch (e) {
      if (e instanceof PeError && (e.kind === 'auth' || e.kind === 'model')) throw e;
      // Stream gap giua chung -> chay agent khong stream
      const runner = createToolRunner({ root: process.cwd(), approval, confirm });
      const r = await runAgent({ cfg, model: currentModel, messages, runner, onEvent: agentEvent, signal, seen: agentSeen, web: webOn });
      console.log(r.text);
      return { text: r.text, incidents: r.incidents || [], stopped: r.stopped };
    }
    if (decided) {
      output.write('\n');
      return { text: buf, incidents: [], stopped: null };
    }
    const jt = extractJsonToolCall(buf);
    if (!jt) {
      console.log(buf);
      return { text: buf, incidents: [], stopped: null };
    }
    // La loi goi tool: chay vong lap agent, dung san cau tra loi dau lam buoc 1.
    const runner = createToolRunner({ root: process.cwd(), approval, confirm });
    const r = await runAgent({
      cfg,
      model: currentModel,
      messages,
      runner,
      onEvent: agentEvent,
      firstReply: { text: buf, toolCalls: [] },
      signal,
      seen: agentSeen,
      web: webOn,
    });
    console.log(r.text);
    return { text: r.text, incidents: r.incidents || [], stopped: r.stopped };
  }

  function agentEvent(type, data) {
    if (type === 'tool') console.log(`  [tool] ${data.desc} ...`);
    else if (type === 'result') console.log(`  [xong] ${data.summary}`);
    else if (type === 'note') console.log(data);
  }

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) { safePrompt(); continue; }

    // Dang cho duyet bai hoc: dong nhap nay la cau tra loi duyet.
    if (lessonReview && line !== '/exit' && line !== '/quit') {
      const a = line.toLowerCase();
      const saveOne = async (e) => {
        const r = await saveLesson(e, e.scope);
        console.log(r.action === 'merged'
          ? `  Đã gộp vào bài học cũ (bây giờ x${r.entry.count}) — ${r.file}`
          : `  Đã lưu bài học — ${r.file}`);
      };
      if (a === 'all' || a === 'tat ca') {
        for (const e of lessonReview.queue) await saveOne(e);
        lessonReview = null;
        console.log('  Đã lưu xong các bài học đề xuất.');
      } else if (a === 'y' || a === 'yes' || a === 'luu') {
        await saveOne(lessonReview.queue.shift());
        if (!lessonReview.queue.length) lessonReview = null;
      } else {
        lessonReview.queue.shift();
        console.log('  (bỏ qua bài học này)');
        if (!lessonReview.queue.length) lessonReview = null;
      }
      if (lessonReview) {
        console.log(formatLessonForReview(lessonReview.queue[0], lessonReview.total - lessonReview.queue.length, lessonReview.total));
        console.log('  Gõ "y" để lưu, "n" để bỏ qua, "all" để lưu tất cả:');
      }
      safePrompt(); continue;
    }

    if (line === '/exit' || line === '/quit') break;
    if (line === '/help') { console.log(HELP); safePrompt(); continue; }
    if (line === '/new') {
      session = await createSession({ cwd: process.cwd(), model: currentModel });
      history = session.messages;
      agentSeen.clear();
      console.log(`Phiên mới: ${session.id}`);
      safePrompt(); continue;
    }
    if (line === '/session') {
      console.log(`Phiên ${session.id} — ${history.length} tin${session.summary ? `, đã tóm tắt ${session.summary.count} tin cũ` : ''}, lưu tại ~/.pe/sessions/${session.id}.json`);
      safePrompt(); continue;
    }
    if (line === '/clear') {
      history.length = 0;
      session.summary = null;
      agentSeen.clear();
      staged = { files: [], images: [] };
      await saveSession(session);
      console.log('(đã xoá lịch sử đoạn này và đính kèm đang chờ)');
      safePrompt(); continue;
    }
    if (line.startsWith('/model')) {
      const id = line.slice(6).trim();
      if (!id) {
        console.log(`Model đang dùng: ${currentModel}`);
      } else if (!id.endsWith(':free')) {
        console.log('Model phải kết thúc bằng ":free" (worker chặn model khác).');
      } else {
        currentModel = id;
        try {
          const fresh = await loadConfig();
          await saveConfig({ workerUrl: fresh.workerUrl, peWorkerUrl: fresh.peWorkerUrl, proxySecret: fresh.proxySecret, model: id, approval: fresh.approval });
          console.log(`Đã đổi model: ${id} (đã lưu)`);
        } catch {
          console.log(`Đã đổi model cho phiên này: ${id} (lưu thất bại)`);
        }
      }
      safePrompt(); continue;
    }
    if (line === '/models') {
      try {
        const ids = freeOnly(await listModels(cfg));
        console.log(ids.map((x) => `  ${x}`).join('\n') || '(không có model :free)');
      } catch (e) { console.log(`Loi: ${e.message}`); }
      safePrompt(); continue;
    }
    if (line.startsWith('/tools')) {
      const v = line.slice(6).trim();
      if (v === 'on') toolsOn = true;
      else if (v === 'off') toolsOn = false;
      console.log(`Chế độ agent (tools): ${toolsOn ? 'BẬT' : 'TẮT'}`);
      safePrompt(); continue;
    }
    if (line.startsWith('/web')) {
      const v = line.slice(4).trim();
      if (v === 'on') webOn = true;
      else if (v === 'off') webOn = false;
      console.log(`Tìm kiếm web: ${webOn ? 'BẬT (worker tự tìm + chèn nguồn)' : 'TẮT'}`);
      safePrompt(); continue;
    }
    if (line.startsWith('/lesson')) {
      const text = line.slice('/lesson'.length).trim();
      if (!text) {
        console.log('Dùng: /lesson <nội dung bài học> — ghi tay 1 bài học (lưu ngay). Xem tất cả bài học: thoát chat rồi chạy `pe lessons`.');
      } else {
        const r = await saveLesson({ loi: 'Bài học ghi tay', gocRe: '', lanSau: text, tag: 'manual' }, 'project');
        console.log(r.action === 'merged'
          ? `Đã gộp vào bài học tương tự (bây giờ x${r.entry.count}) — ${r.file}`
          : `Đã lưu bài học — ${r.file}`);
      }
      safePrompt(); continue;
    }
    if (line.startsWith('/approval')) {
      const v = Number(line.slice(9).trim());
      if ([1, 2, 3].includes(v)) approval = v;
      console.log(`Mức duyệt tool: ${approval} (1 hỏi tất cả, 2 vừa, 3 tự do)`);
      safePrompt(); continue;
    }
    if (line.startsWith('/undo')) {
      const f = line.slice(5).trim();
      try {
        let target = f ? path.resolve(f) : null;
        if (!target) {
          const latest = await latestBackup();
          target = latest ? latest.file : null;
        }
        if (!target) console.log('Chưa có bản backup nào.');
        else {
          const entry = await restoreLatest(target);
          console.log(entry ? `Đã khôi phục ${target} về bản ${new Date(entry.at).toLocaleString('vi-VN')}.` : `Không có backup cho ${target}.`);
        }
      } catch (e) { console.log(`Lỗi undo: ${e.message}`); }
      safePrompt(); continue;
    }
    if (line.startsWith('/file') || line.startsWith('/image')) {
      const isImage = line.startsWith('/image');
      const p = line.slice(isImage ? 6 : 5).trim().replace(/^"(.*)"$/, '$1');
      if (!p) {
        console.log(`Dùng: ${isImage ? '/image' : '/file'} <đường-dẫn>`);
      } else if (!fs.existsSync(p)) {
        console.log(`Không tìm thấy file: ${p}`);
      } else {
        (isImage ? staged.images : staged.files).push(p);
        console.log(`[Đã gắn ${isImage ? 'ảnh' : 'file'} ${p} cho tin nhắn tiếp theo — /attach để xem]`);
      }
      safePrompt(); continue;
    }
    if (line === '/attach') {
      if (!staged.files.length && !staged.images.length) console.log('(không có đính kèm đang chờ)');
      else console.log(`Đang chờ gửi: ${[...staged.files.map((f) => 'file ' + f), ...staged.images.map((f) => 'ảnh ' + f)].join(', ')}`);
      safePrompt(); continue;
    }

    // --- auto-compact: rut gon ngu canh neu sap day ---
    try {
      const c = await maybeCompact(cfg, { model: currentModel, messages: history, summary: session.summary });
      if (c.compacted) {
        history = c.messages;
        session.messages = history;
        session.summary = c.summary;
        console.log(`[Đã rút gọn ngữ cảnh: tóm tắt ${c.dropped} tin cũ, giữ ${history.length} tin gần nhất]`);
      }
    } catch { /* loi compact khong chan chat */ }

    // --- tin nhan thuong: dinh kem staged + @mention ---
    const mentions = await expandMentions(line);
    let att;
    try {
      att = await collectAttachments({
        files: [...staged.files, ...mentions.files],
        images: [...staged.images, ...mentions.images],
      });
    } catch (e) {
      console.log(`Lỗi đính kèm: ${e.message}`);
      safePrompt(); continue;
    }
    for (const n of att.notes) console.log(`Lưu ý: ${n}`);
    const content = buildUserContent(line, att);
    const shadow = line + (describeAttachments(att) ? `\n${describeAttachments(att)}` : '');
    history.push({ role: 'user', content });
    process.stdout.write('pe: ');
    turnAbort = new AbortController();
    try {
      const turn = await replyTurn(turnAbort.signal);
      const text = turn.text;
      history[history.length - 1] = { role: 'user', content: shadow };
      history.push({ role: 'assistant', content: text });
      staged = { files: [], images: [] };
      // Rut bai hoc: luot nay agent co loi nhung da sua xong -> de xuat
      // bai hoc, cho duyet bang dong nhap tiep theo (xem lessonReview).
      if (turn.incidents?.length && !turn.stopped && !lessonReview) {
        try {
          const candidates = await distillLessons({ ...cfg, model: currentModel }, { task: shadow, incidents: turn.incidents, finalText: text });
          if (candidates.length) {
            lessonReview = { queue: [...candidates], total: candidates.length };
            console.log('\nTrong lúc làm việc pé có phạm lỗi rồi tự sửa được. Bài học đề xuất:');
            console.log(formatLessonForReview(candidates[0], 0, candidates.length));
            console.log('  Gõ "y" để lưu, "n" để bỏ qua, "all" để lưu tất cả:');
          }
        } catch { /* rut bai hoc loi thi bo qua */ }
      }
    } catch (e) {
      process.stdout.write('\n');
      history[history.length - 1] = { role: 'user', content: shadow };
      if (turnAbort?.signal.aborted || e?.name === 'AbortError') {
        console.log('(đã ngắt lượt này — gõ tiếp khi sẵn sàng)');
      } else {
      console.log(`Lỗi: ${e.message}\n(câu hỏi vẫn giữ trong lịch sử — gõ lại nếu muốn thử tiếp)`);
      if (att.images.length && /support image input/i.test(e.message)) {
        console.log('Gợi ý: model đang dùng không nhận ảnh. Đổi sang model vision :free, ví dụ: /model nvidia/nemotron-3.5-super-vl:free');
      }
      }
    }
    turnAbort = null;
    session.model = currentModel;
    try { await saveSession(session); } catch { /* luu phien loi khong chan chat */ }
    safePrompt();
  }
  process.removeListener('SIGINT', onSigint);
  rl.close();
  console.log('Tạm biệt!');
}
