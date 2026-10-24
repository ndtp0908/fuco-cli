// Vong lap agent (Buoc 1): model goi tool qua 2 duong —
//  1) native tool_calls (OpenAI) khi model ho tro;
//  2) fallback: model tra ve khoi ```json {"tool": "...", "args": {...}}.
// Ket qua tool duoc dua lai dang text de ca 2 duong deu doc duoc.
import { createHash } from 'node:crypto';
import { chatCompletion } from './api.mjs';
import { TOOL_DEFS, describeToolCall } from './tools.mjs';
import { extractFirstUrl } from './attach.mjs';

export const AGENT_SYSTEM = `Bạn là pé, trợ lý coding chạy trong terminal của người dùng, thao tác trực tiếp trên project hiện tại bằng tools.

Tools: read_file, write_file, edit_file, list_files, grep, run_bash.

Quy tắc:
- Cần dùng tool thì gọi tool (native tool call, hoặc trả về DUY NHẤT 1 khối json như sau, không kèm giải thích):
\`\`\`json
{"tool": "read_file", "args": {"path": "src/Program.cs"}}
\`\`\`
- Xong việc thì trả lời text bình thường, ngắn gọn, nêu rõ đã sửa file nào.
- Trước khi sửa file nên đọc file trước. Sửa nhỏ dùng edit_file (old_text phải khớp nguyên văn, xuất hiện đúng 1 lần).
- File dài: read_file trả theo đoạn và ghi rõ dòng còn lại — đọc TIẾP bằng start ở cuối kết quả, đừng đọc lại đoạn đã đọc. Không bao giờ gọi lại đúng 1 tool với đúng args như cũ (hệ thống sẽ phát hiện lặp và dừng).
- Không tự ý chạy lệnh nguy hiểm. Nếu tool báo LOI thì đọc kỹ lý do rồi mới thử lại.
- Đường dẫn file luôn tương đối so với gốc project.`;

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
export async function runAgent({ cfg, model, messages, runner, onEvent, maxSteps = 60, stallLimit = 3, seen, firstReply, signal, web, healRounds = 1 } = {}) {
  const note = (t) => { if (onEvent) onEvent('note', t); };
  const seenMap = seen || new Map();
  let steps = 0;
  let stall = 0;
  let reply = firstReply || null;
  // Web search chi ap cho lan goi DAU cua luot (cau hoi goc cua nguoi
  // dung); cac buoc agent sau do tin nhan cuoi la ket qua tool — tim web
  // theo do chi ton cong va nhieu ngu canh.
  let webPending = !!web && !firstReply;
  // URL1: link dan trong cau hoi goc -> worker tai trang, cung chi ap
  // cho lan goi model DAU cua luot (nhu web).
  let readUrlPending = null;
  if (!firstReply) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const c = messages[i];
      if (c && c.role === 'user' && typeof c.content === 'string') {
        readUrlPending = extractFirstUrl(c.content);
        break;
      }
    }
  }

  // Su co phuc vu rut bai hoc (v0.8): ghi lai cac loi tool THAT SU
  // (prefix LOI: hoac run_bash exit != 0), toi da 8, khong trung. Luot
  // chay ket thuc thanh cong (stopped === null) + co incidents nghia la
  // "loi -> sua -> xong": ben goi (do/chat) se rut bai hoc tu day.
  const incidents = [];
  // Loi CHUA duoc xu ly (v0.9 tu chua): loi xay ra ma chua co lan goi
  // THANH CONG nao cua CUNG tool do o sau no. Model tra loi text ket
  // thuc trong khi unresolved con -> chua xong viec.
  const unresolved = [];
  let healLeft = healRounds;
  const isErrorResult = (name, result) =>
    result.startsWith('LOI:') || (name === 'run_bash' && /\nExit: [1-9]/.test(`\n${result}`));
  const pushIncident = (name, args, result) => {
    const firstLine = result.split('\n')[0].slice(0, 200);
    let entry = incidents.find((i) => i.tool === name && i.error.split('\n')[0] === firstLine);
    if (!entry && incidents.length < 8) {
      entry = { tool: name, desc: describeToolCall(name, args), error: String(result).slice(0, 400) };
      incidents.push(entry);
    }
    if (entry && !unresolved.includes(entry)) unresolved.push(entry);
  };

  for (;;) {
    if (!reply) {
      reply = await chatCompletion(cfg, { model, messages, tools: TOOL_DEFS, signal, web: webPending, readUrl: readUrlPending || undefined });
      webPending = false;
      readUrlPending = null;
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
      // TU CHUA (v0.9): model dinh ket thuc nhung van con loi chua xu
      // ly -> khong cho ket thuc, mom lai loi va yeu cau sua tiep
      // (toi da healRounds luot nhu nay trong 1 lan chay).
      if (healLeft > 0 && unresolved.length) {
        healLeft--;
        const errs = unresolved
          .map((i) => `- ${i.desc}: ${String(i.error).split('\n')[0].slice(0, 160)}`)
          .join('\n');
        note(`[tự chữa] Còn ${unresolved.length} lỗi chưa xử lý — pé yêu cầu model sửa tiếp thay vì kết thúc.`);
        messages.push({ role: 'assistant', content: reply.text });
        messages.push({
          role: 'user',
          content: `Vẫn còn lỗi chưa được xử lý:\n${errs}\n\nHãy dùng tool sửa cho xong rồi kiểm tra lại kết quả. Nếu thật sự không thể sửa thì trả lời giải thích rõ lý do, không gọi tool nữa.`,
        });
        unresolved.length = 0;
        reply = null;
        continue;
      }
      messages.push({ role: 'assistant', content: reply.text });
      return { text: reply.text, steps, stopped: null, incidents, unresolved };
    }

    if (steps >= maxSteps) {
      const msg = `Đã dùng ${maxSteps} lượt tool trong 1 phiên làm việc. Pé dừng lại tại đây — anh gõ "tiếp tục" để pé làm tiếp từ chỗ này (các tool đã chạy vẫn còn trong ngữ cảnh, pé không làm lại từ đầu).`;
      note(msg);
      messages.push({ role: 'assistant', content: msg });
      return { text: msg, steps, stopped: 'cap', incidents, unresolved };
    }

    const results = [];
    const batchSeen = new Map();
    for (const call of calls) {
      const key = callKey(call.name, call.args);
      if (batchSeen.has(key)) {
        // Trung nguyen xi trong CHINH vong tra loi nay: khong chay lai,
        // tra ghi chu de model dung ngay ket qua vua co.
        results.push(`- ${call.name}: (trùng với lời gọi vừa chạy ở trên — dùng lại kết quả đó, đừng gọi lại)`);
        continue;
      }
      steps++;
      if (onEvent) onEvent('tool', { name: call.name, args: call.args, desc: describeToolCall(call.name, call.args) });
      const result = String(await runner.run(call.name, call.args));
      if (isErrorResult(call.name, result)) pushIncident(call.name, call.args, result);
      else {
        // Tool nay vua chay thanh cong -> cac loi truoc cua CHINH no
        // coi nhu da duoc xu ly.
        for (let i = unresolved.length - 1; i >= 0; i--) {
          if (unresolved[i].tool === call.name) unresolved.splice(i, 1);
        }
      }
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
      const msg = `Phát hiện vòng lặp thật: pé vừa gọi trùng các tool giống hệt nhau ${stall} lần liên tiếp mà không ra thêm thông tin mới nên pé dừng lại. Anh xem kết quả tạm thời ở trên, nếu cần thì nói rõ bước tiếp theo (hoặc file/đoạn cụ thể) để pé làm tiếp.`;
      note(msg);
      messages.push({ role: 'user', content: `Ket qua tool:\n${results.join('\n\n')}` });
      messages.push({ role: 'assistant', content: msg });
      return { text: msg, steps, stopped: 'loop', incidents, unresolved };
    }

    messages.push({ role: 'user', content: `Ket qua tool:\n${results.join('\n\n')}\n\n(Nếu cần thêm tool thì gọi tiếp; xong thì trả lời kết quả cuối cho người dùng.)` });
    reply = null;
  }
}
