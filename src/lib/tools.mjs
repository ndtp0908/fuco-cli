// Tools cho che do agent (Buoc 1): doc/ghi/sua file + liet ke + grep + chay lenh
// trong pham vi thu muc project (cwd). Moi ghi de deu backup truoc (pe undo).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { backupFile } from './backup.mjs';

export const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Doc noi dung file text trong project.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Duong dan tuong doi trong project' },
          start: { type: 'number', description: 'Dong bat dau (mac dinh 1)' },
          end: { type: 'number', description: 'Dong ket thuc' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Ghi (tao moi hoac ghi de) 1 file trong project. File cu se duoc backup truoc.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string', description: 'Toan bo noi dung moi cua file' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Sua 1 doan trong file: thay old_text (phai xuat hien dung 1 lan) bang new_text.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string' },
          new_text: { type: 'string' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'Liet ke file trong project theo mau glob don gian (vd src/**/*.cs).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Mau glob, mac dinh **/*' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: 'Tim chu bieu thuc chinh quy trong cac file text cua project.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'Thu muc con de tim, mac dinh ca project' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_bash',
      description: 'Chay 1 lenh shell trong thu muc project (timeout 60s). Dung de build/test/git.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
        },
        required: ['command'],
      },
    },
  },
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', '.pe', '.vs', '.idea', 'target', '__pycache__']);
const MAX_RESULT = 9000;

function cap(s) {
  s = String(s ?? '');
  return s.length > MAX_RESULT ? s.slice(0, MAX_RESULT) + `\n... (cat bot, tong ${s.length} ky tu)` : s;
}

/** Lenh duoc coi la an toan o muc duyet 2 (chi xem, khong sua doi). */
const SAFE_CMD = /^\s*(ls|dir|pwd|cat|type|echo|head|tail|findstr|git\s+(status|diff|log|branch|show|remote)|node\s+--version|npm\s+(list|ls|--version)|dotnet\s+--version|get-childitem|get-content|get-location)\b/i;
/** Lenh pha hoai — chan o moi muc duyet. */
const CATASTROPHIC = /(rm\s+-rf\s+\/(?!\w)|rm\s+-rf\s+~|rm\s+-rf\s+\*|mkfs|format\s+[a-z]:|del\s+\/[sq]\s+[a-z]:\\|rd\s+\/s\s+\/q\s+[a-z]:\\|shutdown|reboot|dd\s+if=|>\s*\/dev\/sd|diskpart)/i;

export function describeToolCall(name, args) {
  switch (name) {
    case 'read_file': return `doc file ${args.path}`;
    case 'write_file': return `ghi file ${args.path} (${String(args.content || '').length} ky tu)`;
    case 'edit_file': return `sua file ${args.path}`;
    case 'list_files': return `liet ke file ${args.pattern || '**/*'}`;
    case 'grep': return `tim "${args.pattern}"`;
    case 'run_bash': return `chay lenh: ${args.command}`;
    default: return name;
  }
}

/**
 * Tao bo chay tool.
 * - root: thu muc project, khong thao tac ra ngoai.
 * - approval: 1 hoi tat ca | 2 doc tu do, ghi tu do trong project, lenh la thi hoi | 3 tu do (tru lenh pha hoai).
 * - confirm(desc) => Promise<boolean>: hoi nguoi dung khi can.
 */
export function createToolRunner({ root, approval = 2, confirm, home } = {}) {
  const base = path.resolve(root || process.cwd());

  function resolveInside(p) {
    if (!p || typeof p !== 'string') throw new Error('Thieu duong dan.');
    const abs = path.resolve(base, p);
    if (abs !== base && !abs.startsWith(base + path.sep)) {
      throw new Error(`Duong dan ra ngoai project bi chan: ${p}`);
    }
    return abs;
  }

  async function needApproval(name, args) {
    if (name === 'run_bash' && CATASTROPHIC.test(String(args.command || ''))) {
      return 'deny'; // chan cung moi muc
    }
    if (['read_file', 'list_files', 'grep'].includes(name)) return 'auto';
    if (name === 'run_bash') {
      if (approval === 3) return 'auto';
      if (approval === 2 && SAFE_CMD.test(String(args.command || ''))) return 'auto';
      return 'ask';
    }
    // write_file / edit_file
    return approval === 1 ? 'ask' : 'auto';
  }

  async function walk(dir, out, depth) {
    if (depth > 12 || out.length > 4000) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name), out, depth + 1);
      } else if (e.isFile()) {
        out.push(path.join(dir, e.name));
      }
    }
  }

  function globToRegex(glob) {
    // Dung placeholder truoc de cac buoc replace khong "an" lan nhau.
    const P1 = '\u0001'; // **/
    const P2 = '\u0002'; // **
    const P3 = '\u0003'; // *
    const P4 = '\u0004'; // ?
    const esc = glob
      .replace(/\*\*\//g, P1)
      .replace(/\*\*/g, P2)
      .replace(/\*/g, P3)
      .replace(/\?/g, P4)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .split(P1).join('(.*/)?')
      .split(P2).join('.*')
      .split(P3).join('[^/]*')
      .split(P4).join('.');
    return new RegExp('^' + esc + '$', 'i');
  }

  const impl = {
    async read_file(args) {
      const abs = resolveInside(args.path);
      const raw = await fs.readFile(abs, 'utf8');
      const lines = raw.split('\n');
      const start = Math.max(1, Number(args.start) || 1);
      const end = Math.min(lines.length, Number(args.end) || lines.length);
      const slice = lines.slice(start - 1, end);
      return cap(`File ${args.path} (${lines.length} dong), dong ${start}-${end}:\n` + slice.map((l, i) => `${start + i}: ${l}`).join('\n'));
    },
    async write_file(args) {
      const abs = resolveInside(args.path);
      await backupFile(abs, home);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, String(args.content ?? ''), 'utf8');
      return `Da ghi ${args.path} (${String(args.content ?? '').length} ky tu). File cu (neu co) da backup — pe undo de khoi phuc.`;
    },
    async edit_file(args) {
      const abs = resolveInside(args.path);
      const raw = await fs.readFile(abs, 'utf8');
      const oldText = String(args.old_text ?? '');
      const count = oldText ? raw.split(oldText).length - 1 : 0;
      if (count === 0) return 'LOI: khong tim thay doan old_text trong file. Hay doc lai file de lay dung noi dung.';
      if (count > 1) return `LOI: old_text xuat hien ${count} lan — can doan dai hon de xac dinh duy nhat.`;
      await backupFile(abs, home);
      await fs.writeFile(abs, raw.replace(oldText, String(args.new_text ?? '')), 'utf8');
      return `Da sua ${args.path}. File cu da backup — pe undo de khoi phuc.`;
    },
    async list_files(args) {
      const all = [];
      await walk(base, all, 0);
      const re = globToRegex(String(args.pattern || '**/*').replace(/\\/g, '/'));
      const rel = all.map((f) => path.relative(base, f).replace(/\\/g, '/')).filter((r) => re.test(r));
      return cap(rel.length ? `${rel.length} file:\n` + rel.slice(0, 300).join('\n') : 'Khong co file nao khop mau.');
    },
    async grep(args) {
      const sub = args.path ? resolveInside(args.path) : base;
      const all = [];
      await walk(sub, all, 0);
      let re;
      try { re = new RegExp(String(args.pattern), 'i'); } catch { return 'LOI: pattern khong phai regex hop le.'; }
      const hits = [];
      for (const f of all) {
        if (hits.length >= 100) break;
        let st;
        try { st = await fs.stat(f); } catch { continue; }
        if (st.size > 512 * 1024) continue;
        let raw;
        try { raw = await fs.readFile(f, 'utf8'); } catch { continue; }
        if (raw.includes('\0')) continue;
        const rel = path.relative(base, f).replace(/\\/g, '/');
        raw.split('\n').forEach((line, i) => {
          if (hits.length < 100 && re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
        });
      }
      return cap(hits.length ? hits.join('\n') : 'Khong tim thay ket qua nao.');
    },
    async run_bash(args) {
      const cmd = String(args.command || '');
      const out = await new Promise((resolve) => {
        exec(cmd, { cwd: base, timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
          resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), killed: !!err?.killed });
        });
      });
      return cap(`Lenh: ${cmd}\nExit: ${out.code}${out.killed ? ' (qua 60s bi dung)' : ''}\n--- stdout ---\n${out.stdout}\n--- stderr ---\n${out.stderr}`);
    },
  };

  /** Chay 1 tool, tra ve chuoi ket qua cho model. Khong bao gio nem loi ra ngoai. */
  async function run(name, args = {}) {
    if (!impl[name]) return `LOI: tool "${name}" khong ton tai.`;
    try {
      const policy = await needApproval(name, args);
      if (policy === 'deny') return 'LOI: lenh nay bi chan vi nguy hiem (pha hoai he thong). Khong thuc hien.';
      if (policy === 'ask') {
        const ok = confirm ? await confirm(describeToolCall(name, args)) : false;
        if (!ok) return 'Nguoi dung TU CHOI thao tac nay. Hay hoi lai hoac tim cach khac.';
      }
      return await impl[name](args);
    } catch (e) {
      return `LOI: ${e.message}`;
    }
  }

  return { run, base, toolNames: Object.keys(impl) };
}
