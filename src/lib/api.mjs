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
export async function apiFetch(cfg, apiPath, { method = 'GET', body, timeoutMs = 15000, signal } = {}) {
  if (!cfg.workerUrl) throw new PeError('config', 'Chưa có workerUrl. Chạy `pe init` để cấu hình.');
  if (!cfg.proxySecret) throw new PeError('config', 'Chưa có proxySecret. Chạy `pe init` để cấu hình.');
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
      signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw networkError(e);
  }
  const data = await readBody(res);

  if (isFake404(res, data)) {
    throw new PeError('auth', 'Worker trả về trang 404 giả — sai proxy secret HOẶC sai worker URL. Chạy `pe init` để nhập lại.');
  }
  if (res.status === 403) {
    const m = data?.error?.message || data?.message || '';
    if (/only :free models/i.test(m)) {
      throw new PeError('model', `Worker từ chối: chỉ cho phép model :free. ${m}`);
    }
    throw new PeError('http', `Worker trả 403. ${m}`, 403);
  }
  if (!res.ok) {
    const m = data?.error?.message || data?.message || res.statusText;
    throw new PeError('http', `Worker trả lỗi ${res.status}: ${m}`, res.status);
  }
  return data;
}

/** Goi y khi gap loi chung chi tu ky (proxy cong ty chan TLS) — de xuat tu loi
 * SELF_SIGNED_CERT_IN_CHAIN ma chong iu gap tren may cong ty (2026-10-23). */
export function certHint(e) {
  const code = String(e?.cause?.code || e?.code || '');
  const msg = String(e?.cause?.message || e?.message || '');
  if (!/SELF_SIGNED_CERT_IN_CHAIN/i.test(code + ' ' + msg)) return '';
  return '\nGợi ý: mạng công ty đang chặn TLS bằng proxy tự ký chứng chỉ. ' +
    'Lấy file CA của công ty (từ IT, hoặc export từ trình duyệt), rồi đặt biến môi trường ' +
    'NODE_EXTRA_CA_CERTS=<đường-dẫn-file-ca.cer>, mở terminal MỚI và chạy lại. ' +
    'Test nhanh trong 1 terminal: set NODE_EXTRA_CA_CERTS=C:\\path\\ca.cer && pe doctor';
}

function networkError(e) {
  const msg = e?.cause?.code || e?.name || 'network error';
  return new PeError('network', `Không nối được tới worker (${msg}). Kiểm tra URL và mạng.${certHint(e)}`);
}

function checkModel(useModel) {
  if (!useModel || !String(useModel).endsWith(':free')) {
    throw new PeError('model', `Model "${useModel}" không hợp lệ: worker chỉ cho phép model kết thúc bằng ":free".`);
  }
}

/** Danh sach model thu lan luot: model chinh + cac model du phong (Goi B).
 * Model chinh ma khong phai :free la LOI CAU HINH — nem ngay, khong fallback. */
export function modelChain(cfg, requested) {
  const first = requested || cfg.model;
  checkModel(first);
  const chain = [first, ...(cfg.fallbackModels || [])];
  return [...new Set(chain)].filter((m) => m && String(m).endsWith(':free'));
}

/** Loi nao thi nen thu model khac (nghen/het luot/sap) — khong phai loi cau hinh. */
export function shouldFallback(err) {
  if (!err) return false;
  if (err.kind === 'network') return true;
  if (err.kind === 'http' && (err.status === 429 || err.status >= 500)) return true;
  // Model chet/doi ten: OpenRouter tra 400/404 kem thong diep ve model
  if (err.kind === 'http' && /not a valid model|model[^.]*not found|no endpoints/i.test(err.message || '')) return true;
  return /no endpoints|rate.?limit|overloaded|too many requests|temporarily unavailable|resourceexhausted|provider_unavailable/i.test(err.message || '');
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
export async function chatCompletion(cfg, { model, messages, temperature, maxTokens, tools, signal, web, readUrl } = {}) {
  const chain = modelChain(cfg, model);
  let lastErr = null;
  for (const useModel of chain) {
    try {
      const body = { model: useModel, messages };
      if (temperature !== undefined) body.temperature = temperature;
      if (maxTokens !== undefined) body.max_tokens = maxTokens;
      if (tools) body.tools = tools;
      if (web) body.web = true; // worker tu tim web + chen nguon (WEB1)
      if (readUrl) body.readUrl = readUrl; // worker tai trang + chen noi dung (URL1)
      const data = await apiFetch(cfg, '/api/chat', { method: 'POST', body, timeoutMs: 180000, signal });
      const message = data?.choices?.[0]?.message;
      const text = typeof message?.content === 'string' ? message.content : '';
      const toolCalls = parseToolCalls(message);
      if (!text && !toolCalls.length) {
        throw new PeError('http', 'Worker trả về định dạng lạ (thiếu choices[0].message.content).');
      }
      return { text, toolCalls, model: useModel, fellBack: useModel !== chain[0], raw: data };
    } catch (e) {
      lastErr = e;
      if (signal?.aborted) throw e;
      if (!shouldFallback(e)) throw e;
      // thu model tiep theo trong danh sach du phong
    }
  }
  throw lastErr;
}

/**
 * Goi chat completions dang STREAM (SSE cua OpenRouter qua worker).
 * onToken(chunk) duoc goi cho tung mau text. Tra ve toan van khi xong.
 * Loi auth/model/http duoc phan loai giong apiFetch truoc khi stream mo.
 */
export async function chatCompletionStream(cfg, opts = {}) {
  const chain = modelChain(cfg, opts.model);
  let lastErr = null;
  for (const useModel of chain) {
    let emitted = false;
    try {
      const r = await chatCompletionStreamOnce(cfg, {
        ...opts,
        model: useModel,
        onToken: (t) => { emitted = true; if (opts.onToken) opts.onToken(t); },
      });
      return { ...r, fellBack: useModel !== chain[0] };
    } catch (e) {
      lastErr = e;
      if (emitted || opts.signal?.aborted || !shouldFallback(e)) throw e;
    }
  }
  throw lastErr;
}

async function chatCompletionStreamOnce(cfg, { model, messages, onToken, timeoutMs = 240000, signal, web, readUrl } = {}) {
  const useModel = model || cfg.model;
  checkModel(useModel);
  if (!cfg.workerUrl) throw new PeError('config', 'Chưa có workerUrl. Chạy `pe init` để cấu hình.');
  if (!cfg.proxySecret) throw new PeError('config', 'Chưa có proxySecret. Chạy `pe init` để cấu hình.');
  let res;
  try {
    res = await fetch(cfg.workerUrl + '/api/chat', {
      method: 'POST',
      headers: { 'x-proxy-auth': cfg.proxySecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: useModel, messages, stream: true, ...(web ? { web: true } : {}), ...(readUrl ? { readUrl } : {}) }),
      signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw networkError(e);
  }
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('text/event-stream')) {
    // Worker tu choi truoc khi stream (sai secret / model...) — doc body de phan loai.
    const data = await readBody(res);
    if (isFake404(res, data)) {
      throw new PeError('auth', 'Worker trả về trang 404 giả — sai proxy secret HOẶC sai worker URL. Chạy `pe init` để nhập lại.');
    }
    const m = data?.error?.message || data?.message || res.statusText || '';
    if (res.status === 403 && /only :free models/i.test(m)) {
      throw new PeError('model', `Worker từ chối: chỉ cho phép model :free. ${m}`);
    }
    if (!res.ok) throw new PeError('http', `Worker trả lỗi ${res.status}: ${m}`, res.status);
    // Khong phai stream nhung la JSON hop le (worker/model bo qua stream):
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text === 'string') {
      if (onToken) onToken(text);
      return { text, model: useModel };
    }
    throw new PeError('http', 'Worker trả về định dạng lạ khi stream.');
  }
  let full = '';
  let buf = '';
  let streamError = null;
  const decoder = new TextDecoder();
  const handleLine = (line) => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    try {
      const json = JSON.parse(payload);
      // Provider co the tra loi ngay trong stream (choices rong + error)
      if (json?.error) {
        streamError = { message: json.error.message || 'provider error', code: Number(json.error.code) || undefined };
        return;
      }
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
      throw new PeError('network', `Stream bị đứt (${msg}).`);
    }
    // Da co mot phan noi dung — tra ve phan do, kem ghi chu.
    full += '\n[stream bi dut giua chung]';
  }
  if (!full && streamError) {
    throw new PeError('http', `Model lỗi khi stream: ${streamError.message}`, streamError.code);
  }
  if (!full) {
    throw new PeError('http', 'Model kết thúc stream mà không trả nội dung (có thể đang bị giới hạn) — thử lại sau.');
  }
  if (streamError) full += `\n[luu y: stream co loi o cuoi: ${streamError.message}]`;
  return { text: full, model: useModel };
}

/** Lay danh sach model kem thong tin vision (architecture.input_modalities). */
export async function listModelsDetailed(cfg) {
  const data = await apiFetch(cfg, '/api/models', { timeoutMs: 20000 });
  const arr = Array.isArray(data?.data) ? data.data : [];
  return arr.filter((m) => m?.id).map((m) => ({
    id: m.id,
    vision: ((m.architecture?.input_modalities || []).includes('image')),
  }));
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
