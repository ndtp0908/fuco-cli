// Phien chat (Buoc 2): luu lich su vao ~/.pe/sessions/<id>.json de mo lai duoc.
// Moi phien: {id, title, cwd, model, createdAt, updatedAt, summary, messages}
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { configDir } from './config.mjs';

export function sessionsDir(home) {
  return path.join(configDir(home), 'sessions');
}

function sessionPath(id, home) {
  return path.join(sessionsDir(home), `${id}.json`);
}

export function newSessionId() {
  return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export async function createSession({ cwd, model } = {}, home) {
  const s = {
    id: newSessionId(),
    title: '',
    cwd: cwd || process.cwd(),
    model: model || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    summary: null, // {text, count} — ban tom tat cac tin da rut gon
    messages: [],
  };
  await saveSession(s, home);
  return s;
}

export async function saveSession(s, home) {
  const dir = sessionsDir(home);
  await fs.mkdir(dir, { recursive: true });
  s.updatedAt = new Date().toISOString();
  if (!s.title && s.messages.length) {
    const firstUser = s.messages.find((m) => m.role === 'user');
    if (firstUser && typeof firstUser.content === 'string') s.title = firstUser.content.slice(0, 60);
  }
  await fs.writeFile(sessionPath(s.id, home), JSON.stringify(s, null, 2) + '\n', 'utf8');
  return s;
}

export async function loadSession(id, home) {
  try {
    return JSON.parse(await fs.readFile(sessionPath(id, home), 'utf8'));
  } catch {
    return null;
  }
}

export async function listSessions(home) {
  let names = [];
  try {
    names = await fs.readdir(sessionsDir(home));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const s = await loadSession(n.replace(/\.json$/, ''), home);
    if (s) out.push(s);
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}

export async function latestSession(home) {
  const all = await listSessions(home);
  return all.length ? all[0] : null;
}

/** Xoa 1 phien theo id. Tra true neu da xoa, false neu khong ton tai. */
export async function deleteSession(id, home) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(id || ''))) return false;
  try {
    await fs.unlink(sessionPath(id, home));
    return true;
  } catch {
    return false;
  }
}
