// `pe ask` — hoi 1 cau, in tra loi roi thoat.
// Dung: pe ask "prompt..." [--model <id>] [--system "..."]
//       [--file <path>]... [--image <path>]...   hoac: echo "..." | pe ask
// Trong prompt co the go @duong-dan de dinh kem file/anh do.
// Neu vua co prompt vua pipe stdin: noi dung stdin duoc gui kem
// nhu mot block file co nhan "stdin".
import { loadConfig, missingFields } from '../lib/config.mjs';
import { loadContextWithLessons } from '../lib/lessons.mjs';
import { chatCompletionStream, PeError } from '../lib/api.mjs';
import { collectAttachments, expandMentions, buildUserContent, describeAttachments } from '../lib/attach.mjs';
import { currentTimeLine } from '../lib/now.mjs';

/**
 * Doc stdin. Khi DA CO prompt (graceMs > 0): chi cho stdin 300ms de
 * gui chunk dau tien — neu khong co du lieu thi bo qua ngay. Thieu
 * buoc nay, cac moi truong pipe-mo (CI, exec, mot so terminal) khong
 * bao gio gui EOF se lam `pe ask "cau hoi"` treo vo han du cau hoi
 * da co san. Khi chua co prompt: doc den EOF nhu cu.
 */
function readStdin({ graceMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let s = '';
    let got = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onErr);
      try { stdin.pause(); } catch { /* noop */ }
    };
    const onData = (c) => {
      got = true;
      if (timer) { clearTimeout(timer); timer = null; }
      s += c;
    };
    const onEnd = () => { cleanup(); resolve(s); };
    const onErr = (e) => { cleanup(); reject(e); };
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onErr);
    if (graceMs > 0) {
      timer = setTimeout(() => { if (!got) { cleanup(); resolve(''); } }, graceMs);
    }
  });
}

function parseArgs(args) {
  const out = { promptParts: [], model: undefined, system: undefined, files: [], images: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--model' && args[i + 1]) out.model = args[++i];
    else if (a.startsWith('--model=')) out.model = a.slice(8);
    else if (a === '--system' && args[i + 1]) out.system = args[++i];
    else if (a.startsWith('--system=')) out.system = a.slice(9);
    else if (a === '--file' && args[i + 1]) out.files.push(args[++i]);
    else if (a.startsWith('--file=')) out.files.push(a.slice(7));
    else if (a === '--image' && args[i + 1]) out.images.push(args[++i]);
    else if (a.startsWith('--image=')) out.images.push(a.slice(8));
    else if (a === '--web') out.web = true;
    else out.promptParts.push(a);
  }
  return out;
}

export async function runAsk(args) {
  const { promptParts, model, system, files, images, web } = parseArgs(args);
  let prompt = promptParts.join(' ').trim();

  let stdinText = '';
  if (!process.stdin.isTTY) {
    stdinText = await readStdin({ graceMs: prompt ? 300 : 0 });
  }
  if (!prompt && stdinText.trim()) {
    // Chi co stdin: noi dung stdin la cau hoi (hanh vi cu).
    prompt = stdinText.trim();
    stdinText = '';
  }
  if (!prompt && !files.length && !images.length) {
    console.error('Dung: pe ask "cau hoi..." [--model <id>] [--system "..."] [--file <path>] [--image <path>] [--web]');
    process.exitCode = 2;
    return;
  }
  if (!prompt) prompt = 'Hay xem cac noi dung dinh kem sau.';

  const cfg = await loadConfig();
  const miss = missingFields(cfg);
  if (miss.length) {
    console.error(`Thieu cau hinh: ${miss.join(', ')}. Chay \`pe init\` truoc.`);
    process.exitCode = 1;
    return;
  }

  let att;
  try {
    const mentions = await expandMentions(prompt);
    att = await collectAttachments({
      files: [...files, ...mentions.files],
      images: [...images, ...mentions.images],
      stdinText,
    });
  } catch (e) {
    console.error(`Loi dinh kem: ${e.message}`);
    process.exitCode = 2;
    return;
  }
  for (const n of att.notes) console.error(`Luu y: ${n}`);
  const desc = describeAttachments(att);
  if (desc) console.error(desc.replace('Da gui kem', 'Dinh kem'));

  const ctx = await loadContextWithLessons();
  const messages = [];
  const sysParts = [];
  if (system) sysParts.push(system);
  sysParts.push(currentTimeLine());
  if (ctx) sysParts.push('Ngu canh project:\n' + ctx.text);
  if (sysParts.length) messages.push({ role: 'system', content: sysParts.join('\n\n') });
  messages.push({ role: 'user', content: buildUserContent(prompt, att) });

  try {
    const r = await chatCompletionStream(cfg, {
      model,
      messages,
      web,
      onToken: (t) => process.stdout.write(t),
    });
    process.stdout.write('\n');
    if (r?.fellBack) console.error(`(Model chinh bi nghen — da chuyen sang model du phong: ${r.model})`);
  } catch (e) {
    console.error(`Loi: ${e.message}`);
    if (att.images.length && /support image input/i.test(e.message)) {
      console.error('Goi y: model dang dung khong nhan anh. Hay chon model vision :free, vi du: pe ask "..." --image <path> --model nvidia/nemotron-3.5-super-vl:free');
    }
    process.exitCode = 1;
  }
}
