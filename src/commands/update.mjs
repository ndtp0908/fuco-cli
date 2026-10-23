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
  if (!res.ok) throw new Error(`HTTP ${res.status} khi tai ${url}`);
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
    if (ct.includes('text/html')) throw new Error('Nguon tai tra ve trang HTML thay vi file — tai thu cong bang link trong manifest.');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} khi tai file.`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
  return buf.length;
}

export async function runUpdate(args = []) {
  const checkOnly = args.includes('--check');
  const cfg = await loadConfig();
  const manifestUrl = process.env.PE_UPDATE_URL || cfg.updateUrl || DEFAULT_UPDATE_URL;
  console.log(`Ban hien tai: ${VERSION}`);
  let man;
  try {
    man = await fetchJson(manifestUrl);
  } catch (e) {
    console.error(`Khong tai duoc manifest cap nhat (${e.message}).`);
    console.error(`Nguon: ${manifestUrl}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Ban moi nhat: ${man.version} (${manifestUrl})`);
  if (compareVersions(man.version, VERSION) <= 0) {
    console.log('Ban dang dung la moi nhat roi.');
    return;
  }
  console.log(`Co ban moi ${man.version}!`);
  if (checkOnly) {
    console.log('Chay `pe update` de cap nhat.');
    return;
  }
  if (!isSea()) {
    console.log('Ban dang chay qua node (khong phai .exe) nen pe khong tu thay file.');
    console.log('Cap nhat thu cong: git pull repo fuco-cli (hoac tai pe.exe moi tu Drive/GitHub).');
    if (man.exeUrl) console.log(`Ban .exe moi: ${man.exeUrl}`);
    return;
  }
  if (!man.exeUrl || !man.sha256) {
    console.error('Manifest thieu exeUrl/sha256 nen khong tu tai duoc.');
    process.exitCode = 1;
    return;
  }
  const exePath = process.execPath;
  const tmpPath = exePath + '.new';
  console.log(`Dang tai ban moi (~${man.size ? Math.round(man.size / 1024 / 1024) + ' MB' : '?'})...`);
  try {
    await downloadTo(man.exeUrl, tmpPath);
    const data = await fs.readFile(tmpPath);
    const sha = createHash('sha256').update(data).digest('hex');
    if (sha.toLowerCase() !== String(man.sha256).toLowerCase()) {
      await fs.rm(tmpPath, { force: true });
      console.error('SHA256 khong khop — file tai ve co van de, HUY cap nhat de an toan.');
      process.exitCode = 1;
      return;
    }
    // Windows cho phep doi ten file exe dang chay: giu ban cu thanh .old roi thay.
    const oldPath = exePath + '.old';
    await fs.rm(oldPath, { force: true }).catch(() => {});
    await fs.rename(exePath, oldPath);
    await fs.rename(tmpPath, exePath);
    console.log(`Da cap nhat len ${man.version}. Ban cu giu tai ${oldPath} (xoa duoc sau khi chay on).`);
    console.log('Khoi dong lai pe de dung ban moi.');
  } catch (e) {
    console.error(`Cap nhat that bai: ${e.message}`);
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    process.exitCode = 1;
  }
}
