/* ========================================
   DB-Coder 控制台 - 前端逻辑
   ======================================== */

// ---- 全局状态 ----
const AUTH_STORAGE_KEY = "db-coder-api-token";

const state = {
  paused: false,
  refreshTimer: null,
  logAbort: null, // AbortController for fetch-based SSE
  statusAbort: null, // AbortController for status SSE stream
  logLevel: "info",
  currentPage: "",
  taskPage: 1,
  historyPage: 1,
};

// ---- 工具函数 ----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---- 令牌管理 ----
function getToken() {
  return localStorage.getItem(AUTH_STORAGE_KEY) || "";
}

function setToken(token) {
  localStorage.setItem(AUTH_STORAGE_KEY, token.trim());
}

function clearToken() {
  localStorage.removeItem(AUTH_STORAGE_KEY);
}

function showAuthScreen(errorMsg) {
  const overlay = $("#authOverlay");
  const errEl = $("#authError");
  if (!overlay) return;

  overlay.classList.remove("hidden");
  if (errorMsg) {
    errEl.textContent = errorMsg;
    errEl.classList.add("show");
  } else {
    errEl.classList.remove("show");
  }
  setTimeout(() => $("#authTokenInput")?.focus(), 100);
}

function hideAuthScreen() {
  const overlay = $("#authOverlay");
  if (overlay) overlay.classList.add("hidden");
}

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function api(path, opts = {}) {
  try {
    const res = await fetch(`/api${path}`, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
        ...opts.headers,
      },
    });

    if (res.status === 401) {
      clearToken();
      showAuthScreen("令牌无效或已过期，请重新输入");
      return null;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`API 请求失败: ${path}`, err);
    toast(`请求失败: ${err.message}`, "error");
    return null;
  }
}

function toast(msg, type = "success") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

function timeAgo(dateStr) {
  if (!dateStr) return "-";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderMarkdown(text) {
  if (
    typeof marked !== "undefined" &&
    marked.parse &&
    typeof DOMPurify !== "undefined"
  ) {
    try {
      return DOMPurify.sanitize(marked.parse(text, { breaks: true }));
    } catch {
      /* fall through */
    }
  }
  return escapeHtml(text).replace(/\n/g, "<br>");
}

const statusMap = {
  pending: { icon: "○", badge: "pending", label: "等待中" },
  queued: { icon: "◎", badge: "pending", label: "排队中" },
  running: { icon: "●", badge: "running", label: "运行中" },
  in_progress: { icon: "●", badge: "running", label: "进行中" },
  done: { icon: "✓", badge: "done", label: "已完成" },
  completed: { icon: "✓", badge: "done", label: "已完成" },
  failed: { icon: "✗", badge: "failed", label: "失败" },
  paused: { icon: "❚❚", badge: "paused", label: "已暂停" },
  pending_review: { icon: "⚠", badge: "warning", label: "待审核" },
  blocked: { icon: "⊘", badge: "failed", label: "已阻断" },
  skipped: { icon: "⊘", badge: "pending", label: "已跳过" },
  active: { icon: "●", badge: "running", label: "执行中" },
};

function getStatus(s) {
  return statusMap[s] || { icon: "?", badge: "pending", label: s || "未知" };
}

const priorityLabels = {
  low: "低",
  medium: "中",
  high: "高",
  critical: "紧急",
};

// Map numeric priority (from DB) to string key for display
// DB schema: 0=P0 urgent, 1=P1 high, 2=P2 medium, 3=P3 low
const priorityNumToStr = { 0: "critical", 1: "high", 2: "medium", 3: "low" };
const priorityStrToNum = { critical: 0, high: 1, medium: 2, low: 3 };

function getPriorityStr(numOrStr) {
  if (typeof numOrStr === "number")
    return priorityNumToStr[numOrStr] || "medium";
  return numOrStr || "medium";
}

// Extract a display title from task_description (first line, truncated)
function getTaskTitle(task) {
  const desc = task.task_description || task.description || "";
  if (!desc) return `任务 #${task.id}`;
  const firstLine = desc.split("\n")[0].trim();
  return firstLine.slice(0, 80) || `任务 #${task.id}`;
}

// Get the full description body (everything after the first line)
function getTaskBody(task) {
  const desc = task.task_description || task.description || "";
  const lines = desc.split("\n");
  if (lines.length <= 1) return "";
  // Skip first line (title) and any blank line after it
  let start = 1;
  while (start < lines.length && lines[start].trim() === "") start++;
  return lines.slice(start).join("\n");
}

function getCurrentTaskSubtitle(status) {
  const currentTaskId = status?.currentTaskId ?? null;
  const currentTaskTitle = status?.currentTaskTitle ?? null;
  if (!currentTaskId) {
    return "无进行中任务";
  }
  if (
    typeof currentTaskTitle === "string" &&
    currentTaskTitle.trim().length > 0
  ) {
    return getTaskTitle({
      id: currentTaskId,
      task_description: currentTaskTitle,
    });
  }
  const taskIdLabel = String(currentTaskId).slice(0, 8);
  return `任务 #${taskIdLabel}...`;
}

// ---- 路由 ----
const routes = [
  { pattern: /^#\/$|^#?$/, page: "dashboard", title: "仪表盘" },
  { pattern: /^#\/tasks$/, page: "tasks", title: "任务列表" },
  { pattern: /^#\/tasks\/(.+)$/, page: "taskDetail", title: "任务详情" },
  { pattern: /^#\/history$/, page: "history", title: "历史记录" },
  { pattern: /^#\/logs$/, page: "logs", title: "运行日志" },
  { pattern: /^#\/plans$/, page: "plans", title: "计划列表" },
  { pattern: /^#\/plans\/(.+)$/, page: "planDetail", title: "计划详情" },
  { pattern: /^#\/settings$/, page: "settings", title: "系统设置" },
];

function navigate() {
  const hash = location.hash || "#/";
  let matched = false;

  for (const route of routes) {
    const m = hash.match(route.pattern);
    if (m) {
      matched = true;
      cleanup();
      state.currentPage = route.page;
      $("#pageTitle").textContent = route.title;
      updateNav(route.page);
      renderPage(route.page, m[1]);
      break;
    }
  }

  if (!matched) {
    location.hash = "#/";
  }
}

function updateNav(page) {
  $$(".nav-item").forEach((item) => {
    const p = item.dataset.page;
    item.classList.toggle(
      "active",
      p === page ||
        (page === "taskDetail" && p === "tasks") ||
        (page === "planDetail" && p === "plans"),
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
  if (state.statusAbort) {
    state.statusAbort.abort();
    state.statusAbort = null;
  }
  if (state.chatEventSource) {
    state.chatEventSource.abort();
    state.chatEventSource = null;
  }
}

// ---- 页面渲染 ----
function renderPage(page, param) {
  const content = $("#content");
  content.innerHTML =
    '<div class="loading"><div class="spinner"></div>加载中...</div>';

  const renderers = {
    dashboard: renderDashboard,
    tasks: renderTasks,
    taskDetail: () => renderTaskDetail(param),
    history: renderHistory,
    logs: renderLogs,
    plans: renderPlans,
    planDetail: () => renderPlanDetail(param),
    settings: renderSettings,
  };

  (renderers[page] || renderDashboard)();
}

// ---- 仪表盘 ----
function getPatrolStateDesc(
  patrolling,
  loopState,
  currentTaskId,
  scanInterval,
) {
  if (!patrolling) {
    return { title: "已停止", color: "", detail: '点击"开始巡逻"启动自动循环' };
  }
  const intervalMin = Math.round(scanInterval / 60);
  const intervalStr =
    intervalMin >= 1 ? `${intervalMin}分钟` : `${scanInterval}秒`;
  switch (loopState) {
    case "scanning":
      return { title: "扫描中", color: "blue", detail: "正在检测代码变更..." };
    case "planning":
      return {
        title: "规划中",
        color: "blue",
        detail: "正在分析问题并生成任务...",
      };
    case "executing":
      return {
        title: "执行中",
        color: "blue",
        detail: `正在执行任务 #${escapeHtml(String(currentTaskId || ""))}`,
      };
    case "reviewing":
      return {
        title: "审查中",
        color: "orange",
        detail: "Claude + Codex 双重代码审查",
      };
    case "reflecting":
      return {
        title: "反思中",
        color: "orange",
        detail: "总结经验，提取改进建议",
      };
    case "paused":
      return { title: "已暂停", color: "orange", detail: "巡逻暂停中" };
    case "error":
      return { title: "出错", color: "red", detail: "30秒后自动重试" };
    case "idle":
    default:
      return {
        title: "等待中",
        color: "",
        detail: `无变更，每 ${intervalStr} 扫描一次`,
      };
  }
}

async function renderDashboard() {
  const [status, cost, cycleMetrics, cycleEntries] = await Promise.all([
    api("/status"),
    api("/cost"),
    api("/cycle/metrics").catch(() => null),
    api("/cycle/entries?limit=20").catch(() => []),
  ]);
  const content = $("#content");

  const st = status || {};
  const co = cost || {};
  const patrolling = !!st.patrolling;

  // Extract today's cost from daily costs array (sorted by date DESC, [0] = most recent)
  const dailyCostsArr = Array.isArray(co.costs)
    ? co.costs
    : Array.isArray(st.dailyCosts)
      ? st.dailyCosts
      : [];
  const todayCost =
    dailyCostsArr.length > 0 ? Number(dailyCostsArr[0].total_cost_usd || 0) : 0;

  state.paused = !!st.paused;
  updatePatrolBtn(patrolling);

  const scanInterval = st.scanInterval || 300;
  const patrolStateDesc = getPatrolStateDesc(
    patrolling,
    st.state,
    st.currentTaskId,
    scanInterval,
  );
  const currentTaskSubtitle = getCurrentTaskSubtitle(st);

  const patrolBtn = patrolling
    ? `<button class="btn btn-sm btn-warning" data-action="stopPatrol">停止巡逻</button>`
    : `<button class="btn btn-sm btn-primary" data-action="startPatrol">开始巡逻</button>`;

  // Metrics summary
  const metrics = cycleMetrics || {};
  const successRateStr =
    typeof metrics.successRate === "number"
      ? `${Math.round(metrics.successRate * 100)}%`
      : "-";
  const avgDurationStr =
    typeof metrics.avgCycleDurationMs === "number"
      ? `${Math.round(metrics.avgCycleDurationMs / 1000)}s`
      : "-";

  content.innerHTML = `
    <div class="cards-grid" id="dashStatusCards">
      <div class="card" id="cardPatrolState">
        <div class="card-label">巡逻状态</div>
        <div class="card-value ${patrolStateDesc.color}" id="cardPatrolTitle">${patrolStateDesc.title}</div>
        <div class="card-sub" id="cardPatrolDetail">${patrolStateDesc.detail}</div>
      </div>
      <div class="card" id="cardCurrentTask">
        <div class="card-label">当前任务</div>
        <div class="card-value blue" style="font-size:16px;word-break:break-all;" id="cardTaskValue">${st.currentTaskId ? `<a href="#/tasks/${escapeHtml(String(st.currentTaskId))}">#${escapeHtml(String(st.currentTaskId))}</a>` : "空闲"}</div>
        <div class="card-sub" id="cardTaskSub">${escapeHtml(currentTaskSubtitle)}</div>
      </div>
      <div class="card">
        <div class="card-label">今日费用</div>
        <div class="card-value green" id="cardCostValue">$${todayCost.toFixed(2)}</div>
        <div class="card-sub" id="cardCostSub">会话累计 $${Number(co.sessionCost ?? 0).toFixed(2)}</div>
      </div>
      <div class="card" id="cardMetrics">
        <div class="card-label">循环指标</div>
        <div class="card-value blue" id="cardSuccessRate">${successRateStr}</div>
        <div class="card-sub" id="cardMetricsSub">共 ${metrics.totalCycles ?? 0} 轮 · 平均 ${avgDurationStr}</div>
      </div>
    </div>

    <div class="cards-grid" style="margin-bottom:20px;">
      <div class="card mode-card" style="cursor:default;">
        <div class="card-label">巡逻模式</div>
        <div class="card-sub" style="margin:8px 0;">自动 scan → plan → execute → review 循环</div>
        ${patrolBtn}
      </div>
    </div>

    <div id="cycleTimelineContainer">${renderCycleTimeline(st.cycleSteps, st.cycleNumber)}</div>

    <div id="activityContainer">${renderActivitySummary(Array.isArray(cycleEntries) ? cycleEntries : [])}</div>

    <div class="list-container" id="dashboardTasks">
      <div class="list-header">
        <span>近期任务</span>
        <a href="#/tasks" style="font-size:12px;">查看全部 &rarr;</a>
      </div>
      <div class="loading"><div class="spinner"></div>加载中...</div>
    </div>
  `;

  // 加载最近任务 (API now returns {tasks, total, page, pageSize})
  const taskData = await api("/tasks?page=1&pageSize=5");
  const taskList = $("#dashboardTasks");
  const recentTasks = taskData?.tasks ?? taskData;
  if (recentTasks && Array.isArray(recentTasks) && recentTasks.length > 0) {
    taskList.innerHTML = `
      <div class="list-header">
        <span>近期任务</span>
        <a href="#/tasks" style="font-size:12px;">查看全部 &rarr;</a>
      </div>
      ${recentTasks.map((t) => renderTaskRow(t)).join("")}
    `;
  } else {
    taskList.innerHTML = `
      <div class="list-header"><span>近期任务</span></div>
      <div class="empty-state"><p>暂无任务</p></div>
    `;
  }

  updateConnection(!!status);

  // SSE 实时更新 (替代 10s 轮询)
  connectStatusStream();
}

// ---- Cycle Timeline ----
const PHASE_LABELS = {
  decide: "决策",
  "create-task": "创建",
  execute: "执行",
  verify: "验证",
  review: "审查",
  reflect: "反思",
  merge: "合并",
};

function renderCycleTimeline(steps, cycleNumber) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return `<div class="cycle-timeline-container" style="margin-bottom:20px;">
      <div class="card" style="padding:16px 20px;">
        <div class="card-label">Cycle Pipeline</div>
        <div class="card-sub" style="margin-top:8px;">等待首个循环启动...</div>
      </div>
    </div>`;
  }

  const cycleLabel =
    typeof cycleNumber === "number"
      ? `Cycle #${cycleNumber}`
      : "Cycle Pipeline";
  const stepsHtml = steps
    .map((s, i) => {
      const label = PHASE_LABELS[s.phase] || s.phase;
      const durationStr =
        typeof s.durationMs === "number"
          ? `${Math.round(s.durationMs / 1000)}s`
          : "";
      const connector =
        i < steps.length - 1
          ? `<div class="step-connector ${s.status === "done" ? "done" : ""}"></div>`
          : "";
      return `
        <div class="timeline-step ${s.status}" data-phase="${escapeHtml(s.phase)}">
          <div class="step-indicator"></div>
          <div class="step-label">${label}</div>
          ${durationStr ? `<div class="step-duration">${durationStr}</div>` : ""}
        </div>${connector}`;
    })
    .join("");

  return `<div class="cycle-timeline-container" style="margin-bottom:20px;">
    <div class="card" style="padding:16px 20px;">
      <div class="card-label">${escapeHtml(cycleLabel)}</div>
      <div class="cycle-timeline">${stepsHtml}</div>
    </div>
  </div>`;
}

function updateCycleTimeline(steps, cycleNumber) {
  const container = $("#cycleTimelineContainer");
  if (!container) return;
  container.innerHTML = renderCycleTimeline(steps, cycleNumber);
}

// ---- Activity Summary ----
function renderActivitySummary(entries) {
  const recent = Array.isArray(entries) ? entries.slice(-10) : [];
  const rows = recent
    .reverse()
    .map((e) => renderActivityRow(e))
    .join("");

  return `<div class="activity-container" style="margin-bottom:20px;">
    <div class="card" style="padding:16px 20px;">
      <div class="card-label" style="margin-bottom:12px;">活动摘要</div>
      <div id="activityList">${rows || '<div class="card-sub">暂无活动记录</div>'}</div>
    </div>
  </div>`;
}

function renderActivityRow(entry) {
  const type = entry.type || entry.event || "info";
  const icon =
    type.includes("error") || type.includes("fail")
      ? "✗"
      : type.includes("start") || type.includes("begin")
        ? "▶"
        : type.includes("end") ||
            type.includes("done") ||
            type.includes("success")
          ? "✓"
          : "●";
  const iconClass =
    type.includes("error") || type.includes("fail")
      ? "red"
      : type.includes("success") || type.includes("done")
        ? "green"
        : "blue";
  const summary = summarizeCycleEntry(entry);
  const timeStr = entry.timestamp
    ? new Date(entry.timestamp).toLocaleTimeString("zh-CN", { hour12: false })
    : "";

  return `<div class="activity-entry">
    <span class="activity-icon ${iconClass}">${icon}</span>
    <span class="activity-text">${escapeHtml(summary)}</span>
    <span class="activity-time">${timeStr}</span>
  </div>`;
}

function summarizeCycleEntry(entry) {
  if (entry.summary) return entry.summary;
  if (entry.message) return entry.message;
  const type = entry.type || entry.event || "";
  const phase = entry.phase || "";
  if (type && phase) return `${phase}: ${type}`;
  return type || phase || "事件";
}

function appendActivityEntry(data) {
  const list = $("#activityList");
  if (!list) return;
  // Remove "no activity" placeholder
  const placeholder = list.querySelector(".card-sub");
  if (placeholder) placeholder.remove();

  const row = document.createElement("div");
  row.innerHTML = renderActivityRow(data);
  const entry = row.firstElementChild;
  if (entry) {
    list.prepend(entry);
    // Keep max 10 entries
    while (list.children.length > 10) {
      list.lastElementChild.remove();
    }
  }
}

// ---- Status SSE Stream ----
async function connectStatusStream() {
  if (state.statusAbort) state.statusAbort.abort();

  const controller = new AbortController();
  state.statusAbort = controller;

  try {
    const res = await fetch("/api/status/stream", {
      headers: { ...authHeaders(), Accept: "text/event-stream" },
      signal: controller.signal,
    });

    if (res.status === 401) {
      clearToken();
      showAuthScreen("令牌无效或已过期，请重新输入");
      return;
    }

    if (!res.ok || !res.body) return;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "message";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const payload = line.slice(6);
          try {
            handleStatusEvent(currentEvent, JSON.parse(payload));
          } catch {
            // ignore malformed data
          }
          currentEvent = "message";
        } else if (line === "") {
          currentEvent = "message";
        }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    // Reconnect after 5s
    setTimeout(() => {
      if (state.currentPage === "dashboard") connectStatusStream();
    }, 5000);
  }
}

function handleStatusEvent(eventType, data) {
  if (state.currentPage !== "dashboard") return;

  if (eventType === "status") {
    // Update status cards in-place
    const patrolling = !!data.patrolling;
    state.paused = !!data.paused;
    updatePatrolBtn(patrolling);
    updateConnection(true);

    const scanInterval = data.scanInterval || 300;
    const patrolStateDesc = getPatrolStateDesc(
      patrolling,
      data.state,
      data.currentTaskId,
      scanInterval,
    );

    const titleEl = $("#cardPatrolTitle");
    if (titleEl) {
      titleEl.textContent = patrolStateDesc.title;
      titleEl.className = `card-value ${patrolStateDesc.color}`;
    }
    const detailEl = $("#cardPatrolDetail");
    if (detailEl) detailEl.textContent = patrolStateDesc.detail;

    const taskValueEl = $("#cardTaskValue");
    if (taskValueEl) {
      taskValueEl.innerHTML = data.currentTaskId
        ? `<a href="#/tasks/${escapeHtml(String(data.currentTaskId))}">#${escapeHtml(String(data.currentTaskId))}</a>`
        : "空闲";
    }
    const taskSubEl = $("#cardTaskSub");
    if (taskSubEl) {
      taskSubEl.textContent = getCurrentTaskSubtitle(data);
    }

    // Update cycle timeline
    if (Array.isArray(data.cycleSteps)) {
      updateCycleTimeline(data.cycleSteps, data.cycleNumber);
    }
  } else if (eventType === "cycle-event") {
    // Append to activity summary
    appendActivityEntry(data);
  }
}

// ---- Patrol control ----
async function startPatrol() {
  const result = await api("/patrol/start", { method: "POST" });
  if (result?.ok) {
    toast("巡逻已启动");
    updatePatrolBtn(true);
    if (state.currentPage === "dashboard") renderDashboard();
  }
}

async function stopPatrol() {
  toast("正在停止巡逻...");
  const result = await api("/patrol/stop", { method: "POST" });
  if (result?.ok) {
    toast("巡逻已停止");
    updatePatrolBtn(false);
    if (state.currentPage === "dashboard") renderDashboard();
  }
}

function renderTaskRow(t) {
  const st = getStatus(t.status);
  const pri = getPriorityStr(t.priority);
  const title = getTaskTitle(t);
  const evalScore = t.evaluation_score
    ? ` (评分: ${t.evaluation_score.total})`
    : "";
  const evalActions =
    t.status === "pending_review"
      ? `
    <button class="btn btn-sm btn-primary" data-action="approveTask" data-id="${escapeHtml(String(t.id ?? ""))}" onclick="event.stopPropagation()">通过</button>
    <button class="btn btn-sm btn-secondary" data-action="skipTask" data-id="${escapeHtml(String(t.id ?? ""))}" onclick="event.stopPropagation()">跳过</button>
  `
      : "";
  return `
    <div class="list-item" data-action="navigate" data-id="#/tasks/${escapeHtml(String(t.id ?? ""))}">
      <span class="status-icon" title="${st.label}">${st.icon}</span>
      <span class="list-item-title">${escapeHtml(title)}${evalScore}</span>
      <span class="badge badge-${pri}">${priorityLabels[pri] || pri}</span>
      <span class="badge badge-${st.badge}">${st.label}</span>
      ${evalActions}
      <span style="color:var(--text-muted);font-size:12px;min-width:70px;text-align:right;">${timeAgo(t.created_at)}</span>
    </div>
  `;
}

// ---- 任务列表 ----
const TASK_PAGE_SIZE = 20;

async function renderTasks() {
  const content = $("#content");
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
      ${tasks.map((t) => renderTaskRow(t)).join("")}
    </div>
    ${totalPages > 1 ? renderPagination(page, totalPages, "task") : ""}
  `;

  bindPagination(content, "task", (p) => {
    state.taskPage = p;
    renderTasks();
  });
}

function renderPagination(current, totalPages, key) {
  const pages = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= current - 1 && i <= current + 1)) {
      pages.push(i);
    } else if (pages.length > 0 && pages[pages.length - 1] !== "...") {
      pages.push("...");
    }
  }

  const attr = `data-${key}-page`;
  return `
    <div style="display:flex;align-items:center;justify-content:center;gap:4px;margin-top:16px;">
      <button class="btn btn-sm btn-secondary" ${attr}="${current - 1}" ${current <= 1 ? "disabled" : ""}>&#8249;</button>
      ${pages
        .map((p) =>
          p === "..."
            ? '<span style="padding:0 6px;color:var(--text-muted);">...</span>'
            : `<button class="btn btn-sm ${p === current ? "btn-primary" : "btn-secondary"}" ${attr}="${p}">${p}</button>`,
        )
        .join("")}
      <button class="btn btn-sm btn-secondary" ${attr}="${current + 1}" ${current >= totalPages ? "disabled" : ""}>&#8250;</button>
    </div>
  `;
}

function bindPagination(container, key, callback) {
  container.querySelectorAll(`[data-${key}-page]`).forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      callback(parseInt(btn.dataset[`${key}Page`], 10));
    });
  });
}

// ---- 任务详情 ----
async function renderTaskDetail(id) {
  const content = $("#content");
  const task = await api(`/tasks/${id}`);

  if (!task) {
    content.innerHTML = `<div class="empty-state"><p>任务不存在或加载失败</p></div>`;
    return;
  }

  const st = getStatus(task.status);
  const pri = getPriorityStr(task.priority);
  const title = getTaskTitle(task);
  const body = getTaskBody(task);
  const fullDesc = task.task_description || task.description || "";

  content.innerHTML = `
    <div class="detail-header">
      <a href="#/tasks" class="btn btn-sm btn-secondary">&larr; 返回</a>
      <h2>${escapeHtml(title)}</h2>
      <span class="badge badge-${st.badge}">${st.label}</span>
      <button class="btn btn-sm btn-danger" data-action="deleteTask" data-id="${escapeHtml(String(task.id ?? ""))}">删除任务</button>
    </div>

    <div class="detail-meta">
      <div class="meta-item">
        <div class="meta-label">任务 ID</div>
        <div class="meta-value">${escapeHtml(String(task.id ?? ""))}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">优先级</div>
        <div class="meta-value"><span class="badge badge-${pri}">${priorityLabels[pri] || pri}</span></div>
      </div>
      <div class="meta-item">
        <div class="meta-label">Git 分支</div>
        <div class="meta-value">${escapeHtml(String(task.git_branch || "-"))}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">费用</div>
        <div class="meta-value">$${Number(task.total_cost_usd ?? 0).toFixed(4)}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">创建时间</div>
        <div class="meta-value">${escapeHtml(String(task.created_at || "-"))}</div>
      </div>
      <div class="meta-item">
        <div class="meta-label">阶段</div>
        <div class="meta-value">${escapeHtml(String(task.phase || "-"))}</div>
      </div>
    </div>

    <h3 class="section-title">任务描述</h3>
    <div class="card" style="margin-bottom:20px;">
      <div style="white-space:pre-wrap;font-size:13px;line-height:1.7;color:var(--text-secondary);">${escapeHtml(body || fullDesc || "无描述")}</div>
    </div>

    ${renderEvaluationInfo(task)}
    ${renderSubtasks(task.subtasks)}
    ${renderTaskLogs(task.logs)}
  `;
}

function renderEvaluationInfo(task) {
  if (!task.evaluation_score) return "";
  const s = task.evaluation_score;
  const dims = [
    ["问题真实性", s.problemLegitimacy],
    ["方案比例", s.solutionProportionality],
    ["预期复杂度", s.expectedComplexity],
    ["历史成功率", s.historicalSuccess],
  ];
  const actions =
    task.status === "pending_review"
      ? `
    <div style="margin-top:12px;display:flex;gap:8px;">
      <button class="btn btn-primary" data-action="approveTask" data-id="${escapeHtml(String(task.id ?? ""))}">通过 (回到队列)</button>
      <button class="btn btn-secondary" data-action="skipTask" data-id="${escapeHtml(String(task.id ?? ""))}">跳过</button>
    </div>
  `
      : "";
  return `
    <h3 class="section-title">改前评估</h3>
    <div class="card" style="margin-bottom:20px;">
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:12px;">
        ${dims
          .map(
            ([label, val]) => `
          <div style="display:flex;justify-content:space-between;padding:4px 8px;background:var(--bg-secondary);border-radius:4px;">
            <span style="color:var(--text-muted);font-size:13px;">${label}</span>
            <span style="font-weight:600;color:${val > 0 ? "var(--accent)" : val < 0 ? "var(--danger,#e53e3e)" : "var(--text-muted)"};">${val > 0 ? "+" : ""}${val}</span>
          </div>
        `,
          )
          .join("")}
      </div>
      <div style="display:flex;justify-content:space-between;padding:8px;background:var(--bg-secondary);border-radius:4px;font-weight:700;">
        <span>总分</span>
        <span style="color:${s.total > 0 ? "var(--accent)" : "var(--danger,#e53e3e)"};">${s.total > 0 ? "+" : ""}${s.total}</span>
      </div>
      ${task.evaluation_reasoning ? `<p style="margin-top:12px;font-size:13px;color:var(--text-secondary);">${escapeHtml(task.evaluation_reasoning)}</p>` : ""}
      ${actions}
    </div>
  `;
}

function renderSubtasks(subtasks) {
  if (!subtasks || !Array.isArray(subtasks) || subtasks.length === 0) return "";
  return `
    <h3 class="section-title">子任务 (${subtasks.length})</h3>
    <div class="list-container">
      ${subtasks
        .map((s) => {
          const st = getStatus(s.status);
          return `<div class="list-item">
          <span class="status-icon">${st.icon}</span>
          <span class="list-item-title">${escapeHtml(s.title || s.description || "")}</span>
          <span class="badge badge-${st.badge}">${st.label}</span>
        </div>`;
        })
        .join("")}
    </div>
  `;
}

function renderTaskLogs(logs) {
  if (!logs || !Array.isArray(logs) || logs.length === 0) return "";
  return `
    <h3 class="section-title">任务日志 (${logs.length})</h3>
    <div class="list-container">
      ${logs
        .map((l) => {
          const duration = l.duration_ms
            ? `${(l.duration_ms / 1000).toFixed(1)}s`
            : "-";
          const cost = l.cost_usd ? `$${Number(l.cost_usd).toFixed(4)}` : "-";
          return `
          <div class="list-item" style="flex-wrap:wrap;gap:8px;cursor:default;">
            <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1;">
              <span class="badge badge-blue">${escapeHtml(l.phase || "-")}</span>
              <span class="badge badge-secondary">${escapeHtml(l.agent || "-")}</span>
              <span style="color:var(--text-muted);font-size:12px;">${duration} | ${cost}</span>
              <span style="color:var(--text-muted);font-size:12px;margin-left:auto;">${timeAgo(l.created_at)}</span>
            </div>
            ${l.input_summary ? `<div style="width:100%;font-size:12px;color:var(--text-secondary);padding:4px 0 0 8px;border-top:1px solid var(--border);"><strong>Input:</strong> ${escapeHtml(l.input_summary)}</div>` : ""}
            ${l.output_summary ? `<div style="width:100%;font-size:12px;color:var(--text);padding:4px 0 0 8px;"><strong>Output:</strong> ${escapeHtml(l.output_summary)}</div>` : ""}
          </div>`;
        })
        .join("")}
    </div>
  `;
}

// ---- 历史记录 ----
const HISTORY_PAGE_SIZE = 20;

async function renderHistory() {
  const content = $("#content");
  const page = state.historyPage || 1;
  const data = await api(
    `/tasks?status=done,failed&page=${page}&pageSize=${HISTORY_PAGE_SIZE}`,
  );

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
      ${tasks.map((t) => renderTaskRow(t)).join("")}
    </div>
    ${totalPages > 1 ? renderPagination(page, totalPages, "history") : ""}
  `;

  bindPagination(content, "history", (p) => {
    state.historyPage = p;
    renderHistory();
  });
}

// ---- 运行日志 ----
function renderLogs() {
  const content = $("#content");
  const levels = ["debug", "info", "warn", "error"];

  content.innerHTML = `
    <div class="log-container">
      <div class="log-toolbar">
        <span style="font-size:12px;color:var(--text-muted);margin-right:4px;">级别筛选:</span>
        ${levels.map((l) => `<button class="filter-btn ${l === state.logLevel ? "active" : ""}" data-level="${l}">${l.toUpperCase()}</button>`).join("")}
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
  $$(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.logLevel = btn.dataset.level;
      $$(".filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  // 清屏
  $("#logClear").addEventListener("click", () => {
    $("#logOutput").innerHTML = "";
  });

  // SSE 连接
  connectLogStream();
}

async function connectLogStream() {
  if (state.logAbort) state.logAbort.abort();

  const output = $("#logOutput");
  if (!output) return;

  const controller = new AbortController();
  state.logAbort = controller;

  try {
    const res = await fetch("/api/logs?follow=true", {
      headers: { ...authHeaders(), Accept: "text/event-stream" },
      signal: controller.signal,
    });

    if (res.status === 401) {
      clearToken();
      showAuthScreen("令牌无效或已过期，请重新输入");
      return;
    }

    if (!res.ok || !res.body) {
      appendLog({
        level: "error",
        message: `[日志流连接失败: HTTP ${res.status}]`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    appendLog({
      level: "info",
      message: "[日志流已连接]",
      timestamp: new Date().toISOString(),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const payload = line.slice(6);
          try {
            appendLog(JSON.parse(payload));
          } catch {
            appendLog({
              level: "info",
              message: payload,
              timestamp: new Date().toISOString(),
            });
          }
        }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") return; // intentional cleanup
    appendLog({
      level: "warn",
      message: "[连接断开，5秒后重连...]",
      timestamp: new Date().toISOString(),
    });
    setTimeout(() => {
      if (state.currentPage === "logs") connectLogStream();
    }, 5000);
  }
}

function appendLog(entry) {
  const output = $("#logOutput");
  if (!output) return;

  const lvl = (entry.level || "info").toLowerCase();
  const levelPriority = { debug: 0, info: 1, warn: 2, error: 3 };
  if ((levelPriority[lvl] ?? 1) < (levelPriority[state.logLevel] ?? 1)) return;

  const ts = entry.timestamp
    ? new Date(entry.timestamp).toLocaleTimeString("zh-CN")
    : "";
  const line = document.createElement("div");
  line.className = `log-line ${lvl}`;
  line.innerHTML = `<span class="timestamp">${ts}</span> <span class="level">[${lvl.toUpperCase().padEnd(5)}]</span> ${escapeHtml(entry.message || entry.msg || "")}`;
  output.appendChild(line);

  // 限制行数
  while (output.children.length > 2000) {
    output.removeChild(output.firstChild);
  }

  // 自动滚动
  const autoScroll = $("#logAutoScroll");
  if (autoScroll && autoScroll.checked) {
    output.scrollTop = output.scrollHeight;
  }
}

// ---- 系统设置 ----
async function renderSettings() {
  const content = $("#content");
  const status = await api("/status");
  const cost = await api("/cost");

  if (!status) {
    content.innerHTML =
      '<div class="empty-state"><p>无法获取系统配置</p></div>';
    return;
  }

  const config = status.config || status;
  const costsArr = Array.isArray(cost?.costs)
    ? cost.costs
    : Array.isArray(config.dailyCosts)
      ? config.dailyCosts
      : [];
  const settingsTodayCost =
    costsArr.length > 0 ? Number(costsArr[0].total_cost_usd || 0) : 0;

  content.innerHTML = `
    <div class="config-block">
      <h3>运行状态</h3>
      ${configRow("当前项目", config.projectPath ? config.projectPath.split("/").pop() : "未知", config.projectPath)}
      ${configRow("系统状态", getStatus(config.state).label)}
      ${configRow("是否暂停", config.paused ? "是" : "否")}
      ${configRow("当前任务", config.currentTaskId || "无")}
      ${configRow("巡逻", config.patrolling ? "运行中" : "已停止")}
    </div>

    <div class="config-block">
      <h3>费用统计</h3>
      ${configRow("今日费用", `$${settingsTodayCost.toFixed(4)}`)}
      ${configRow("会话费用", `$${Number(cost?.sessionCost ?? 0).toFixed(4)}`)}
      ${costsArr.map((c) => configRow(c.date, `$${Number(c.total_cost_usd || 0).toFixed(4)} (${c.task_count} 任务)`)).join("")}
    </div>

    <div class="config-block">
      <h3>系统配置 (只读)</h3>
      ${renderConfigEntries(config)}
    </div>
  `;
}

function configRow(key, val, title) {
  const titleAttr = title ? ` title="${escapeHtml(String(title))}"` : "";
  return `<div class="config-row"><span class="config-key">${escapeHtml(String(key))}</span><span class="config-val"${titleAttr}>${escapeHtml(String(val))}</span></div>`;
}

function renderConfigEntries(obj, prefix = "") {
  const skip = new Set([
    "state",
    "paused",
    "currentTaskId",
    "dailyCosts",
    "config",
    "projectPath",
  ]);
  return Object.entries(obj)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        return renderConfigEntries(v, key);
      }
      return configRow(key, Array.isArray(v) ? JSON.stringify(v) : v);
    })
    .join("");
}

// ---- 控制操作 ----
async function togglePause() {
  const endpoint = state.paused ? "/control/resume" : "/control/pause";
  const res = await api(endpoint, { method: "POST" });
  if (res !== null) {
    state.paused = !state.paused;
    toast(state.paused ? "系统已暂停" : "系统已恢复");
  }
}

async function deleteTask(id) {
  if (!confirm(`确定删除任务 #${id}？此操作不可撤销。`)) return;
  const res = await api(`/tasks/${id}`, { method: "DELETE" });
  if (res !== null) {
    toast("任务已删除");
    location.hash = "#/tasks";
  }
}

async function approveTask(id) {
  const res = await api(`/tasks/${id}/approve`, { method: "POST" });
  if (res !== null) {
    toast("任务已通过，已回到执行队列");
    navigate();
  }
}

async function skipTask(id) {
  const res = await api(`/tasks/${id}/skip`, { method: "POST" });
  if (res !== null) {
    toast("任务已跳过");
    navigate();
  }
}

// Legacy window globals removed — all interactive elements now use data-action
// delegation (setupActionDelegation) or direct addEventListener in init().

function updatePatrolBtn(patrolling) {
  const btn = $("#btnPatrol");
  if (!btn) return;
  state.patrolling = !!patrolling;
  if (patrolling) {
    btn.textContent = "■ 停止巡逻";
    btn.classList.remove("btn-primary");
    btn.classList.add("btn-warning");
  } else {
    btn.textContent = "▶ 开始巡逻";
    btn.classList.remove("btn-warning");
    btn.classList.add("btn-primary");
  }
}

async function togglePatrol() {
  if (state.patrolling) {
    await stopPatrol();
  } else {
    await startPatrol();
  }
}

function updateConnection(online) {
  const el = $("#connectionStatus");
  if (!el) return;
  const dot = el.querySelector(".status-dot");
  const text = el.querySelector("span:last-child");
  if (online) {
    dot.className = "status-dot online";
    text.textContent = "已连接";
  } else {
    dot.className = "status-dot offline";
    text.textContent = "未连接";
  }
}

// ---- 模态框 ----
function openModal() {
  $("#modalOverlay").classList.add("show");
  $("#taskTitle").value = "";
  $("#taskDesc").value = "";
  $("#taskPriority").value = "medium";
  setTimeout(() => $("#taskTitle").focus(), 100);
}

function closeModal() {
  $("#modalOverlay").classList.remove("show");
}

async function submitTask() {
  const title = $("#taskTitle").value.trim();
  const desc = $("#taskDesc").value.trim();
  const priorityStr = $("#taskPriority").value;

  if (!title) {
    toast("请输入任务标题", "error");
    return;
  }

  // Combine title + description into a single description field
  // First line = title, rest = body (backend only has task_description)
  const description = desc ? `${title}\n\n${desc}` : title;
  const priority = priorityStrToNum[priorityStr] ?? 2;

  const res = await api("/tasks", {
    method: "POST",
    body: JSON.stringify({ description, priority }),
  });

  if (res !== null) {
    closeModal();
    toast("任务创建成功");
    location.hash = "#/tasks";
  }
}

// ---- 计划对话页面 ----
const planStatusLabels = {
  draft: { label: "草案", badge: "pending" },
  approved: { label: "已批准", badge: "done" },
  rejected: { label: "已拒绝", badge: "failed" },
  expired: { label: "已过期", badge: "paused" },
};

const chatStatusLabels = {
  chatting: { label: "对话中", badge: "running" },
  researching: { label: "研究中", badge: "running" },
  generating: { label: "生成计划中", badge: "running" },
  ready: { label: "计划就绪", badge: "done" },
  error: { label: "出错", badge: "failed" },
  closed: { label: "已结束", badge: "done" },
};

async function renderPlans() {
  const content = $("#content");
  const drafts = await api("/plans");

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h2 style="margin:0;">计划列表</h2>
      <button class="btn btn-primary" data-action="newPlanChat">+ 新建对话</button>
    </div>
    <div class="list-container" id="planList">
      ${
        !drafts || drafts.length === 0
          ? '<div class="empty-state"><p>暂无计划会话，点击上方按钮开始</p></div>'
          : drafts
              .map((d) => {
                const chatSt = chatStatusLabels[d.chat_status];
                const planSt =
                  planStatusLabels[d.status] || planStatusLabels.draft;
                const st = chatSt || planSt;
                const taskCount = d.plan?.tasks?.length ?? 0;
                const title = d.chat_status
                  ? (d.markdown || "").split("\\n")[0].slice(0, 80) ||
                    "对话 #" + d.id
                  : (d.markdown || d.reasoning || "")
                      .split("\\n")[0]
                      .slice(0, 80) || "计划 #" + d.id;
                return `
            <div class="list-item" data-action="navigate" data-id="#/plans/${escapeHtml(String(d.id ?? ""))}">
              <span class="badge badge-${st.badge}">${st.label}</span>
              <span class="list-item-title" style="flex:1;">${escapeHtml(title)}</span>
              ${taskCount > 0 ? `<span style="color:var(--text-muted);font-size:12px;">${taskCount} 任务</span>` : ""}
              <span style="color:var(--text-muted);font-size:12px;min-width:50px;text-align:right;">$${Number(d.cost_usd || 0).toFixed(2)}</span>
              <span style="color:var(--text-muted);font-size:12px;min-width:70px;text-align:right;">${timeAgo(d.created_at)}</span>
            </div>`;
              })
              .join("")
      }
    </div>
  `;
}

async function renderPlanDetail(id) {
  const content = $("#content");
  const draft = await api(`/plans/${id}`);
  if (!draft) {
    content.innerHTML = '<div class="empty-state"><p>计划不存在</p></div>';
    return;
  }

  // Chat-based sessions show chat UI; legacy drafts show plan detail
  const isChatSession = !!draft.chat_status;
  const isInChat =
    isChatSession &&
    ["chatting", "researching", "generating", "closed"].includes(
      draft.chat_status,
    );

  if (isInChat) {
    renderChatView(id, draft);
  } else if (
    isChatSession &&
    draft.chat_status === "ready" &&
    draft.plan?.tasks?.length > 0
  ) {
    renderPlanReviewView(id, draft);
  } else if (
    !isChatSession ||
    draft.status !== "draft" ||
    draft.plan?.tasks?.length > 0
  ) {
    renderPlanReviewView(id, draft);
  } else {
    renderChatView(id, draft);
  }
}

async function renderChatView(id, draft) {
  const content = $("#content");
  const chatSt =
    chatStatusLabels[draft.chat_status] || chatStatusLabels.chatting;

  const isClosed = draft.chat_status === "closed";
  content.innerHTML = `
    <div class="chat-container">
      <div class="chat-status-bar">
        <a href="#/plans" style="font-size:12px;color:var(--text-muted);text-decoration:none;">&larr; 返回列表</a>
        <span style="flex:1;"></span>
        <span class="badge badge-${chatSt.badge}" id="chatStatusBadge">${chatSt.label}</span>
        ${
          isClosed
            ? ""
            : `<button class="btn btn-sm btn-success" id="btnGeneratePlan" style="display:none;" data-action="generatePlanFromChat" data-id="${id}">生成计划</button>
        <button class="btn btn-sm btn-secondary" data-action="closeChatSession" data-id="${id}">关闭会话</button>`
        }
      </div>
      <div class="chat-messages" id="chatMessages"></div>
      ${
        isClosed
          ? `<div style="padding:12px;text-align:center;color:var(--text-muted);font-size:13px;">会话已结束 <button class="btn btn-sm btn-primary" data-action="resumeChatSession" data-id="${id}" style="margin-left:8px;">恢复对话</button></div>`
          : `<div class="chat-input-area">
        <textarea class="chat-input" id="chatInput" placeholder="描述你的需求，或继续对话..." rows="2"></textarea>
        <button class="btn btn-primary chat-send-btn" id="chatSendBtn" data-action="sendChatMessage" data-id="${id}">发送</button>
      </div>`
      }
    </div>
  `;

  // Load existing messages
  const messages = await api(`/plans/${id}/messages`);
  if (messages && messages.length > 0) {
    messages.forEach((m) => appendChatBubble(m.role, m.content));
  }

  // Show generate button if ready
  if (draft.chat_status === "ready") {
    const btn = $("#btnGeneratePlan");
    if (btn) btn.style.display = "";
  }

  // Setup SSE
  setupChatSSE(id);

  // Setup Enter key handling
  const input = $("#chatInput");
  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage(id);
      }
    });
    input.focus();
  }
}

function renderPlanReviewView(id, draft) {
  const content = $("#content");
  const st = planStatusLabels[draft.status] || planStatusLabels.draft;
  const tasks = draft.plan?.tasks || [];

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <div>
        <a href="#/plans" style="font-size:12px;color:var(--text-muted);">&larr; 返回列表</a>
        <h2 style="margin:4px 0 0;">计划 #${escapeHtml(String(draft.id ?? ""))} <span class="badge badge-${st.badge}">${st.label}</span></h2>
      </div>
      <div style="display:flex;gap:8px;">
        ${
          draft.status === "draft"
            ? `
          <button class="btn btn-success" data-action="approvePlan" data-id="${draft.id}">批准</button>
          <button class="btn btn-warning" data-action="rejectPlan" data-id="${draft.id}">拒绝</button>
        `
            : ""
        }
        ${
          draft.status === "approved"
            ? `
          <button class="btn btn-primary" data-action="executePlan" data-id="${draft.id}">执行计划</button>
        `
            : ""
        }
      </div>
    </div>
    <div class="card" style="margin-bottom:16px;padding:16px;">
      <div class="card-label">分析摘要</div>
      <div style="white-space:pre-wrap;font-size:13px;max-height:200px;overflow-y:auto;">${escapeHtml(draft.analysis_summary || "无").slice(0, 2000)}</div>
    </div>
    <div class="card" style="margin-bottom:16px;padding:16px;">
      <div class="card-label">计划内容</div>
      <div style="white-space:pre-wrap;font-size:13px;" id="planMarkdown">${escapeHtml(draft.markdown || draft.reasoning || "无")}</div>
    </div>
    <div class="card" style="padding:16px;">
      <div class="card-label">任务列表 (${tasks.length})</div>
      <div class="list-container">
        ${tasks
          .map(
            (t, i) => `
          <div class="list-item" style="cursor:default;">
            <span style="color:var(--text-muted);font-size:12px;min-width:30px;">#${i + 1}</span>
            <span class="list-item-title" style="flex:1;">${escapeHtml(t.description || "")}</span>
            <span class="badge badge-${t.priority <= 1 ? "high" : t.priority === 2 ? "medium" : "low"}">${t.executor || "auto"}</span>
            <span style="color:var(--text-muted);font-size:12px;">${t.estimatedComplexity || ""}</span>
          </div>
        `,
          )
          .join("")}
      </div>
    </div>
    <div style="margin-top:12px;color:var(--text-muted);font-size:12px;">
      费用: $${Number(draft.cost_usd || 0).toFixed(4)} | 创建: ${timeAgo(draft.created_at)}
      ${draft.reviewed_at ? " | 审核: " + timeAgo(draft.reviewed_at) : ""}
    </div>
  `;
}

// ---- Chat helpers ----

function appendChatBubble(role, content) {
  const container = $("#chatMessages");
  if (!container) return;
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${role}`;
  const rendered =
    role === "user" ? escapeHtml(content) : renderMarkdown(content);
  bubble.innerHTML = `
    <div class="chat-bubble-role">${role === "user" ? "你" : role === "assistant" ? "Claude" : "系统"}</div>
    <div class="chat-bubble-content">${rendered}</div>
  `;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

function getOrCreateStreamingBubble() {
  let bubble = $("#chatMessages .chat-bubble.assistant.streaming");
  if (!bubble) {
    const container = $("#chatMessages");
    if (!container) return null;
    bubble = document.createElement("div");
    bubble.className = "chat-bubble assistant streaming";
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
  const bubble = $("#chatMessages .chat-bubble.assistant.streaming");
  if (bubble) {
    bubble.classList.remove("streaming");
    const contentEl = bubble.querySelector(".chat-bubble-content");
    if (contentEl && text) contentEl.innerHTML = renderMarkdown(text);
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
      headers: { ...authHeaders(), Accept: "text/event-stream" },
      signal: controller.signal,
    });

    if (!res.ok || !res.body) return;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let currentEvent = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const payload = line.slice(6);
          handleChatSSEEvent(currentEvent || "message", payload, draftId);
          currentEvent = "";
        } else if (line.trim() === "") {
          currentEvent = "";
        }
      }
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    // Reconnect after delay
    setTimeout(() => {
      if (state.currentPage === "planDetail") setupChatSSE(draftId);
    }, 5000);
  }
}

function handleChatSSEEvent(event, payload, draftId) {
  let data;
  try {
    data = JSON.parse(payload);
  } catch {
    return;
  }

  if (event === "message") {
    if (data.role === "assistant") {
      finalizeStreamingBubble(data.content);
    }
  } else if (event === "assistant_text") {
    const bubble = getOrCreateStreamingBubble();
    if (bubble) {
      const contentEl = bubble.querySelector(".chat-bubble-content");
      if (contentEl) contentEl.innerHTML = renderMarkdown(data.text);
      const container = $("#chatMessages");
      if (container) container.scrollTop = container.scrollHeight;
    }
  } else if (event === "status") {
    const badge = $("#chatStatusBadge");
    const st = chatStatusLabels[data.status];
    if (badge && st) {
      badge.textContent = st.label;
      badge.className = `badge badge-${st.badge}`;
    }
    const sendBtn = $("#chatSendBtn");
    const input = $("#chatInput");
    if (data.status === "researching" || data.status === "generating") {
      if (sendBtn) sendBtn.disabled = true;
      if (input) input.disabled = true;
    } else {
      if (sendBtn) sendBtn.disabled = false;
      if (input) input.disabled = false;
    }
    const genBtn = $("#btnGeneratePlan");
    if (genBtn) genBtn.style.display = data.status === "ready" ? "" : "none";
    if (data.status === "ready") {
      finalizeStreamingBubble("");
    }
  } else if (event === "plan_ready") {
    toast("计划已生成");
    cleanup();
    renderPlanDetail(draftId);
  }
}

async function sendChatMessage(draftId) {
  const input = $("#chatInput");
  if (!input) return;
  const msg = input.value.trim();
  if (!msg) return;

  input.value = "";
  appendChatBubble("user", msg);

  await api(`/plans/${draftId}/message`, {
    method: "POST",
    body: JSON.stringify({ message: msg }),
  });
}

async function generatePlanFromChat(draftId) {
  const btn = $("#btnGeneratePlan");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "生成中...";
  }
  await api(`/plans/${draftId}/generate`, { method: "POST", body: "{}" });
}

async function newPlanChat() {
  const result = await api("/plans/chat", { method: "POST", body: "{}" });
  if (result?.id) {
    toast("对话已创建");
    location.hash = `#/plans/${result.id}`;
  }
}

async function closeChatSession(draftId) {
  await api(`/plans/${draftId}/close`, { method: "POST", body: "{}" });
  toast("会话已关闭");
  location.hash = "#/plans";
}

async function resumeChatSession(draftId) {
  const result = await api(`/plans/${draftId}/resume`, {
    method: "POST",
    body: "{}",
  });
  if (result?.ok) {
    toast("会话已恢复");
    renderPlanDetail(draftId);
  }
}

async function approvePlan(id) {
  const result = await api(`/plans/${id}/approve`, {
    method: "POST",
    body: "{}",
  });
  if (result?.ok) {
    toast("计划已批准");
    renderPlanDetail(id);
  }
}

async function rejectPlan(id) {
  const result = await api(`/plans/${id}/reject`, {
    method: "POST",
    body: "{}",
  });
  if (result?.ok) {
    toast("计划已拒绝");
    renderPlanDetail(id);
  }
}

async function executePlan(id) {
  const result = await api(`/plans/${id}/execute`, {
    method: "POST",
    body: "{}",
  });
  if (result?.ok) {
    toast("计划任务已加入队列");
    location.hash = "#/tasks";
  }
}

// ---- 移动端菜单 ----
function toggleSidebar() {
  $("#sidebar").classList.toggle("open");
}

// ---- 认证流程 ----
async function attemptAuth(token) {
  setToken(token);

  // Validate token against server
  try {
    const res = await fetch("/api/status", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 401) {
      clearToken();
      showAuthScreen("令牌无效，请检查后重试");
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
  const input = $("#authTokenInput");
  const submit = $("#authSubmit");

  submit.addEventListener("click", () => {
    const token = input.value.trim();
    if (!token) {
      showAuthScreen("请输入令牌");
      return;
    }
    attemptAuth(token);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const token = input.value.trim();
      if (token) attemptAuth(token);
    }
  });
}

// ---- 事件委托 (CSP-friendly: 替代 inline onclick) ----
// Scoped to #content — all dynamically rendered data-action buttons live inside it.
// Static elements (sidebar, topbar, modals) use direct addEventListener in init().
function setupActionDelegation() {
  const contentEl = document.getElementById("content");
  if (!contentEl) return;

  contentEl.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;

    const action = el.dataset.action;
    const id = el.dataset.id;
    const arg = el.dataset.arg;

    switch (action) {
      case "startPatrol":
        startPatrol();
        break;
      case "stopPatrol":
        stopPatrol();
        break;
      case "deleteTask":
        deleteTask(id);
        break;
      case "approveTask":
        approveTask(id);
        break;
      case "skipTask":
        skipTask(id);
        break;
      case "generatePlanFromChat":
        generatePlanFromChat(id);
        break;
      case "closeChatSession":
        closeChatSession(id);
        break;
      case "resumeChatSession":
        resumeChatSession(id);
        break;
      case "sendChatMessage":
        sendChatMessage(id);
        break;
      case "approvePlan":
        approvePlan(id);
        break;
      case "rejectPlan":
        rejectPlan(id);
        break;
      case "executePlan":
        executePlan(id);
        break;
      case "newPlanChat":
        newPlanChat();
        break;
      case "navigate":
        location.hash = id;
        break;
    }
  });
}

// ---- 初始化 ----
function init() {
  // 事件委托 (替代 inline onclick，CSP 安全)
  setupActionDelegation();

  // 认证界面事件
  setupAuthListeners();

  // 路由监听
  window.addEventListener("hashchange", navigate);

  // 按钮事件
  $("#menuToggle").addEventListener("click", toggleSidebar);
  // Topbar buttons (no inline onclick — CSP-friendly)
  $("#btnPatrol").addEventListener("click", togglePatrol);
  updatePatrolBtn(false);

  // 模态框事件
  $("#modalClose").addEventListener("click", closeModal);
  $("#modalCancel").addEventListener("click", closeModal);
  $("#modalSubmit").addEventListener("click", submitTask);
  $("#modalOverlay").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  // ESC 关闭模态框
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  // 点击侧边栏项时关闭移动端菜单
  $$(".nav-item").forEach((item) => {
    item.addEventListener("click", () => {
      $("#sidebar").classList.remove("open");
    });
  });

  // 检查已保存的令牌
  const savedToken = getToken();
  if (savedToken) {
    // Validate saved token silently
    hideAuthScreen();
    api("/status").then((res) => {
      updateConnection(!!res);
      // If api() got 401, it already showed auth screen
    });
    navigate();
  } else {
    // No token — show auth screen
    showAuthScreen();
  }
}

document.addEventListener("DOMContentLoaded", init);
