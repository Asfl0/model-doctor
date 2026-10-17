/**
 * 运行引擎：并发调度测试项、推送进度、支持取消、生成报告。
 */
import { randomUUID } from 'node:crypto';
import { TESTS, TEST_ORDER } from './tests.mjs';
import { listModels, normalizeBaseUrl } from './http.mjs';

const runs = new Map();
const MAX_KEEP = 30;

export function createRun({ baseUrl, apiKey, model, tests, concurrency = 3, timeoutMs = 120000, headers }) {
  const base = normalizeBaseUrl(baseUrl);
  const selected = (tests && tests.length ? tests : TEST_ORDER).filter((id) => TESTS[id]);
  if (!selected.length) throw new Error('至少选择一个测试项');
  if (!model || !String(model).trim()) throw new Error('model_name 不能为空');

  const run = {
    id: randomUUID(),
    baseUrl: base,
    apiKey,
    model: String(model).trim(),
    timeoutMs,
    headers: headers || {},
    concurrency: Math.max(1, Math.min(Number(concurrency) || 3, 8)),
    createdAt: Date.now(),
    finishedAt: null,
    cancelled: false,
    controller: new AbortController(),
    subscribers: new Set(),
    items: selected.map((id) => ({
      id,
      label: TESTS[id].label,
      group: TESTS[id].group,
      status: 'pending',
      result: null,
      error: null,
      durationMs: null,
    })),
  };

  runs.set(run.id, run);
  trimRuns();
  return run;
}

function trimRuns() {
  if (runs.size <= MAX_KEEP) return;
  const sorted = [...runs.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const r of sorted.slice(0, runs.size - MAX_KEEP)) {
    if (r.finishedAt) runs.delete(r.id);
  }
}

export function getRun(id) {
  return runs.get(id);
}

export function subscribe(run, fn) {
  run.subscribers.add(fn);
  return () => run.subscribers.delete(fn);
}

function emit(run, event) {
  for (const fn of run.subscribers) {
    try {
      fn(event);
    } catch {
      /* 忽略单个订阅者异常 */
    }
  }
}

export function cancelRun(run) {
  if (!run || run.finishedAt) return false;
  run.cancelled = true;
  run.controller.abort(new Error('cancelled'));
  for (const item of run.items) {
    if (item.status === 'pending' || item.status === 'running') item.status = 'cancelled';
  }
  emit(run, { type: 'cancelled' });
  return true;
}

export async function executeRun(run) {
  // 给 SSE 订阅者一点时间挂载，避免首个事件丢失
  await new Promise((r) => setImmediate(r));
  if (run.subscribers.size === 0) {
    await new Promise((r) => setTimeout(r, 60));
  }
  emit(run, { type: 'start', run: snapshot(run) });

  const queue = [...run.items];
  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      if (run.cancelled || item.status === 'cancelled') continue;
      item.status = 'running';
      emit(run, { type: 'item', item: { ...item } });
      const startedAt = Date.now();
      try {
        const res = await TESTS[item.id].run({
          baseUrl: run.baseUrl,
          apiKey: run.apiKey,
          model: run.model,
          timeoutMs: run.timeoutMs,
          headers: run.headers,
          signal: run.controller.signal,
        });
        item.status = res.pass ? 'pass' : 'fail';
        item.result = res;
        item.durationMs = Date.now() - startedAt;
      } catch (e) {
        item.status = run.cancelled ? 'cancelled' : 'fail';
        item.error = e?.message || String(e);
        item.durationMs = Date.now() - startedAt;
      }
      emit(run, { type: 'item', item: { ...item } });
    }
  };

  const workers = Array.from({ length: Math.min(run.concurrency, run.items.length) }, () => worker());
  await Promise.all(workers);

  if (run.cancelled) {
    for (const item of run.items) if (item.status === 'pending' || item.status === 'running') item.status = 'cancelled';
  }
  // 取消后重查一次，避免已结束的结果被标为未完成
  run.finishedAt = Date.now();
  const report = buildReport(run);
  emit(run, { type: 'done', report });
  return report;
}

export function snapshot(run) {
  return {
    id: run.id,
    baseUrl: run.baseUrl,
    model: run.model,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    cancelled: run.cancelled,
    items: run.items.map((i) => ({ ...i })),
  };
}

function verdictFor(groups) {
  const has = (id) => groups.find((g) => g.id === id);
  const ran = (id) => ['pass', 'fail'].includes(has(id)?.status);

  const basic = has('basic');
  if (basic && basic.status === 'fail') return { tier: 'unreachable', label: '不可用' };

  const visionRan = ['vision', 'vision-strict'].some(ran);
  const toolRan = ['tool', 'tool-strict'].some(ran);
  const visionOk = ['vision', 'vision-strict'].some((id) => has(id)?.status === 'pass');
  const toolOk = ['tool', 'tool-strict'].some((id) => has(id)?.status === 'pass');
  const reasoningOk = has('reasoning')?.status === 'pass';
  const jsonOk = has('json')?.status === 'pass';

  const caps = [];
  if (visionOk) caps.push('视觉');
  if (toolOk) caps.push('函数调用');
  if (reasoningOk) caps.push('思考');
  if (jsonOk) caps.push('JSON');

  const missing = [];
  if (visionRan && !visionOk) missing.push('视觉');
  if (toolRan && !toolOk) missing.push('函数调用');
  if (has('reasoning')?.status === 'fail') missing.push('可靠推理');
  if (has('json')?.status === 'fail') missing.push('JSON');

  if (caps.length >= 3 && missing.length === 0) {
    return { tier: 'flagship', label: '能力全面', caps, missing };
  }
  if (caps.length > 0) {
    const tail = missing.length ? `，缺 ${missing.join('/')}` : '';
    return { tier: 'partial', label: `${caps.join(' + ')}${tail}`, caps, missing };
  }
  if (missing.length > 0) {
    return { tier: 'text-only', label: '仅文本对话', missing };
  }
  // 只测了基础项
  return { tier: basic?.status === 'pass' ? 'basic' : 'unknown', label: basic?.status === 'pass' ? '基础可用' : '未完成' };
}

export function buildReport(run) {
  const items = run.items.map((i) => ({ ...i }));
  const scored = items.filter((i) => i.status === 'pass' || i.status === 'fail');
  const passed = items.filter((i) => i.status === 'pass').length;
  const failed = items.filter((i) => i.status === 'fail').length;
  const skipped = items.filter((i) => i.status === 'cancelled' || i.status === 'pending').length;

  const latency = items
    .filter((i) => i.result?.latencyMs)
    .map((i) => i.result.latencyMs)
    .sort((a, b) => a - b);
  const p50 = latency.length ? latency[Math.floor(latency.length / 2)] : null;

  return {
    runId: run.id,
    model: run.model,
    baseUrl: run.baseUrl,
    startedAt: run.createdAt,
    finishedAt: run.finishedAt,
    durationMs: (run.finishedAt || Date.now()) - run.createdAt,
    cancelled: run.cancelled,
    summary: {
      total: items.length,
      passed,
      failed,
      skipped,
      score: scored.length ? Number((passed / scored.length).toFixed(3)) : 0,
      latencyP50Ms: p50,
    },
    verdict: verdictFor(items),
    items,
  };
}

export async function probeModels(opts) {
  return listModels(opts);
}
