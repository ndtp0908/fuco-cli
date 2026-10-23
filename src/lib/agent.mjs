// Vong lap agent (Buoc 1): model goi tool qua 2 duong —
//  1) native tool_calls (OpenAI) khi model ho tro;
//  2) fallback: model tra ve khoi ```json {"tool": "...", "args": {...}}.
// Ket qua tool duoc dua lai dang text de ca 2 duong deu doc duoc.
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

/**
 * Chay vong lap agent cho den khi model tra loi text (hoac het maxSteps).
 * - messages: lich su (da co system + user). Ham nay tu them cac message tool.
 * - onEvent(type, data): 'tool' {name,args} | 'result' {name,summary} | 'note' (text)
 * - firstReply: (tuy chon) ket qua chatCompletion da goi san cho buoc dau (chat streaming dung).
 * Tra ve { text, steps }.
 */
export async function runAgent({ cfg, model, messages, runner, onEvent, maxSteps = 14, firstReply } = {}) {
  const note = (t) => { if (onEvent) onEvent('note', t); };
  let steps = 0;
  let reply = firstReply || null;

  for (;;) {
    if (!reply) {
      reply = await chatCompletion(cfg, { model, messages, tools: TOOL_DEFS });
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
      return { text: reply.text, steps };
    }

    if (steps >= maxSteps) {
      const msg = `Da dung ${maxSteps} buoc tool. Pe dung lai de tranh lap vo han — anh xem ket qua tam thoi o tren va bao pe lam tiep neu can.`;
      note(msg);
      messages.push({ role: 'assistant', content: msg });
      return { text: msg, steps };
    }

    const results = [];
    for (const call of calls) {
      steps++;
      if (onEvent) onEvent('tool', { name: call.name, args: call.args, desc: describeToolCall(call.name, call.args) });
      const result = await runner.run(call.name, call.args);
      if (onEvent) onEvent('result', { name: call.name, summary: String(result).split('\n')[0].slice(0, 160) });
      results.push(`- ${call.name}: ${result}`);
    }
    messages.push({ role: 'user', content: `Ket qua tool:\n${results.join('\n\n')}\n\n(Neu can them tool thi goi tiep; xong thi tra loi ket qua cuoi cho nguoi dung.)` });
    reply = null;
  }
}
