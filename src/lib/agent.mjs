// Vong lap agent (Buoc 1): model goi tool qua 2 duong —
//  1) native tool_calls (OpenAI) khi model ho tro;
//  2) fallback: model tra ve khoi ```json {"tool": "...", "args": {...}}.
// Ket qua tool duoc dua lai dang text de ca 2 duong deu doc duoc.
import { createHash } from 'node:crypto';
import { chatCompletion } from './api.mjs';
import { TOOL_DEFS, describeToolCall } from './tools.mjs';

export const AGENT_SYSTEM = `Ban la pe, tro ly coding chay trong terminal cua nguoi dung, thao tac truc tiep tren project hien tai bang tools.

Tools: read_file, write_file, edit_file, list_files, grep, run_bash.

Quy tac:
- Can dung tool thi goi tool (native tool call, hoac tra ve DUY NHAT 1 khoi json nhu sau, khong kem giai thich):
\`\`\`json
{"tool": "read_file", "args": {"path": "src/Program.cs"}}
\`\`\`
- Xong viec thi tra loi text binh thuong, ngan gon, neu ro da sua file nao.
- Truoc khi sua file nen doc file truoc. Sua nho dung edit_file (old_text phai khop nguyen van, xuat hien dung 1 lan).
- File dai: read_file tra theo doan va ghi ro dong con lai — doc TIEP bang start o cuoi ket qua, dung doc lai doan da doc. Khong bao gio goi lai dung 1 tool voi dung args nhu cu (he thong se phat hien lap va dung).
- Khong tu y chay lenh nguy hiem. Neu tool bao LOI thi doc ky ly do roi moi thu lai.
- Duong dan file luon tuong doi so voi goc project.`;

const TOOL_JSON_RE = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/;

/** Trich xuat loi goi tool dang JSON-text tu cau tra loi (fallback). */
export function extractJsonToolCall(text) {
  if (!text) return null;
  const tryParse = (s) => {
    try {
      const o = JSON.parse(s);
      if (o && typeof o.tool === 'string' && o.args && typeof o.args === 'object') return { name: o.tool, args: o.args };
    } catch { /* khong phai json */ }
    return null;
  };
  const fenced = text.match(TOOL_JSON_RE);
  if (fenced) {
    const got = tryParse(fenced[1]);
    if (got) return got;
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    const whole = tryParse(trimmed);
    if (whole) return whole;
    // Model tra nhieu object lien nhau / kem text thua: lay object can bang dau tien
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const got = tryParse(trimmed.slice(0, i + 1));
          if (got) return got;
          break;
        }
      }
    }
  }
  return null;
}

function hashText(s) {
  return createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
}

/** Khoa chuan hoa cho 1 loi goi tool (args sap xep theo key cho on dinh). */
export function callKey(name, args) {
  const sorted = {};
  for (const k of Object.keys(args || {}).sort()) sorted[k] = args[k];
  return `${name}|${JSON.stringify(sorted)}`;
}

/**
 * Chay vong lap agent cho den khi model tra loi text.
 *
 * PHAT HIEN LAP THEO TIEN TRIEN (v0.6 — thay bo dem buoc mu maxSteps cu):
 * ban cu dem MOI luot goi tool vao 1 tran 14 buoc, nen doc file dai theo
 * tung doan (read_file phan trang), grep tim dan... deu bi cat ngang va
 * bao "lap" oan; nguoi dung go "tiep tuc" thi bo dem reset tu dau nen
 * doc them duoc chut lai dung tiep. Ban nay chi coi la LAP THAT khi:
 * cung 1 loi goi (tool + args giong het) tra ve ket qua GIONG HET lan
 * truoc — tuc khong ra them thong tin moi — lap lai `stallLimit` lan
 * lien tiep. Goi moi (args khac, vd doc doan tiep theo cua file) hoac
 * ket qua khac di (file vua bi sua) deu la TIEN TRIEN, reset bo dem lap.
 * Van con 1 tran an toan tong `maxSteps` luot goi (mac dinh 60) de
 * phong truong hop model di duong vong dai bat tan.
 *
 * - seen: Map dung chung xuyen cac luot chat trong 1 phien (chat truyen
 *   vao) de phat hien ca lap XUYEN LUOT; pe do chay 1 lan thi bo qua.
 * - messages: lich su (da co system + user). Ham nay tu them cac message tool.
 * - onEvent(type, data): 'tool' {name,args} | 'result' {name,summary} | 'note' (text)
 * - firstReply: (tuy chon) ket qua chatCompletion da goi san cho buoc dau (chat streaming dung).
 * Tra ve { text, steps, stopped: null | 'loop' | 'cap' }.
 */
export async function runAgent({ cfg, model, messages, runner, onEvent, maxSteps = 60, stallLimit = 3, seen, firstReply, signal } = {}) {
  const note = (t) => { if (onEvent) onEvent('note', t); };
  const seenMap = seen || new Map();
  let steps = 0;
  let stall = 0;
  let reply = firstReply || null;

  for (;;) {
    if (!reply) {
      reply = await chatCompletion(cfg, { model, messages, tools: TOOL_DEFS, signal });
    }
    const calls = [];
    if (reply.toolCalls && reply.toolCalls.length) {
      for (const tc of reply.toolCalls) calls.push({ name: tc.name, args: tc.args });
      // Ghi lai dang native de cac model chat tool hieu ngu canh
      messages.push({ role: 'assistant', content: reply.text || '', tool_calls: reply.raw?.choices?.[0]?.message?.tool_calls });
    } else {
      const jt = extractJsonToolCall(reply.text);
      if (jt) {
        calls.push(jt);
        messages.push({ role: 'assistant', content: reply.text });
      }
    }

    if (!calls.length) {
      messages.push({ role: 'assistant', content: reply.text });
      return { text: reply.text, steps, stopped: null };
    }

    if (steps >= maxSteps) {
      const msg = `Da dung ${maxSteps} luot tool trong 1 phien lam viec. Pe dung lai tai day — anh go "tiep tuc" de pe lam tiep tu cho nay (cac tool da chay van con trong ngu canh, pe khong lam lai tu dau).`;
      note(msg);
      messages.push({ role: 'assistant', content: msg });
      return { text: msg, steps, stopped: 'cap' };
    }

    const results = [];
    const batchSeen = new Map();
    for (const call of calls) {
      const key = callKey(call.name, call.args);
      if (batchSeen.has(key)) {
        // Trung nguyen xi trong CHINH vong tra loi nay: khong chay lai,
        // tra ghi chu de model dung ngay ket qua vua co.
        results.push(`- ${call.name}: (trung voi loi goi vua chay o tren — dung lai ket qua do, dung goi lai)`);
        continue;
      }
      steps++;
      if (onEvent) onEvent('tool', { name: call.name, args: call.args, desc: describeToolCall(call.name, call.args) });
      const result = String(await runner.run(call.name, call.args));
      if (onEvent) onEvent('result', { name: call.name, summary: result.split('\n')[0].slice(0, 160) });
      batchSeen.set(key, result);
      // Cham tien trien: goi moi hoac ket qua khac lan truoc = co thong
      // tin moi; trung ca goi lan ket qua = lap that.
      const h = hashText(result);
      const prev = seenMap.get(key);
      if (!prev || prev.hash !== h) stall = 0;
      else stall++;
      seenMap.set(key, { hash: h, count: (prev?.count || 0) + 1 });
      results.push(`- ${call.name}: ${result}`);
      if (stall >= stallLimit) break;
    }

    if (stall >= stallLimit) {
      const msg = `Phat hien vong lap that: pe vua goi trung cac tool giong het nhau ${stall} lan lien tiep ma khong ra them thong tin moi nen pe dung lai. Anh xem ket qua tam thoi o tren, neu can thi noi ro buoc tiep theo (hoac file/doan cu the) de pe lam tiep.`;
      note(msg);
      messages.push({ role: 'user', content: `Ket qua tool:\n${results.join('\n\n')}` });
      messages.push({ role: 'assistant', content: msg });
      return { text: msg, steps, stopped: 'loop' };
    }

    messages.push({ role: 'user', content: `Ket qua tool:\n${results.join('\n\n')}\n\n(Neu can them tool thi goi tiep; xong thi tra loi ket qua cuoi cho nguoi dung.)` });
    reply = null;
  }
}
