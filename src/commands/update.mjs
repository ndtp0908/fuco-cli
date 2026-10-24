// `pe update` — tu cap nhat ban .exe (Goi A2).
// Nguon: file manifest JSON (mac dinh tren repo GitHub cua pe, doi bang
// PE_UPDATE_URL hoac config updateUrl): {version, exeUrl, sha256, size}.
// Chi tu thay file khi dang chay dang SEA (file .exe don le); chay bang
// node thi chi bao ban moi + huong dan cap nhat qua git.
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadConfig } from '../lib/config.mjs';
import { VERSION, compareVersions } from '../lib/version.mjs';

export const DEFAULT_UPDATE_URL = 'https://raw.githubusercontent.com/ndtp0908/fuco-cli/main/release/pe-update.json';

function isSea() {
  try {
    const req = createRequire(import.meta.url);
    return req('node:sea').isSea();
  } catch {
    return false;
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} khi tải ${url}`);
  return res.json();
}

/** Tai file (co xu ly trang confirm cua Google Drive cho file lon). */
async function downloadTo(url, dest) {
  let res = await fetch(url, { signal: AbortSignal.timeout(600000), redirect: 'follow' });
  let ct = res.headers.get('content-type') || '';
  if (ct.includes('text/html')) {
    const html = await res.text();
    const m = html.match(/confirm=([0-9A-Za-z_-]+)/) || html.match(/name="confirm" value="([^"]+)"/);
    if (m && url.includes('drive.google.com')) {
      const u = new URL(url);
      u.searchParams.set('confirm', m[1]);
      res = await fetch(u.toString(), { signal: AbortSignal.timeout(600000), redirect: 'follow' });
      ct = res.headers.get('content-type') || '';
    }
    if (ct.includes('text/html')) throw new Error('Nguồn tải trả về trang HTML thay vì file — tải thủ công bằng link trong manifest.');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} khi tải file.`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
  return buf.length;
}

export async function runUpdate(args = []) {
  const checkOnly = args.includes('--check');
  const cfg = await loadConfig();
  const manifestUrl = process.env.PE_UPDATE_URL || cfg.updateUrl || DEFAULT_UPDATE_URL;
  console.log(`Bản hiện tại: ${VERSION}`);
  let man;
  try {
    man = await fetchJson(manifestUrl);
  } catch (e) {
    console.error(`Không tải được manifest cập nhật (${e.message}).`);
    console.error(`Nguồn: ${manifestUrl}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Bản mới nhất: ${man.version} (${manifestUrl})`);
  if (compareVersions(man.version, VERSION) <= 0) {
    console.log('Bản đang dùng là mới nhất rồi.');
    return;
  }
  console.log(`Có bản mới ${man.version}!`);
  if (checkOnly) {
    console.log('Chạy `pe update` để cập nhật.');
    return;
  }
  if (!isSea()) {
    console.log('Bản đang chạy qua node (không phải .exe) nên pé không tự thay file.');
    console.log('Cập nhật thủ công: git pull repo fuco-cli (hoặc tải pe.exe mới từ Drive/GitHub).');
    if (man.exeUrl) console.log(`Bản .exe mới: ${man.exeUrl}`);
    return;
  }
  if (!man.exeUrl || !man.sha256) {
    console.error('Manifest thiếu exeUrl/sha256 nên không tự tải được.');
    process.exitCode = 1;
    return;
  }
  const exePath = process.execPath;
  const tmpPath = exePath + '.new';
  console.log(`Đang tải bản mới (~${man.size ? Math.round(man.size / 1024 / 1024) + ' MB' : '?'})...`);
  try {
    await downloadTo(man.exeUrl, tmpPath);
    const data = await fs.readFile(tmpPath);
    const sha = createHash('sha256').update(data).digest('hex');
    if (sha.toLowerCase() !== String(man.sha256).toLowerCase()) {
      await fs.rm(tmpPath, { force: true });
      console.error('SHA256 không khớp — file tải về có vấn đề, HUỶ cập nhật để an toàn.');
      process.exitCode = 1;
      return;
    }
    // Windows cho phep doi ten file exe dang chay: giu ban cu thanh .old roi thay.
    const oldPath = exePath + '.old';
    await fs.rm(oldPath, { force: true }).catch(() => {});
    await fs.rename(exePath, oldPath);
    await fs.rename(tmpPath, exePath);
    console.log(`Đã cập nhật lên ${man.version}. Bản cũ giữ tại ${oldPath} (xoá được sau khi chạy ổn).`);
    console.log('Khởi động lại pé để dùng bản mới.');
  } catch (e) {
    console.error(`Cập nhật thất bại: ${e.message}`);
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    process.exitCode = 1;
  }
}
