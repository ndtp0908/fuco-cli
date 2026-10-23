// Backup file truoc khi pe sua/ghi de — phuc vu `pe undo` va /undo.
// Luu o ~/.pe/backups/ + index.json (file goc -> ban sao moi nhat).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { configDir } from './config.mjs';

function backupsDir(home) {
  return path.join(configDir(home), 'backups');
}

function indexPath(home) {
  return path.join(backupsDir(home), 'index.json');
}

async function readIndex(home) {
  try {
    return JSON.parse(await fs.readFile(indexPath(home), 'utf8'));
  } catch {
    return [];
  }
}

async function writeIndex(home, idx) {
  await fs.mkdir(backupsDir(home), { recursive: true });
  await fs.writeFile(indexPath(home), JSON.stringify(idx.slice(-200), null, 2) + '\n', 'utf8');
}

/** Sao luu file (neu ton tai). Tra ve duong dan ban sao hoac null. */
export async function backupFile(absPath, home) {
  let st;
  try {
    st = await fs.stat(absPath);
  } catch {
    return null; // file chua co — khong can backup
  }
  if (!st.isFile()) return null;
  const dir = backupsDir(home);
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = path.basename(absPath).replace(/[^\w.\-]+/g, '_');
  const dest = path.join(dir, `${stamp}__${safe}`);
  await fs.copyFile(absPath, dest);
  const idx = await readIndex(home);
  idx.push({ file: absPath, backup: dest, at: new Date().toISOString() });
  await writeIndex(home, idx);
  return dest;
}

/** Khoi phuc ban sao moi nhat cua file. Tra ve {backup} hoac null neu khong co. */
export async function restoreLatest(absPath, home) {
  const idx = await readIndex(home);
  const target = path.resolve(absPath);
  for (let i = idx.length - 1; i >= 0; i--) {
    if (path.resolve(idx[i].file) === target) {
      const entry = idx[i];
      await fs.copyFile(entry.backup, target);
      idx.splice(i, 1);
      await writeIndex(home, idx);
      return entry;
    }
  }
  return null;
}

/** Ban sao moi nhat cua bat ky file nao (cho `pe undo` khong tham so). */
export async function latestBackup(home) {
  const idx = await readIndex(home);
  return idx.length ? idx[idx.length - 1] : null;
}

export async function listBackups(home) {
  return readIndex(home);
}
