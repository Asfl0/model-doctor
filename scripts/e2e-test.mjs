/**
 * 端到端 API 自测：启动 run -> 订阅 SSE -> 校验报告
 */
const BASE = 'http://127.0.0.1:7788';

async function startRun(body) {
  const res = await fetch(`${BASE}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function subscribe(runId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const events = [];
    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort();
      reject(new Error('SSE timeout'));
    }, timeoutMs);

    fetch(`${BASE}/api/run/${runId}/events`, { signal: ac.signal })
      .then(async (res) => {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of block.split('\n')) {
              if (!line.startsWith('data:')) continue;
              try {
                const e = JSON.parse(line.slice(5).trim());
                events.push(e);
                if (e.type === 'done') {
                  clearTimeout(timer);
                  ac.abort();
                  return resolve({ events, report: e.report });
                }
              } catch {}
            }
          }
        }
        clearTimeout(timer);
        resolve({ events, report: null });
      })
      .catch((e) => {
        if (e.name === 'AbortError' && events.some((x) => x.type === 'done')) return;
        clearTimeout(timer);
        reject(e);
      });
  });
}

const cases = [
  { name: '全能力模型', model: 'mock-vision', expectPass: 8 },
  { name: '纯文本模型', model: 'mock-text-only', expectPass: 6 },
  { name: '推理错误模型', model: 'mock-dumb', expectPass: 7 },
];

let ok = 0;
for (const c of cases) {
  const { runId } = await startRun({
    baseUrl: 'http://127.0.0.1:8099/v1',
    apiKey: 'sk-test',
    model: c.model,
    concurrency: 4,
  });
  const { events, report } = await subscribe(runId);
  const itemEvents = events.filter((e) => e.type === 'item').length;
  const pass = report?.summary.passed;
  const good = pass === c.expectPass && itemEvents >= 8;
  console.log(`${good ? 'PASS' : 'FAIL'} ${c.name}: 通过 ${pass}/${report?.summary.total} (期望 ${c.expectPass}), 结论=${report?.verdict.label}, item事件=${itemEvents}`);
  if (good) ok++;
  else console.log(JSON.stringify(report?.items?.map((i) => [i.id, i.status]), null, 1));
}

// 取消测试
const { runId } = await startRun({
  baseUrl: 'http://127.0.0.1:8099/v1',
  apiKey: 'sk-test',
  model: 'mock-vision',
  tests: ['basic', 'vision', 'reasoning'],
});
const cancelRes = await (await fetch(`${BASE}/api/run/${runId}/cancel`, { method: 'POST' })).json();
await new Promise((r) => setTimeout(r, 400));
const snap = await (await fetch(`${BASE}/api/run/${runId}`)).json();
const st = snap.items.map((i) => i.status);
const allDone = st.every((s) => s === 'pass' || s === 'cancelled');
console.log(`取消测试: accepted=${cancelRes.ok}, cancelled=${snap.cancelled}, 状态=${st.join(',')}, 状态合法=${allDone}`);

// 模型列表
const ml = await (
  await fetch(`${BASE}/api/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'http://127.0.0.1:8099/v1', apiKey: 'sk-test' }),
  })
).json();
console.log(`模型列表: ${ml.models?.length} 个 -> ${ml.models?.map((m) => m.id).join(', ')}`);

console.log(`\n结果: ${ok}/${cases.length} 用例通过`);
process.exit(ok === cases.length ? 0 : 1);
