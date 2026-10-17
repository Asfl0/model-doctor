/**
 * 交互式截图：展开模型搜索器并输入关键字后截图
 * 用 CDP（Chrome DevTools Protocol）驱动，无需 puppeteer
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const exe = CANDIDATES.find((p) => existsSync(p));
if (!exe) { console.log('NO_BROWSER'); process.exit(0); }

const PAGE = process.argv[2] || 'http://127.0.0.1:7794/';
const OUT = process.argv[3] || 'shot-picker.png';
const QUERY = process.argv[4] || '';

const child = spawn(exe, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--remote-debugging-port=9333',
  '--window-size=1440,1000',
  '--user-data-dir=./.cache/cdp-profile',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9333/json/list');
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('no cdp target');
}

const ws = new WebSocket(await getWsUrl());
await new Promise((res) => (ws.onopen = res));

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
function send(method, params = {}) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((res) => pending.set(mid, res));
}

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: PAGE });
await sleep(2500);

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) console.log('EVAL ERR', JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
}

// 先切到 mock 上游，再打开搜索器
await evaluate(`(() => {
  document.getElementById('baseUrl').value = 'http://127.0.0.1:8099/v1';
  document.getElementById('apiKey').value = 'sk-test';
  document.getElementById('fetch-models').click();
  return true;
})()`);
await sleep(1800);

if (QUERY) {
  await evaluate(`(() => {
    const s = document.getElementById('model-search');
    s.value = ${JSON.stringify(QUERY)};
    s.dispatchEvent(new Event('input'));
    return true;
  })()`);
  await sleep(600);
}

const stats = await evaluate(`(() => {
  const list = document.querySelectorAll('.model-opt');
  return {
    pickerVisible: !document.getElementById('model-picker').classList.contains('hidden'),
    count: list.length,
    ids: [...list].map(e => e.dataset.id),
    meta: document.getElementById('model-picker-meta').innerText,
    hint: document.getElementById('models-hint').innerText,
  };
})()`);
console.log('UI STATE: ' + JSON.stringify(stats, null, 1));

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
console.log('SAVED ' + OUT);

ws.close();
child.kill();
process.exit(0);
