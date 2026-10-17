/**
 * 极简 OpenAI 兼容 HTTP 客户端。
 * 只用 Node 内置 fetch（Node >= 18），零第三方依赖，保证 portable。
 */

export class UpstreamError extends Error {
  constructor(message, { status, body, url, kind = 'http' } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.body = body;
    this.url = url;
    this.kind = kind;
  }
}

/** 规范化 baseURL：去掉尾部斜杠和误加上的 /chat/completions */
export function normalizeBaseUrl(input) {
  let url = String(input || '').trim();
  if (!url) throw new UpstreamError('base_url 不能为空', { kind: 'config' });
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/chat\/completions$/i, '');
  url = url.replace(/\/completions$/i, '');
  return url;
}

export function joinUrl(baseUrl, path) {
  const base = normalizeBaseUrl(baseUrl);
  const p = path.startsWith('/') ? path : '/' + path;
  return base + p;
}

function authHeaders(apiKey, extra) {
  const headers = { 'Content-Type': 'application/json', ...(extra || {}) };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

async function readErrorBody(res) {
  const text = await res.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** 非流式 POST /chat/completions */
export async function chatCompletion({
  baseUrl,
  apiKey,
  model,
  body,
  timeoutMs = 120000,
  headers,
  signal,
}) {
  const url = joinUrl(baseUrl, '/chat/completions');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ac.abort(signal?.reason);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(apiKey, headers),
      body: JSON.stringify({ model, stream: false, ...body }),
      signal: ac.signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      const errBody = await readErrorBody(res);
      throw new UpstreamError(describeHttpError(res.status, errBody), {
        status: res.status,
        body: errBody,
        url,
      });
    }
    const raw = await res.text();
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new UpstreamError('上游返回了非 JSON 响应', { status: res.status, body: raw.slice(0, 2000), url, kind: 'parse' });
    }
    return { json, latencyMs, url, status: res.status };
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    if (e?.name === 'AbortError') {
      throw new UpstreamError(signal?.aborted ? '请求已被取消' : `请求超时（${timeoutMs}ms）`, { kind: 'timeout', url });
    }
    throw new UpstreamError(describeNetworkError(e), { kind: 'network', url, body: String(e?.cause?.message || e?.message || e) });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** 流式 POST /chat/completions，收集首个 token 时间与全文 */
export async function chatCompletionStream({
  baseUrl,
  apiKey,
  model,
  body,
  timeoutMs = 120000,
  headers,
  signal,
}) {
  const url = joinUrl(baseUrl, '/chat/completions');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ac.abort(signal?.reason);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const startedAt = Date.now();
  let firstTokenMs = null;
  let text = '';
  let reasoning = '';
  const toolCalls = [];
  let usage = null;
  let finishReason = null;
  const rawChunks = [];

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(apiKey, headers),
      body: JSON.stringify({ model, stream: true, stream_options: { include_usage: true }, ...body }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const errBody = await readErrorBody(res);
      throw new UpstreamError(describeHttpError(res.status, errBody), { status: res.status, body: errBody, url });
    }
    if (!res.body) throw new UpstreamError('上游未返回流式 body', { status: res.status, url, kind: 'parse' });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') continue;
        let evt;
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }
        if (rawChunks.length < 20) rawChunks.push(evt);
        if (evt.usage) usage = evt.usage;
        const choice = evt.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta || {};
        const piece = typeof delta.content === 'string' ? delta.content : '';
        const thinkPiece =
          typeof delta.reasoning_content === 'string'
            ? delta.reasoning_content
            : typeof delta.reasoning === 'string'
              ? delta.reasoning
              : '';
        if ((piece || thinkPiece) && firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
        text += piece;
        reasoning += thinkPiece;
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? toolCalls.length;
            if (!toolCalls[i]) toolCalls[i] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) toolCalls[i].id = tc.id;
            if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
          }
        }
      }
    }

    return {
      text,
      reasoning,
      toolCalls: toolCalls.filter(Boolean),
      finishReason,
      usage,
      firstTokenMs,
      latencyMs: Date.now() - startedAt,
      url,
      status: res.status,
      rawChunks,
    };
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    if (e?.name === 'AbortError') {
      throw new UpstreamError(signal?.aborted ? '请求已被取消' : `请求超时（${timeoutMs}ms）`, { kind: 'timeout', url });
    }
    throw new UpstreamError(describeNetworkError(e), { kind: 'network', url, body: String(e?.cause?.message || e?.message || e) });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 从各种常见返回结构里挖出模型数组：
 *   { data: [...] } / { models: [...] } / { result: [...] } / { data: { models: [...] } }
 *   以及裸数组 [...]
 */
function pickModelArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const candidates = [payload.data, payload.models, payload.result, payload.list, payload.items];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
    if (c && typeof c === 'object') {
      for (const k of ['models', 'data', 'list', 'items']) {
        if (Array.isArray(c[k])) return c[k];
      }
    }
  }
  return [];
}

function normalizeModel(m) {
  if (typeof m === 'string') return { id: m.trim(), name: m };
  if (!m || typeof m !== 'object') return null;
  const id = String(
    m.id || m.name || m.model || m.model_name || m.slug || m.modelId || ''
  ).trim();
  if (!id) return null;
  return {
    id,
    name: m.name || m.display_name || id,
    ownedBy: m.owned_by || m.ownedBy || m.provider || m.owner || null,
    type: m.type || m.object || null,
    contextLength:
      m.context_length || m.context_window || m.max_context_length || m.max_input_tokens || null,
    modalities:
      m.architecture?.input_modalities || m.input_modalities || m.modalities || null,
    pricing: m.pricing || null,
  };
}

/** GET /models（支持本地过滤与排序，避免上游返回上千条时前端卡顿） */
export async function listModels({ baseUrl, apiKey, timeoutMs = 20000, headers, q } = {}) {
  const url = joinUrl(baseUrl, '/models');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { ...authHeaders(apiKey, headers), 'Content-Type': undefined },
      signal: ac.signal,
    });
    if (!res.ok) {
      const errBody = await readErrorBody(res);
      throw new UpstreamError(describeHttpError(res.status, errBody), { status: res.status, body: errBody, url });
    }
    const text = await res.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new UpstreamError('上游 /models 返回的不是合法 JSON', {
        kind: 'bad-json',
        url,
        body: text.slice(0, 300),
      });
    }

    const rawList = pickModelArray(payload);
    const seen = new Set();
    let models = rawList
      .map(normalizeModel)
      .filter(Boolean)
      .filter((m) => (seen.has(m.id) ? false : seen.add(m.id)));

    const keyword = String(q || '').trim().toLowerCase();
    if (keyword) {
      const tokens = keyword.split(/\s+/).filter(Boolean);
      models = models.filter((m) => {
        const low = m.id.toLowerCase();
        return tokens.every((t) => low.includes(t));
      });
    }
    models.sort((a, b) => a.id.localeCompare(b.id));
    return models;
  } finally {
    clearTimeout(timer);
  }
}

function describeHttpError(status, body) {
  const detail =
    (body && typeof body === 'object' && (body.error?.message || body.message || body.msg || body.error)) ||
    (typeof body === 'string' ? body.slice(0, 300) : '');
  const hint =
    status === 401
      ? '密钥无效或未授权'
      : status === 403
        ? '无权限访问该模型'
        : status === 404
          ? '模型或端点不存在（检查 base_url 是否带 /v1）'
          : status === 429
            ? '限流或额度不足'
            : status >= 500
              ? '上游服务端错误'
              : '';
  const parts = [`HTTP ${status}`, hint, detail && String(detail)].filter(Boolean);
  return parts.join(' · ');
}

function describeNetworkError(e) {
  const code = e?.cause?.code || e?.code;
  const map = {
    ENOTFOUND: '域名解析失败（DNS）',
    ECONNREFUSED: '连接被拒绝（端口未监听或被防火墙拦截）',
    ECONNRESET: '连接被重置',
    ETIMEDOUT: '连接超时',
    CERT_HAS_EXPIRED: 'TLS 证书已过期',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书链无法验证（自签证书需另配）',
    DEPTH_ZERO_SELF_SIGNED_CERT: '自签 TLS 证书',
  };
  return map[code] || `网络错误：${e?.message || e}`;
}
