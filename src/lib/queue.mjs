// Client noi voi pe-worker (hang doi KV) — dung cho pe assign/tasks/result.
// Hop dong (pe-worker/src/index.js):
//  - header `x-agent-secret: <MY_SECRET>` (cung secret voi proxy cua worker chinh)
//  - sai secret -> trang 404 gia (text/html)
//  - POST /task {type, title, input} -> {task_id, status}
//  - GET /pending -> {pending: [id]}; GET /processing -> {processing: [task]}
//  - GET /result/:id -> {status, result, error}; GET /task/:id -> task day du
import { PeError } from './api.mjs';

export async function queueFetch(cfg, apiPath, { method = 'GET', body, timeoutMs = 30000 } = {}) {
  if (!cfg.peWorkerUrl) throw new PeError('config', 'Chua co peWorkerUrl.');
  if (!cfg.proxySecret) throw new PeError('config', 'Chua co proxySecret. Chay `pe init` de cau hinh.');
  let res;
  try {
    res = await fetch(cfg.peWorkerUrl + apiPath, {
      method,
      headers: {
        'x-agent-secret': cfg.proxySecret,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const msg = e?.cause?.code || e?.name || 'network error';
    throw new PeError('network', `Khong noi duoc toi pe-worker (${msg}).`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/html')) {
    throw new PeError('auth', 'Pe-worker tra ve trang 404 gia — sai secret (MY_SECRET dung chung) hoac sai peWorkerUrl.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* giu null */ }
  if (!res.ok) {
    throw new PeError('http', `Pe-worker tra loi ${res.status}: ${data?.error || res.statusText}`, res.status);
  }
  return data;
}

export async function submitTask(cfg, { type = 'ask', title, input } = {}) {
  return queueFetch(cfg, '/task', { method: 'POST', body: { type, title, input } });
}

export async function getResult(cfg, id) {
  return queueFetch(cfg, `/result/${encodeURIComponent(id)}`);
}

export async function getTask(cfg, id) {
  return queueFetch(cfg, `/task/${encodeURIComponent(id)}`);
}

export async function listPending(cfg) {
  const d = await queueFetch(cfg, '/pending');
  return Array.isArray(d?.pending) ? d.pending : [];
}

export async function listProcessing(cfg) {
  const d = await queueFetch(cfg, '/processing');
  return Array.isArray(d?.processing) ? d.processing : [];
}

/** Trich cau tra loi tu result (co the la string, {answer}, hoac object khac). */
export function resultText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result.answer === 'string') return result.answer;
  return JSON.stringify(result, null, 2);
}
