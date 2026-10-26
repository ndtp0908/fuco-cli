// Log cac loi goi tool THAT BAI ra file .txt de nguoi dung tu kiem tra,
// map lai tool khi model doi cach goi, hoac phat hien model moi goi khac.
// Ghi append, dong bo (ghi xong moi chay tiep — su kien fail hiem nen
// khong dang ke), khong bao gio lam hong luot chay: ghi loi thi tra false.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { configDir } from './config.mjs';

export const TOOLCALL_LOG_NAME = 'pe-toolcall-failures.txt';

function isSea() {
  try {
    const req = createRequire(pathToFileURL(process.execPath));
    return req('node:sea').isSea();
  } catch { return false; }
}

/**
 * Vi tri file log (uu tien):
 * 1) PE_TOOLCALL_LOG (ghi de, duong dan tuy y)
 * 2) Ban dong goi SEA: cung thu muc voi pe.exe
 * 3) Chay tu source: thu muc pe home (PE_HOME/.pe) — tranh ghi canh node.exe
 */
export function toolcallLogPath() {
  if (process.env.PE_TOOLCALL_LOG) return process.env.PE_TOOLCALL_LOG;
  if (isSea()) return path.join(path.dirname(process.execPath), TOOLCALL_LOG_NAME);
  return path.join(configDir(), TOOLCALL_LOG_NAME);
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Rut gon args de log khoi phong: chuoi dai cat 200 ky tu + ghi do dai that.
function summarizeArgs(args) {
  const cut = (v) => {
    if (typeof v === 'string' && v.length > 200) return v.slice(0, 200) + `... (tong ${v.length} ky tu)`;
    if (Array.isArray(v)) return v.map(cut);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = cut(v[k]);
      return o;
    }
    return v;
  };
  try { return JSON.stringify(cut(args)); } catch { return '(args khong stringify duoc)'; }
}

/**
 * Ghi 1 muc log. event: { type, model, tool, rawTool, args, detail, raw }
 * type: 'extract-failed' | 'extract-retry' | 'unknown-tool' | 'alias-mapped'
 *       | 'tool-error' | 'loop-stop' | 'cap-stop'
 * Tra ve true neu ghi duoc, false neu khong (nguoi goi tu quyet co bao hay khong).
 * Chi ghi FAIL + map — luot chay tot khong ghi gi, file khong bi rac.
 */
export function logToolEvent(event) {
  const file = toolcallLogPath();
  const lines = [];
  lines.push(`=== ${stamp()} | ${event.type} | model=${event.model || '?'} ===`);
  if (event.tool) lines.push(`tool: ${event.tool}`);
  if (event.rawTool && event.rawTool !== event.tool) lines.push(`ten goc tu model: ${event.rawTool}`);
  if (event.args !== undefined) lines.push(`args: ${summarizeArgs(event.args)}`);
  if (event.detail) lines.push(`chi tiet: ${String(event.detail).split('\n')[0].slice(0, 500)}`);
  if (event.raw) lines.push(`doan tho tu model: ${String(event.raw).slice(0, 1000)}`);
  lines.push('');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, lines.join('\n'), 'utf8');
    return true;
  } catch {
    return false;
  }
}
