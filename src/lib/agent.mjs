// Vong lap agent (Buoc 1): model goi tool qua 2 duong —
//  1) native tool_calls (OpenAI) khi model ho tro;
//  2) fallback: model tra ve cac khoi ```json {"tool": "...", "args": {...}}.
//     Parser tu sua loi JSON thuong gap cua model free (newline that trong
//     chuoi, dau phay thua) va lay DUOC NHIEU call trong 1 luot.
// Ket qua tool duoc dua lai dang text de ca 2 duong deu doc duoc.
import { createHash } from 'node:crypto';
import { chatCompletion } from './api.mjs';
import { TOOL_DEFS, describeToolCall } from './tools.mjs';
import { extractFirstUrl } from './attach.mjs';
import { logToolEvent, toolcallLogPath } from './toolcall-log.mjs';

export const AGENT_SYSTEM = `Bạn là pé, trợ lý coding chạy trong terminal của người dùng, thao tác trực tiếp trên project hiện tại bằng tools.

Tools: read_file, write_file, edit_file, list_files, grep, run_bash.

Quy tắc:
- Cần dùng tool thì gọi tool (native tool call, hoặc trả về các khối json, mỗi khối là 1 tool call, không kèm giải thích ngoài khối):
\`\`\`json
{"tool": "read_file", "args": {"path": "src/Program.cs"}}
\`\`\`
- Được trả NHIỀU khối json trong 1 lượt, theo đúng thứ tự cần chạy.
- Trong chuỗi JSON: xuống dòng phải viết \\n, tab viết \\t, không để dấu phẩy cuối trước } hoặc ].
- Xong việc thì trả lời text bình thường, ngắn gọn, nêu rõ đã sửa file nào.
- Trước khi sửa file nên đọc file trước. Sửa nhỏ dùng edit_file (old_text phải khớp nguyên văn, xuất hiện đúng 1 lần).
- File dài: read_file trả theo đoạn và ghi rõ dòng còn lại — đọc TIẾP bằng start ở cuối kết quả, đừng đọc lại đoạn đã đọc. Không bao giờ gọi lại đúng 1 tool với đúng args như cũ (hệ thống sẽ phát hiện lặp và dừng).
- Không tự ý chạy lệnh nguy hiểm. Nếu tool báo LOI thì đọc kỹ lý do rồi mới thử lại.
- Đường dẫn file luôn tương đối so với gốc project.`;

/**
 * Ghi chú shell cho agent (dot25b): mỗi lệnh run_bash chạy trong một
 * shell MỚI tại thư mục project nên cd không có tác dụng bền, và
 * lệnh phải đúng hệ điều hành — model hay phí lượt vào pwd/cd/ls
 * trên Windows vì không biết điều này.
 */
export function shellNote() {
  const win = process.platform === 'win32';
  return `Môi trường shell: ${win ? 'Windows cmd.exe — dùng dir, type, mkdir, echo, findstr; KHÔNG dùng lệnh Unix (ls, cat, grep, sed, rm)' : 'shell Unix — dùng ls, cat, grep, sed'}.\nMỗi lệnh run_bash chạy trong một shell MỚI tại thư mục project: lệnh cd không có tác dụng sang lệnh sau — luôn dùng đường dẫn tuyệt đối hoặc tương đối từ gốc project, đừng cd rồi mới làm việc.`;
}

const KNOWN_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'list_files', 'grep', 'run_bash']);
export function isKnownTool(name) { return KNOWN_TOOLS.has(name); }
// Map ten tool la ve tool that (model free hay viet tat / sai dinh dang
// ten: readfile, shell, search...). Chi map TEN, khong doan args — sai
// args thi runner tra LOI, model tu sua (doan bua args nguy hiem hon,
// vd ghi nham file).
const TOOL_ALIASES = {
  read: 'read_file', cat: 'read_file', open: 'read_file', view: 'read_file', show: 'read_file',
  write: 'write_file', create: 'write_file', save: 'write_file',
  edit: 'edit_file', modify: 'edit_file', patch: 'edit_file', replace: 'edit_file',
  list: 'list_files', ls: 'list_files', dir: 'list_files', glob: 'list_files', files: 'list_files',
  search: 'grep', find: 'grep',
  bash: 'run_bash', shell: 'run_bash', exec: 'run_bash', run: 'run_bash',
  command: 'run_bash', cmd: 'run_bash', terminal: 'run_bash',
};
function mapToolName(name) {
  if (KNOWN_TOOLS.has(name)) return name;
  const flat = String(name).toLowerCase().replace(/[^a-z]/g, '');
  for (const t of KNOWN_TOOLS) if (flat === t.replace(/_/g, '')) return t;
  return TOOL_ALIASES[String(name).toLowerCase()] || null;
}

/** Tim index SAU '}' dong object JSON bat dau tai i (ton trong chuoi/escape). -1 neu khong can bang. */
function matchObject(text, i) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (; i < text.length; i++) {
    const ch = text[i];
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
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Sua loi JSON thuong gap cua model free: newline/tab/ky tu dieu khien THAT trong chuoi. */
function repairJsonString(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      if (ch < ' ') { out += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'); continue; }
      out += ch;
      continue;
    }
    if (ch === '"') inStr = true;
    out += ch;
  }
  return out;
}

/** Parse 1 object tool-call, thu lan luot: goc -> sua newline -> sua newline + bo dau phay thua. */
function parseToolObject(s) {
  const tryAll = (cand) => {
    try {
      const o = JSON.parse(cand);
      if (o && typeof o.tool === 'string' && o.args && typeof o.args === 'object') {
        // Tool la: map ve tool that neu map duoc; khong map duoc thi GIU
        // NGUYEN ten — runner se tra LOI ("tool X khong ton tai") va vong
        // lap agent dua loi do lai cho model tu sua, thay vi drop im lang.
        // Lap lai tool la giong het 3 lan thi bo phat hien stall dung lai.
        // rawName giu ten goc de log map (phuc vu map tay ve sau).
        return { name: mapToolName(o.tool) || o.tool, args: o.args, rawName: o.tool };
      }
    } catch { /* thu cach sua tiep theo */ }
    return null;
  };
  return tryAll(s)
    || tryAll(repairJsonString(s))
    || tryAll(repairJsonString(s).replace(/,\s*([}\]])/g, '$1'))
    || tryAll(s.replace(/,\s*([}\]])/g, '$1'));
}

/**
 * Trich TAT CA loi goi tool dang JSON-text tu cau tra loi (fallback), theo thu tu xuat hien.
 * Nhan: khoi fence ```json {...} va JSON tran {"tool": ...} nam giua prose.
 * Ten tool la duoc map ve tool that (alias); ten khong map duoc van giu
 * nguyen de runner tra LOI cho model tu sua.
 */
export function extractJsonToolCalls(text) {
  if (!text) return [];
  const calls = [];
  const done = new Set(); // vi tri bat dau da xu ly (fence + scan tran khoi chong lap)
  const fenceRe = /```(?:json)?[ \t]*\r?\n?/g;
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    let i = m.index + m[0].length;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '{') continue; // fence code thuong, khong phai tool JSON
    const end = matchObject(text, i);
    if (end === -1) continue; // cat do / hong -> looksLikeToolJson bao
    const got = parseToolObject(text.slice(i, end));
    if (got) { calls.push(got); done.add(i); }
    fenceRe.lastIndex = end; // bo qua phan trong fence
  }
  const headRe = /\{\s*"tool"\s*:/g;
  while ((m = headRe.exec(text)) !== null) {
    if (done.has(m.index)) continue;
    const end = matchObject(text, m.index);
    if (end === -1) continue;
    const got = parseToolObject(text.slice(m.index, end));
    if (got) calls.push(got);
  }
  return calls;
}

/** Lay loi goi tool dau tien (tuong thich nguoc). */
export function extractJsonToolCall(text) {
  return extractJsonToolCalls(text)[0] || null;
}

/**
 * Text co dau hieu model DINH goi tool nhung JSON hong/cat do nen khong trich duoc?
 * Dung de runAgent xin model gui lai thay vi coi doan text do la dap an cuoi.
 */
export function looksLikeToolJson(text) {
  if (!text) return { broken: false, truncated: false };
  if (extractJsonToolCalls(text).length) return { broken: false, truncated: false };
  const fenceRe = /```(?:json)?[ \t]*\r?\n?/g;
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    let i = m.index + m[0].length;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] === '{') {
      return matchObject(text, i) === -1
        ? { broken: true, truncated: true }
        : { broken: true, truncated: false };
    }
  }
  const headRe = /\{\s*"tool"\s*:/g;
  while ((m = headRe.exec(text)) !== null) {
    return matchObject(text, m.index) === -1
      ? { broken: true, truncated: true }
      : { broken: true, truncated: false };
  }
  // JSON viet bang nhay don {'tool': ...} — khong parse duoc, nhung ro
  // rang model dinh goi tool -> retry xin gui lai dung dinh dang.
  if (/\{\s*'tool'\s*:/.test(text)) return { broken: true, truncated: false };
  return { broken: false, truncated: false };
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
 * Tra ve { text, steps, stopped: null | 'loop' | 'cap', brokenJson: true neu text cuoi
 * van chua JSON tool hong sau khi da retry }.
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
  // Retry khi model DINH goi tool nhung JSON hong (toi da 1 lan / luot
  // chay): xin model gui lai thay vi coi doan text do la dap an cuoi —
  // day la goc cua hien tuong "in JSON tho + khong chay tool" o ban cu.
  let brokenRetryLeft = 1;
  // Log tool-call fail (dot log): ghi loi, bao 1 lan neu khong ghi duoc.
  let logWarned = false;
  const logFail = (e) => {
    if (!logToolEvent(e) && !logWarned) {
      logWarned = true;
      note(`[log] Không ghi được log tool-call vào ${toolcallLogPath()} — kiểm tra quyền ghi thư mục.`);
    }
  };
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
    // Model that su dung o luot nay (co the fallback khac model yeu cau).
    const usedModel = reply.model || model;
    const calls = [];
    if (reply.toolCalls && reply.toolCalls.length) {
      for (const tc of reply.toolCalls) calls.push({ name: tc.name, args: tc.args });
      // Ghi lai dang native de cac model chat tool hieu ngu canh
      messages.push({ role: 'assistant', content: reply.text || '', tool_calls: reply.raw?.choices?.[0]?.message?.tool_calls });
    } else {
      const jts = extractJsonToolCalls(reply.text);
      if (jts.length) {
        calls.push(...jts);
        messages.push({ role: 'assistant', content: reply.text });
      }
    }

    if (!calls.length) {
      // JSON HONG (dot fix): model dinh goi tool nhung sai dinh dang
      // hoac bi cat do -> xin gui lai 1 lan, khong coi la dap an cuoi.
      const broken = looksLikeToolJson(reply.text);
      if (brokenRetryLeft > 0 && broken.broken) {
        brokenRetryLeft--;
        logFail({ type: 'extract-retry', model: usedModel, detail: broken.truncated ? 'JSON cat do' : 'JSON sai dinh dang', raw: reply.text });
        note(broken.truncated
          ? '[JSON cắt dở] Lời gọi tool vừa rồi thiếu phần cuối — pé xin model gửi lại đầy đủ.'
          : '[JSON hỏng] Lời gọi tool vừa rồi sai định dạng nên không chạy được tool nào — pé xin model gửi lại đúng dạng.');
        messages.push({ role: 'assistant', content: reply.text });
        messages.push({
          role: 'user',
          content: broken.truncated
            ? 'Lời gọi tool vừa rồi bị CẮT DỞ giữa chừng (thiếu phần cuối JSON). Hãy gửi lại ĐẦY ĐỦ lời gọi tool đó, đúng 1 khối ```json, không kèm giải thích ngoài khối.'
            : 'Lời gọi tool vừa rồi SAI ĐỊNH DẠNG JSON nên pé không chạy được tool nào. Hãy gửi lại, mỗi tool call là 1 khối ```json hoàn chỉnh dạng {"tool": ..., "args": {...}}; trong chuỗi JSON, xuống dòng phải viết \\n, tab viết \\t, không để dấu phẩy cuối trước } hoặc ]. Không kèm giải thích ngoài khối.',
        });
        reply = null;
        continue;
      }
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
      if (broken.broken) {
        logFail({ type: 'extract-failed', model: usedModel, detail: broken.truncated ? 'JSON cat do (da retry 1 lan van hong)' : 'JSON sai dinh dang (da retry 1 lan van hong)', raw: reply.text });
      }
      return { text: reply.text, steps, stopped: null, incidents, unresolved, brokenJson: broken.broken };
    }

    if (steps >= maxSteps) {
      const msg = `Đã dùng ${maxSteps} lượt tool trong 1 phiên làm việc. Pé dừng lại tại đây — anh gõ "tiếp tục" để pé làm tiếp từ chỗ này (các tool đã chạy vẫn còn trong ngữ cảnh, pé không làm lại từ đầu).`;
      note(msg);
      logFail({ type: 'cap-stop', model: usedModel, detail: `dung o tran ${maxSteps} luot` });
      messages.push({ role: 'assistant', content: msg });
      return { text: msg, steps, stopped: 'cap', incidents, unresolved, brokenJson: false };
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
      // Log map + tool la truoc khi chay (de map tay ve sau).
      if (call.rawName && call.rawName !== call.name) {
        logFail({ type: 'alias-mapped', model: usedModel, tool: call.name, rawTool: call.rawName, args: call.args });
      } else if (!KNOWN_TOOLS.has(call.name)) {
        logFail({ type: 'unknown-tool', model: usedModel, tool: call.name, args: call.args });
      }
      steps++;
      if (onEvent) onEvent('tool', { name: call.name, args: call.args, desc: describeToolCall(call.name, call.args) });
      const result = String(await runner.run(call.name, call.args));
      if (isErrorResult(call.name, result)) {
        pushIncident(call.name, call.args, result);
        logFail({ type: 'tool-error', model: usedModel, tool: call.name, args: call.args, detail: result });
      }
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
      logFail({ type: 'loop-stop', model: usedModel, detail: `lap that: trung tool + ket qua ${stall} lan lien tiep` });
      messages.push({ role: 'user', content: `Ket qua tool:\n${results.join('\n\n')}` });
      messages.push({ role: 'assistant', content: msg });
      return { text: msg, steps, stopped: 'loop', incidents, unresolved, brokenJson: false };
    }

    messages.push({ role: 'user', content: `Ket qua tool:\n${results.join('\n\n')}\n\n(Nếu cần thêm tool thì gọi tiếp; xong thì trả lời kết quả cuối cho người dùng.)` });
    reply = null;
  }
}
