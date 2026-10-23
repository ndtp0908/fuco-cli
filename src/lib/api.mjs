// Client noi voi fuco-agent-proxy worker.
// Hop dong that (worker/src/index.js):
//  - moi request can header `x-proxy-auth: <MY_SECRET>`; sai/thieu -> worker tra
//    trang 404 GIA (status 200, text/html) de nguy trang.
//  - POST {url}/api/chat -> proxy sang OpenRouter /v1/chat/completions.
//    Worker CHAN CUNG: model phai ket thuc bang `:free`, neu khong -> 403.
//  - GET  {url}/api/models -> proxy sang OpenRouter /v1/models.

export class PeError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.name = 'PeError';
    this.kind = kind;   // 'network' | 'auth' | 'model' | 'http' | 'config' | 'usage'
    this.status = status;
  }
}

async function readBody(res) {
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { return await res.json(); } catch { return null; }
  }
  return await res.text();
}

function isFake404(res, body) {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  return ct.includes('text/html') || (typeof body === 'string' && /<title>\s*404/i.test(body));
}

/** fetch thap: gan header auth, phan loai loi ro rang. */
export async function apiFetch(cfg, apiPath, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  if (!cfg.workerUrl) throw new PeError('config', 'Chua co workerUrl. Chay `pe init` de cau hinh.');
  if (!cfg.proxySecret) throw new PeError('config', 'Chua co proxySecret. Chay `pe init` de cau hinh.');
  const url = cfg.workerUrl + apiPath;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'x-proxy-auth': cfg.proxySecret,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const msg = e?.cause?.code || e?.name || 'network error';
    throw new PeError('network', `Khong noi duoc toi worker (${msg}). Kiem tra URL va mang.`);
  }
  const data = await readBody(res);

  if (isFake404(res, data)) {
    throw new PeError('auth', 'Worker tra ve trang 404 gia — sai proxy secret HOAC sai worker URL. Chay `pe init` de nhap lai.');
  }
  if (res.status === 403) {
    const m = data?.error?.message || data?.message || '';
    if (/only :free models/i.test(m)) {
      throw new PeError('model', `Worker tu choi: chi cho phep model :free. ${m}`);
    }
    throw new PeError('http', `Worker tra 403. ${m}`, 403);
  }
  if (!res.ok) {
    const m = data?.error?.message || data?.message || res.statusText;
    throw new PeError('http', `Worker tra loi ${res.status}: ${m}`, res.status);
  }
  return data;
}

function checkModel(useModel) {
  if (!useModel || !String(useModel).endsWith(':free')) {
    throw new PeError('model', `Model "${useModel}" khong hop le: worker chi cho phep model ket thuc bang ":free".`);
  }
}

function parseToolCalls(message) {
  const raw = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return raw.map((tc) => {
    let args = {};
    try { args = JSON.parse(tc?.function?.arguments || '{}'); } catch { /* giu {} */ }
    return { id: tc?.id || '', name: tc?.function?.name || '', args };
  }).filter((tc) => tc.name);
}

/** Goi chat completions, tra ve text + tool calls (neu model dung native tools). */
export async function chatCompletion(cfg, { model, messages, temperature, maxTokens, tools } = {}) {
  const useModel = model || cfg.model;
  checkModel(useModel);
  const body = { model: useModel, messages };
  if (temperature !== undefined) body.temperature = temperature;
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  if (tools) body.tools = tools;
  const data = await apiFetch(cfg, '/api/chat', { method: 'POST', body, timeoutMs: 180000 });
  const message = data?.choices?.[0]?.message;
  const text = typeof message?.content === 'string' ? message.content : '';
  const toolCalls = parseToolCalls(message);
  if (!text && !toolCalls.length) {
    throw new PeError('http', 'Worker tra ve dinh dang la (thieu choices[0].message.content).');
  }
  return { text, toolCalls, model: useModel, raw: data };
}

/**
 * Goi chat completions dang STREAM (SSE cua OpenRouter qua worker).
 * onToken(chunk) duoc goi cho tung mau text. Tra ve toan van khi xong.
 * Loi auth/model/http duoc phan loai giong apiFetch truoc khi stream mo.
 */
export async function chatCompletionStream(cfg, { model, messages, onToken, timeoutMs = 240000 } = {}) {
  const useModel = model || cfg.model;
  checkModel(useModel);
  if (!cfg.workerUrl) throw new PeError('config', 'Chua co workerUrl. Chay `pe init` de cau hinh.');
  if (!cfg.proxySecret) throw new PeError('config', 'Chua co proxySecret. Chay `pe init` de cau hinh.');
  let res;
  try {
    res = await fetch(cfg.workerUrl + '/api/chat', {
      method: 'POST',
      headers: { 'x-proxy-auth': cfg.proxySecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: useModel, messages, stream: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const msg = e?.cause?.code || e?.name || 'network error';
    throw new PeError('network', `Khong noi duoc toi worker (${msg}). Kiem tra URL va mang.`);
  }
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('text/event-stream')) {
    // Worker tu choi truoc khi stream (sai secret / model...) — doc body de phan loai.
    const data = await readBody(res);
    if (isFake404(res, data)) {
      throw new PeError('auth', 'Worker tra ve trang 404 gia — sai proxy secret HOAC sai worker URL. Chay `pe init` de nhap lai.');
    }
    const m = data?.error?.message || data?.message || res.statusText || '';
    if (res.status === 403 && /only :free models/i.test(m)) {
      throw new PeError('model', `Worker tu choi: chi cho phep model :free. ${m}`);
    }
    if (!res.ok) throw new PeError('http', `Worker tra loi ${res.status}: ${m}`, res.status);
    // Khong phai stream nhung la JSON hop le (worker/model bo qua stream):
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text === 'string') {
      if (onToken) onToken(text);
      return { text, model: useModel };
    }
    throw new PeError('http', 'Worker tra ve dinh dang la khi stream.');
  }
  let full = '';
  let buf = '';
  const decoder = new TextDecoder();
  const handleLine = (line) => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const json = JSON.parse(payload);
      const delta = json?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) {
        full += delta;
        if (onToken) onToken(delta);
      }
    } catch { /* chunk vo, bo qua */ }
  };
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    }
    if (buf) handleLine(buf);
  } catch (e) {
    if (!full) {
      const msg = e?.cause?.code || e?.name || 'network error';
      throw new PeError('network', `Stream bi dut (${msg}).`);
    }
    // Da co mot phan noi dung — tra ve phan do, kem ghi chu.
    full += '\n[stream bi dut giua chung]';
  }
  return { text: full, model: useModel };
}

/** Lay danh sach model tu worker. */
export async function listModels(cfg) {
  const data = await apiFetch(cfg, '/api/models', { timeoutMs: 20000 });
  const arr = Array.isArray(data?.data) ? data.data : [];
  return arr.map((m) => m.id).filter(Boolean);
}

export function freeOnly(ids) {
  return ids.filter((id) => id.endsWith(':free'));
}
