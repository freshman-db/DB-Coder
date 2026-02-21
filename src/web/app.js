/* ========================================
   DB-Coder 控制台 - 前端逻辑
   ======================================== */

// ---- 全局状态 ----
const state = {
  paused: false,
  refreshTimer: null,
  logSource: null,
  logLevel: 'info',
  currentPage: '',
};

// ---- 工具函数 ----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

async function api(path, opts = {}) {
  try {
    const res = await fetch(`/api${path}`, {
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      ...opts,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`API 请求失败: ${path}`, err);
    toast(`请求失败: ${err.message}`, 'error');
    return null;
  }
}

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

function timeAgo(dateStr) {
  if (!dateStr) return '-';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

const statusMap = {
  pending: { icon: '○', badge: 'pending', label: '等待中' },
  queued: { icon: '◎', badge: 'pending', label: '排队中' },
  running: { icon: '●', badge: 'running', label: '运行中' },
  in_progress: { icon: '●', badge: 'running', label: '进行中' },
  done: { icon: '✓', badge: 'done', label: '已完成' },
  completed: { icon: '✓', badge: 'done', label: '已完成' },
  failed: { icon: '✗', badge: 'failed', label: '失败' },
  paused: { icon: '❚❚', badge: 'paused', label: '已暂停' },
};

function getStatus(s) {
  return statusMap[s] || { icon: '?', badge: 'pending', label: s || '未知' };
}

const priorityLabels = { low: '低', medium: '中', high: '高', critical: '紧急' };

// ---- 路由 ----
const routes = [
  { pattern: /^#\/$|^#?$/, page: 'dashboard', title: '仪表盘' },
  { pattern: /^#\/tasks$/, page: 'tasks', title: '任务列表' },
  { pattern: /^#\/tasks\/(.+)$/, page: 'taskDetail', title: '任务详情' },
  { pattern: /^#\/history$/, page: 'history', title: '历史记录' },
  { pattern: /^#\/logs$/, page: 'logs', title: '运行日志' },
  { pattern: /^#\/memory$/, page: 'memory', title: '记忆检索' },
  { pattern: /^#\/settings$/, page: 'settings', title: '系统设置' },
];

function navigate() {
  const hash = location.hash || '#/';
  let matched = false;

  for (const route of routes) {
    const m = hash.match(route.pattern);
    if (m) {
      matched = true;
      cleanup();
      state.currentPage = route.page;
      $('#pageTitle').textContent = route.title;
      updateNav(route.page);
      renderPage(route.page, m[1]);
      break;
    }
  }

  if (!matched) {
    location.hash = '#/';
  }
}

function updateNav(page) {
  $$('.nav-item').forEach((item) => {
    const p = item.dataset.page;
    item.classList.toggle('active', p === page || (page === 'taskDetail' && p === 'tasks'));
  });
}

function cleanup() {
  clearInterval(state.refreshTimer);
  state.refreshTimer = null;
  if (state.logSource) {
    state.logSource.close();
    state.logSource = null;
  }
}

// ---- 页面渲染 ----
function renderPage(page, param) {
  const content = $('#content');
  content.innerHTML = '<div class="loading"><div class="spinner"></div>加载中...</div>';

  const renderers = {
    dashboard: renderDashboard,
    tasks: renderTasks,
    taskDetail: () => renderTaskDetail(param),
    history: renderHistory,
    logs: renderLogs,
    memory: renderMemory,
    settings: renderSettings,
  };

  (renderers[page] || renderDashboard)();
}

// ---- 仪表盘 ----
async function renderDashboard() {
  const [status, cost] = await Promise.all([api('/status'), api('/cost')]);
  const content = $('#content');

  const st = status || {};
  const co = cost || {};
  const stInfo = getStatus(st.state);
  const healthScore = st.healthScore ?? '-';
  const healthColor = healthScore >= 80 ? 'green' : healthScore >= 50 ? 'orange' : 'red';

  state.paused = !!st.paused;
  updatePauseBtn();

  content.innerHTML = `
    <div class="cards-grid">
      <div class="card">
        <div class="card-label">运行状态</div>
        <div class="card-value ${stInfo.badge === 'running' ? 'blue' : stInfo.badge === 'paused' ? 'orange' : ''}">${stInfo.label}</div>
        <div class="card-sub">${st.paused ? '已暂停' : '正常运行'}</div>
      </div>
      <div class="card">
        <div class="card-label">当前任务</div>
        <div class="card-value blue" style="font-size:16px;word-break:break-all;">${st.currentTaskId ? `<a href="#/tasks/${st.currentTaskId}">#${st.currentTaskId}</a>` : '空闲'}</div>
        <div class="card-sub">${st.currentTaskTitle || '无进行中任务'}</div>
      </div>
      <div class="card">
        <div class="card-label">今日费用</div>
        <div class="card-value green">$${(co.dailyCost ?? st.dailyCosts ?? 0).toFixed(2)}</div>
        <div class="card-sub">会话累计 $${(co.sessionCost ?? 0).toFixed(2)}</div>
      </div>
      <div class="card">
        <div class="card-label">健康评分</div>
        <div class="card-value ${healthColor}">${healthScore}</div>
        <div class="card-sub">综合运行质量</div>
      </div>
    </div>

    <div class="list-container" id="dashboardTasks">
      <div class="list-header">
        <span>近期任务</span>
        <a href="#/tasks" style="font-size:12px;">查看全部 &rarr;</a>
      </div>
      <div class="loading"><div class="spinner"></div>加载中...</div>
    </div>
  `;

  // 加载最近任务
  const tasks = await api('/tasks');
  const taskList = $('#dashboardTasks');
  if (tasks && Array.isArray(tasks) && tasks.length > 0) {
    const recent = tasks.slice(0, 5);
    taskList.innerHTML = `
      <div class="list-header">
        <span>近期任务</span>
        <a href="#/tasks" style="font-size:12px;">查看全部 &rarr;</a>
      </div>
      ${recent.map((t) => renderTaskRow(t)).join('')}
    `;
  } else {
    taskList.innerHTML = `
      <div class="list-header"><span>近期任务</span></div>
      <div class="empty-state"><p>暂无任务</p></div>
    `;
  }

  updateConnection(!!status);

  // 自动刷新
  state.refreshTimer = setInterval(async () => {
    if (state.currentPage !== 'dashboard') return;
    const s = await api('/status');
    if (!s) return;
    state.paused = !!s.paused;
    updatePauseBtn();
    updateConnection(true);
  }, 10000);
}

function renderTaskRow(t) {
  const st = getStatus(t.status);
  const pri = t.priority || 'medium';
  return `
    <div class="list-item" onclick="location.hash='#/tasks/${t.id}'">
      <span class="status-icon" title="${st.label}">${st.icon}</span>
      <span class="list-item-title">${escapeHtml(t.title || t.description?.slice(0, 60) || `任务 #${t.id}`)}</span>
      <span class="badge badge-${pri}">${priorityLabels[pri] || pri}</span>
      <span class="badge badge-${st.badge}">${st.label}</span>
      <span style="color:var(--text-muted);font-size:12px;min-width:70px;text-align:right;">${timeAgo(t.createdAt || t.created_at)}</span>
    </div>
  `;
}

// ---- 任务列表 ----
async function renderTasks() {
  const content = $('#content');
  const tasks = await api('/tasks');

  if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
    content.innerHTML = `
      <div class="empty-state">
        <div class="icon">&#128203;</div>
        <p>暂无任务，点击右上角「新建任务」创建</p>
      </div>
    `;
    return;
  }

  content.innerHTML = `
    <div class="list-container">
      <div class="list-header">
        <span>全部任务 (${tasks.length})</span>
      </div>
      ${tasks.map((t) => renderTaskRow(t)).join('')}
    </div>
  `;
}

// ---- 任务详情 ----
async function renderTaskDetail(id) {
  const content = $('#content');
  const task = await api(`/tasks/${id}`);

  if (!task) {
    content.innerHTML = `<div class="empty-state"><p>任务不存在或加载失败</p></div>`;
    return;
  }

  const st = getStatus(task.status);
  const pri = task.priority || 'medium';

  content.innerHTML = `
    <div class="detail-header">
      <a href="#/tasks" class="btn btn-sm btn-secondary">&larr; 返回</a>
      <h2>${escapeHtml(task.title || `任务 #${task.id}`)}</h2>
      <span class="badge badge-${st.badge}">${st.label}</span>
      <button class="btn btn-sm btn-danger" onclick="deleteTask('${task.id}')">删除任务</button>
    </div>

    <div class="detail-meta">
      <div class="meta-item">
        <div class="meta-label">任务 ID</div>
        <div class="meta-value">${task.id}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">优先级</div>
        <div class="meta-value"><span class="badge badge-${pri}">${priorityLabels[pri] || pri}</span></div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Git 分支</div>
        <div class="meta-value">${task.branch || task.gitBranch || '-'}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">费用</div>
        <div class="meta-value">$${(task.cost ?? 0).toFixed(4)}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">创建时间</div>
        <div class="meta-value">${task.createdAt || task.created_at || '-'}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">仓库</div>
        <div class="meta-value">${task.repo || task.repository || '-'}</div>
      </div>
    </div>

    <h3 class="section-title">任务描述</h3>
    <div class="card" style="margin-bottom:20px;">
      <div style="white-space:pre-wrap;font-size:13px;line-height:1.7;color:var(--text-secondary);">${escapeHtml(task.description || '无描述')}</div>
    </div>

    ${renderSubtasks(task.subtasks)}
    ${renderTaskLogs(task.logs)}
  `;
}

function renderSubtasks(subtasks) {
  if (!subtasks || !Array.isArray(subtasks) || subtasks.length === 0) return '';
  return `
    <h3 class="section-title">子任务 (${subtasks.length})</h3>
    <div class="list-container">
      ${subtasks.map((s) => {
        const st = getStatus(s.status);
        return `<div class="list-item">
          <span class="status-icon">${st.icon}</span>
          <span class="list-item-title">${escapeHtml(s.title || s.description || '')}</span>
          <span class="badge badge-${st.badge}">${st.label}</span>
        </div>`;
      }).join('')}
    </div>
  `;
}

function renderTaskLogs(logs) {
  if (!logs || !Array.isArray(logs) || logs.length === 0) return '';
  return `
    <h3 class="section-title">任务日志</h3>
    <div class="log-container" style="height:300px;">
      <div class="log-output">
        ${logs.map((l) => {
          const lvl = (l.level || 'info').toLowerCase();
          return `<div class="log-line ${lvl}"><span class="timestamp">${l.timestamp || ''}</span><span class="level">[${lvl.toUpperCase()}]</span>${escapeHtml(l.message || l.msg || '')}</div>`;
        }).join('')}
      </div>
    </div>
  `;
}

// ---- 历史记录 ----
async function renderHistory() {
  const content = $('#content');
  const tasks = await api('/tasks');

  if (!tasks || !Array.isArray(tasks)) {
    content.innerHTML = `<div class="empty-state"><p>暂无历史记录</p></div>`;
    return;
  }

  const completed = tasks.filter((t) => t.status === 'done' || t.status === 'completed' || t.status === 'failed');

  if (completed.length === 0) {
    content.innerHTML = `<div class="empty-state"><div class="icon">&#128214;</div><p>暂无已完成的任务</p></div>`;
    return;
  }

  content.innerHTML = `
    <div class="list-container">
      <div class="list-header"><span>历史记录 (${completed.length})</span></div>
      ${completed.map((t) => renderTaskRow(t)).join('')}
    </div>
  `;
}

// ---- 运行日志 ----
function renderLogs() {
  const content = $('#content');
  const levels = ['debug', 'info', 'warn', 'error'];

  content.innerHTML = `
    <div class="log-container">
      <div class="log-toolbar">
        <span style="font-size:12px;color:var(--text-muted);margin-right:4px;">级别筛选:</span>
        ${levels.map((l) => `<button class="filter-btn ${l === state.logLevel ? 'active' : ''}" data-level="${l}">${l.toUpperCase()}</button>`).join('')}
        <div style="flex:1;"></div>
        <button class="btn btn-sm btn-secondary" id="logClear">清屏</button>
        <label style="font-size:12px;color:var(--text-muted);display:flex;align-items:center;gap:4px;">
          <input type="checkbox" id="logAutoScroll" checked> 自动滚动
        </label>
      </div>
      <div class="log-output" id="logOutput"></div>
    </div>
  `;

  // 级别筛选
  $$('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.logLevel = btn.dataset.level;
      $$('.filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // 清屏
  $('#logClear').addEventListener('click', () => {
    $('#logOutput').innerHTML = '';
  });

  // SSE 连接
  connectLogStream();
}

function connectLogStream() {
  if (state.logSource) state.logSource.close();

  const output = $('#logOutput');
  if (!output) return;

  try {
    state.logSource = new EventSource('/api/logs?follow=true');

    state.logSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        appendLog(data);
      } catch {
        appendLog({ level: 'info', message: event.data, timestamp: new Date().toISOString() });
      }
    };

    state.logSource.onerror = () => {
      appendLog({ level: 'warn', message: '[连接断开，尝试重连...]', timestamp: new Date().toISOString() });
    };

    state.logSource.onopen = () => {
      appendLog({ level: 'info', message: '[日志流已连接]', timestamp: new Date().toISOString() });
    };
  } catch (err) {
    appendLog({ level: 'error', message: `SSE 连接失败: ${err.message}`, timestamp: new Date().toISOString() });
  }
}

function appendLog(entry) {
  const output = $('#logOutput');
  if (!output) return;

  const lvl = (entry.level || 'info').toLowerCase();
  const levelPriority = { debug: 0, info: 1, warn: 2, error: 3 };
  if ((levelPriority[lvl] ?? 1) < (levelPriority[state.logLevel] ?? 1)) return;

  const ts = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('zh-CN') : '';
  const line = document.createElement('div');
  line.className = `log-line ${lvl}`;
  line.innerHTML = `<span class="timestamp">${ts}</span> <span class="level">[${lvl.toUpperCase().padEnd(5)}]</span> ${escapeHtml(entry.message || entry.msg || '')}`;
  output.appendChild(line);

  // 限制行数
  while (output.children.length > 2000) {
    output.removeChild(output.firstChild);
  }

  // 自动滚动
  const autoScroll = $('#logAutoScroll');
  if (autoScroll && autoScroll.checked) {
    output.scrollTop = output.scrollHeight;
  }
}

// ---- 记忆检索 ----
function renderMemory() {
  const content = $('#content');
  content.innerHTML = `
    <div class="search-bar">
      <input type="text" class="form-input" id="memoryQuery" placeholder="输入关键词搜索记忆..." autofocus>
      <button class="btn btn-primary" id="memorySearch">搜索</button>
    </div>
    <div id="memoryResults">
      <div class="empty-state">
        <div class="icon">&#128270;</div>
        <p>输入关键词搜索项目记忆库</p>
      </div>
    </div>
  `;

  const input = $('#memoryQuery');
  const searchBtn = $('#memorySearch');

  const doSearch = async () => {
    const q = input.value.trim();
    if (!q) return;

    const results = $('#memoryResults');
    results.innerHTML = '<div class="loading"><div class="spinner"></div>搜索中...</div>';

    const data = await api(`/memory?q=${encodeURIComponent(q)}`);

    if (!data || (Array.isArray(data) && data.length === 0)) {
      results.innerHTML = '<div class="empty-state"><p>未找到相关记忆</p></div>';
      return;
    }

    const items = Array.isArray(data) ? data : (data.results || []);
    if (items.length === 0) {
      results.innerHTML = '<div class="empty-state"><p>未找到相关记忆</p></div>';
      return;
    }

    results.innerHTML = items.map((item) => `
      <div class="memory-result">
        <div class="result-title">${escapeHtml(item.title || item.file || '记忆片段')}</div>
        <div class="result-body">${escapeHtml(item.content || item.text || item.body || '')}</div>
        <div class="result-meta">
          ${item.score ? `相关度: ${(item.score * 100).toFixed(0)}%` : ''}
          ${item.source ? ` | 来源: ${item.source}` : ''}
          ${item.updatedAt ? ` | 更新: ${timeAgo(item.updatedAt)}` : ''}
        </div>
      </div>
    `).join('');
  };

  searchBtn.addEventListener('click', doSearch);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
}

// ---- 系统设置 ----
async function renderSettings() {
  const content = $('#content');
  const status = await api('/status');
  const cost = await api('/cost');

  if (!status) {
    content.innerHTML = '<div class="empty-state"><p>无法获取系统配置</p></div>';
    return;
  }

  const config = status.config || status;
  const costs = cost?.costs || {};

  content.innerHTML = `
    <div class="config-block">
      <h3>运行状态</h3>
      ${configRow('系统状态', getStatus(config.state).label)}
      ${configRow('是否暂停', config.paused ? '是' : '否')}
      ${configRow('当前任务', config.currentTaskId || '无')}
      ${configRow('运行模式', config.mode || '-')}
    </div>

    <div class="config-block">
      <h3>费用统计</h3>
      ${configRow('今日费用', `$${(cost?.dailyCost ?? config.dailyCosts ?? 0).toFixed(4)}`)}
      ${configRow('会话费用', `$${(cost?.sessionCost ?? 0).toFixed(4)}`)}
      ${Object.entries(costs).map(([k, v]) => configRow(k, `$${Number(v).toFixed(4)}`)).join('')}
    </div>

    <div class="config-block">
      <h3>系统配置 (只读)</h3>
      ${renderConfigEntries(config)}
    </div>
  `;
}

function configRow(key, val) {
  return `<div class="config-row"><span class="config-key">${escapeHtml(String(key))}</span><span class="config-val">${escapeHtml(String(val))}</span></div>`;
}

function renderConfigEntries(obj, prefix = '') {
  const skip = new Set(['state', 'paused', 'currentTaskId', 'dailyCosts', 'config']);
  return Object.entries(obj)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return renderConfigEntries(v, key);
      }
      return configRow(key, Array.isArray(v) ? JSON.stringify(v) : v);
    })
    .join('');
}

// ---- 控制操作 ----
async function togglePause() {
  const endpoint = state.paused ? '/control/resume' : '/control/pause';
  const res = await api(endpoint, { method: 'POST' });
  if (res !== null) {
    state.paused = !state.paused;
    updatePauseBtn();
    toast(state.paused ? '系统已暂停' : '系统已恢复');
  }
}

async function triggerScan() {
  const res = await api('/control/scan', { method: 'POST' });
  if (res !== null) toast('扫描已触发');
}

async function deleteTask(id) {
  if (!confirm(`确定删除任务 #${id}？此操作不可撤销。`)) return;
  const res = await api(`/tasks/${id}`, { method: 'DELETE' });
  if (res !== null) {
    toast('任务已删除');
    location.hash = '#/tasks';
  }
}

// 暴露到全局供 onclick 使用
window.deleteTask = deleteTask;

function updatePauseBtn() {
  const btn = $('#btnPause');
  if (!btn) return;
  if (state.paused) {
    btn.textContent = '▶ 恢复';
    btn.classList.remove('btn-warning');
    btn.classList.add('btn-success');
  } else {
    btn.textContent = '⏸ 暂停';
    btn.classList.remove('btn-success');
    btn.classList.add('btn-warning');
  }
}

function updateConnection(online) {
  const el = $('#connectionStatus');
  if (!el) return;
  const dot = el.querySelector('.status-dot');
  const text = el.querySelector('span:last-child');
  if (online) {
    dot.className = 'status-dot online';
    text.textContent = '已连接';
  } else {
    dot.className = 'status-dot offline';
    text.textContent = '未连接';
  }
}

// ---- 模态框 ----
function openModal() {
  $('#modalOverlay').classList.add('show');
  $('#taskTitle').value = '';
  $('#taskDesc').value = '';
  $('#taskPriority').value = 'medium';
  $('#taskRepo').value = '';
  setTimeout(() => $('#taskTitle').focus(), 100);
}

function closeModal() {
  $('#modalOverlay').classList.remove('show');
}

async function submitTask() {
  const title = $('#taskTitle').value.trim();
  const description = $('#taskDesc').value.trim();
  const priority = $('#taskPriority').value;
  const repo = $('#taskRepo').value.trim();

  if (!title) {
    toast('请输入任务标题', 'error');
    return;
  }

  const body = { title, description, priority };
  if (repo) body.repo = repo;

  const res = await api('/tasks', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (res !== null) {
    closeModal();
    toast('任务创建成功');
    location.hash = '#/tasks';
  }
}

// ---- 移动端菜单 ----
function toggleSidebar() {
  $('#sidebar').classList.toggle('open');
}

// ---- 初始化 ----
function init() {
  // 路由监听
  window.addEventListener('hashchange', navigate);

  // 按钮事件
  $('#btnPause').addEventListener('click', togglePause);
  $('#btnScan').addEventListener('click', triggerScan);
  $('#btnAddTask').addEventListener('click', openModal);
  $('#menuToggle').addEventListener('click', toggleSidebar);

  // 模态框事件
  $('#modalClose').addEventListener('click', closeModal);
  $('#modalCancel').addEventListener('click', closeModal);
  $('#modalSubmit').addEventListener('click', submitTask);
  $('#modalOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  // ESC 关闭模态框
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  // 点击侧边栏项时关闭移动端菜单
  $$('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      $('#sidebar').classList.remove('open');
    });
  });

  // 初始连接检测
  api('/status').then((res) => updateConnection(!!res));

  // 初始路由
  navigate();
}

document.addEventListener('DOMContentLoaded', init);
