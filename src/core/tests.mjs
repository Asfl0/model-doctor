/**
 * 测试项实现。
 * 前 3 项复刻 Chatbox `src/renderer/utils/model-tester.ts` 的语义：
 *   1) basic    —— 发 "Hi"，不发错即通过
 *   2) vision   —— 发 1x1 PNG + 询问颜色，不发错即通过（与 Chatbox 完全一致）
 *   3) tool     —— 发 get_weather 工具 + 天气问题，不发错即通过（与 Chatbox 完全一致）
 * 额外增加可判分项，判定比"不报错"更严格：
 *   4) vision-strict  —— 四色网格，要求答对颜色顺序
 *   5) reasoning      —— 数学题 + 思考标签，要求答案正确
 *   6) tool-strict    —— 要求真的返回 get_weather 且 location 正确
 *   7) json           —— 要求返回合法 JSON 且字段齐全
 *   8) stream         —— 要求流式返回并能收到首 token
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chatCompletion, chatCompletionStream } from './http.mjs';
import {
  CHATBOX_TEST_IMAGE_DATA_URL,
  VISION_GRID_ANSWER,
  REASONING_PROMPT,
  REASONING_EXPECTED,
  TOOL_PROMPT,
  CHATBOX_TOOL_PROMPT,
  WEATHER_TOOL,
  JSON_PROMPT,
  JSON_REQUIRED_KEYS,
} from './constants.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
let cachedGridDataUrl = null;

function visionGridDataUrl() {
  if (cachedGridDataUrl) return cachedGridDataUrl;
  try {
    const b64 = readFileSync(resolve(__dirname, '../assets/vision-grid.b64'), 'utf8').trim();
    cachedGridDataUrl = `data:image/png;base64,${b64}`;
  } catch {
    cachedGridDataUrl = CHATBOX_TEST_IMAGE_DATA_URL;
  }
  return cachedGridDataUrl;
}

/* ---------------- 工具函数 ---------------- */

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
  }
  return '';
}

function extractMessage(json) {
  const msg = json?.choices?.[0]?.message;
  if (!msg) return { text: '', reasoning: '', toolCalls: [], finishReason: null, usage: json?.usage || null };
  const text = contentToText(msg.content);
  const reasoning = msg.reasoning_content || msg.reasoning || msg.thinking || '';
  return {
    text,
    reasoning: typeof reasoning === 'string' ? reasoning : '',
    toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
    finishReason: json?.choices?.[0]?.finish_reason || null,
    usage: json?.usage || null,
  };
}

const COLOR_WORDS = {
  red: ['red', '红'],
  blue: ['blue', '蓝'],
  green: ['green', '绿'],
  yellow: ['yellow', '黄'],
};

function detectColors(text) {
  const lower = String(text || '').toLowerCase();
  const found = [];
  const positions = [];
  for (const [name, words] of Object.entries(COLOR_WORDS)) {
    let best = -1;
    for (const w of words) {
      const i = lower.indexOf(w.toLowerCase());
      if (i >= 0 && (best < 0 || i < best)) best = i;
    }
    if (best >= 0) {
      positions.push({ name, at: best });
    }
  }
  positions.sort((a, b) => a.at - b.at);
  for (const p of positions) found.push(p.name);
  return found;
}

function extractAnswerNumber(text) {
  const m = String(text || '').match(/ANSWER\s*[:：]\s*(-?\d+)/i);
  if (m) return Number(m[1]);
  const nums = String(text || '').match(/-?\d+/g);
  return nums && nums.length ? Number(nums[nums.length - 1]) : null;
}

function hasThinkingBlock(reasoning, text) {
  if (reasoning && reasoning.trim().length > 0) return true;
  if (/<\s*think\s*>/i.test(text) || /<\|?end.?of.?thinking/i.test(text)) return true;
  if (/<\s*thinking\s*>/i.test(text)) return true;
  return false;
}

function mkResult(pass, detail, extra = {}) {
  return { pass, detail, ...extra };
}

/* ---------------- 各测试项 ---------------- */

export async function testBasic({ baseUrl, apiKey, model, timeoutMs, headers, signal }) {
  try {
    const { json, latencyMs } = await chatCompletion({
      baseUrl,
      apiKey,
      model,
      timeoutMs,
      headers,
      signal,
      body: { messages: [{ role: 'user', content: 'Hi' }] },
    });
    const m = extractMessage(json);
    const reply = m.text || m.reasoning;
    return mkResult(
      true,
      reply ? `模型正常响应，延迟 ${latencyMs}ms` : `请求成功但返回内容为空，延迟 ${latencyMs}ms`,
      {
        latencyMs,
        model: json?.model || model,
        replyPreview: reply.slice(0, 300),
        usage: m.usage,
        finishReason: m.finishReason,
      }
    );
  } catch (e) {
    return mkResult(false, e.message, { status: e.status, body: e.body });
  }
}

/** Chatbox 等价视觉探测：只验证多模态通道被接受 */
export async function testVisionChatbox({ baseUrl, apiKey, model, timeoutMs, headers, signal }) {
  try {
    const { json, latencyMs } = await chatCompletion({
      baseUrl,
      apiKey,
      model,
      timeoutMs,
      headers,
      signal,
      body: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What color is in this image?' },
              { type: 'image_url', image_url: { url: CHATBOX_TEST_IMAGE_DATA_URL } },
            ],
          },
        ],
      },
    });
    const m = extractMessage(json);
    return mkResult(true, `视觉输入被接受，模型回复：${(m.text || '').slice(0, 120) || '(空)'}`, {
      latencyMs,
      replyPreview: m.text.slice(0, 300),
    });
  } catch (e) {
    return mkResult(false, e.message, { status: e.status, body: e.body });
  }
}

/** Chatbox 等价工具调用探测：流式请求 + 注册 get_weather（带 execute 桩），
 *  不在 prompt 里提示用工具，不传 tool_choice / max_tokens，max_steps=1
 *  即只请求一轮，不做回注。判定：流中真的出现 tool_call。
 */
export async function testToolChatbox({ baseUrl, apiKey, model, timeoutMs, headers, signal }) {
  try {
    const r = await chatCompletionStream({
      baseUrl,
      apiKey,
      model,
      timeoutMs,
      headers,
      signal,
      body: {
        messages: [{ role: 'user', content: CHATBOX_TOOL_PROMPT }],
        tools: [WEATHER_TOOL],
      },
    });
    const calls = r.toolCalls || [];
    const first = calls[0];
    if (!first) {
      return mkResult(false, '请求成功但流中没有任何 tool_call（模型把工具调用降级成了纯文本回复）', {
        latencyMs: r.latencyMs,
        firstTokenMs: r.firstTokenMs,
        finishReason: r.finishReason,
        toolCalls: [],
        replyPreview: (r.text || '').slice(0, 300),
      });
    }
    const name = first.function?.name || '';
    const nameOk = name === 'get_weather';
    return mkResult(nameOk, nameOk
      ? `挂起 get_weather 工具后模型发起了工具调用（${r.firstTokenMs ?? '?'}ms 首块）`
      : `模型发起了工具调用，但函数名不是 get_weather：${name || '(空)'}`, {
      latencyMs: r.latencyMs,
      firstTokenMs: r.firstTokenMs,
      finishReason: r.finishReason,
      toolName: name,
      toolCallRaw: first.function?.arguments ?? null,
      toolCalls: calls,
      replyPreview: (r.text || '').slice(0, 300),
      parity: 'Chatbox testToolUseRequest：stream + tools(execute 桩) + maxSteps=1，不传 tool_choice',
    });
  } catch (e) {
    return mkResult(false, e.message, { status: e.status, body: e.body });
  }
}

/** 严格视觉：判定颜色顺序 */
export async function testVisionStrict({ baseUrl, apiKey, model, timeoutMs, headers, signal }) {
  try {
    const { json, latencyMs } = await chatCompletion({
      baseUrl,
      apiKey,
      model,
      timeoutMs: timeoutMs ?? 120000,
      headers,
      signal,
      body: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: VISION_GRID_ANSWER.prompt },
              { type: 'image_url', image_url: { url: visionGridDataUrl(), detail: 'high' } },
            ],
          },
        ],
        max_tokens: 128,
      },
    });
    const m = extractMessage(json);
    const answer = m.text.trim();
    const got = detectColors(answer).slice(0, 4);
    const expected = VISION_GRID_ANSWER.expectedColors;
    let matched = 0;
    for (let i = 0; i < 4; i++) if (got[i] === expected[i]) matched++;
    const pass = matched >= 3;
    return mkResult(pass, pass ? `颜色识别正确（顺序 ${got.join(',')}）` : `颜色识别不匹配：期望 ${expected.join(',')}，实际 ${got.join(',') || '无法解析'}`, {
      latencyMs,
      score: matched / 4,
      answer: answer.slice(0, 300),
      expected,
      got,
    });
  } catch (e) {
    return mkResult(false, e.message, { status: e.status, body: e.body });
  }
}

/** 思考能力 */
export async function testReasoning({ baseUrl, apiKey, model, timeoutMs, headers, signal }) {
  try {
    const { json, latencyMs } = await chatCompletion({
      baseUrl,
      apiKey,
      model,
      timeoutMs: timeoutMs ?? 180000,
      headers,
      signal,
      body: {
        messages: [{ role: 'user', content: REASONING_PROMPT }],
        max_tokens: 1024,
      },
    });
    const m = extractMessage(json);
    const answer = extractAnswerNumber(m.text);
    const inlineThink = (m.text.match(/<think[\s>][\s\S]*?<\/think>/i) || m.text.match(/<thinking[\s>][\s\S]*?<\/thinking>/i) || [])[0] || '';
    const sawThinking = hasThinkingBlock(m.reasoning, m.text) || (m.reasoning || '').length > 0;
    const reasoningChars = (m.reasoning || '').length || inlineThink.length;
    const correct = answer === REASONING_EXPECTED;
    return mkResult(correct, correct
      ? `答案正确（${answer}）${sawThinking ? '，并输出了思考内容' : '，但未输出思考内容'}`
      : `答案错误：期望 ${REASONING_EXPECTED}，实际 ${answer ?? '无法解析'}`, {
      latencyMs,
      correct,
      sawThinking,
      reasoningChars,
      answer,
      replyPreview: m.text.slice(0, 500),
      reasoningPreview: (m.reasoning || inlineThink || '').slice(0, 500),
    });
  } catch (e) {
    return mkResult(false, e.message, { status: e.status, body: e.body });
  }
}

/** 严格工具调用 */
export async function testToolStrict({ baseUrl, apiKey, model, timeoutMs, headers, signal }) {
  try {
    const { json, latencyMs } = await chatCompletion({
      baseUrl,
      apiKey,
      model,
      timeoutMs,
      headers,
      signal,
      body: {
        messages: [{ role: 'user', content: TOOL_PROMPT }],
        tools: [WEATHER_TOOL],
        tool_choice: 'auto',
        max_tokens: 512,
      },
    });
    const m = extractMessage(json);
    const call = m.toolCalls[0];
    if (!call) {
      return mkResult(false, '模型未发起 tool_call（可能不支持函数调用）', {
        latencyMs,
        replyPreview: m.text.slice(0, 300),
        rawToolCalls: m.toolCalls,
      });
    }
    const name = call.function?.name || call.name || '';
    let args = call.function?.arguments ?? call.arguments ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        return mkResult(false, `tool_call 参数不是合法 JSON：${String(call.function?.arguments).slice(0, 200)}`, {
          latencyMs,
          toolName: name,
        });
      }
    }
    const location = String(args?.location ?? args?.city ?? '').toLowerCase();
    const nameOk = name === 'get_weather';
    const locOk = location.includes('san francisco') || location.includes('sf') || location.includes('旧金山');
    const pass = nameOk && locOk;
    return mkResult(pass, pass
      ? `正确调用 get_weather(location=${args.location ?? args.city})`
      : `调用存在但参数不符：name=${name}, args=${JSON.stringify(args)}`, {
      latencyMs,
      toolName: name,
      args,
    });
  } catch (e) {
    return mkResult(false, e.message, { status: e.status, body: e.body });
  }
}

/** JSON 模式 */
export async function testJson({ baseUrl, apiKey, model, timeoutMs, headers, signal }) {
  try {
    const { json, latencyMs } = await chatCompletion({
      baseUrl,
      apiKey,
      model,
      timeoutMs,
      headers,
      signal,
      body: {
        messages: [{ role: 'user', content: JSON_PROMPT }],
        response_format: { type: 'json_object' },
        max_tokens: 256,
      },
    });
    const m = extractMessage(json);
    const raw = m.text.trim();
    const stripped = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(stripped);
    } catch {
      return mkResult(false, `返回内容不是合法 JSON：${raw.slice(0, 200) || '(空)'}`, { latencyMs, raw: raw.slice(0, 500) });
    }
    const missing = JSON_REQUIRED_KEYS.filter((k) => !(k in parsed));
    const pass = missing.length === 0;
    return mkResult(pass, pass ? '返回合法 JSON 且字段齐全' : `JSON 合法但缺少字段：${missing.join(', ')}`, {
      latencyMs,
      parsed,
      raw: raw.slice(0, 500),
    });
  } catch (e) {
    return mkResult(false, e.message, { status: e.status, body: e.body });
  }
}

/** 流式支持 */
export async function testStream({ baseUrl, apiKey, model, timeoutMs, headers, signal }) {
  try {
    const r = await chatCompletionStream({
      baseUrl,
      apiKey,
      model,
      timeoutMs,
      headers,
      signal,
      body: { messages: [{ role: 'user', content: 'Count from 1 to 5, comma separated.' }], max_tokens: 128 },
    });
    const pass = r.text.length > 0;
    return mkResult(pass, pass
      ? `流式正常，首 token ${r.firstTokenMs ?? '?'}ms，总耗时 ${r.latencyMs}ms`
      : '流式连接建立但未收到内容', {
      latencyMs: r.latencyMs,
      firstTokenMs: r.firstTokenMs,
      finishReason: r.finishReason,
      usage: r.usage,
      replyPreview: r.text.slice(0, 300),
    });
  } catch (e) {
    return mkResult(false, e.message, { status: e.status, body: e.body });
  }
}

/* ---------------- 注册表 ---------------- */

export const TESTS = {
  basic: {
    label: '基础对话',
    group: 'chatbox',
    description: '发送 "Hi"，复刻 Chatbox basicTest：不发错即通过。',
    defaultOn: true,
    run: testBasic,
  },
  vision: {
    label: '视觉（Chatbox 等价）',
    group: 'chatbox',
    description: '发送 1x1 PNG 并询问颜色，复刻 Chatbox visionTest：多模态通道被接受即通过。',
    defaultOn: true,
    run: testVisionChatbox,
  },
  tool: {
    label: '函数调用（Chatbox 等价）',
    group: 'chatbox',
    description:
      '与 Chatbox toolTest 同形：流式请求 + 注册 get_weather 工具（execute 桩），prompt 不提示用工具，不传 tool_choice，maxSteps=1；流中出现 tool_call 即通过。',
    defaultOn: true,
    run: testToolChatbox,
  },
  'vision-strict': {
    label: '视觉识别（严格判分）',
    group: 'strict',
    description: '2x2 四色网格，要求答对颜色顺序（至少 3/4）。',
    defaultOn: true,
    run: testVisionStrict,
  },
  reasoning: {
    label: '思考能力',
    group: 'strict',
    description: '数学题 + 要求输出思考过程，校验最终答案与 thinking 内容。',
    defaultOn: true,
    run: testReasoning,
  },
  'tool-strict': {
    label: '函数调用（严格判分）',
    group: 'strict',
    description: '校验 tool_calls 中的函数名与 location 参数是否都正确。',
    defaultOn: true,
    run: testToolStrict,
  },
  json: {
    label: 'JSON 模式',
    group: 'strict',
    description: '要求 response_format=json_object 并校验返回 JSON 与字段。',
    defaultOn: true,
    run: testJson,
  },
  stream: {
    label: '流式输出',
    group: 'strict',
    description: '校验 SSE 流式返回、首 token 延迟与用量。',
    defaultOn: false,
    run: testStream,
  },
};

export const TEST_ORDER = ['basic', 'vision', 'tool', 'vision-strict', 'reasoning', 'tool-strict', 'json', 'stream'];

export function testCatalog() {
  return TEST_ORDER.map((id) => {
    const t = TESTS[id];
    return { id, label: t.label, group: t.group, description: t.description, defaultOn: t.defaultOn };
  });
}
