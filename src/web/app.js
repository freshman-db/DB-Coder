/* ========================================
   DB-Coder 控制台 - 前端逻辑
   ======================================== */

// ---- 全局状态 ----
const AUTH_STORAGE_KEY = 'db-coder-api-token';

const state = {
  paused: false,
  refreshTimer: null,
  logAbort: null, // AbortController for fetch-based SSE
  logLevel: 'info',
  currentPage: '',
  taskPage: 1,
  historyPage: 1,
};

// ---- 工具函数 ----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---- 令牌管理 ----
function getToken() {
  return localStorage.getItem(AUTH_STORAGE_KEY) || '';
}

function setToken(token) {
  localStorage.setItem(AUTH_STORAGE_KEY, token.trim());
}

function clearToken() {
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

function showAuthScreen(errorMsg) {
  const overlay = $('#authOverlay');
  const errEl = $('#authError');
  if (!overlay) return;

  overlay.classList.remove('hidden');
  if (errorMsg) {
    errEl.textContent = errorMsg;
    errEl.classList.add('show');
  } else {
    errEl.classList.remove('show');
  }
  setTimeout(() => $('#authTokenInput')?.focus(), 100);
}

function hideAuthScreen() {
  const overlay = $('#authOverlay');
  if (overlay) overlay.classList.add('hidden');
}

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function api(path, opts = {}) {
  try {
    const res = await fetch(`/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...authHeaders(), ...opts.headers },
    });

    if (res.status === 401) {
      clearToken();
      showAuthScreen('令牌无效或已过期，请重新输入');
      return null;
    }

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

// Map numeric priority (from DB) to string key for display
// DB schema: 0=P0 urgent, 1=P1 high, 2=P2 medium, 3=P3 low
const priorityNumToStr = { 0: 'critical', 1: 'high', 2: 'medium', 3: 'low' };
const priorityStrToNum = { critical: 0, high: 1, medium: 2, low: 3 };

function getPriorityStr(numOrStr) {
  if (typeof numOrStr === 'number') return priorityNumToStr[numOrStr] || 'medium';
  return numOrStr || 'medium';
}

// Extract a display title from task_description (first line, truncated)
function getTaskTitle(task) {
  const desc = task.task_description || task.description || '';
  if (!desc) return `任务 #${task.id}`;
  const firstLine = desc.split('\n')[0].trim();
  return firstLine.slice(0, 80) || `任务 #${task.id}`;
}

// Get the full description body (everything after the first line)
function getTaskBody(task) {
  const desc = task.task_description || task.description || '';
  const lines = desc.split('\n');
  if (lines.length <= 1) return '';
  // Skip first line (title) and any blank line after it
  let start = 1;
  while (start < lines.length && lines[start].trim() === '') start++;
  return lines.slice(start).join('\n');
}

// ---- 路由 ----
const routes = [
  { pattern: /^#\/$|^#?$/, page: 'dashboard', title: '仪表盘' },
  { pattern: /^#\/tasks$/, page: 'tasks', title: '任务列表' },
  { pattern: /^#\/tasks\/(.+)$/, page: 'taskDetail', title: '任务详情' },
  { pattern: /^#\/history$/, page: 'history', title: '历史记录' },
  { pattern: /^#\/logs$/, page: 'logs', title: '运行日志' },
  { pattern: /^#\/memory$/, page: 'memory', title: '记忆检索' },
  { pattern: /^#\/plans$/, page: 'plans', title: '计划对话' },
  { pattern: /^#\/plans\/(.+)$/, page: 'planDetail', title: '计划详情' },
  { pattern: /^#\/analysis$/, page: 'analysis', title: '代码分析' },
  { pattern: /^#\/analysis\/(.+)$/, page: 'analysisDetail', title: '分析报告' },
  { pattern: /^#\/plugins$/, page: 'plugins', title: '插件管理' },
  { pattern: /^#\/evolution$/, page: 'evolution', title: '进化分析' },
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
    item.classList.toggle('active',
      p === page
      || (page === 'taskDetail' && p === 'tasks')
      || (page === 'planDetail' && p === 'plans')
      || (page === 'analysisDetail' && p === 'analysis')
    );
  });
}

function cleanup() {
  clearInterval(state.refreshTimer);
  state.refreshTimer = null;
  if (state.logAbort) {
    state.logAbort.abort();
    state.logAbort = null;
  }
  if (state.chatEventSource) {
    state.chatEventSource.abort();
    state.chatEventSource = null;
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
    plans: renderPlans,
    planDetail: () => renderPlanDetail(param),
    analysis: renderAnalysis,
    analysisDetail: () => renderAnalysisDetail(param),
    plugins: renderPlugins,
    evolution: renderEvolution,
    settings: renderSettings,
  };

  (renderers[page] || renderDashboard)();
}

// ---- 仪表盘 ----
async function renderDashboard() {
  const [status, cost, evoSummary] = await Promise.all([
    api('/status'), api('/cost'), api('/evolution/summary').catch(() => null),
  ]);
  const content = $('#content');

  const st = status || {};
  const co = cost || {};
  const stInfo = getStatus(st.state);
  const patrolling = !!st.patrolling;

  // Extract today's cost from daily costs array (sorted by date DESC, [0] = most recent)
  const dailyCostsArr = Array.isArray(co.costs) ? co.costs : Array.isArray(st.dailyCosts) ? st.dailyCosts : [];
  const todayCost = dailyCostsArr.length > 0 ? Number(dailyCostsArr[0].total_cost_usd || 0) : 0;

  // Health score from evolution trend data
  const healthScore = evoSummary?.trends?.health?.current ?? '-';
  const healthColor = healthScore >= 80 ? 'green' : healthScore >= 50 ? 'orange' : 'red';

  state.paused = !!st.paused;
  updatePauseBtn();

  const patrolBtn = patrolling
    ? `<button class="btn btn-sm btn-warning" onclick="stopPatrol()">停止巡逻</button>`
    : `<button class="btn btn-sm btn-primary" onclick="startPatrol()">开始巡逻</button>`;

  content.innerHTML = `
    <div class="cards-grid">
      <div class="card">
        <div class="card-label">巡逻状态</div>
        <div class="card-value ${patrolling ? 'blue' : ''}">${patrolling ? '运行中' : '已停止'}</div>
        <div class="card-sub">${patrolling ? st.state || '自动扫描与执行' : '等待指令'}</div>
      </div>
      <div class="card">
        <div class="card-label">当前任务</div>
        <div class="card-value blue" style="font-size:16px;word-break:break-all;">${st.currentTaskId ? `<a href="#/tasks/${st.currentTaskId}">#${st.currentTaskId}</a>` : '空闲'}</div>
        <div class="card-sub">${st.currentTaskTitle || '无进行中任务'}</div>
      </div>
      <div class="card">
        <div class="card-label">今日费用</div>
        <div class="card-value green">$${todayCost.toFixed(2)}</div>
        <div class="card-sub">会话累计 $${Number(co.sessionCost ?? 0).toFixed(2)}</div>
      </div>
      <div class="card">
        <div class="card-label">健康评分</div>
        <div class="card-value ${healthColor}">${healthScore}</div>
        <div class="card-sub">综合运行质量</div>
      </div>
    </div>

    <div class="cards-grid" style="margin-bottom:20px;">
      <div class="card mode-card" style="cursor:default;">
        <div class="card-label">巡逻模式</div>
        <div class="card-sub" style="margin:8px 0;">自动 scan → plan → execute → review 循环</div>
        ${patrolBtn}
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

  // 加载最近任务 (API now returns {tasks, total, page, pageSize})
  const taskData = await api('/tasks?page=1&pageSize=5');
  const taskList = $('#dashboardTasks');
  const recentTasks = taskData?.tasks ?? taskData;
  if (recentTasks && Array.isArray(recentTasks) && recentTasks.length > 0) {
    taskList.innerHTML = `
      <div class="list-header">
        <span>近期任务</span>
        <a href="#/tasks" style="font-size:12px;">查看全部 &rarr;</a>
      </div>
      ${recentTasks.map((t) => renderTaskRow(t)).join('')}
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

// ---- Patrol control ----
async function startPatrol() {
  const result = await api('/patrol/start', { method: 'POST' });
  if (result?.ok) {
    toast('巡逻已启动');
    renderDashboard();
  }
}

async function stopPatrol() {
  toast('正在停止巡逻...');
  const result = await api('/patrol/stop', { method: 'POST' });
  if (result?.ok) {
    toast('巡逻已停止');
    renderDashboard();
  }
}

function showPlanForm() {
  const overlay = $('#modalOverlay');
  const modal = overlay.querySelector('.modal');
  modal.querySelector('.modal-header h3').textContent = '新建计划';
  modal.querySelector('.modal-body').innerHTML = `
    <div class="form-group">
      <label for="planDesc">需求描述</label>
      <textarea id="planDesc" class="form-input" rows="4" placeholder="描述你希望实现的功能或改进..."></textarea>
    </div>
    <div class="form-group">
      <label for="planGoals">目标 (可选, 每行一个)</label>
      <textarea id="planGoals" class="form-input" rows="2" placeholder="例如：提升性能\n改善用户体验"></textarea>
    </div>
    <div class="form-group">
      <label for="planConstraints">约束 (可选, 每行一个)</label>
      <textarea id="planConstraints" class="form-input" rows="2" placeholder="例如：不能修改 API 接口\n保持向后兼容"></textarea>
    </div>
    <div class="form-group">
      <label for="planModules">目标模块 (可选, 每行一个)</label>
      <textarea id="planModules" class="form-input" rows="2" placeholder="例如：src/core/\nsrc/server/"></textarea>
    </div>
  `;
  const submitBtn = modal.querySelector('#modalSubmit');
  submitBtn.textContent = '提交计划';
  submitBtn.onclick = async () => {
    const desc = $('#planDesc')?.value?.trim();
    if (!desc) { toast('请填写需求描述', 'error'); return; }
    const goals = $('#planGoals')?.value?.split('\n').map(s => s.trim()).filter(Boolean) || [];
    const constraints = $('#planConstraints')?.value?.split('\n').map(s => s.trim()).filter(Boolean) || [];
    const targetModules = $('#planModules')?.value?.split('\n').map(s => s.trim()).filter(Boolean) || [];
    const body = { description: desc };
    if (goals.length) body.goals = goals;
    if (constraints.length) body.constraints = constraints;
    if (targetModules.length) body.targetModules = targetModules;
    const result = await api('/plans', { method: 'POST', body: JSON.stringify(body) });
    if (result) {
      toast('计划生成已启动，请稍候查看');
      overlay.classList.remove('show');
      location.hash = '#/plans';
    }
  };
  overlay.classList.add('show');
}

function showAnalysisForm() {
  const overlay = $('#modalOverlay');
  const modal = overlay.querySelector('.modal');
  modal.querySelector('.modal-header h3').textContent = '发起代码分析';
  modal.querySelector('.modal-body').innerHTML = `
    <div class="form-group">
      <label for="analysisPath">模块路径</label>
      <input id="analysisPath" class="form-input" placeholder="例如：src/core/ 或留空分析整个项目">
    </div>
    <div class="form-group">
      <label><input type="checkbox" id="analysisProject"> 分析整个项目</label>
    </div>
  `;
  const submitBtn = modal.querySelector('#modalSubmit');
  submitBtn.textContent = '开始分析';
  submitBtn.onclick = async () => {
    const isProject = $('#analysisProject')?.checked;
    const modulePath = $('#analysisPath')?.value?.trim() || '';
    const body = isProject ? { type: 'project' } : { modulePath };
    const result = await api('/analysis', { method: 'POST', body: JSON.stringify(body) });
    if (result) {
      toast('代码分析已启动，请稍候查看');
      overlay.classList.remove('show');
      location.hash = '#/analysis';
    }
  };
  overlay.classList.add('show');
}

function renderTaskRow(t) {
  const st = getStatus(t.status);
  const pri = getPriorityStr(t.priority);
  const title = getTaskTitle(t);
  return `
    <div class="list-item" onclick="location.hash='#/tasks/${t.id}'">
      <span class="status-icon" title="${st.label}">${st.icon}</span>
      <span class="list-item-title">${escapeHtml(title)}</span>
      <span class="badge badge-${pri}">${priorityLabels[pri] || pri}</span>
      <span class="badge badge-${st.badge}">${st.label}</span>
      <span style="color:var(--text-muted);font-size:12px;min-width:70px;text-align:right;">${timeAgo(t.created_at)}</span>
    </div>
  `;
}

// ---- 任务列表 ----
const TASK_PAGE_SIZE = 20;

async function renderTasks() {
  const content = $('#content');
  const page = state.taskPage || 1;
  const data = await api(`/tasks?page=${page}&pageSize=${TASK_PAGE_SIZE}`);

  // Support both paginated {tasks, total} and legacy array responses
  const tasks = data?.tasks ?? (Array.isArray(data) ? data : []);
  const total = data?.total ?? tasks.length;
  const totalPages = Math.max(1, Math.ceil(total / TASK_PAGE_SIZE));

  if (!tasks.length && page === 1) {
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
        <span>全部任务 (${total})</span>
      </div>
      ${tasks.map((t) => renderTaskRow(t)).join('')}
    </div>
    ${totalPages > 1 ? renderPagination(page, totalPages, 'task') : ''}
  `;

  bindPagination(content, 'task', (p) => { state.taskPage = p; renderTasks(); });
}

function renderPagination(current, totalPages, key) {
  const pages = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= current - 1 && i <= current + 1)) {
      pages.push(i);
    } else if (pages.length > 0 && pages[pages.length - 1] !== '...') {
      pages.push('...');
    }
  }

  const attr = `data-${key}-page`;
  return `
    <div style="display:flex;align-items:center;justify-content:center;gap:4px;margin-top:16px;">
      <button class="btn btn-sm btn-secondary" ${attr}="${current - 1}" ${current <= 1 ? 'disabled' : ''}>&#8249;</button>
      ${pages.map(p =>
        p === '...'
          ? '<span style="padding:0 6px;color:var(--text-muted);">...</span>'
          : `<button class="btn btn-sm ${p === current ? 'btn-primary' : 'btn-secondary'}" ${attr}="${p}">${p}</button>`
      ).join('')}
      <button class="btn btn-sm btn-secondary" ${attr}="${current + 1}" ${current >= totalPages ? 'disabled' : ''}>&#8250;</button>
    </div>
  `;
}

function bindPagination(container, key, callback) {
  container.querySelectorAll(`[data-${key}-page]`).forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      callback(parseInt(btn.dataset[`${key}Page`], 10));
    });
  });
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
  const pri = getPriorityStr(task.priority);
  const title = getTaskTitle(task);
  const body = getTaskBody(task);
  const fullDesc = task.task_description || task.description || '';

  content.innerHTML = `
    <div class="detail-header">
      <a href="#/tasks" class="btn btn-sm btn-secondary">&larr; 返回</a>
      <h2>${escapeHtml(title)}</h2>
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
        <div class="meta-value">${task.git_branch || '-'}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">费用</div>
        <div class="meta-value">$${Number(task.total_cost_usd ?? 0).toFixed(4)}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">创建时间</div>
        <div class="meta-value">${task.created_at || '-'}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">阶段</div>
        <div class="meta-value">${task.phase || '-'}</div>
      </div>
    </div>

    <h3 class="section-title">任务描述</h3>
    <div class="card" style="margin-bottom:20px;">
      <div style="white-space:pre-wrap;font-size:13px;line-height:1.7;color:var(--text-secondary);">${escapeHtml(body || fullDesc || '无描述')}</div>
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
    <h3 class="section-title">任务日志 (${logs.length})</h3>
    <div class="list-container">
      ${logs.map((l) => {
        const duration = l.duration_ms ? `${(l.duration_ms / 1000).toFixed(1)}s` : '-';
        const cost = l.cost_usd ? `$${Number(l.cost_usd).toFixed(4)}` : '-';
        return `
          <div class="list-item" style="flex-wrap:wrap;gap:8px;cursor:default;">
            <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1;">
              <span class="badge badge-blue">${escapeHtml(l.phase || '-')}</span>
              <span class="badge badge-secondary">${escapeHtml(l.agent || '-')}</span>
              <span style="color:var(--text-muted);font-size:12px;">${duration} | ${cost}</span>
              <span style="color:var(--text-muted);font-size:12px;margin-left:auto;">${timeAgo(l.created_at)}</span>
            </div>
            ${l.input_summary ? `<div style="width:100%;font-size:12px;color:var(--text-secondary);padding:4px 0 0 8px;border-top:1px solid var(--border);"><strong>Input:</strong> ${escapeHtml(l.input_summary)}</div>` : ''}
            ${l.output_summary ? `<div style="width:100%;font-size:12px;color:var(--text);padding:4px 0 0 8px;"><strong>Output:</strong> ${escapeHtml(l.output_summary)}</div>` : ''}
          </div>`;
      }).join('')}
    </div>
  `;
}

// ---- 历史记录 ----
const HISTORY_PAGE_SIZE = 20;

async function renderHistory() {
  const content = $('#content');
  const page = state.historyPage || 1;
  const data = await api(`/tasks?status=done,failed&page=${page}&pageSize=${HISTORY_PAGE_SIZE}`);

  const tasks = data?.tasks ?? (Array.isArray(data) ? data : []);
  const total = data?.total ?? tasks.length;
  const totalPages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));

  if (!tasks.length && page === 1) {
    content.innerHTML = `<div class="empty-state"><div class="icon">&#128214;</div><p>暂无已完成的任务</p></div>`;
    return;
  }

  content.innerHTML = `
    <div class="list-container">
      <div class="list-header"><span>历史记录 (${total})</span></div>
      ${tasks.map((t) => renderTaskRow(t)).join('')}
    </div>
    ${totalPages > 1 ? renderPagination(page, totalPages, 'history') : ''}
  `;

  bindPagination(content, 'history', (p) => { state.historyPage = p; renderHistory(); });
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

async function connectLogStream() {
  if (state.logAbort) state.logAbort.abort();

  const output = $('#logOutput');
  if (!output) return;

  const controller = new AbortController();
  state.logAbort = controller;

  try {
    const res = await fetch('/api/logs?follow=true', {
      headers: { ...authHeaders(), Accept: 'text/event-stream' },
      signal: controller.signal,
    });

    if (res.status === 401) {
      clearToken();
      showAuthScreen('令牌无效或已过期，请重新输入');
      return;
    }

    if (!res.ok || !res.body) {
      appendLog({ level: 'error', message: `[日志流连接失败: HTTP ${res.status}]`, timestamp: new Date().toISOString() });
      return;
    }

    appendLog({ level: 'info', message: '[日志流已连接]', timestamp: new Date().toISOString() });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const payload = line.slice(6);
          try {
            appendLog(JSON.parse(payload));
          } catch {
            appendLog({ level: 'info', message: payload, timestamp: new Date().toISOString() });
          }
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return; // intentional cleanup
    appendLog({ level: 'warn', message: '[连接断开，5秒后重连...]', timestamp: new Date().toISOString() });
    setTimeout(() => {
      if (state.currentPage === 'logs') connectLogStream();
    }, 5000);
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
// ---- 插件管理 ----
async function renderPlugins() {
  const content = $('#content');
  const data = await api('/plugins');

  if (!data) {
    content.innerHTML = '<div class="empty-state"><p>插件监控不可用</p></div>';
    return;
  }

  const relevanceColors = { essential: '#10b981', recommended: '#3b82f6', optional: '#6b7280', irrelevant: '#9ca3af' };
  const relevanceLabels = { essential: '核心', recommended: '推荐', optional: '可选', irrelevant: '无关' };

  function pluginCard(p) {
    const statusBadge = p.installed
      ? (p.enabled ? '<span class="badge badge-success">已启用</span>' : '<span class="badge badge-muted">已禁用</span>')
      : '<span class="badge badge-info">未安装</span>';
    const updateBadge = p.hasUpdate ? '<span class="badge badge-warning">可更新</span>' : '';
    const relevanceDot = `<span style="color:${relevanceColors[p.relevance] || '#6b7280'}">${relevanceLabels[p.relevance] || p.relevance}</span>`;

    const actions = [];
    if (!p.installed) {
      actions.push(`<button class="btn btn-sm btn-primary" onclick="pluginAction('${escapeHtml(p.name)}','install')">安装</button>`);
    } else {
      if (p.hasUpdate) actions.push(`<button class="btn btn-sm btn-warning" onclick="pluginAction('${escapeHtml(p.name)}','update')">更新</button>`);
      if (p.enabled) {
        actions.push(`<button class="btn btn-sm btn-secondary" onclick="pluginAction('${escapeHtml(p.name)}','disable')">禁用</button>`);
      } else {
        actions.push(`<button class="btn btn-sm btn-success" onclick="pluginAction('${escapeHtml(p.name)}','enable')">启用</button>`);
      }
    }

    return `
      <div class="card plugin-card">
        <div class="plugin-header">
          <strong>${escapeHtml(p.name.split('/').pop() || p.name)}</strong>
          <div class="plugin-badges">${statusBadge} ${updateBadge} ${relevanceDot}</div>
        </div>
        <p class="plugin-desc">${escapeHtml(p.description || '无描述')}</p>
        <div class="plugin-meta">
          <span>v${escapeHtml(p.version || '?')}</span>
          <div class="plugin-actions">${actions.join(' ')}</div>
        </div>
      </div>`;
  }

  const installed = (data.installed || []);
  const available = (data.available || []);
  const checkedAt = data.checkedAt ? new Date(data.checkedAt).toLocaleString('zh-CN') : '-';

  content.innerHTML = `
    <div class="page-header">
      <h2>插件管理</h2>
      <span class="text-muted">最近检查: ${escapeHtml(checkedAt)}</span>
    </div>

    <div class="section">
      <h3>已安装插件 (${installed.length})</h3>
      <div class="plugin-grid">
        ${installed.length > 0 ? installed.map(pluginCard).join('') : '<p class="text-muted">暂无已安装插件</p>'}
      </div>
    </div>

    ${available.length > 0 ? `
    <div class="section">
      <h3>可用插件 (${available.length})</h3>
      <div class="plugin-grid">
        ${available.map(pluginCard).join('')}
      </div>
    </div>` : ''}
  `;
}

async function pluginAction(name, action) {
  const res = await api(`/plugins/${encodeURIComponent(name)}/${action}`, { method: 'POST' });
  if (res?.ok) {
    toast(`插件 ${name} ${action} 成功`);
    renderPlugins();
  } else {
    toast(`操作失败: ${res?.error || '未知错误'}`, 'error');
  }
}
window.pluginAction = pluginAction;

// ---- 进化分析 ----
async function renderEvolution() {
  const content = $('#content');
  const [summary, reviewPatterns, adjustments] = await Promise.all([
    api('/evolution/summary'),
    api('/evolution/review-patterns'),
    api('/evolution/adjustments'),
  ]);

  if (!summary) {
    content.innerHTML = '<div class="empty-state"><p>进化引擎不可用</p></div>';
    return;
  }

  // Review patterns section
  const patternsHtml = reviewPatterns?.categories?.length > 0
    ? reviewPatterns.categories.map((c) => `
        <div class="list-item">
          <span class="list-item-title">${escapeHtml(c.category)}</span>
          <span class="badge ${c.count >= 5 ? 'badge-failed' : c.count >= 3 ? 'badge-warning' : 'badge-pending'}">${c.count} 次</span>
        </div>`).join('')
    : '<div class="empty-state"><p>暂无审查模式数据</p></div>';

  // Adjustments section
  const adjHtml = adjustments?.length > 0
    ? adjustments.slice(0, 10).map((a) => {
        const effColor = a.effectiveness > 0.3 ? 'green' : a.effectiveness < -0.1 ? 'red' : 'orange';
        return `<div class="list-item">
          <span class="badge badge-${a.category === 'avoidance' ? 'failed' : 'pending'}" style="min-width:60px;text-align:center;">${escapeHtml(a.category)}</span>
          <span class="list-item-title">${escapeHtml(a.text.slice(0, 100))}</span>
          <span style="color:${effColor};font-size:12px;min-width:50px;text-align:right;">${a.effectiveness.toFixed(2)}</span>
        </div>`;
      }).join('')
    : '<div class="empty-state"><p>暂无活跃调整</p></div>';

  // Goals section
  const goalsHtml = summary.goals?.length > 0
    ? summary.goals.map((g) => `
        <div class="list-item">
          <span class="list-item-title">目标 #${g.goalIndex}</span>
          <div style="flex:1;margin:0 12px;">
            <div style="background:var(--bg-tertiary);border-radius:4px;height:8px;overflow:hidden;">
              <div style="background:var(--primary);width:${Math.min(100, g.progress)}%;height:100%;border-radius:4px;"></div>
            </div>
          </div>
          <span style="font-size:12px;color:var(--text-muted);min-width:40px;text-align:right;">${Math.round(g.progress)}%</span>
        </div>`).join('')
    : '<div class="empty-state"><p>暂无目标</p></div>';

  content.innerHTML = `
    <div class="cards-grid">
      <div class="card">
        <div class="card-label">活跃调整</div>
        <div class="card-value blue">${summary.adjustments?.active ?? 0}</div>
      </div>
      <div class="card">
        <div class="card-label">待处理提案</div>
        <div class="card-value orange">${summary.proposals?.pending ?? 0}</div>
      </div>
      <div class="card">
        <div class="card-label">健康趋势</div>
        <div class="card-value ${summary.trends?.health?.direction === 'improving' ? 'green' : summary.trends?.health?.direction === 'degrading' ? 'red' : ''}">${summary.trends?.health?.direction === 'improving' ? '↑ 上升' : summary.trends?.health?.direction === 'degrading' ? '↓ 下降' : '→ 稳定'}</div>
        <div class="card-sub">Δ ${summary.trends?.health?.delta?.toFixed(1) ?? 0}</div>
      </div>
      <div class="card">
        <div class="card-label">审查问题类型</div>
        <div class="card-value">${reviewPatterns?.categories?.length ?? 0}</div>
      </div>
    </div>

    <div class="list-container" style="margin-bottom:20px;">
      <div class="list-header"><span>反复出现的审查问题</span></div>
      ${patternsHtml}
    </div>

    <div class="list-container" style="margin-bottom:20px;">
      <div class="list-header"><span>活跃调整 (Top 10)</span></div>
      ${adjHtml}
    </div>

    <div class="list-container">
      <div class="list-header"><span>目标进度</span></div>
      ${goalsHtml}
    </div>
  `;
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
  const costsArr = Array.isArray(cost?.costs) ? cost.costs : Array.isArray(config.dailyCosts) ? config.dailyCosts : [];
  const settingsTodayCost = costsArr.length > 0 ? Number(costsArr[0].total_cost_usd || 0) : 0;

  content.innerHTML = `
    <div class="config-block">
      <h3>运行状态</h3>
      ${configRow('系统状态', getStatus(config.state).label)}
      ${configRow('是否暂停', config.paused ? '是' : '否')}
      ${configRow('当前任务', config.currentTaskId || '无')}
      ${configRow('巡逻', config.patrolling ? '运行中' : '已停止')}
    </div>

    <div class="config-block">
      <h3>费用统计</h3>
      ${configRow('今日费用', `$${settingsTodayCost.toFixed(4)}`)}
      ${configRow('会话费用', `$${Number(cost?.sessionCost ?? 0).toFixed(4)}`)}
      ${costsArr.map(c => configRow(c.date, `$${Number(c.total_cost_usd || 0).toFixed(4)} (${c.task_count} 任务)`)).join('')}
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
  setTimeout(() => $('#taskTitle').focus(), 100);
}

function closeModal() {
  $('#modalOverlay').classList.remove('show');
}

async function submitTask() {
  const title = $('#taskTitle').value.trim();
  const desc = $('#taskDesc').value.trim();
  const priorityStr = $('#taskPriority').value;

  if (!title) {
    toast('请输入任务标题', 'error');
    return;
  }

  // Combine title + description into a single description field
  // First line = title, rest = body (backend only has task_description)
  const description = desc ? `${title}\n\n${desc}` : title;
  const priority = priorityStrToNum[priorityStr] ?? 2;

  const res = await api('/tasks', {
    method: 'POST',
    body: JSON.stringify({ description, priority }),
  });

  if (res !== null) {
    closeModal();
    toast('任务创建成功');
    location.hash = '#/tasks';
  }
}

// ---- 计划对话页面 ----
const planStatusLabels = {
  draft: { label: '草案', badge: 'pending' },
  approved: { label: '已批准', badge: 'done' },
  rejected: { label: '已拒绝', badge: 'failed' },
  expired: { label: '已过期', badge: 'paused' },
};

const chatStatusLabels = {
  chatting: { label: '对话中', badge: 'running' },
  researching: { label: '研究中', badge: 'running' },
  generating: { label: '生成计划中', badge: 'running' },
  ready: { label: '计划就绪', badge: 'done' },
  error: { label: '出错', badge: 'failed' },
};

async function renderPlans() {
  const content = $('#content');
  const drafts = await api('/plans');

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h2 style="margin:0;">计划对话</h2>
      <button class="btn btn-primary" onclick="startNewChat()">+ 开始新对话</button>
    </div>
    <div class="list-container" id="planList">
      ${!drafts || drafts.length === 0 ? '<div class="empty-state"><p>暂无计划会话，点击上方按钮开始</p></div>' :
        drafts.map(d => {
          const chatSt = chatStatusLabels[d.chat_status];
          const planSt = planStatusLabels[d.status] || planStatusLabels.draft;
          const st = chatSt || planSt;
          const taskCount = d.plan?.tasks?.length ?? 0;
          const title = d.chat_status
            ? (d.markdown || '').split('\\n')[0].slice(0, 80) || '对话 #' + d.id
            : (d.markdown || d.reasoning || '').split('\\n')[0].slice(0, 80) || '计划 #' + d.id;
          return `
            <div class="list-item" onclick="location.hash='#/plans/${d.id}'">
              <span class="badge badge-${st.badge}">${st.label}</span>
              <span class="list-item-title" style="flex:1;">${escapeHtml(title)}</span>
              ${taskCount > 0 ? `<span style="color:var(--text-muted);font-size:12px;">${taskCount} 任务</span>` : ''}
              <span style="color:var(--text-muted);font-size:12px;min-width:50px;text-align:right;">$${Number(d.cost_usd || 0).toFixed(2)}</span>
              <span style="color:var(--text-muted);font-size:12px;min-width:70px;text-align:right;">${timeAgo(d.created_at)}</span>
            </div>`;
        }).join('')}
    </div>
  `;
}

async function startNewChat() {
  const result = await api('/plans/chat', { method: 'POST', body: '{}' });
  if (result?.id) {
    location.hash = `#/plans/${result.id}`;
  }
}

async function renderPlanDetail(id) {
  const content = $('#content');
  const draft = await api(`/plans/${id}`);
  if (!draft) { content.innerHTML = '<div class="empty-state"><p>计划不存在</p></div>'; return; }

  // Chat-based sessions show chat UI; legacy drafts show plan detail
  const isChatSession = !!draft.chat_status;
  const isInChat = isChatSession && ['chatting', 'researching', 'generating'].includes(draft.chat_status);

  if (isInChat) {
    renderChatView(id, draft);
  } else if (isChatSession && draft.chat_status === 'ready' && draft.plan?.tasks?.length > 0) {
    renderPlanReviewView(id, draft);
  } else if (!isChatSession || draft.status !== 'draft' || draft.plan?.tasks?.length > 0) {
    renderPlanReviewView(id, draft);
  } else {
    renderChatView(id, draft);
  }
}

async function renderChatView(id, draft) {
  const content = $('#content');
  const chatSt = chatStatusLabels[draft.chat_status] || chatStatusLabels.chatting;

  content.innerHTML = `
    <div class="chat-container">
      <div class="chat-status-bar">
        <a href="#/plans" style="font-size:12px;color:var(--text-muted);text-decoration:none;">&larr; 返回列表</a>
        <span style="flex:1;"></span>
        <span class="badge badge-${chatSt.badge}" id="chatStatusBadge">${chatSt.label}</span>
        <button class="btn btn-sm btn-success" id="btnGeneratePlan" style="display:none;" onclick="generatePlanFromChat(${id})">生成计划</button>
        <button class="btn btn-sm btn-secondary" onclick="closeChatSession(${id})">关闭会话</button>
      </div>
      <div class="chat-messages" id="chatMessages"></div>
      <div class="chat-input-area">
        <textarea class="chat-input" id="chatInput" placeholder="描述你的需求，或继续对话..." rows="2"></textarea>
        <button class="btn btn-primary chat-send-btn" id="chatSendBtn" onclick="sendChatMessage(${id})">发送</button>
      </div>
    </div>
  `;

  // Load existing messages
  const messages = await api(`/plans/${id}/messages`);
  if (messages && messages.length > 0) {
    messages.forEach(m => appendChatBubble(m.role, m.content));
  }

  // Show generate button if ready
  if (draft.chat_status === 'ready') {
    const btn = $('#btnGeneratePlan');
    if (btn) btn.style.display = '';
  }

  // Setup SSE
  setupChatSSE(id);

  // Setup Enter key handling
  const input = $('#chatInput');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage(id);
      }
    });
    input.focus();
  }
}

function renderPlanReviewView(id, draft) {
  const content = $('#content');
  const st = planStatusLabels[draft.status] || planStatusLabels.draft;
  const tasks = draft.plan?.tasks || [];

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <div>
        <a href="#/plans" style="font-size:12px;color:var(--text-muted);">&larr; 返回列表</a>
        <h2 style="margin:4px 0 0;">计划 #${draft.id} <span class="badge badge-${st.badge}">${st.label}</span></h2>
      </div>
      <div style="display:flex;gap:8px;">
        ${draft.status === 'draft' ? `
          <button class="btn btn-success" onclick="approvePlan(${draft.id})">批准</button>
          <button class="btn btn-warning" onclick="rejectPlan(${draft.id})">拒绝</button>
        ` : ''}
        ${draft.status === 'approved' ? `
          <button class="btn btn-primary" onclick="executePlan(${draft.id})">执行计划</button>
        ` : ''}
      </div>
    </div>
    <div class="card" style="margin-bottom:16px;padding:16px;">
      <div class="card-label">分析摘要</div>
      <div style="white-space:pre-wrap;font-size:13px;max-height:200px;overflow-y:auto;">${escapeHtml(draft.analysis_summary || '无').slice(0, 2000)}</div>
    </div>
    <div class="card" style="margin-bottom:16px;padding:16px;">
      <div class="card-label">计划内容</div>
      <div style="white-space:pre-wrap;font-size:13px;" id="planMarkdown">${escapeHtml(draft.markdown || draft.reasoning || '无')}</div>
    </div>
    <div class="card" style="padding:16px;">
      <div class="card-label">任务列表 (${tasks.length})</div>
      <div class="list-container">
        ${tasks.map((t, i) => `
          <div class="list-item" style="cursor:default;">
            <span style="color:var(--text-muted);font-size:12px;min-width:30px;">#${i + 1}</span>
            <span class="list-item-title" style="flex:1;">${escapeHtml(t.description || '')}</span>
            <span class="badge badge-${t.priority <= 1 ? 'high' : t.priority === 2 ? 'medium' : 'low'}">${t.executor || 'auto'}</span>
            <span style="color:var(--text-muted);font-size:12px;">${t.estimatedComplexity || ''}</span>
          </div>
        `).join('')}
      </div>
    </div>
    <div style="margin-top:12px;color:var(--text-muted);font-size:12px;">
      费用: $${Number(draft.cost_usd || 0).toFixed(4)} | 创建: ${timeAgo(draft.created_at)}
      ${draft.reviewed_at ? ' | 审核: ' + timeAgo(draft.reviewed_at) : ''}
    </div>
  `;
}

// ---- Chat helpers ----

function appendChatBubble(role, content) {
  const container = $('#chatMessages');
  if (!container) return;
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${role}`;
  bubble.innerHTML = `
    <div class="chat-bubble-role">${role === 'user' ? '你' : role === 'assistant' ? 'Claude' : '系统'}</div>
    <div class="chat-bubble-content">${escapeHtml(content)}</div>
  `;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

function getOrCreateStreamingBubble() {
  let bubble = $('#chatMessages .chat-bubble.assistant.streaming');
  if (!bubble) {
    const container = $('#chatMessages');
    if (!container) return null;
    bubble = document.createElement('div');
    bubble.className = 'chat-bubble assistant streaming';
    bubble.innerHTML = `
      <div class="chat-bubble-role">Claude</div>
      <div class="chat-bubble-content"><span class="typing-indicator"><span></span><span></span><span></span></span></div>
    `;
    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
  }
  return bubble;
}

function finalizeStreamingBubble(text) {
  const bubble = $('#chatMessages .chat-bubble.assistant.streaming');
  if (bubble) {
    bubble.classList.remove('streaming');
    const contentEl = bubble.querySelector('.chat-bubble-content');
    if (contentEl && text) contentEl.textContent = text;
  }
}

async function setupChatSSE(draftId) {
  // Close existing
  if (state.chatEventSource) {
    state.chatEventSource.abort();
    state.chatEventSource = null;
  }

  const controller = new AbortController();
  state.chatEventSource = controller;

  try {
    const res = await fetch(`/api/plans/${draftId}/stream`, {
      headers: { ...authHeaders(), Accept: 'text/event-stream' },
      signal: controller.signal,
    });

    if (!res.ok || !res.body) return;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let currentEvent = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const payload = line.slice(6);
          handleChatSSEEvent(currentEvent || 'message', payload, draftId);
          currentEvent = '';
        } else if (line.trim() === '') {
          currentEvent = '';
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    // Reconnect after delay
    setTimeout(() => {
      if (state.currentPage === 'planDetail') setupChatSSE(draftId);
    }, 5000);
  }
}

function handleChatSSEEvent(event, payload, draftId) {
  let data;
  try { data = JSON.parse(payload); } catch { return; }

  if (event === 'message') {
    if (data.role === 'assistant') {
      finalizeStreamingBubble(data.content);
    }
  } else if (event === 'partial') {
    getOrCreateStreamingBubble();
    const container = $('#chatMessages');
    if (container) container.scrollTop = container.scrollHeight;
  } else if (event === 'assistant_text') {
    const bubble = getOrCreateStreamingBubble();
    if (bubble) {
      const contentEl = bubble.querySelector('.chat-bubble-content');
      if (contentEl) contentEl.textContent = data.text;
      const container = $('#chatMessages');
      if (container) container.scrollTop = container.scrollHeight;
    }
  } else if (event === 'status') {
    const badge = $('#chatStatusBadge');
    const st = chatStatusLabels[data.status];
    if (badge && st) {
      badge.textContent = st.label;
      badge.className = `badge badge-${st.badge}`;
    }
    const sendBtn = $('#chatSendBtn');
    const input = $('#chatInput');
    if (data.status === 'researching' || data.status === 'generating') {
      if (sendBtn) sendBtn.disabled = true;
      if (input) input.disabled = true;
    } else {
      if (sendBtn) sendBtn.disabled = false;
      if (input) input.disabled = false;
    }
    const genBtn = $('#btnGeneratePlan');
    if (genBtn) genBtn.style.display = data.status === 'ready' ? '' : 'none';
    if (data.status === 'ready') {
      finalizeStreamingBubble('');
    }
  } else if (event === 'plan_ready') {
    toast('计划已生成');
    cleanup();
    renderPlanDetail(draftId);
  }
}

async function sendChatMessage(draftId) {
  const input = $('#chatInput');
  if (!input) return;
  const msg = input.value.trim();
  if (!msg) return;

  input.value = '';
  appendChatBubble('user', msg);

  await api(`/plans/${draftId}/message`, {
    method: 'POST',
    body: JSON.stringify({ message: msg }),
  });
}

async function generatePlanFromChat(draftId) {
  const btn = $('#btnGeneratePlan');
  if (btn) { btn.disabled = true; btn.textContent = '生成中...'; }
  await api(`/plans/${draftId}/generate`, { method: 'POST', body: '{}' });
}

async function closeChatSession(draftId) {
  await api(`/plans/${draftId}/close`, { method: 'POST', body: '{}' });
  toast('会话已关闭');
  location.hash = '#/plans';
}

async function approvePlan(id) {
  const result = await api(`/plans/${id}/approve`, { method: 'POST', body: '{}' });
  if (result?.ok) {
    toast('计划已批准');
    renderPlanDetail(id);
  }
}

async function rejectPlan(id) {
  const result = await api(`/plans/${id}/reject`, { method: 'POST', body: '{}' });
  if (result?.ok) {
    toast('计划已拒绝');
    renderPlanDetail(id);
  }
}

async function executePlan(id) {
  const result = await api(`/plans/${id}/execute`, { method: 'POST', body: '{}' });
  if (result?.ok) {
    toast('计划任务已加入队列');
    location.hash = '#/tasks';
  }
}

// ---- 代码分析页面 ----
async function renderAnalysis() {
  const content = $('#content');
  const reports = await api('/analysis');

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h2 style="margin:0;">代码分析</h2>
      <button class="btn btn-primary" onclick="showAnalysisForm()">+ 发起分析</button>
    </div>
    <div class="list-container" id="analysisList">
      ${!reports || reports.length === 0 ? '<div class="empty-state"><p>暂无分析报告</p></div>' :
        reports.map(r => `
          <div class="list-item" onclick="location.hash='#/analysis/${r.id}'">
            <span class="list-item-title" style="flex:1;">${escapeHtml(r.title || '分析 #' + r.id)}</span>
            <span style="color:var(--text-muted);font-size:12px;">${r.modules?.length ?? 0} 模块</span>
            <span style="color:var(--text-muted);font-size:12px;min-width:80px;">${escapeHtml(r.module_path || '.')}</span>
            <span style="color:var(--text-muted);font-size:12px;min-width:50px;text-align:right;">$${Number(r.cost_usd || 0).toFixed(2)}</span>
            <span style="color:var(--text-muted);font-size:12px;min-width:70px;text-align:right;">${timeAgo(r.created_at)}</span>
          </div>
        `).join('')}
    </div>
  `;

}

async function renderAnalysisDetail(id) {
  const content = $('#content');
  const report = await api(`/analysis/${id}`);
  if (!report) { content.innerHTML = '<div class="empty-state"><p>报告不存在</p></div>'; return; }

  const modules = report.modules || [];
  const complexityColors = { low: 'green', medium: 'orange', high: 'red' };

  content.innerHTML = `
    <div style="margin-bottom:16px;">
      <a href="#/analysis" style="font-size:12px;color:var(--text-muted);">&larr; 返回列表</a>
      <h2 style="margin:4px 0 0;">${escapeHtml(report.title || '分析报告 #' + report.id)}</h2>
      <div style="color:var(--text-muted);font-size:12px;">模块: ${escapeHtml(report.module_path || '.')} | 费用: $${Number(report.cost_usd || 0).toFixed(4)} | ${timeAgo(report.created_at)}</div>
    </div>
    <div class="card" style="margin-bottom:16px;padding:16px;">
      <div class="card-label">摘要</div>
      <div style="white-space:pre-wrap;font-size:13px;">${escapeHtml(report.summary || '无')}</div>
    </div>
    <div class="card" style="margin-bottom:16px;padding:16px;">
      <div class="card-label">详细报告</div>
      <div style="white-space:pre-wrap;font-size:13px;max-height:500px;overflow-y:auto;">${escapeHtml(report.markdown || '无')}</div>
    </div>
    ${modules.length > 0 ? `
    <div class="card" style="padding:16px;">
      <div class="card-label">模块列表 (${modules.length})</div>
      <div class="list-container">
        ${modules.map(m => `
          <div class="list-item" style="cursor:default;">
            <span class="badge badge-${m.type === 'class' ? 'running' : m.type === 'function' ? 'pending' : 'done'}">${m.type}</span>
            <span class="list-item-title" style="flex:1;">${escapeHtml(m.name)}</span>
            <span style="color:var(--text-muted);font-size:12px;">${escapeHtml(m.path)}</span>
            <span style="color:${complexityColors[m.complexity] || 'inherit'};font-size:12px;">${m.complexity}</span>
            <span style="color:var(--text-muted);font-size:12px;">${m.lines}L</span>
          </div>
        `).join('')}
      </div>
    </div>` : ''}
  `;
}

// ---- 移动端菜单 ----
function toggleSidebar() {
  $('#sidebar').classList.toggle('open');
}

// ---- 认证流程 ----
async function attemptAuth(token) {
  setToken(token);

  // Validate token against server
  try {
    const res = await fetch('/api/status', {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 401) {
      clearToken();
      showAuthScreen('令牌无效，请检查后重试');
      return false;
    }

    if (res.ok) {
      hideAuthScreen();
      updateConnection(true);
      navigate();
      return true;
    }
  } catch {
    // Network error — token might still be valid, let the user proceed
  }

  hideAuthScreen();
  navigate();
  return true;
}

function setupAuthListeners() {
  const input = $('#authTokenInput');
  const submit = $('#authSubmit');

  submit.addEventListener('click', () => {
    const token = input.value.trim();
    if (!token) {
      showAuthScreen('请输入令牌');
      return;
    }
    attemptAuth(token);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const token = input.value.trim();
      if (token) attemptAuth(token);
    }
  });
}

// ---- 初始化 ----
function init() {
  // 认证界面事件
  setupAuthListeners();

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

  // 检查已保存的令牌
  const savedToken = getToken();
  if (savedToken) {
    // Validate saved token silently
    hideAuthScreen();
    api('/status').then((res) => {
      updateConnection(!!res);
      // If api() got 401, it already showed auth screen
    });
    navigate();
  } else {
    // No token — show auth screen
    showAuthScreen();
  }
}

document.addEventListener('DOMContentLoaded', init);
