// `pe chat` — tro chuyen lien tuc (REPL) voi pe qua fuco-agent worker.
// Co: streaming cau tra loi, dinh kem file/anh (/file /image @mention),
// che do agent dung tools trong project (mac dinh bat), duyet 3 muc, undo.
import readline from 'node:readline';
import fs from 'node:fs';
import { loadConfig, missingFields, loadProjectContext } from '../lib/config.mjs';
import { chatCompletionStream, listModels, freeOnly, PeError } from '../lib/api.mjs';
import { collectAttachments, expandMentions, buildUserContent, describeAttachments } from '../lib/attach.mjs';
import { createToolRunner } from '../lib/tools.mjs';
import { runAgent, AGENT_SYSTEM, extractJsonToolCall } from '../lib/agent.mjs';
import { restoreLatest, latestBackup } from '../lib/backup.mjs';
import path from 'node:path';

const BASE_SYSTEM = 'Ban la pe — tro ly cua nguoi dung trong ung dung fuco-agent, gio dang noi chuyen qua CLI. Tra loi ngan gon, dung trong tam. Nguoi dung la coder (.NET/Angular).';

const HELP = `
Lenh trong chat:
  /help            hien tro giup nay
  /model [id]      xem / doi model (phai la :free; doi la co luu)
  /models          liet ke model :free
  /file <path>     dinh kem file text/code cho tin nhan TIEP THEO
  /image <path>    dinh kem anh cho tin nhan tiep theo
  /attach          xem dinh kem dang cho gui
  /tools [on|off]  bat/tat che do agent (dung tools trong project)
  /approval [1|2|3]  muc duyet tool: 1 hoi tat ca, 2 vua (mac dinh), 3 tu do
  /undo [file]     khoi phuc file ve ban truoc khi pe sua
  /clear           xoa lich su doan nay + dinh kem dang cho
  /exit            thoat (hoac Ctrl+C)
Trong cau co the go @duong-dan de dinh kem ngay file/anh do.
`;

export async function runChat(args = [], input = process.stdin, output = process.stdout) {
  void args;
  const cfg = await loadConfig();
  const miss = missingFields(cfg);
  if (miss.length) {
    console.error(`Chua cau hinh du: thieu ${miss.join(', ')}. Chay \`pe init\` truoc.`);
    process.exitCode = 2;
    return;
  }
  const ctx = await loadProjectContext();
  let currentModel = cfg.model;
  let approval = cfg.approval;
  let toolsOn = true;
  const history = []; // user/assistant (khong chua system)
  let staged = { files: [], images: [] }; // dinh kem cho cho tin nhan tiep theo

  const rl = readline.createInterface({ input, output, prompt: 'pe> ' });
  let rlClosed = false;
  rl.on('close', () => { rlClosed = true; });
  const safePrompt = () => { if (!rlClosed) { try { rl.prompt(); } catch { /* da dong */ } } };

  const confirm = (desc) => new Promise((resolve) => {
    if (rlClosed) {
      console.log(`  [can duyet] ${desc} — input da dong nen mac dinh tu choi.`);
      resolve(false);
      return;
    }
    try {
      rl.question(`  Cho phep ${desc}? (y/N) `, (a) => resolve(/^y(es)?$/i.test(a.trim())));
    } catch {
      resolve(false);
    }
  });

  console.log(`pe chat — model: ${currentModel}${ctx ? `\nDa nap ngu canh project: ${ctx.path}` : ''}`);
  console.log('Go "/help" de xem lenh, "/exit" de thoat.\n');
  safePrompt();

  const buildSystem = () => {
    let s = BASE_SYSTEM;
    if (ctx) s += `\n\nNgu canh project:\n${ctx.text}`;
    if (toolsOn) s += `\n\n${AGENT_SYSTEM}`;
    return s;
  };

  /**
   * Tra loi 1 luot:
   * - toolsOn: stream truoc KHONG tools, giu dem — neu la loi goi tool dang JSON
   *   thi chuyen sang vong lap agent; khong phai thi in truc tiep (streaming that).
   * - tat tools: stream truc tiep.
   */
  async function replyTurn() {
    const messages = [{ role: 'system', content: buildSystem() }, ...history];
    if (!toolsOn) {
      let buf = '';
      await chatCompletionStream(cfg, {
        model: currentModel,
        messages,
        onToken: (t) => { buf += t; output.write(t); },
      });
      output.write('\n');
      return buf;
    }
    let buf = '';
    let decided = false; // true = chac chan khong phai tool JSON -> da in truc tiep
    try {
      await chatCompletionStream(cfg, {
        model: currentModel,
        messages,
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
      const { text } = await runAgent({ cfg, model: currentModel, messages, runner, onEvent: agentEvent });
      console.log(text);
      return text;
    }
    if (decided) {
      output.write('\n');
      return buf;
    }
    const jt = extractJsonToolCall(buf);
    if (!jt) {
      console.log(buf);
      return buf;
    }
    // La loi goi tool: chay vong lap agent, dung san cau tra loi dau lam buoc 1.
    const runner = createToolRunner({ root: process.cwd(), approval, confirm });
    const { text } = await runAgent({
      cfg,
      model: currentModel,
      messages,
      runner,
      onEvent: agentEvent,
      firstReply: { text: buf, toolCalls: [] },
    });
    console.log(text);
    return text;
  }

  function agentEvent(type, data) {
    if (type === 'tool') console.log(`  [tool] ${data.desc} ...`);
    else if (type === 'result') console.log(`  [xong] ${data.summary}`);
    else if (type === 'note') console.log(data);
  }

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) { safePrompt(); continue; }

    if (line === '/exit' || line === '/quit') break;
    if (line === '/help') { console.log(HELP); safePrompt(); continue; }
    if (line === '/clear') {
      history.length = 0;
      staged = { files: [], images: [] };
      console.log('(da xoa lich su doan nay va dinh kem dang cho)');
      safePrompt(); continue;
    }
    if (line.startsWith('/model')) {
      const id = line.slice(6).trim();
      if (!id) {
        console.log(`Model dang dung: ${currentModel}`);
      } else if (!id.endsWith(':free')) {
        console.log('Model phai ket thuc bang ":free" (worker chan model khac).');
      } else {
        currentModel = id;
        const { saveConfig } = await import('../lib/config.mjs');
        try {
          const fresh = await loadConfig();
          await saveConfig({ workerUrl: fresh.workerUrl, proxySecret: fresh.proxySecret, model: id, approval: fresh.approval });
          console.log(`Da doi model: ${id} (da luu)`);
        } catch {
          console.log(`Da doi model cho phien nay: ${id} (luu that bai)`);
        }
      }
      safePrompt(); continue;
    }
    if (line === '/models') {
      try {
        const ids = freeOnly(await listModels(cfg));
        console.log(ids.map((x) => `  ${x}`).join('\n') || '(khong co model :free)');
      } catch (e) { console.log(`Loi: ${e.message}`); }
      safePrompt(); continue;
    }
    if (line.startsWith('/tools')) {
      const v = line.slice(6).trim();
      if (v === 'on') toolsOn = true;
      else if (v === 'off') toolsOn = false;
      console.log(`Che do agent (tools): ${toolsOn ? 'BAT' : 'TAT'}`);
      safePrompt(); continue;
    }
    if (line.startsWith('/approval')) {
      const v = Number(line.slice(9).trim());
      if ([1, 2, 3].includes(v)) approval = v;
      console.log(`Muc duyet tool: ${approval} (1 hoi tat ca, 2 vua, 3 tu do)`);
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
        if (!target) console.log('Chua co ban backup nao.');
        else {
          const entry = await restoreLatest(target);
          console.log(entry ? `Da khoi phuc ${target} ve ban ${new Date(entry.at).toLocaleString('vi-VN')}.` : `Khong co backup cho ${target}.`);
        }
      } catch (e) { console.log(`Loi undo: ${e.message}`); }
      safePrompt(); continue;
    }
    if (line.startsWith('/file') || line.startsWith('/image')) {
      const isImage = line.startsWith('/image');
      const p = line.slice(isImage ? 6 : 5).trim().replace(/^"(.*)"$/, '$1');
      if (!p) {
        console.log(`Dung: ${isImage ? '/image' : '/file'} <duong-dan>`);
      } else if (!fs.existsSync(p)) {
        console.log(`Khong tim thay file: ${p}`);
      } else {
        (isImage ? staged.images : staged.files).push(p);
        console.log(`[Da gan ${isImage ? 'anh' : 'file'} ${p} cho tin nhan tiep theo — /attach de xem]`);
      }
      safePrompt(); continue;
    }
    if (line === '/attach') {
      if (!staged.files.length && !staged.images.length) console.log('(khong co dinh kem dang cho)');
      else console.log(`Dang cho gui: ${[...staged.files.map((f) => 'file ' + f), ...staged.images.map((f) => 'anh ' + f)].join(', ')}`);
      safePrompt(); continue;
    }

    // --- tin nhan thuong: dinh kem staged + @mention ---
    const mentions = await expandMentions(line);
    let att;
    try {
      att = await collectAttachments({
        files: [...staged.files, ...mentions.files],
        images: [...staged.images, ...mentions.images],
      });
    } catch (e) {
      console.log(`Loi dinh kem: ${e.message}`);
      safePrompt(); continue;
    }
    for (const n of att.notes) console.log(`Luu y: ${n}`);
    const content = buildUserContent(line, att);
    const shadow = line + (describeAttachments(att) ? `\n${describeAttachments(att)}` : '');
    history.push({ role: 'user', content });
    process.stdout.write('pe: ');
    try {
      const text = await replyTurn();
      history[history.length - 1] = { role: 'user', content: shadow };
      history.push({ role: 'assistant', content: text });
      staged = { files: [], images: [] };
    } catch (e) {
      process.stdout.write('\n');
      history[history.length - 1] = { role: 'user', content: shadow };
      console.log(`Loi: ${e.message}\n(cau hoi van giu trong lich su — go lai neu muon thu tiep)`);
      if (att.images.length && /support image input/i.test(e.message)) {
        console.log('Goi y: model dang dung khong nhan anh. Doi sang model vision :free, vi du: /model nvidia/nemotron-3.5-super-vl:free');
      }
    }
    safePrompt();
  }
  rl.close();
  console.log('Tam biet!');
}
