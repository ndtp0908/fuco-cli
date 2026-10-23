// `pe chat` — che do tro chuyen lien tuc (REPL).
// Lenh trong chat: /help /model [id] /models /file /image /attach /clear /exit
// Dinh kem: /file <path> va /image <path> gan file cho TIN NHAN TIEP THEO,
// hoac go @duong-dan ngay trong cau. Lich su chi luu dong mo ta dinh kem
// (khong luu lai base64) de cac luot sau khong phai gui lai anh.
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig, missingFields, saveConfig } from '../lib/config.mjs';
import { chatCompletion, freeOnly, listModels } from '../lib/api.mjs';
import { collectAttachments, expandMentions, buildUserContent, describeAttachments, readTextAttachment, readImageAttachment } from '../lib/attach.mjs';

const HELP = `Lenh trong chat:
  /help            hien bang nay
  /model           xem model hien tai
  /model <id>      doi model (phai la model :free) — luu vao config
  /models          liet ke cac model :free tu worker
  /file <path>     dinh kem file text/code cho tin nhan tiep theo
  /image <path>    dinh kem anh cho tin nhan tiep theo (model phai co vision)
  /attach          xem cac dinh kem dang cho gui
  /clear           xoa lich su doan chat nay + dinh kem dang cho
  /exit            thoat (Ctrl+C / Ctrl+D cung duoc)
  @duong-dan       go ngay trong cau de dinh kem file/anh do`;

export async function runChat() {
  const cfg = await loadConfig();
  const miss = missingFields(cfg);
  if (miss.length) {
    console.error(`Thieu cau hinh: ${miss.join(', ')}. Chay \`pe init\` truoc.`);
    process.exitCode = 1;
    return;
  }
  let model = cfg.model;
  let history = [];
  let staged = { textBlocks: [], images: [], notes: [] };

  const rl = readline.createInterface({ input, output, prompt: 'pe> ' });
  // Khi stdin la pipe (khong phai TTY), readline tu dong sau EOF —
  // goi rl.prompt() luc do se vang "readline was closed". Dung ban an toan nay.
  let rlClosed = false;
  rl.on('close', () => { rlClosed = true; });
  const safePrompt = () => { if (!rlClosed) { try { safePrompt(); } catch { /* da dong */ } } };
  console.log(`pe chat — model: ${model}\nGo "/help" de xem lenh, "/exit" de thoat.\n`);
  safePrompt();

  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) { safePrompt(); continue; }

    if (line === '/exit' || line === '/quit') { rl.close(); break; }
    if (line === '/help') { console.log(HELP); safePrompt(); continue; }
    if (line === '/clear') {
      history = [];
      staged = { textBlocks: [], images: [], notes: [] };
      console.log('(da xoa lich su doan nay + dinh kem dang cho)');
      safePrompt(); continue;
    }
    if (line === '/attach') {
      const d = describeAttachments(staged);
      console.log(d ? d.replace('Da gui kem', 'Dang cho gui') : '(chua co dinh kem nao dang cho)');
      safePrompt(); continue;
    }
    if (line.startsWith('/file ') || line.startsWith('/image ')) {
      const isImg = line.startsWith('/image ');
      const p = line.slice(isImg ? 7 : 6).trim().replace(/^"|"$/g, '');
      try {
        if (isImg) {
          const a = await readImageAttachment(p);
          staged.images.push(a);
          if (a.large) console.log('Luu y: anh kha lon, gui nguyen ban co the bi tu choi.');
        } else {
          staged.textBlocks.push(await readTextAttachment(p));
        }
        console.log(describeAttachments(staged).replace('Da gui kem', 'Dang cho gui'));
      } catch (e) {
        console.log(`Loi dinh kem: ${e.message}`);
      }
      safePrompt(); continue;
    }
    if (line === '/model' || line.startsWith('/model ')) {
      const id = line.slice(6).trim();
      if (!id) {
        console.log(`model hien tai: ${model}`);
      } else if (!id.endsWith(':free')) {
        console.log(`Tu choi: worker chi cho phep model ket thuc bang ":free".`);
      } else {
        model = id;
        await saveConfig({ workerUrl: cfg.workerUrl, proxySecret: cfg.proxySecret, model, approval: cfg.approval });
        console.log(`Da doi model thanh ${model} (da luu)`);
      }
      safePrompt(); continue;
    }
    if (line === '/models') {
      try {
        const ids = freeOnly(await listModels(cfg));
        console.log(ids.length ? ids.slice(0, 40).join('\n') : '(worker khong tra ve model :free nao)');
        if (ids.length > 40) console.log(`... va ${ids.length - 40} model nua`);
      } catch (e) { console.log(`Loi: ${e.message}`); }
      safePrompt(); continue;
    }

    // Tin nhan thuong: gop dinh kem dang cho + @mention trong cau.
    let att = staged;
    try {
      const mentions = await expandMentions(line);
      if (mentions.files.length || mentions.images.length) {
        const extra = await collectAttachments({ files: mentions.files, images: mentions.images });
        att = {
          textBlocks: [...staged.textBlocks, ...extra.textBlocks],
          images: [...staged.images, ...extra.images],
          notes: [...staged.notes, ...extra.notes],
        };
      }
    } catch (e) {
      console.log(`Loi dinh kem: ${e.message}`);
      safePrompt(); continue;
    }
    staged = { textBlocks: [], images: [], notes: [] };
    for (const n of att.notes) console.log(`Luu y: ${n}`);
    const desc = describeAttachments(att);
    const shadow = desc ? `${line}\n${desc}` : line;
    history.push({ role: 'user', content: buildUserContent(line, att) });
    try {
      process.stdout.write('pe dang nghi... \r');
      const { text } = await chatCompletion(cfg, { model, messages: history });
      process.stdout.write(' '.repeat(20) + '\r');
      console.log(text + '\n');
      // Lich su giu ban text (kem dong mo ta dinh kem), khong giu base64.
      history[history.length - 1] = { role: 'user', content: shadow };
      history.push({ role: 'assistant', content: text });
    } catch (e) {
      process.stdout.write(' '.repeat(20) + '\r');
      history[history.length - 1] = { role: 'user', content: shadow };
      console.log(`Loi: ${e.message}\n(cau hoi van giu trong lich su — go lai neu muon thu tiep)`);
      if (att.images.length && /support image input/i.test(e.message)) {
        console.log('Goi y: model dang dung khong nhan anh. Doi sang model vision :free, vi du: /model nvidia/nemotron-3.5-super-vl:free');
      }
    }
    safePrompt();
  }
  console.log('Tam biet!');
}
