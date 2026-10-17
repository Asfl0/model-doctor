'use strict';

/* ================= 状态 ================= */
const state = {
  catalog: [],
  selected: new Set(),
  runId: null,
  running: false,
  items: new Map(),
  report: null,
  es: null,
  detailItemId: null,
};

const PRESETS = [
  { name: 'OpenAI', url: 'https://api.openai.com/v1' },
  { name: 'DeepSeek', url: 'https://api.deepseek.com/v1' },
  { name: 'Moonshot', url: 'https://api.moonshot.cn/v1' },
  { name: 'DashScope', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { name: 'SiliconFlow', url: 'https://api.siliconflow.cn/v1' },
  { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
  { name: 'Ollama', url: 'http://127.0.0.1:11434/v1' },
  { name: 'LM Studio', url: 'http://127.0.0.1:1234/v1' },
];

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'model-doctor.config';

/* 默认配置（可在设置面板修改后持久化） */
const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:3000/v1',
  apiKey: 'sk-wmUc7Py2hCKcF8RQngTG8M8V09y7h7UIxMPZEaRXWHTLVzb0',
  model: '',
};

/* ================= 工具 ================= */
function toast(msg, ms = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtMs(ms) {
  if (ms == null) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

function statusIcon(status) {
  switch (status) {
    case 'pass': return '✓';
    case 'fail': return '✕';
    case 'running': return '<span class="spin">◌</span>';
    case 'cancelled': return '–';
    default: return '·';
  }
}

function badgeClass(status) {
  return ['pass', 'fail', 'running', 'cancelled'].includes(status) ? status : 'pending';
}

/* ================= 初始化 ================= */
async function init() {
  // 预设
  $('presets').innerHTML = PRESETS.map(
    (p) => `<button type="button" class="preset" data-url="${p.url}">${p.name}</button>`
  ).join('');
  $('presets').addEventListener('click', (e) => {
    const btn = e.target.closest('.preset');
    if (!btn) return;
    $('baseUrl').value = btn.dataset.url;
    saveConfig();
    fetchModels();
  });

  // 测试项
  const res = await fetch('/api/tests');
  const { tests } = await res.json();
  state.catalog = tests;
  renderTestList();

  loadConfig();
  bindEvents();

  // 页面就绪后自动向上游搜索模型列表（失败不阻塞，仅提示）
  autoProbeModels();
}

/** 自动搜索上游模型：避免用户还要手点 🔍 */
let autoProbeTimer = null;
function autoProbeModels() {
  clearTimeout(autoProbeTimer);
  autoProbeTimer = setTimeout(() => {
    if (!$('baseUrl').value.trim()) return;
    if ($('model').value.trim() && pickerState.models.length) {
      renderModelChips();
      return;
    }
    fetchModels(true);
  }, 300);
}

function renderTestList() {
  const groups = { chatbox: '复刻 Chatbox', strict: '增强判分' };
  let html = '';
  for (const [gid, gname] of Object.entries(groups)) {
    const list = state.catalog.filter((t) => t.group === gid);
    if (!list.length) continue;
    html += `<div class="group-title">${gname}</div>`;
    for (const t of list) {
      html += `
        <label class="test-item">
          <input type="checkbox" data-id="${t.id}" ${t.defaultOn ? 'checked' : ''} />
          <div class="test-item-body">
            <div class="test-item-name">${escapeHtml(t.label)}</div>
            <div class="test-item-desc">${escapeHtml(t.description)}</div>
          </div>
        </label>`;
    }
  }
  $('test-list').innerHTML = html;

  state.selected = new Set(state.catalog.filter((t) => t.defaultOn).map((t) => t.id));
  $('test-list').addEventListener('change', (e) => {
    const cb = e.target.closest('input[type=checkbox]');
    if (!cb) return;
    if (cb.checked) state.selected.add(cb.dataset.id);
    else state.selected.delete(cb.dataset.id);
    updateToggleAll();
  });
  updateToggleAll();
}

function updateToggleAll() {
  const all = state.catalog.length;
  const on = state.selected.size;
  $('toggle-all').textContent = on === all ? '取消全选' : '全选';
}

function bindEvents() {  $('toggle-all').addEventListener('click', () => {
    const all = state.catalog.length;
    const on = state.selected.size;
    const next = on === all ? new Set() : new Set(state.catalog.map((t) => t.id));
    state.selected = next;
    document.querySelectorAll('#test-list input[type=checkbox]').forEach((cb) => {
      cb.checked = next.has(cb.dataset.id);
    });
    updateToggleAll();
  });

  $('toggle-key').addEventListener('click', () => {
    const el = $('apiKey');
    el.type = el.type === 'password' ? 'text' : 'password';
  });

  $('fetch-models').addEventListener('click', () => openModelPicker());
  bindChipEvents();
  $('model-search').addEventListener('input', () => renderModelOptions());
  $('model-refresh').addEventListener('click', () => fetchModels(true));
  $('model-picker-close').addEventListener('click', () => closeModelPicker());
  $('model-search').addEventListener('keydown', onSearchKeydown);
  $('model-picker-list').addEventListener('click', (e) => {
    const opt = e.target.closest('.model-opt');
    if (opt) pickModel(opt.dataset.id);
  });
  $('model').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault();
      openModelPicker();
    }
  });
  document.addEventListener('click', (e) => {
    const picker = $('model-picker');
    if (picker.classList.contains('hidden')) return;
    if (picker.contains(e.target) || e.target.closest('#fetch-models') || e.target.closest('#model')) return;
    closeModelPicker();
  });
  $('run-btn').addEventListener('click', startRun);
  $('cancel-btn').addEventListener('click', cancelRun);
  $('detail-close').addEventListener('click', () => $('detail-panel').classList.add('hidden'));
  $('export-json').addEventListener('click', exportJson);
  $('copy-md').addEventListener('click', copyMarkdown);

  ['baseUrl', 'apiKey', 'model'].forEach((id) => $(id).addEventListener('input', saveConfig));

  // 改完 Base URL / Key 后自动重新搜索模型
  ['baseUrl', 'apiKey'].forEach((id) =>
    $(id).addEventListener('change', () => {
      pickerState.models = [];
      autoProbeModels();
    })
  );

  $('remember').addEventListener('change', () => {
    if ($('remember').checked) saveConfig();
    else localStorage.removeItem(STORAGE_KEY);
  });

  // URL 参数自动填充并开跑（便于自动化与分享）
  const q = new URLSearchParams(location.search);
  if (q.get('base') || q.get('model')) {
    if (q.get('base')) $('baseUrl').value = q.get('base');
    if (q.get('key')) $('apiKey').value = q.get('key');
    if (q.get('model')) $('model').value = q.get('model');
    if (q.get('tests')) {
      state.selected = new Set(String(q.get('tests')).split(',').filter(Boolean));
      document.querySelectorAll('#test-list input[type=checkbox]').forEach((cb) => {
        cb.checked = state.selected.has(cb.dataset.id);
      });
      updateToggleAll();
    }
    if (q.get('autostart') === '1') startRun();
  }
}

/* ================= 配置持久化 ================= */
function saveConfig() {
  if (!$('remember').checked) return;
  const cfg = {
    baseUrl: $('baseUrl').value,
    apiKey: $('apiKey').value,
    model: $('model').value,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    /* 忽略 */
  }
}

function loadConfig() {
  // 先写入默认值
  $('baseUrl').value = DEFAULTS.baseUrl;
  $('apiKey').value = DEFAULTS.apiKey;
  $('model').value = DEFAULTS.model;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const cfg = JSON.parse(raw);
    if (cfg.baseUrl) $('baseUrl').value = cfg.baseUrl;
    if (cfg.apiKey) $('apiKey').value = cfg.apiKey;
    if (cfg.model) $('model').value = cfg.model;
    $('remember').checked = true;
  } catch {
    /* 忽略 */
  }
}

/* ================= 模型搜索选择器 ================= */
const pickerState = {
  models: [],
  filtered: [],
  cursor: -1,
  loading: false,
};

function openModelPicker() {
  $('model-picker').classList.remove('hidden');
  const cur = $('model').value.trim();
  if (!pickerState.models.length) {
    fetchModels(true);
  } else {
    $('model-search').value = cur;
    renderModelOptions();
  }
  $('model-search').focus();
  $('model-search').select();
}

function closeModelPicker() {
  $('model-picker').classList.add('hidden');
}

function pickModel(id) {
  if (!id) return;
  $('model').value = id;
  saveConfig();
  closeModelPicker();
  $('models-hint').textContent = `已选择：${id}`;
  $('models-hint').className = 'hint ok';
  renderModelChips();
}

/**
 * 模糊匹配：
 *   1) 子串匹配：任意位置包含即命中
 *   2) 有序子序列匹配：gpt4o 可命中 gpt-4o，dsv3 可命中 deepseek-v3
 *   3) * 作为软分隔符（如 gpt*mini）
 * 多关键词以空格分隔，需全部命中。
 */
function fuzzyMatch(id, tokens) {
  if (!tokens.length) return true;
  const low = String(id).toLowerCase();
  return tokens.every((t) => {
    const parts = t.split('*').filter(Boolean);
    if (!parts.length) return true;
    let from = 0;
    for (const p of parts) {
      const at = low.indexOf(p, from);
      if (at >= 0) {
        from = at + p.length;
        continue;
      }
      // 退化：按字符有序子序列匹配
      let pos = from;
      let ok = true;
      for (const ch of p) {
        const found = low.indexOf(ch, pos);
        if (found < 0) {
          ok = false;
          break;
        }
        pos = found + 1;
      }
      if (!ok) return false;
      from = pos;
    }
    return true;
  });
}

function highlight(id, tokens) {
  const safe = escapeHtml(id);
  if (!tokens.length) return safe;
  // 仅对第一个 token 做高亮，避免复杂回溯
  const t = tokens[0].replace(/[*]/g, '');
  if (!t) return safe;
  return safe.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i'), '<mark>$1</mark>');
}

function renderModelOptions() {
  const raw = $('model-search').value.trim();
  const tokens = raw.toLowerCase().split(/\s+/).filter(Boolean);
  const list = raw ? pickerState.models.filter((m) => fuzzyMatch(m.id, tokens)) : pickerState.models;
  // 排序：前缀 > 词首 > 子串 > 其它，同档按名称
  const scored = list
    .map((m) => {
      const low = m.id.toLowerCase();
      let rank = 3;
      if (tokens.length) {
        const t0 = tokens[0].replace(/\*/g, '');
        if (t0 && low.startsWith(t0)) rank = 0;
        else if (t0 && low.split(/[-_/.\s]/).some((w) => w.startsWith(t0))) rank = 1;
        else if (t0 && low.includes(t0)) rank = 2;
      }
      return { m, rank };
    })
    .sort((a, b) => a.rank - b.rank || a.m.id.localeCompare(b.m.id))
    .map((x) => x.m);

  pickerState.filtered = scored;
  pickerState.cursor = scored.length ? 0 : -1;

  const meta = $('model-picker-meta');
  if (pickerState.loading) {
    meta.innerHTML = '<span>正在拉取上游模型列表…</span>';
  } else {
    meta.innerHTML = `<span>共 ${pickerState.models.length} 个，匹配 ${scored.length} 个</span><span>↑↓ 选择 · Enter 确认 · Esc 关闭</span>`;
  }

  if (!scored.length) {
    $('model-picker-list').innerHTML = `<div class="model-empty">${
      pickerState.loading ? '加载中…' : pickerState.models.length ? '没有匹配的模型' : '没有拿到模型列表，点 ⟳ 重试'
    }</div>`;
    return;
  }

  $('model-picker-list').innerHTML = scored
    .map((m, i) => {
      const tags = [];
      if (m.ownedBy) tags.push(`<span class="mo-tag">${escapeHtml(m.ownedBy)}</span>`);
      if (m.contextLength) tags.push(`<span class="mo-tag">${m.contextLength >= 1000 ? Math.round(m.contextLength / 1000) + 'k' : m.contextLength}</span>`);
      const mods = Array.isArray(m.modalities) ? m.modalities : [];
      if (mods.includes('image')) tags.push('<span class="mo-tag">vision</span>');
      return `<div class="model-opt${i === pickerState.cursor ? ' active' : ''}" data-id="${escapeHtml(m.id)}">${highlight(m.id, tokens)}<span class="mo-tags">${tags.join('')}</span></div>`;
    })
    .join('');

  const active = $('model-picker-list').querySelector('.model-opt.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function moveCursor(delta) {
  const list = pickerState.filtered;
  if (!list.length) return;
  pickerState.cursor = (pickerState.cursor + delta + list.length) % list.length;
  $('model-picker-list').querySelectorAll('.model-opt').forEach((el, i) => {
    el.classList.toggle('active', i === pickerState.cursor);
  });
  const active = $('model-picker-list').querySelector('.model-opt.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function onSearchKeydown(e) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveCursor(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveCursor(-1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const m = pickerState.filtered[pickerState.cursor];
    if (m) pickModel(m.id);
    else if ($('model-search').value.trim()) pickModel($('model-search').value.trim());
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeModelPicker();
  }
}

/* ================= 获取模型列表 ================= */
async function fetchModels(force = false) {
  const baseUrl = $('baseUrl').value.trim();
  const apiKey = $('apiKey').value.trim();
  const hint = $('models-hint');
  if (!baseUrl) {
    hint.textContent = '请先填写 Base URL';
    hint.className = 'hint error';
    return;
  }
  if (pickerState.loading && !force) return;
  pickerState.loading = true;
  hint.textContent = '正在搜索上游模型…';
  hint.className = 'hint';
  renderModelChips();
  if (!$('model-picker').classList.contains('hidden')) {
    $('model-picker-meta').innerHTML = '<span>正在拉取上游模型列表…</span>';
    $('model-picker-list').innerHTML = '<div class="model-empty">加载中…</div>';
  }
  try {
    const res = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl, apiKey, q: $('model-search').value.trim() }),
    });
    const data = await res.json();
    pickerState.loading = false;
    if (data.error) {
      hint.textContent = data.error;
      hint.className = 'hint error';
      $('model-picker-meta').innerHTML = `<span class="hint error">${escapeHtml(data.error)}</span>`;
      $('model-picker-list').innerHTML = '<div class="model-empty">获取失败，检查 Base URL 与 Key</div>';
      return;
    }
    pickerState.models = data.models || [];
    hint.textContent = `上游共 ${pickerState.models.length} 个模型，点 🔍 可检索`;
    hint.className = 'hint ok';
    renderModelOptions();
    renderModelChips();
  } catch (e) {
    pickerState.loading = false;
    hint.textContent = '获取失败：' + e.message;
    hint.className = 'hint error';
    renderModelChips();
  }
}

/* ================= 侧栏模型快捷标签（前 12 个） ================= */
const CHIP_LIMIT = 12;

function renderModelChips() {
  const box = $('model-chips');
  if (!box) return;
  if (pickerState.loading) {
    box.innerHTML = '<span class="chip-meta">正在拉取上游模型…</span>';
    return;
  }
  if (!pickerState.models.length) {
    box.innerHTML = '<span class="chip-meta">未取到模型列表，点 ⟳ 重试</span>';
    return;
  }
  const cur = $('model').value.trim();
  const shown = pickerState.models.slice(0, CHIP_LIMIT);
  const more = pickerState.models.length - shown.length;
  box.innerHTML =
    shown
      .map(
        (m) =>
          `<button type="button" class="chip${m.id === cur ? ' on' : ''}" data-id="${escapeHtml(m.id)}" title="${escapeHtml(m.id)}">${escapeHtml(m.id)}</button>`
      )
      .join('') +
    (more > 0
      ? `<button type="button" class="chip more" data-more="1">+${more} 个…</button>`
      : '');
}

function bindChipEvents() {
  const box = $('model-chips');
  if (!box) return;
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    if (btn.dataset.more) {
      openModelPicker();
      return;
    }
    pickModel(btn.dataset.id);
    renderModelChips();
  });
}

/* ================= 运行 ================= */
async function startRun() {
  const baseUrl = $('baseUrl').value.trim();
  const apiKey = $('apiKey').value.trim();
  const model = $('model').value.trim();
  if (!baseUrl) return toast('请填写 Base URL');
  if (!model) return toast('请填写 Model');
  if (!state.selected.size) return toast('至少选择一个测试项');

  resetResults();
  state.running = true;
  $('run-btn').disabled = true;
  $('cancel-btn').disabled = false;
  $('target-label').textContent = `${model}  ·  ${baseUrl}`;

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl,
        apiKey,
        model,
        tests: [...state.selected],
        concurrency: Number($('concurrency').value) || 3,
        timeoutMs: (Number($('timeout').value) || 120) * 1000,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    state.runId = data.runId;
    subscribeRun(data.runId);
  } catch (e) {
    toast('启动失败：' + e.message);
    finishRun();
  }
}

function subscribeRun(runId) {
  if (state.es) state.es.close();
  const es = new EventSource(`/api/run/${runId}/events`);
  state.es = es;

  es.onmessage = (ev) => {
    let event;
    try {
      event = JSON.parse(ev.data);
    } catch {
      return;
    }
    switch (event.type) {
      case 'snapshot':
        event.run.items.forEach((it) => state.items.set(it.id, it));
        renderResults();
        updateProgress();
        break;
      case 'start':
        event.run.items.forEach((it) => state.items.set(it.id, it));
        renderResults();
        updateProgress();
        break;
      case 'item':
        state.items.set(event.item.id, event.item);
        renderResults();
        updateProgress();
        if (state.detailItemId === event.item.id) showDetail(event.item.id);
        break;
      case 'done':
        state.report = event.report;
        renderVerdict();
        finishRun();
        break;
      case 'cancelled':
        toast('已停止');
        break;
      default:
        break;
    }
  };

  es.onerror = () => {
    if (state.running) {
      fetch(`/api/run/${runId}/report`)
        .then((r) => (r.ok ? r.json() : null))
        .then((rep) => {
          if (rep) {
            state.report = rep;
            renderVerdict();
          }
        })
        .finally(finishRun);
    }
  };
}

function finishRun() {
  state.running = false;
  $('run-btn').disabled = false;
  $('cancel-btn').disabled = true;
  if (state.es) {
    state.es.close();
    state.es = null;
  }
  updateProgress();
}

async function cancelRun() {
  if (!state.runId) return;
  await fetch(`/api/run/${state.runId}/cancel`, { method: 'POST' });
  $('cancel-btn').disabled = true;
}

/* ================= 渲染 ================= */
function resetResults() {
  if (state.es) state.es.close();
  state.items.clear();
  state.report = null;
  state.runId = null;
  state.detailItemId = null;
  $('results').innerHTML = '';
  $('detail-panel').classList.add('hidden');
  $('verdict-card').className = 'verdict empty';
  $('verdict-tier').textContent = '测试中…';
  $('verdict-label').textContent = '正在逐项探测模型能力';
  $('verdict-stats').innerHTML = '';
  $('progress-bar').style.width = '0%';
  $('progress-text').textContent = `0 / ${state.selected.size}`;
}

function orderedItems() {
  const order = state.catalog.map((t) => t.id);
  return [...state.items.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

function renderResults() {
  const items = orderedItems();
  if (!items.length) return;
  $('results').innerHTML = items
    .map((it) => {
      const detail = it.result?.detail || it.error || (it.status === 'running' ? '探测中…' : it.status === 'pending' ? '排队中' : '');
      const meta = [it.durationMs != null ? fmtMs(it.durationMs) : '', it.result?.status ? `HTTP ${it.result.status}` : '']
        .filter(Boolean)
        .join(' · ');
      return `
        <div class="result-card status-${it.status}" data-id="${it.id}">
          <div class="badge ${badgeClass(it.status)}">${statusIcon(it.status)}</div>
          <div>
            <div class="result-name">
              ${escapeHtml(it.label)}
              <span class="tag">${it.group === 'chatbox' ? 'Chatbox' : 'Strict'}</span>
            </div>
            <div class="result-detail">${escapeHtml(detail)}</div>
          </div>
          <div class="result-meta">${escapeHtml(meta)}</div>
        </div>`;
    })
    .join('');

  $('results')
    .querySelectorAll('.result-card')
    .forEach((card) => {
      card.addEventListener('click', () => showDetail(card.dataset.id));
    });
}

function updateProgress() {
  const total = state.items.size || state.selected.size;
  const done = [...state.items.values()].filter((i) => ['pass', 'fail', 'cancelled'].includes(i.status)).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('progress-bar').style.width = pct + '%';
  $('progress-text').textContent = `${done} / ${total}`;
  const running = [...state.items.values()].some((i) => i.status === 'running');
  $('progress-bar').classList.toggle('active', running);
  if (!state.running && done === total && total > 0) {
    $('progress-bar').style.width = '100%';
  }
}

function renderVerdict() {
  const rep = state.report;
  if (!rep) return;
  const card = $('verdict-card');
  card.className = `verdict tier-${rep.verdict.tier}`;
  $('verdict-tier').textContent = rep.verdict.label;
  $('verdict-label').textContent =
    `${rep.model} · ${rep.summary.passed}/${rep.summary.total} 项通过 · 耗时 ${(rep.durationMs / 1000).toFixed(1)}s`;

  const scorePct = Math.round(rep.summary.score * 100);
  $('verdict-stats').innerHTML = `
    <div class="stat">
      <div class="stat-value pass">${rep.summary.passed}</div>
      <div class="stat-label">通过</div>
    </div>
    <div class="stat">
      <div class="stat-value fail">${rep.summary.failed}</div>
      <div class="stat-label">失败</div>
    </div>
    <div class="stat">
      <div class="stat-value">${scorePct}%</div>
      <div class="stat-label">得分</div>
    </div>
    <div class="stat">
      <div class="stat-value">${rep.summary.latencyP50Ms ? fmtMs(rep.summary.latencyP50Ms) : '—'}</div>
      <div class="stat-label">P50 延迟</div>
    </div>`;
}

function showDetail(itemId) {
  const it = state.items.get(itemId);
  if (!it) return;
  state.detailItemId = itemId;
  $('detail-title').textContent = `${it.label} · ${it.status}`;
  const payload = {
    status: it.status,
    durationMs: it.durationMs,
    error: it.error || undefined,
    result: it.result || undefined,
  };
  $('detail-body').textContent = JSON.stringify(payload, null, 2);
  $('detail-panel').classList.remove('hidden');
  $('detail-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ================= 导出 ================= */
function exportJson() {
  if (!state.report) return toast('先完成一次测试');
  const blob = new Blob([JSON.stringify(state.report, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const safe = state.report.model.replace(/[^\w.-]+/g, '_');
  a.download = `model-doctor-${safe}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function copyMarkdown() {
  if (!state.report) return toast('先完成一次测试');
  const r = state.report;
  const lines = [
    `# 模型能力测试报告`,
    ``,
    `- 模型: \`${r.model}\``,
    `- 端点: \`${r.baseUrl}\``,
    `- 结论: **${r.verdict.label}**`,
    `- 通过: ${r.summary.passed}/${r.summary.total}（得分 ${Math.round(r.summary.score * 100)}%）`,
    ``,
    `| 测试项 | 结果 | 说明 | 耗时 |`,
    `| --- | --- | --- | --- |`,
    ...r.items.map(
      (i) =>
        `| ${i.label} | ${i.status === 'pass' ? '✅' : i.status === 'fail' ? '❌' : '➖'} | ${(i.result?.detail || i.error || '').replace(/\|/g, '\\|')} | ${i.durationMs != null ? fmtMs(i.durationMs) : '—'} |`
    ),
  ];
  const md = lines.join('\n');
  navigator.clipboard.writeText(md).then(
    () => toast('已复制 Markdown'),
    () => toast('复制失败')
  );
}

init();
