import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { openOffice, closeOffice, refreshOffice } from './office.js';

// ---------- 禁用右键菜单 ----------
// macOS WKWebView 会弹出默认菜单（Reload / Play All Animations / Inspect Element）。
// 捕获阶段 + 冒泡阶段都挂 handler，并返回 false，尽量确保任何位置都不弹。
for (const target of [window, document]) {
  target.addEventListener(
    'contextmenu',
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      return false;
    },
    { capture: true }
  );
}
document.oncontextmenu = () => false;

// ---------- DOM ----------
const connectorsEl = document.getElementById('connectors');
const streamEl = document.getElementById('stream');
const artifactsEl = document.getElementById('artifacts');
const detailEl = document.getElementById('artifact-detail');
const selectEl = document.getElementById('connector-select');
const filterConnEl = document.getElementById('filter-connector');
const filterKindEl = document.getElementById('filter-kind');
const filterTimeEl = document.getElementById('filter-time');
const searchEl = document.getElementById('artifact-search');
const statsEl = document.getElementById('artifact-stats');
const exportBtn = document.getElementById('export-summary');
const clearBtn = document.getElementById('clear-artifacts');
const exportFmt = document.getElementById('export-format');
const syncBtn = document.getElementById('sync-all');
const toastEl = document.getElementById('toast');
const scopeBarEl = document.getElementById('scope-bar');
const scopeLabelEl = document.getElementById('scope-label');
const scopeClearEl = document.getElementById('scope-clear');
const moreEl = document.getElementById('artifact-more');
const connCountEl = document.getElementById('conn-count');
const convsEl = document.getElementById('convs');
const convCountEl = document.getElementById('conv-count');
const backdropEl = document.getElementById('detail-backdrop');
const leftEl = document.getElementById('left');
const rightEl = document.getElementById('right');
const splitLeftEl = document.getElementById('split-left');
const splitRightEl = document.getElementById('split-right');

// 每次「加载更多」的步长
const PAGE = 120; // 产物
const CONV_FETCH = 5000; // 左栏会话简表（很小），一次取够才能按分组算准每组条数


// 代理节点弹窗（中心 hub + 远端代理 agent，取代旧 P2P）
const proxyModalEl = document.getElementById('proxy-modal');
const proxyHost = document.getElementById('hub-host');
const proxyPort = document.getElementById('hub-port');
const proxySecret = document.getElementById('hub-secret');
const hubStartBtn = document.getElementById('hub-start');
const hubRefreshBtn = document.getElementById('hub-refresh');
const openOfficeBtn = document.getElementById('open-office');
const proxyListEl = document.getElementById('proxy-list');
const proxyStatusEl = document.getElementById('proxy-status');
const proxyOnlineEl = document.getElementById('proxy-online');
const proxyTotalEl = document.getElementById('proxy-total');
const proxyCloseBtn = document.getElementById('proxy-close');
const proxyBtn = document.getElementById('proxy-btn');
const officeBtn = document.getElementById('office-btn');

// 右栏 tab / 对比视图
const tabBtns = document.querySelectorAll('.tab');
const artifactsPaneEl = document.getElementById('artifacts-pane');
const comparePaneEl = document.getElementById('compare-pane');
const compareGroupsEl = document.getElementById('compare-groups');
const compareViewEl = document.getElementById('compare-view');
const compareCountEl = document.getElementById('compare-count');
const filterTimeCompareEl = document.getElementById('filter-time-compare');
// 对比：列表视图 / 详情视图（右栏窄，用「先列表、点进详情」而不是左右并排）
const cmpListViewEl = document.getElementById('cmp-list-view');
const cmpDetailViewEl = document.getElementById('cmp-detail-view');
const cmpTabsEl = document.getElementById('cmp-tabs');
const cmpSearchEl = document.getElementById('cmp-search');
const cmpSortEl = document.getElementById('cmp-sort');
const compareMoreEl = document.getElementById('compare-more');
// 对比状态：全量分组 / 类型页签 / 搜索词 / 排序 / 已渲染条数 / 当前详情
let cmpAll = [];
let cmpKind = 'all';
let cmpQ = '';
let cmpSort = 'count';
let cmpRendered = 0;
const CMP_PAGE = 30;
let currentCompare = null;
let armedDeleteId = null;

// ---------- 状态 ----------
const state = {
  connectors: [],
  tasks: new Map(), // id -> { id, connector, title, events:[], status, workdir }
  activeTaskId: null,
  runningIds: new Set(),
  activeAnswerEl: null, // 当前回答气泡（token 累积用）
  artifacts: [],
  convs: [], // 左栏历史会话（轻量 brief，不含正文）
  convTotal: 0,
  peers: [], // 远端代理节点（list_proxies）：ProxyInfo[]，含在线态与最近一次 activity 快照
  // 数据来源（统一数据门面返回的 meta）：本机 + 各在线代理的合并视图
  dataSources: [], // 有数据贡献的节点名
  dataOffline: [], // 已登记但离线的节点名
  dataErrors: [], // 取数失败的节点
  artSources: [], // 产物列表的来源节点
  artOffline: [],
  artErrors: [],
  hubRunning: false, // 本机中心 hub 是否正在监听（与后端 hub_running() 同步）
  stats: null,
  tokenStats: [], // 按连接器聚合的 token 用量（list_all_token_stats）
  tokenMeta: null, // token 统计的来源信息（sources / offline / errors）
  shown: PAGE, // 产物：当前渲染到第几条（滚动到底自动增大）
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}
function connName(id) {
  return state.connectors.find((c) => c.id === id)?.name || id;
}
function connObj(id) {
  return state.connectors.find((c) => c.id === id);
}
// 每个工具一个稳定的颜色（用于圆点，辨识度比纯文字高）
function connHue(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
function connColor(id) {
  return `hsl(${connHue(id)} 68% 52%)`;
}
function kindLabel(k) {
  return { file: '文件', conversation: '对话', log: '日志' }[k] || k;
}
function toast(msg, kind = '') {
  toastEl.textContent = msg;
  toastEl.className = 'toast show ' + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (toastEl.className = 'toast'), 2800);
}

// ---------- 初始化 ----------
async function init() {
  state.connectors = await invoke('list_connectors');
  renderConnectors();
  renderConnectorSelect();
  renderFilterConnectors();
  await refreshToolActivity();
  await refreshPeers();
  await refreshConversations();
  await refreshArtifacts();
  await refreshStats();
  renderStream();
  wire();
  applySecState();
  wireSectionHeads();
  initSplitters();
  initInfiniteScroll();
  await listen('agent-event', onEvent);
  // 启动即把各工具已有的全部历史任务 / 会话 / 产物收进统一视图
  syncAll();
  if (state.connectors.length) selectEl.value = state.connectors[0].id;
  highlightConnector();
  // 每 5 秒重扫一次会话文件：接近实时。是否「在跑」由会话尾记录判断，
  // 一轮回答结束会立刻落回空闲，不再像只靠 mtime 那样拖到 5 分钟后。
  setInterval(() => {
    if (!document.hidden) refreshToolActivity();
  }, 5000);
  // 切回窗口时立刻补一次，避免在后台期间显示的是旧状态
  window.addEventListener('focus', () => refreshToolActivity());
}

// ---------- 已连工具 ----------
// 每个工具的执行情况来自后端「活体扫描」：直接 stat 各工具会话目录里的会话文件，
// 近 5 分钟仍在写入 = 正在执行。不再用 tasks.json（那只有 agentry 自己派发过任务才有记录，
// 而派发能力已随「执行」一起移除），否则永远显示 0，与实际正在跑的任务对不上。
const ACTIVE_WINDOW = 300; // 秒：会话文件在此窗口内被写过 = 进行中
let liveTools = new Map(); // connector id -> { sessions, running, today, last }

function liveStatus(cid) {
  return liveTools.get(cid) || { sessions: 0, running: 0, today: 0, last: 0, open: null };
}

// 三种状态要分开（用户明确要求）：
//   执行中       —— 有一轮提问/回答还没结束（后端读会话尾部判断，不是只看文件有没有被写）
//   已开启·空闲   —— 工具应用开着（lsappinfo 拿到的运行中 App），但当前没有在跑
//   未开启       —— 没检测到该工具；再细分为「未知」（拿不到 App 清单时不下结论）
function toolState(ts) {
  if (ts.running > 0) return { key: 'busy', text: `执行中 ${ts.running}`, cls: 'badge running live' };
  if (ts.open === true) return { key: 'open', text: '已开启 · 空闲', cls: 'badge open' };
  if (ts.open === false) return { key: 'off', text: '未开启', cls: 'badge soft' };
  return { key: 'unknown', text: '', cls: '' };
}

// 上一次拉取还没回来时跳过本次，避免定时器堆叠请求（后端偶尔变慢时界面会越来越卡）。
let toolActivityFetching = false;

async function refreshToolActivity() {
  if (toolActivityFetching) return;
  toolActivityFetching = true;
  try {
    const d = new Date();
    const midnight = Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000);
    try {
      const arr = await invoke('tool_activity', { todayStart: midnight, activeWindow: ACTIVE_WINDOW });
      liveTools = new Map((arr || []).map((t) => [t.connector, t]));
    } catch {
      /* 后端还没热起来时忽略，保持上一次结果 */
    }
    updateConnectorStatuses();
    renderExecutionIfIdle();
  } finally {
    toolActivityFetching = false;
  }
}

// 中栏只有在「没有打开具体任务」时才显示执行情况；有任务时保持任务流不动
function renderExecutionIfIdle() {
  if (!state.activeTaskId) renderExecution();
}

// 仅刷新已渲染连接器卡片上的执行情况，避免整卡重建
function updateConnectorStatuses() {
  connectorsEl.querySelectorAll('.connector').forEach((el) => {
    const cid = el.dataset.id;
    if (!cid) return;
    const ts = liveStatus(cid);
    const live = el.querySelector('.c-live');
    if (live) {
      const st = toolState(ts);
      live.innerHTML = st.text ? `<span class="${st.cls}">${st.text}</span>` : '';
    }
    const cnt = el.querySelector('.c-count');
    if (cnt) cnt.textContent = `${ts.sessions} 会话`;
  });
}

// 只更新工具卡片上的 token chip（token 统计是异步到达的，单独刷新时用）。
// 不重建卡片 DOM —— 重建会丢掉「再点一次确认删除」的状态。
function updateConnectorTokens() {
  connectorsEl.querySelectorAll('.connector').forEach((el) => {
    const cid = el.dataset.id;
    if (!cid) return;
    const tk = tokenStatOf(cid);
    const chip = el.querySelector('.c-token');
    if (tk) {
      if (chip) {
        chip.textContent = `${fmtTokens(tk.input + tk.output)} tok`;
        chip.title =
          `输入 ${fmtTokens(tk.input)} · 输出 ${fmtTokens(tk.output)} · ` +
          `缓存命中 ${fmtTokens(tk.cache_read)}（${fmtRate(tokenRate(tk))}）· 省 ${fmtTokens(
            tokenSaved(tk),
          )}`;
      } else {
        // 卡片渲染时还没数据 → 补一个 chip
        const meta = el.querySelector('.c-meta');
        if (meta) {
          const span = document.createElement('span');
          span.className = 'c-token';
          span.textContent = `${fmtTokens(tk.input + tk.output)} tok`;
          meta.insertBefore(span, meta.querySelector('.c-live'));
        }
      }
    } else if (chip) {
      chip.remove();
    }
  });
}
function renderConnectors() {
  connectorsEl.innerHTML = '';
  connCountEl.textContent = state.connectors.length;
  state.connectors.forEach((c) => {
    const el = document.createElement('div');
    el.className = 'connector';
    el.dataset.id = c.id;
    const ts = liveStatus(c.id);
    const st = toolState(ts);
    // 说明文字收进 title，卡片只保留「工具名 + 传输方式 + 会话数 + 状态」，
    // 今日 / 最近活动等执行细节统一放到中栏「执行情况」，避免与左栏重复。
    if (c.note) el.title = c.note;
    // 该工具的 token 消耗（只有记录了 usage 的工具有；没有就不显示）
    const tk = tokenStatOf(c.id);
    const tkChip = tk
      ? `<span class="c-token" title="输入 ${fmtTokens(tk.input)} · 输出 ${fmtTokens(
          tk.output,
        )} · 缓存命中 ${fmtTokens(tk.cache_read)}（${fmtRate(tokenRate(tk))}）· 省 ${fmtTokens(
          tokenSaved(tk),
        )}">${fmtTokens(tk.input + tk.output)} tok</span>`
      : '';
    el.innerHTML = `<div class="c-top">
        <span class="dot" style="background:${connColor(c.id)}"></span>
        <div class="c-name">${esc(c.name)}</div>
        <div class="c-actions">
          <button class="c-del" title="移除该工具">×</button>
        </div>
      </div>
      <div class="c-meta">
        <span class="c-chip">${esc(c.transport)}</span>
        <span class="c-count">${ts.sessions} 会话</span>
        ${tkChip}
        <span class="c-live">${st.text ? `<span class="${st.cls}">${st.text}</span>` : ''}</span>
      </div>`;
    el.addEventListener('click', () => {
      selectEl.value = c.id;
      highlightConnector();
      // 点卡片 = 只看这个工具的产物与任务；再点一次回到全部
      toggleScope(c.id);
    });
    const delBtn = el.querySelector('.c-del');
    if (delBtn) {
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (armedDeleteId !== c.id) {
          armedDeleteId = c.id;
          delBtn.classList.add('armed');
          delBtn.textContent = '确认?';
          toast('再点一次移除该工具（不影响本机文件）');
          setTimeout(() => {
            if (armedDeleteId === c.id) {
              armedDeleteId = null;
              delBtn.classList.remove('armed');
              delBtn.textContent = '×';
            }
          }, 3000);
          return;
        }
        armedDeleteId = null;
        try {
          state.connectors = await invoke('remove_connector', { id: c.id });
          if (filterConnEl.value === c.id) filterConnEl.value = '';
          renderConnectors();
          renderConnectorSelect();
          renderFilterConnectors();
          highlightConnector();
          updateScopeBar();
          renderExecutionIfIdle();
          refreshConversations();
          refreshArtifacts();
          refreshStats();
          toast('已移除 ' + c.name);
        } catch (err) {
          toast('移除失败：' + err, 'err');
        }
      });
    }
    connectorsEl.appendChild(el);
  });
}

// ---------- 工具范围（右侧 + 执行情况都跟着收窄）----------
function currentScope() {
  return filterConnEl.value || '';
}
function toggleScope(id) {
  const next = currentScope() === id ? '' : id;
  filterConnEl.value = next;
  state.shown = PAGE;
  updateScopeBar();
  renderExecutionIfIdle();
  refreshConversations();
  refreshArtifacts();
  refreshStats();
}
function updateScopeBar() {
  const scope = currentScope();
  scopeBarEl.classList.toggle('hidden', !scope);
  if (scope) {
    scopeLabelEl.innerHTML = `只看 <b>${esc(connName(scope))}</b> 的会话与产物`;
  }
}
function highlightConnector() {
  const id = selectEl.value;
  connectorsEl
    .querySelectorAll('.connector')
    .forEach((e) => e.classList.toggle('active', e.dataset.id === id));
}
function renderConnectorSelect() {
  const prev = selectEl.value;
  selectEl.innerHTML = '';
  state.connectors.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name;
    selectEl.appendChild(o);
  });
  if (prev && state.connectors.some((c) => c.id === prev)) selectEl.value = prev;
}
function renderFilterConnectors() {
  const prev = filterConnEl.value;
  filterConnEl.innerHTML = '<option value="">全部工具</option>';
  state.connectors.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name;
    filterConnEl.appendChild(o);
  });
  if (prev && state.connectors.some((c) => c.id === prev)) filterConnEl.value = prev;
}

// ---------- 执行情况（替代原来的「任务」列表）----------
// 派发已移除，agentry 不再自己产生任务记录，所以「任务 N（0）」这类区块没有意义，整块删掉。
// makeTaskRecord：agent-event 事件流仍按 task_id 路由，把对端同步回来的任务条目在本地渲染成会话/产物视图（本工具本身不派发任务）。
function makeTaskRecord(connector, title, taskId) {
  const t = { id: taskId, connector, title, events: [], status: 'running', workdir: '', created_at: Math.floor(Date.now() / 1000) };
  state.tasks.set(taskId, t);
  return t;
}

// 远端代理节点：拉列表（含在线态与最近 activity 快照），供中栏「远程」区与办公室展示。
// 只读，不触发任何同步；节点的接入/管理在「☖ 代理节点」弹窗里操作。
async function refreshPeers() {
  let peers = [];
  try {
    peers = await invoke('list_proxies');
  } catch {
    peers = [];
  }
  state.peers = Array.isArray(peers) ? peers : [];
  renderExecutionIfIdle();
}

// ---------- 历史会话（左栏，分类展示）----------
// 同步进来的会话是「历史」，不是本机下达的任务，所以单独一栏，避免「任务 0」造成误解。
// 会话动辄几百条（本机实测 466 条），平铺既难找也难看，所以支持两种分组维度：
//   工具（codex / workbuddy …）· 任务（按会话文件所属工作区）
// 「时间」不再单独成档：分组标题与组内每条都直接显示最近活动时间。
// 分组可折叠，组内默认只渲染 20 条（点「还有 N 条」继续），避免一次性塞满 DOM。
const CONV_MODE_KEY = 'agentdesk.convMode';
const CONV_OPEN_KEY = 'agentdesk.convOpen';
// 档位顺序 / 默认档位的版本号：变了就强制重置用户的旧偏好（见下方迁移逻辑）
const CONV_PREFS_VER_KEY = 'agentdesk.convPrefsVer';
const CONV_PREFS_VER = 2; // v2 = 任务在前、工具在后，默认任务
const CONV_GROUP_PAGE = 20; // 每个分组默认渲染条数
const CONV_TOP_PROJECTS = 12; // 任务维度只单列前 N 个，其余合并成「其他任务」
// 顺序：任务在前、工具在后（2026-10-24 按用户要求对调）
const CONV_MODES = [
  ['project', '任务'],
  ['tool', '工具'],
];

let convMode = 'project'; // 默认展示「任务」
let convOpen = new Set(); // 展开中的分组 key
let convOpenInited = false; // 是否已有用户偏好（没有就默认只展开第一组）
const convShown = new Map(); // 分组 key -> 组内已渲染条数

try {
  const m = localStorage.getItem(CONV_MODE_KEY);
  const validMode = CONV_MODES.some(([k]) => k === m);
  if (validMode) convMode = m;
  const o = JSON.parse(localStorage.getItem(CONV_OPEN_KEY) || 'null');
  if (Array.isArray(o)) {
    // 旧格式（纯数组）
    convOpen = new Set(o);
    convOpenInited = o.length > 0;
  } else if (o && typeof o === 'object') {
    convOpen = new Set(Array.isArray(o.open) ? o.open : []);
    convOpenInited = !!o.inited; // 记住「用户手动全部收起」也算偏好，重启后不要又自动展开
  }
  // 档位已失效（例如被移除的 'time'）：旧分组的展开记忆对不上新分组，重置为首组自动展开
  if (m && !validMode) {
    convOpen = new Set();
    convOpenInited = false;
  }
  // 档位顺序/默认值变更（v2：任务在前、默认任务）→ 强制回到新默认档，
  // 否则老用户 localStorage 里存的 'tool' 会让「工具」继续当默认，看不到本次调整
  const ver = parseInt(localStorage.getItem(CONV_PREFS_VER_KEY) || '0', 10) || 0;
  if (ver < CONV_PREFS_VER) {
    convMode = 'project';
    convOpen = new Set();
    convOpenInited = false;
    convShown.clear();
    localStorage.setItem(CONV_PREFS_VER_KEY, String(CONV_PREFS_VER));
  }
} catch {
  /* 隐私模式下 localStorage 可能不可读，用默认值 */
}

function saveConvPrefs() {
  try {
    localStorage.setItem(CONV_MODE_KEY, convMode);
    localStorage.setItem(CONV_OPEN_KEY, JSON.stringify({ inited: true, open: [...convOpen] }));
  } catch {
    /* 忽略 */
  }
}

// 「任务」维度 = 这段会话实际在做的项目。
//
// 关键：不能用会话文件所在目录当项目名。WorkBuddy 每段对话都会新建一个
// `~/.workbuddy/projects/Users-<user>-WorkBuddy-2026-08-13-22-27-30` 工作区目录，
// 拿它分组就会得到上百个「WorkBuddy · 08-13」—— 用户看到的全是年月日，不知道是什么。
// 真正有意义的是会话文件里的 cwd（后端 list_conversations 的 workspace 字段），
// 取它有意义的末段当项目名（例如 .../2026-10-16-14-06-45/agentry → agentry）。
//
// 取舍顺序：cwd > 工作区目录名去掉时间戳 > 标题里的绝对路径 > 按工具归组。
// 任何一级都不允许把时间戳当组名；实在没有项目信息就并进「工具」这一组。
const CONV_GENERIC_SEG = new Set([
  'users', 'home', 'documents', 'desktop', 'downloads', 'projects', 'project',
  'workbuddy', 'work', 'workspace', 'workspaces', 'code', 'repo', 'repos',
  'src', 'lib', 'bin', 'dist', 'build', 'target', 'test', 'tests', 'docs',
  'app', 'apps', 'tmp', 'temp', 'public', 'assets', 'node_modules', 'vendor',
  '__pycache__', 'outputs', 'output', 'delivery', 'deliverables', 'artifacts',
  'logs', 'log', 'cache', 'resources', 'scripts', 'tools', 'config', 'boot-inf',
]);
// 2026-08-13 / 2026-08-13-22-27-30 / 20260813 都是时间戳，不是项目名
function isTimestampSeg(s) {
  return /^\d{4}-\d{2}-\d{2}(-\d{2}(-\d{2}(-\d{2})?)?)?$/.test(s) || /^\d{8,}$/.test(s);
}
// 从绝对路径里挑「有意义」的末段：跳过用户目录、工具品牌、时间戳、通用代码目录、文件名
function projectNameFromPath(p, user) {
  if (!p) return '';
  const segs = String(p).split('/').filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    const low = s.toLowerCase();
    if (!s || s === '~' || isTimestampSeg(s)) continue;
    if (user && low === String(user).toLowerCase()) continue;
    if (CONV_GENERIC_SEG.has(low)) continue;
    if (/\.[a-z0-9]{1,6}$/i.test(s)) continue; // 看起来是文件名而不是目录
    // 目录名里内嵌时间戳（automation-2026-08-13-22-27-30）→ 只留前缀
    const stripped = s.replace(/[-_]?\d{4}-\d{2}-\d{2}(-\d{2}(-\d{2}(-\d{2})?)?)?$/, '').trim();
    const cand = stripped && stripped !== s ? stripped : s;
    if (!cand || cand === s) return s;
    if (CONV_GENERIC_SEG.has(cand.toLowerCase())) continue;
    return cand;
  }
  return '';
}
// 名字本身没有信息量（就是工具名 / 纯日期 / 通用目录）时，不能当独立项目
function isGenericProject(name, shortConn) {
  const low = String(name || '').toLowerCase().trim();
  if (!low) return true;
  if (CONV_GENERIC_SEG.has(low)) return true;
  if (/^\d{4}[-/]?\d{2}/.test(low)) return true; // 以日期开头
  const brand = String(shortConn || '').toLowerCase().replace(/\s+/g, '');
  if (brand && low.replace(/\s+/g, '') === brand) return true; // 名字就是工具名
  return false;
}
// 只有「看起来真的是个项目名」才单独成组，避免把时间戳 / 哈希 / 半截路径当项目
function looksLikeProjectName(name, shortConn) {
  const n = String(name || '').trim();
  if (n.length < 2 || n.length > 24) return false;
  if (/^\d/.test(n)) return false; // 2026-08-13、1-98e2…
  if (/^[0-9a-f]{8,}$/i.test(n)) return false; // 纯哈希
  if (/[-_](imgs?|images?)$/i.test(n)) return false; // 图片/资源目录不是项目名
  if (isGenericProject(n, shortConn)) return false;
  return true;
}
function convProjectOf(cv) {
  const conn = cv.connector || 'other';
  const fullConn = connName(conn);
  const shortConn = fullConn.replace(/\s*[（(][^（()）]*[)）]\s*$/, '') || fullConn;
  const user = (cv.path || '').match(/\/Users\/([^/]+)/)?.[1] || '';

  // 0) 工作区的用户自定义显示名 —— 唯一可靠的「项目真名」
  //    例：/Users/xiaoxiao/WorkBuddy/automation-2026-08-13-22-27-30
  //        → 「定时任务-每日 AI 新闻推送」
  if (cv.workspace_name && looksLikeProjectName(cv.workspace_name, shortConn)) {
    return {
      key: 'wsn:' + cv.workspace_name.toLowerCase(),
      label: cv.workspace_name,
      tip: cv.workspace || cv.workspace_name,
    };
  }

  // 0b) 后端从工作区根推断出的项目目录名（agentry / ai-native-sdlc-zsxq …）
  if (cv.project && looksLikeProjectName(cv.project, shortConn)) {
    return { key: 'proj2:' + cv.project.toLowerCase(), label: cv.project, tip: cv.workspace || cv.project };
  }

  // 1) 会话真实 cwd 里有意义的末段（claude / cursor 等工具会写真实项目路径）
  const wsName = projectNameFromPath(cv.workspace, user);
  if (wsName) return { key: 'ws:' + wsName, label: wsName, tip: cv.workspace };

  // 2) 工具自己的项目目录名：去掉末尾时间戳 + 「工具名-」前缀
  //    例：Users-xiaoxiao-WorkBuddy-automation-2026-08-13-22-27-30 → automation
  const pm = (cv.path || '').match(/\/projects\/([^/]+)\//);
  if (pm) {
    const seg = pm[1].replace(/^-+/, ''); // claude 风格的前导 -
    const home = seg.match(/^Users-[^-]+-(.+)$/);
    let rest = (home ? home[1] : seg)
      .replace(/-\d{4}-\d{2}-\d{2}(-\d{2}(-\d{2}(-\d{2})?)?)?$/, '')
      .trim();
    if (shortConn) {
      const esc2 = shortConn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const stripped = rest.replace(new RegExp('^' + esc2 + '[-_\\s]', 'i'), '').trim();
      if (stripped) rest = stripped;
    }
    // key 用名字而非完整目录名：不同时间戳目录其实是同一个项目，要合并
    if (looksLikeProjectName(rest, shortConn)) {
      return { key: 'proj:' + rest.toLowerCase(), label: rest, tip: cv.path };
    }
  }

  // 3) 拿不到真实项目（WorkBuddy 的 cwd 恒为工作区根，目录名只有工具名 + 时间戳；
  //    codex 的路径里没有项目）→ 绝不按「工具名 · 日期」分组，统一并进「全部任务」，
  //    组内按时间倒序列出每条会话的标题 —— 这就是任务列表该有的样子。
  //    注意：不要再试图从会话标题里抠路径，实测会抠出「…」「1-98e2…」这类垃圾分组。
  return { key: 'task:@all', label: '全部任务', tip: `${fullConn} · 无项目目录信息，按时间列出` };
}

// 工具维度条目里的一行小字：真实项目名（没有项目 / 就是工具名时省略，避免噪声）
function projectInline(cv, connFull) {
  const p = convProjectOf(cv);
  if (!p || String(p.key).startsWith('task:@all')) return ''; // 「全部任务」不是项目名
  const short = String(connFull || '').replace(/\s*[（(][^（()）]*[)）]\s*$/, '');
  if (!p.label || p.label === short) return '';
  return `<span class="t-proj" title="${esc(p.tip || p.label)}">${esc(p.label)}</span><span class="cv-sep">·</span>`;
}

function buildConvGroups() {
  const map = new Map();
  for (const cv of state.convs) {
    let g;
    if (convMode === 'tool') {
      // 分组标题里去掉「(codebuddy CLI)」这类后缀，否则窄栏里只剩半截名字，全名放 tooltip
      const full = connName(cv.connector);
      g = {
        key: 'conn:' + cv.connector,
        label: full.replace(/\s*[（(][^（()）]*[)）]\s*$/, '') || full,
        tip: full,
        dot: connColor(cv.connector),
      };
    } else g = convProjectOf(cv);
    let e = map.get(g.key);
    if (!e) {
      e = { key: g.key, label: g.label, tip: g.tip || '', dot: g.dot || '', order: g.order || 0, items: [], count: 0, latest: 0 };
      map.set(g.key, e);
    }
    e.items.push(cv);
    e.count += 1;
    if ((cv.created_at || 0) > e.latest) e.latest = cv.created_at || 0;
  }
  let arr = [...map.values()];
  // state.convs 已按时间倒序，组内顺序天然也是倒序
  arr.sort((a, b) => b.count - a.count || b.latest - a.latest || a.label.localeCompare(b.label));

  // 任务维度长尾很长（本机 466 条会话来自 244 个任务目录），只单列前 N 个，其余合并
  if (convMode === 'project' && arr.length > CONV_TOP_PROJECTS + 1) {
    const head = arr.slice(0, CONV_TOP_PROJECTS);
    const tail = arr.slice(CONV_TOP_PROJECTS);
    const rest = { key: 'proj:@rest', label: `其余任务（${tail.length} 个）`, tip: '点开可看这些任务下的会话', dot: '', order: 99, items: [], count: 0, latest: 0 };
    tail.forEach((g) => {
      rest.items.push(...g.items);
      rest.count += g.count;
      if (g.latest > rest.latest) rest.latest = g.latest;
    });
    rest.items.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    head.push(rest);
    arr = head;
  }
  return arr;
}

async function refreshConversations() {
  try {
    const scope = currentScope();
    // 走「统一数据门面」：本机 + 各在线代理的会话合并返回。
    // 远端会话的 id 带「节点名:」前缀，来源在 meta.sources 里。
    const res = await invoke('list_all_conversations', { connector: scope || null, limit: CONV_FETCH });
    const list = (res && res.list) || {};
    state.convs = list.items || [];
    state.convTotal = (list && list.total) || 0;
    state.dataSources = (res && res.meta && res.meta.sources) || [];
    state.dataOffline = (res && res.meta && res.meta.offline) || [];
    state.dataErrors = (res && res.meta && res.meta.errors) || [];
  } catch {
    state.convs = [];
    state.convTotal = 0;
    state.dataSources = [];
    state.dataOffline = [];
    state.dataErrors = [];
  }
  renderConversations();
}

// 数据来源提示：把「本机 + 哪些远端节点」以及「哪些节点离线/取数失败」讲清楚。
// 只在有远端参与时显示 —— 纯本机时不加噪音。
function dataSourceNote() {
  const src = state.dataSources || [];
  const off = state.dataOffline || [];
  const err = state.dataErrors || [];
  const remote = src.filter((s) => s && s !== 'localhost' && s !== '本机');
  if (!remote.length && !off.length && !err.length) return null;
  const parts = [];
  if (remote.length) parts.push(`本机 + ${remote.length} 台远端（${remote.join('、')}）`);
  if (off.length) parts.push(`${off.length} 台离线（${off.join('、')}）`);
  if (err.length) parts.push(`${err.length} 台取数失败`);
  return {
    cls: off.length || err.length ? 'warn' : '',
    text: parts.join(' · '),
  };
}

function renderConversations() {
  convCountEl.textContent = state.convTotal;
  // 把「会话数 / 任务数」的关系写进提示：工具里看到的是任务，这里一条条列的是任务下的会话，
  // 数字必然不一样，标清楚才不会让人以为数据收错了。
  if (state.convs.length) {
    convCountEl.title = `${state.convTotal} 个会话；「工具」按 AI 工具分组，「任务」按项目分组（没有项目信息的归入「全部任务」）`;
  }
  if (!state.convs.length) {
    const scope = currentScope();
    convsEl.innerHTML = `<div class="rail-empty">${
      scope ? '该工具还没有同步到会话' : '还没有同步到会话，点右侧「同步全部」拉取历史'
    }</div>`;
    return;
  }
  const groups = buildConvGroups();
  // 首次进入默认只展开第一组：466 条全展开既卡又难读
  if (!convOpenInited && groups.length) {
    convOpenInited = true;
    convOpen = new Set([groups[0].key]);
  }
  const allOpen = groups.every((g) => convOpen.has(g.key));

  let html = `<div class="conv-modes">${CONV_MODES.map(
    ([k, l]) => `<button class="conv-mode${convMode === k ? ' active' : ''}" data-conv-mode="${k}">${l}</button>`
  ).join('')}<span class="conv-modes-gap"></span><button class="conv-all" data-conv-all="1">${
    allOpen ? '收起全部' : '展开全部'
  }</button></div>`;

  // 数据来源提示：告诉用户这些会话来自哪几台机器（有节点离线时也要说清楚，
  // 否则用户会以为看到的就是全部数据）。
  const srcNote = dataSourceNote();
  if (srcNote) html += `<div class="conv-src ${srcNote.cls}">${esc(srcNote.text)}</div>`;

  for (const g of groups) {
    const open = convOpen.has(g.key);
    const shown = Math.min(convShown.get(g.key) || CONV_GROUP_PAGE, g.count);
    const tip = `${g.tip || g.label}${g.latest ? ' · 最近 ' + relTime(g.latest) : ''}`;
    html += `<div class="cvg-group${open ? ' open' : ''}" data-g="${esc(g.key)}">
      <div class="cvg-head" title="${esc(tip)}">
        <span class="cvg-caret">${open ? '▾' : '▸'}</span>
        ${g.dot ? `<span class="cvg-dot" style="background:${g.dot}"></span>` : ''}
        <span class="cvg-label">${esc(g.label)}</span>
        ${g.latest ? `<span class="cvg-time">${relTime(g.latest)}</span>` : ''}
        <span class="cvg-count">${g.count}</span>
      </div>`;
    if (open) {
      html += '<div class="cvg-body">';
      for (const cv of g.items.slice(0, shown)) {
        // 工具维度：组内工具名全一样，条目里改显示「项目 · 时间」，这样每条都有信息量；
        // 任务维度：组名已经是项目，条目里只留时间（工具用色点表示），跟办公室一致。
        const meta =
          convMode === 'tool'
            ? `${projectInline(cv, connName(cv.connector))}<span class="cv-name">${relTime(cv.created_at)}</span>`
            : `<span class="t-dot" style="background:${connColor(cv.connector)}" title="${esc(connName(cv.connector))}"></span>
               <span class="cv-name">${relTime(cv.created_at)}</span>`;
        // 标题优先用工具生成的短标题（ai-title），没有才退回首条用户消息；
        // 原始首条消息挂在 tooltip 上，长命令不会挤占列表空间
        const title = cv.title || cv.name || '未命名会话';
        const tipAttr = cv.title && cv.name && cv.title !== cv.name ? ` title="${esc(cv.name)}"` : '';
        // 远端会话标出来源机器（本机的不标，避免噪音）
        const originChip = cv.origin
          ? `<span class="cv-origin" title="来自 ${esc(cv.origin)}">${esc(cv.origin)}</span>`
          : '';
        // token 消耗（只有记录了 usage 的工具有；没有就不显示，避免 0 误导）
        const tokenChip = cv.tokens
          ? `<span class="cv-token" title="输入 ${fmtTokens(cv.tokens.input)} · 输出 ${fmtTokens(
              cv.tokens.output,
            )} · 缓存命中 ${fmtTokens(cv.tokens.cache_read)}（${fmtRate(tokenRate(cv.tokens))}）· 省 ${fmtTokens(
              tokenSaved(cv.tokens),
            )}">${fmtTokens(cv.tokens.input + cv.tokens.output)} tok</span>`
          : '';
        html += `<div class="conv-item" data-cid="${esc(cv.id)}">
          <div class="cv-title"${tipAttr}>${esc(title)}</div>
          <div class="cv-meta">${originChip}${tokenChip}${meta}</div>
        </div>`;
      }
      if (g.count > shown) {
        html += `<button class="cvg-more">还有 ${g.count - shown} 条 · 展开</button>`;
      }
      html += '</div>';
    }
    html += '</div>';
  }
  if (state.convs.length < state.convTotal) {
    html += `<div class="rail-empty">仅载入最近 ${state.convs.length} / 共 ${state.convTotal} 条</div>`;
  }
  convsEl.innerHTML = html;
}

function setConvMode(m) {
  if (m === convMode) return;
  convMode = m;
  convOpenInited = true;
  convOpen = new Set();
  convShown.clear();
  const groups = buildConvGroups();
  if (groups.length) convOpen.add(groups[0].key);
  saveConvPrefs();
  renderConversations();
}

function toggleConvGroup(key) {
  if (convOpen.has(key)) convOpen.delete(key);
  else convOpen.add(key);
  convOpenInited = true;
  saveConvPrefs();
  renderConversations();
}

function toggleAllConvGroups() {
  const groups = buildConvGroups();
  const allOpen = groups.every((g) => convOpen.has(g.key));
  convOpen = new Set(allOpen ? [] : groups.map((g) => g.key));
  convOpenInited = true;
  saveConvPrefs();
  renderConversations();
}
function switchTask(id) {
  state.activeTaskId = id;
  state.activeAnswerEl = null;
  renderStream();
}
function renderStream() {
  const t = state.tasks.get(state.activeTaskId);
  streamEl.innerHTML = '';
  if (!t) {
    renderExecution();
    return;
  }
  document.getElementById('active-task-title').textContent = t.title;
  document.getElementById('active-task-meta').textContent = `${connName(t.connector)} · ${t.status}`;
  addMsg('user', t.title);
  t.events.forEach((ev) => appendEventDom(ev, false));
}

// 中栏「执行情况」：本机 + 远程两块。
// 之前「总览」用每工具一张大卡片（会话/文件），和左栏「已连工具」、底部「本机执行情况」三处重复，
// 现在统一收成这里一张执行情况表：左栏只负责切工具，执行细节全在中栏。
function renderExecution() {
  const rows = state.connectors.map((c) => ({ c, ts: liveStatus(c.id) }));
  const busyTools = rows.filter((r) => r.ts.running > 0).length;
  const openTools = rows.filter((r) => r.ts.open === true).length;
  const runningTotal = rows.reduce((n, r) => n + r.ts.running, 0);
  const sessionsTotal = rows.reduce((n, r) => n + r.ts.sessions, 0);
  const scope = currentScope();

  document.getElementById('active-task-title').textContent = '执行情况';
  document.getElementById('active-task-meta').textContent = busyTools
    ? `${busyTools} 个工具正在提问/回答`
    : `${rows.length} 个工具 · 无任务在跑`;

  const localRows = rows.length
    ? rows
        .map(
          ({ c, ts }) => {
            const st = toolState(ts);
            return `<div class="exec-row${scope === c.id ? ' active' : ''}" data-conn="${esc(c.id)}" title="点击只看该工具">
        <span class="dot" style="background:${connColor(c.id)}"></span>
        <span class="ex-name">${esc(c.name)}</span>
        <span class="ex-badges">
          ${st.text ? `<span class="${st.cls}">${st.text}</span>` : ''}
          <span class="badge soft">今日 ${ts.today}</span>
          <span class="badge soft">会话 ${ts.sessions}</span>
        </span>
        <span class="ex-time">${ts.last ? relTime(ts.last) : '—'}</span>
      </div>`;
          }
        )
        .join('')
    : '<div class="exec-empty">还没有连接任何工具</div>';

  const remoteRows = state.peers.length
    ? state.peers
        .map((p) => {
          const tools = (p.activity && p.activity.tools) || [];
          const run = tools.reduce((n, t) => n + (t.running || 0), 0);
          const openN = tools.filter((t) => t.open === true).length;
          const dot = p.online ? 'peer-dot on' : 'peer-dot off';
          return `<div class="exec-row peer" data-peer="${esc(p.id)}" title="点击打开「代理节点」查看 / 管理该机器">
        <span class="dot ${dot}"></span>
        <span class="ex-name">${esc(p.name)}</span>
        <span class="ex-addr">${esc(p.machine || '')}</span>
        <span class="ex-badges">
          <span class="badge soft">工具 ${tools.length}</span>
          ${run ? `<span class="badge running">执行中 ${run}</span>` : ''}
          ${openN ? `<span class="badge soft">开启 ${openN}</span>` : ''}
          ${p.online ? '' : '<span class="badge off">离线</span>'}
        </span>
        <span class="ex-time">${p.online ? relTime(p.last_seen) : '离线'}</span>
      </div>`;
        })
        .join('')
    : '<div class="exec-empty">还没有远端机器接入。点右上角「☖ 代理节点」，在本机「启动中心」后，在远端机器上安装 <b>agentry-proxy</b>（<code>agentry-proxy --init --hub &lt;中心&gt;:端口 --secret &lt;密钥&gt; --name &lt;机器名&gt;</code>，然后运行 <code>agentry-proxy</code>）即可加入。</div>';

  streamEl.innerHTML = `<div class="exec">
    <div class="exec-hero">
      <div class="exec-hero-txt">
        <h1>执行情况</h1>
        <p>任务照旧在 codex / workbuddy 等工具里跑。状态每约 5 秒刷新一次、切回窗口立刻刷新：<b>执行中</b>＝正在提问/回答（看会话文件末尾的记录判定，回答完即变）；<b>已开启·空闲</b>＝软件已打开但当前没在跑任务（用 lsappinfo 看 App 是否在运行）；<b>未开启</b>＝软件没开。</p>
      </div>
      <div class="exec-actions">
        <span class="exec-note">${
          busyTools ? `<span class="ss-live">${busyTools} 个工具正在提问/回答</span>` : '无任务在跑'
        } · 共 ${sessionsTotal} 个会话${openTools ? ` · ${openTools} 个工具已开启` : ''}</span>
        <button id="exec-refresh" class="mini ghost-btn" title="重新扫描各工具的会话文件">刷新</button>
      </div>
    </div>

    <section class="exec-sec">
      <div class="exec-sec-head">
        <span class="ex-tag local">本机</span>
        <span class="exec-sec-sub">${rows.length} 个工具${runningTotal ? ` · ${runningTotal} 个任务在跑` : ''}${openTools ? ` · ${openTools} 个已开启` : ''}</span>
      </div>
      <div class="exec-list">${localRows}</div>
    </section>

    <section class="exec-sec">
      <div class="exec-sec-head">
        <span class="ex-tag remote">远程</span>
        <span class="exec-sec-sub">${state.peers.length ? `${state.peers.length} 个节点` : '未接入'}</span>
        <button class="mini ghost-btn exec-add-peer" title="打开「代理节点」管理接入">管理节点</button>
      </div>
      <div class="exec-list">${remoteRows}</div>
    </section>

    <div class="exec-hint">点「本机」的某一行 = 只看该工具的会话与产物（再点回到全部）；远端机器跑轻量<b>代理 agent</b>主动连到本机「中心」，其各 AI 工具状态实时出现在远程区与「🏢 办公室」。</div>
  </div>`;
}

function addMsg(role, text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg';
  const roleEl = document.createElement('div');
  roleEl.className = 'role';
  const label = { user: '你', answer: '回答', log: '日志', conv: '最终回答', art: '产物' }[role] || role;
  roleEl.innerHTML = `<span>${esc(label)}</span><button class="mini-copy" type="button" data-pick="stream" title="复制这条内容">复制</button>`;
  const b = document.createElement('div');
  b.className = 'bubble ' + role;
  b.textContent = text;
  wrap.appendChild(roleEl);
  wrap.appendChild(b);
  streamEl.appendChild(wrap);
  bindMiniCopy(wrap);
  return b;
}
function appendEventDom(ev, scroll = true) {
  const t = state.tasks.get(state.activeTaskId);
  if (!t) return;
  if (ev.type === 'token') {
    if (!state.activeAnswerEl) state.activeAnswerEl = addMsg('answer', '');
    state.activeAnswerEl.textContent += ev.content + '\n';
  } else if (ev.type === 'log') {
    addMsg('log', ev.content);
  } else if (ev.type === 'conversation') {
    addMsg('conv', ev.content);
    state.activeAnswerEl = null;
  } else if (ev.type === 'artifact') {
    addMsg('art', `产物：${ev.name}` + (ev.path ? `\n${ev.path}` : ''));
  } else if (ev.type === 'start') {
    t.workdir = ev.workdir || '';
    addMsg('log', `▶ 启动于 ${ev.workdir || '(项目根)'}`);
  }
  if (scroll) streamEl.scrollTop = streamEl.scrollHeight;
}

// ---------- 事件入口（按 task_id 路由）----------
function onEvent(e) {
  let evt;
  try {
    evt = JSON.parse(e.payload);
  } catch {
    return;
  }
  // 同步事件与具体任务无关，单独处理
  if (evt.type === 'sync-progress') {
    statsEl.textContent = `同步中… 已收录 ${evt.count} 项`;
    return;
  }
  if (evt.type === 'sync-done') {
    refreshArtifacts();
    refreshConversations();
    refreshStats();
    refreshToolActivity();
    if (!comparePaneEl.classList.contains('hidden')) refreshCompare();
    return;
  }
  const tid = evt.task_id;
  if (!tid) return;
  const t = state.tasks.get(tid) || makeTaskRecord(evt.connector, '(任务)', tid);
  t.events.push(evt);
  if (evt.type === 'start') {
    t.status = 'running';
    state.runningIds.add(tid);
    refreshToolActivity();
  } else if (evt.type === 'done') {
    t.status = 'done';
    state.runningIds.delete(tid);
    refreshToolActivity();
    if (tid === state.activeTaskId) {
      document.getElementById('active-task-meta').textContent = `${connName(t.connector)} · 完成`;
    }
  } else if (evt.type === 'artifact') {
    refreshArtifacts();
    refreshStats();
    if (!comparePaneEl.classList.contains('hidden')) refreshCompare();
  }
  if (tid === state.activeTaskId) appendEventDom(evt);
}

// 时间快捷筛选：把下拉选项换算成本地时区的 since / until（epoch 秒）。
// created_at 在后端是秒级时间戳，所以这里直接给秒即可。
function timeRangeSecs(preset) {
  const nowSec = Math.floor(Date.now() / 1000);
  const today = new Date();
  const midnight = (offsetDays) =>
    Math.floor(
      new Date(today.getFullYear(), today.getMonth(), today.getDate() - offsetDays).getTime() / 1000
    );
  switch (preset) {
    case 'today':
      return { since: midnight(0), until: null }; // 今天 00:00 起
    case 'yesterday':
      return { since: midnight(1), until: midnight(0) }; // 昨天整天
    case '7d':
      return { since: nowSec - 7 * 86400, until: null };
    case '30d':
      return { since: nowSec - 30 * 86400, until: null };
    default:
      return { since: null, until: null };
  }
}

// ---------- 产物统一视图 ----------
async function refreshArtifacts() {
  const f = {};
  if (filterConnEl.value) f.connector = filterConnEl.value;
  if (filterKindEl.value) f.kind = filterKindEl.value;
  if (searchEl.value.trim()) f.q = searchEl.value.trim();
  const { since, until } = timeRangeSecs(filterTimeEl.value);
  if (since != null) f.since = String(since);
  if (until != null) f.until = String(until);
  // 统一数据门面：本机 + 各在线代理的产物合并（远端条目 id 带「节点名:」前缀）
  const res = await invoke('list_all_artifacts', {
    filter: Object.keys(f).length ? f : null,
  });
  state.artifacts = (res && res.list) || [];
  state.artSources = (res && res.meta && res.meta.sources) || [];
  state.artOffline = (res && res.meta && res.meta.offline) || [];
  state.artErrors = (res && res.meta && res.meta.errors) || [];
  renderArtifacts();
}
// 统计条：必须和下面列出的内容一致。
// 列表是「工具 + 类型 + 时间 + 搜索」四重过滤后的结果，所以这里直接用过滤后的 state.artifacts 算，
// 不再去查全量统计——否则筛到「今天 3 条」时标题还写着「共 1514 条」，看起来就是数据对不上。
function renderStatsBar() {
  const list = state.artifacts || [];
  let size = 0;
  const byConn = new Map();
  for (const a of list) {
    size += a.size || 0;
    byConn.set(a.connector, (byConn.get(a.connector) || 0) + 1);
  }
  const filtered = !!(
    filterConnEl.value ||
    filterKindEl.value ||
    filterTimeEl.value ||
    searchEl.value.trim()
  );
  const parts = [];
  if (!filterConnEl.value) {
    [...byConn.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([c, n]) => parts.push(`${connName(c)} ${n}`));
  }
  const sizeStr = size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${(size / 1024).toFixed(1)} KB`;
  statsEl.innerHTML =
    `${filtered ? '筛选后' : '共'} <b>${list.length}</b> 项` +
    (parts.length ? `（${parts.map((p) => esc(p)).join(' · ')}）` : '') +
    ` · ${sizeStr}` +
    (filtered ? '<span class="stat-flag">已筛选</span>' : '');
}
async function refreshStats() {
  renderStatsBar();
  // token 统计跟着一起刷（各处调用 refreshStats 的地方自动也就有了最新数据）
  refreshTokenStats();
  try {
    const scope = currentScope();
    state.stats = await invoke('artifact_stats', { connector: scope || null });
  } catch {
    state.stats = null;
  }
  if (!state.activeTaskId) renderStream();
}

// 某个连接器的 token 统计（从 state.tokenStats 里找）。
function tokenStatOf(connector) {
  const hit = (state.tokenStats || []).find((s) => s.connector === connector);
  if (!hit) return null;
  return hit.usage || hit;
}

// ---------- token 用量（消耗 + 缓存节省） ----------
//
// 数据来自后端的 list_all_token_stats：本机 + 各在线远端，按连接器聚合。
// 远端代理与中心共用 agent-core 的同一份解析实现 → 口径完全一致。
let tokenStatsLoading = false;
async function refreshTokenStats() {
  if (tokenStatsLoading) return;
  tokenStatsLoading = true;
  try {
    const res = await invoke('list_all_token_stats');
    state.tokenStats = (res && res.list) || [];
    state.tokenMeta = (res && res.meta) || null;
  } catch {
    state.tokenStats = [];
    state.tokenMeta = null;
  } finally {
    tokenStatsLoading = false;
  }
  renderTokenStats();
  // 工具卡片上有 token chip → 数据到了要更新卡片
  // 只改 chip 文本，不重建卡片 DOM（重建会丢掉「再点一次确认删除」的状态）
  updateConnectorTokens();
}

function renderTokenStats() {
  const el = document.getElementById('token-stats');
  if (!el) return;
  const list = state.tokenStats || [];
  if (!list.length) {
    el.innerHTML = '';
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');

  // 总量
  const total = { input: 0, output: 0, cache_read: 0, sessions: 0 };
  list.forEach((t) => {
    const u = t.usage || t;
    total.input += Number(u.input) || 0;
    total.output += Number(u.output) || 0;
    total.cache_read += Number(u.cache_read) || 0;
    total.sessions += Number(u.sessions) || 0;
  });

  const rows = list
    .map((t) => {
      const u = t.usage || t;
      const rate = tokenRate(u);
      const saved = tokenSaved(u);
      return `<div class="tk-row">
        <span class="tk-tool"><i class="tk-dot" style="background:${connColor(t.connector)}"></i>${esc(t.name || t.connector)}</span>
        <span class="tk-num" title="输入 token（累计）">↓ ${fmtTokens(u.input)}</span>
        <span class="tk-num" title="输出 token">↑ ${fmtTokens(u.output)}</span>
        <span class="tk-cache" title="命中缓存的输入 token / 命中率">缓存 ${fmtTokens(u.cache_read)}（${fmtRate(tokenRate(u))}）</span>
        <span class="tk-save" title="缓存命中省下的 token 等价量（缓存读价约为输入价 1/10）">省 ${fmtTokens(saved)}</span>
      </div>`;
    })
    .join('');

  el.innerHTML = `
    <div class="tk-head">
      <span class="tk-title">Token 用量</span>
      <span class="tk-sum">
        共 ${fmtTokens(total.input)} 输入 · ${fmtTokens(total.output)} 输出 ·
        缓存 ${fmtTokens(total.cache_read)}（${fmtRate(tokenRate(total))}）·
        <b class="tk-save">省 ${fmtTokens(tokenSaved(total))}</b>
      </span>
    </div>
    ${rows}`;
}
async function exportAll() {
  try {
    const fmt = exportFmt.value || 'md';
    const content = await invoke('export_all', { format: fmt });
    const ext = fmt === 'json' ? 'json' : fmt === 'csv' ? 'csv' : 'md';
    const path = await invoke('save_export', {
      content,
      filename: `artifacts-${Date.now()}.${ext}`,
    });
    toast('已导出：' + path);
  } catch (e) {
    toast('导出失败：' + e, 'err');
  }
}

// 清空全部产物（两步确认，避免误触；macOS WKWebView 的 window.confirm 为空实现，故不用）
let clearArmed = false;
let clearTimer = null;
async function clearAll() {
  if (!clearArmed) {
    clearArmed = true;
    clearBtn.textContent = '确认清空?';
    clearTimer = setTimeout(() => {
      clearArmed = false;
      clearBtn.textContent = '清空';
    }, 3000);
    return;
  }
  clearArmed = false;
  clearBtn.textContent = '清空';
  clearTimeout(clearTimer);
  try {
    await invoke('clear_artifacts');
    await refreshArtifacts();
    await refreshStats();
    if (!comparePaneEl.classList.contains('hidden')) refreshCompare();
    toast('已清空产物');
  } catch (e) {
    toast('清空失败：' + e, 'err');
  }
}

// 同步全部已连工具已有的历史任务 / 会话 / 产物（不限于本工具下达的）。
async function syncAll() {
  try {
    toast('正在同步各工具历史数据…');
    const reports = await invoke('sync_all');
    const parts = reports
      .filter((r) => r.conversations > 0 || r.files > 0)
      .map((r) => `${connName(r.connector)}: ${r.conversations} 会话 / ${r.files} 文件`);
    refreshArtifacts();
    refreshConversations();
    refreshStats();
    refreshToolActivity();
    if (!comparePaneEl.classList.contains('hidden')) refreshCompare();
    if (parts.length) toast('已同步 — ' + parts.join('；'));
    else toast('同步完成：各工具暂无更多历史数据');
  } catch (e) {
    toast('同步失败：' + e, 'err');
  }
}

// ---------- 代理节点（中心 hub + 远端代理 agent，取代旧 P2P）----------
// 本机（或一台中心机）监听，远端只跑轻量代理 agent 主动接入，按周期上报各 AI 工具状态。
function openProxy() {
  proxyModalEl.classList.remove('hidden');
  syncHubState();
  refreshProxyList();
}
function closeProxy() {
  proxyModalEl.classList.add('hidden');
  proxyStatusEl.innerHTML = '';
}
// 同步「中心是否在运行」并据此切换按钮（启动中心 / 停止中心）
async function syncHubState() {
  try {
    state.hubRunning = await invoke('hub_running');
  } catch {
    state.hubRunning = false;
  }
  updateHubButton();
}
function updateHubButton() {
  if (!hubStartBtn) return;
  if (state.hubRunning) {
    hubStartBtn.textContent = '停止中心';
    hubStartBtn.classList.add('danger');
    hubStartBtn.title = '停止本机的中心 hub 监听（端口随之释放）';
  } else {
    hubStartBtn.textContent = '启动中心';
    hubStartBtn.classList.remove('danger');
    hubStartBtn.title = '本机（或一台中心机）担任中心 hub，监听等待代理接入';
  }
}
// 启停中心：运行中则停止，否则启动
async function toggleHub() {
  const host = (proxyHost.value || '127.0.0.1').trim();
  const port = parseInt(proxyPort.value, 10) || 47800;
  const secret = proxySecret.value;
  if (state.hubRunning) {
    hubStartBtn.disabled = true;
    hubStartBtn.textContent = '停止中…';
    try {
      const stopped = await invoke('hub_stop');
      state.hubRunning = false;
      toast(stopped ? '中心已停止' : '中心本来就没在运行', stopped ? 'ok' : 'info');
    } catch (e) {
      toast('停止失败：' + e, 'err');
    } finally {
      hubStartBtn.disabled = false;
      await syncHubState();
      refreshProxyList();
    }
    return;
  }
  if (!secret.trim()) {
    toast('请先填写共享密钥（与代理一致）', 'err');
    proxySecret.focus();
    return;
  }
  hubStartBtn.disabled = true;
  hubStartBtn.textContent = '启动中…';
  try {
    await invoke('hub_start', { host, port, secret });
    toast(`中心已启动：监听 ${host}:${port}`, 'ok');
    state.hubRunning = true;
  } catch (e) {
    toast('启动失败：' + e, 'err');
  } finally {
    hubStartBtn.disabled = false;
    await syncHubState();
    refreshProxyList();
  }
}
// 拉取已接入的代理节点（含在线态 + 最近一次 activity 快照），刷新弹窗列表与中栏「远程」区
async function refreshProxyList() {
  let peers = [];
  try {
    peers = await invoke('list_proxies');
  } catch (e) {
    proxyStatusEl.innerHTML = `<span class="cs-err">获取接入列表失败：${e}</span>`;
    return;
  }
  state.peers = Array.isArray(peers) ? peers : [];
  // 同步中心运行状态，刷新按钮（启动 / 停止）
  try {
    state.hubRunning = await invoke('hub_running');
  } catch {
    state.hubRunning = false;
  }
  updateHubButton();
  const online = state.peers.filter((p) => p.online).length;
  proxyOnlineEl.textContent = String(online);
  proxyTotalEl.textContent = String(state.peers.length);
  proxyListEl.innerHTML = '';
  if (!state.peers.length) {
    proxyListEl.innerHTML =
      '<div class="p2p-empty">还没有机器接入。在远端运行代理命令即可（默认每 5 秒上报一次）。</div>';
  }
  state.peers.forEach((p) => {
    const tools = (p.activity && p.activity.tools) || [];
    const run = tools.reduce((n, t) => n + (t.running || 0), 0);
    const row = document.createElement('div');
    row.className = 'p2p-item';
    row.innerHTML = `
      <div class="p2p-item-main">
        <div class="p2p-item-name"><span class="dot ${p.online ? 'peer-dot on' : 'peer-dot off'}"></span>${esc(p.name)}</div>
        <div class="p2p-item-sub">${esc(p.machine || '')} · 工具 ${tools.length}${run ? ` · 执行中 ${run}` : ''}${p.online ? ` · ${relTime(p.last_seen)}` : ' · 离线'}</div>
      </div>`;
    proxyListEl.appendChild(row);
  });
  renderExecutionIfIdle();
}

// ---------- 复制 ----------
// body 上有 user-select:none（桌面应用外壳防误选），内容区在 CSS 里单独放开；
// 按钮再补一个显式复制，走 clipboard API，失败退回 execCommand。
async function copyText(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到兜底 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-2000px;left:0;width:1px;height:1px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// 单条消息复制按钮的即时反馈：临时把按钮文案换成「已复制」，避免刷屏 toast
function flashCopy(btn, ok) {
  if (!btn) return;
  if (btn._restoreTimer) clearTimeout(btn._restoreTimer);
  const label = btn.dataset.label || btn.textContent;
  btn.dataset.label = label;
  btn.textContent = ok ? '已复制' : '复制失败';
  btn.classList.toggle('ok', ok);
  btn.classList.toggle('fail', !ok);
  btn._restoreTimer = setTimeout(() => {
    btn.textContent = label;
    btn.classList.remove('ok', 'fail');
  }, 1200);
}

// 绑定「每条消息一个复制按钮」：按钮通过 data-* 指向取文本的函数，避免把长正文塞进 DOM 属性
function bindMiniCopy(root) {
  root.querySelectorAll('.mini-copy').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const pick = btn.dataset.pick;
      const idx = Number(btn.dataset.idx);
      let text = '';
      if (pick === 'stream') {
        // 流式回答的正文还在持续追加，点击时再取，保证复制到最新内容
        const bubble = btn.closest('.msg')?.querySelector('.bubble');
        text = bubble ? bubble.textContent : '';
      } else {
        text = detailMsgTexts[idx] || '';
      }
      const ok = await copyText(String(text).trim());
      flashCopy(btn, ok);
    };
  });
}

// ---------- 右栏 tab 切换 ----------
function switchRightTab(tab) {
  tabBtns.forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  artifactsPaneEl.classList.toggle('hidden', tab !== 'artifacts');
  comparePaneEl.classList.toggle('hidden', tab !== 'compare');
  if (tab === 'compare') refreshCompare();
}

// ---------- 跨工具对比 ----------
async function loadContent(a) {
  if (a.kind === 'conversation' || a.kind === 'log') return a.content || '';
  if (a.path) {
    try {
      // 统一读取：origin 是来源节点 id（非空即远端），后端据此转发到那台机器读文件
      return await invoke('read_artifact_any', { path: a.path, origin: a.origin || null });
    } catch (e) {
      return '(读取失败: ' + e + ')';
    }
  }
  return a.content || '(无内容)';
}

// 同一个工具可能贡献多件产物：先按工具合并成「工具 ×N」，否则一屏全是重复标签
function groupByConnector(g) {
  const byConn = new Map();
  (g.connectors || []).forEach((m) => {
    const cur = byConn.get(m.connector) || { n: 0 };
    cur.n += 1;
    byConn.set(m.connector, cur);
  });
  return [...byConn.entries()].map(([cid, v]) => ({ cid, n: v.n }));
}

// 一个分组算哪种类型：取首个成员的类型（同名/同内容聚合通常同类型）
function groupKind(g) {
  const m = g.connectors && g.connectors[0];
  return (m && m.kind) || 'file';
}

async function refreshCompare() {
  // 正在看某一组详情时，刷新后仍停在那一组，不要把人踢回列表
  const keepKey =
    !cmpDetailViewEl.classList.contains('hidden') && currentCompare && currentCompare.group
      ? currentCompare.group.key
      : null;
  const keepIdx = currentCompare ? currentCompare.idx || 0 : 0;
  try {
    const f = {};
    const { since, until } = timeRangeSecs(filterTimeCompareEl.value);
    if (since != null) f.since = String(since);
    if (until != null) f.until = String(until);
    cmpAll = await invoke('compare_groups', {
      filter: Object.keys(f).length ? f : null,
    });
    cmpRendered = 0;
    renderCompareTabs();
    if (keepKey) {
      const same = cmpAll.find((g) => g.key === keepKey);
      if (same) {
        await openCompareGroup(same, keepIdx);
        return;
      }
    }
    closeCompareDetail();
    renderCompareList();
  } catch (e) {
    cmpAll = [];
    cmpRendered = 0;
    renderCompareTabs();
    compareGroupsEl.innerHTML = '<div class="rail-empty">加载失败：' + esc(e) + '</div>';
    compareMoreEl.innerHTML = '';
    compareCountEl.textContent = '';
  }
}

// 类型页签：既是分类展示，也是筛选器（全部 / 对话 / 文件 / 日志 + 各类型组数）
function renderCompareTabs() {
  const counts = { all: cmpAll.length, conversation: 0, file: 0, log: 0 };
  cmpAll.forEach((g) => {
    const k = groupKind(g);
    counts[k] = (counts[k] || 0) + 1;
  });
  // 换时间窗后原来选中的类型可能为空，回落到「全部」
  if (cmpKind !== 'all' && !counts[cmpKind]) cmpKind = 'all';
  const defs = [{ key: 'all', label: '全部', icon: '▦' }, ...ART_KINDS];
  cmpTabsEl.innerHTML = defs
    .filter((d) => d.key === 'all' || counts[d.key])
    .map(
      (d) => `<button type="button" class="cmp-tab${cmpKind === d.key ? ' active' : ''}" data-kind="${d.key}">
        <span class="cmp-tab-ico">${d.icon}</span>${d.label}<b>${counts[d.key] || 0}</b></button>`
    )
    .join('');
  cmpTabsEl.querySelectorAll('.cmp-tab').forEach((b) => {
    b.onclick = () => {
      if (cmpKind === b.dataset.kind) return;
      cmpKind = b.dataset.kind;
      renderCompareTabs();
      renderCompareList();
    };
  });
  cmpSortEl.textContent = { count: '份数 ↓', time: '时间 ↓', name: '名称 ↑' }[cmpSort];
}

function visibleCompareGroups() {
  const q = cmpQ.trim().toLowerCase();
  let arr = cmpAll.filter((g) => cmpKind === 'all' || groupKind(g) === cmpKind);
  if (q) {
    arr = arr.filter(
      (g) =>
        String(g.name || '').toLowerCase().includes(q) ||
        (g.connectors || []).some((m) => connName(m.connector).toLowerCase().includes(q))
    );
  }
  const out = arr.slice();
  if (cmpSort === 'count') {
    out.sort((a, b) => b.count - a.count || (b.latest || 0) - (a.latest || 0));
  } else if (cmpSort === 'time') {
    out.sort((a, b) => (b.latest || 0) - (a.latest || 0) || b.count - a.count);
  } else {
    out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN'));
  }
  return out;
}

// 一行 = 一个分组：名称占满整行（最多两行，不中途截断），下面一行放徽标/数量/时间，再一行放工具
function makeCompareRow(g) {
  const el = document.createElement('div');
  el.className = 'compare-group';
  const tools = groupByConnector(g);
  const head = tools.slice(0, 3);
  const rest = tools.length - head.length;
  const toolHtml =
    head
      .map(
        (t) =>
          `<span class="cg-tool" title="${esc(connName(t.cid))}"><i style="background:${connColor(
            t.cid
          )}"></i>${esc(connName(t.cid))}${t.n > 1 ? `<b>×${t.n}</b>` : ''}</span>`
      )
      .join('') + (rest > 0 ? `<span class="cg-tool cg-tool-rest">+${rest}</span>` : '');
  el.innerHTML = `<div class="cg-row">
      <span class="cg-ico">${kindIcon(groupKind(g))}</span>
      <span class="cg-name" title="${esc(g.name)}">${esc(g.name)}</span>
      <span class="cg-chev">›</span>
    </div>
    <div class="cg-meta">
      <span class="cg-type">${g.match === 'content' ? '同内容' : '同名'}</span>
      ${g.identical ? '<span class="cg-ident">完全一致</span>' : ''}
      <span class="cg-stat">${g.count} 份 · ${tools.length} 个工具</span>
      ${g.latest ? `<span class="cg-time">${relTime(g.latest)}</span>` : ''}
    </div>
    <div class="cg-tools">${toolHtml}</div>`;
  el.onclick = () => openCompareGroup(g, 0);
  return el;
}

function renderCompareList() {
  const arr = visibleCompareGroups();
  compareGroupsEl.innerHTML = '';
  compareMoreEl.innerHTML = '';
  cmpRendered = 0;
  compareCountEl.textContent = arr.length ? `${arr.length} 组` : '';
  if (!cmpAll.length) {
    compareGroupsEl.innerHTML = filterTimeCompareEl.value
      ? '<div class="rail-empty">该时间范围内没有可对比产物：换个时间段，或把时间筛选切回「全部时间」。</div>'
      : '<div class="rail-empty">暂无可对比产物：需至少两个工具产生同名产物（如都用「回答」或生成同名文件）。</div>';
    return;
  }
  if (!arr.length) {
    compareGroupsEl.innerHTML = `<div class="rail-empty">没有匹配的分组${
      cmpQ.trim() ? `（关键词「${esc(cmpQ.trim())}」）` : ''
    }：清空搜索词，或切回「全部」类型。</div>`;
    return;
  }
  appendCompareRows(arr, CMP_PAGE);
}

// 分组多时按批次追加，避免一次塞几百个节点卡住
function appendCompareRows(arr, add) {
  const end = Math.min(cmpRendered + add, arr.length);
  for (let i = cmpRendered; i < end; i++) compareGroupsEl.appendChild(makeCompareRow(arr[i]));
  cmpRendered = end;
  compareMoreEl.innerHTML = '';
  const status = document.createElement('div');
  status.className = 'more-status';
  status.textContent =
    end >= arr.length
      ? `已显示全部 ${arr.length} 组`
      : `已显示 ${end} / 共 ${arr.length} 组 · 继续向下滚动自动加载`;
  compareMoreEl.appendChild(status);
  if (end < arr.length) {
    const btn = document.createElement('button');
    btn.className = 'more-btn';
    btn.textContent = `加载更多（还有 ${arr.length - end} 组）`;
    btn.onclick = () => appendCompareRows(visibleCompareGroups(), CMP_PAGE);
    compareMoreEl.appendChild(btn);
  }
}

// 列表 ⇄ 详情：右栏窄，详情独占整栏，靠「← 列表」返回
function closeCompareDetail() {
  cmpDetailViewEl.classList.add('hidden');
  cmpListViewEl.classList.remove('hidden');
  compareViewEl.innerHTML = '';
  currentCompare = null;
}

async function openCompareGroup(g, focus = 0) {
  cmpListViewEl.classList.add('hidden');
  cmpDetailViewEl.classList.remove('hidden');
  compareViewEl.innerHTML = '<div class="cmp-empty">加载中…</div>';
  try {
    const arts = await Promise.all((g.connectors || []).map((m) => invoke('get_artifact', { id: m.id })));
    const contents = await Promise.all(arts.map(loadContent));
    const idx = Math.max(0, Math.min(focus, arts.length - 1));
    currentCompare = { arts, contents, name: g.name, group: g, idx };
    renderCompareDetail();
  } catch (e) {
    compareViewEl.innerHTML = '<div class="cmp-empty">加载失败：' + esc(e) + '</div>';
  }
}

// 详情：一整栏给一份内容看，工具用页签切换（原来是几份竖着堆，内容多时要滚很久）
function renderCompareDetail() {
  const { arts, contents, name, idx, group } = currentCompare;
  const cur = arts[idx] || arts[0];
  const text = contents[idx] ?? '';
  const tools = groupByConnector(group);
  const sameTool = arts.filter((a) => a.connector === cur.connector).length;
  const nth = arts.slice(0, idx).filter((a) => a.connector === cur.connector).length + 1;
  const lineCount = text ? text.split('\n').length : 0;
  let html = `<div class="cmp-dhead">
      <button id="cmp-close" class="cmp-back" title="返回分组列表">← 列表</button>
      <span class="cmp-title" title="${esc(name)}">${esc(name)}</span>
    </div>
    <div class="cmp-dmeta">
      <span class="cg-type">${group.match === 'content' ? '同内容' : '同名'}</span>
      ${group.identical ? '<span class="cg-ident">完全一致</span>' : ''}
      <span class="cmp-dstat">${arts.length} 份 · ${tools.length} 个工具</span>
      ${cur.created_at ? `<span class="cmp-dtime">${relTime(cur.created_at)}</span>` : ''}
    </div>
    <div class="cmp-tooltabs">${arts
      .map(
        (a, i) => `<button type="button" class="cmp-tooltab${i === idx ? ' active' : ''}" data-idx="${i}"
          title="${esc(connName(a.connector))} · ${esc(a.name || '')}">
          <i style="background:${connColor(a.connector)}"></i>${esc(connName(a.connector))}${
          sameTool > 1
            ? `<b>#${arts.slice(0, i).filter((x) => x.connector === a.connector).length + 1}</b>`
            : ''
        }</button>`
      )
      .join('')}</div>
    <div class="cmp-dact">
      <button id="cmp-copy" class="cmp-btn" type="button">复制这份</button>
      <button id="cmp-open" class="cmp-btn ghost" type="button">打开产物</button>
      ${arts.length >= 2 ? '<button id="cmp-diff" class="cmp-btn ghost" type="button">逐行差异</button>' : ''}
      <span class="cmp-lines">${lineCount ? lineCount + ' 行' : ''}${cur.size ? ' · ' + fmtSize(cur.size) : ''}</span>
    </div>
    ${cur.path ? `<div class="cmp-path" title="${esc(cur.path)}">${esc(cur.path)}</div>` : ''}
    <pre class="cmp-pre big">${esc(text || '(无内容)')}</pre>`;
  compareViewEl.innerHTML = html;
  compareViewEl.scrollTop = 0;
  compareViewEl.querySelector('#cmp-close').onclick = () => {
    closeCompareDetail();
    renderCompareList();
  };
  compareViewEl.querySelectorAll('.cmp-tooltab').forEach((b) => {
    b.onclick = () => {
      const i = Number(b.dataset.idx);
      if (i === currentCompare.idx) return;
      currentCompare.idx = i;
      renderCompareDetail();
    };
  });
  compareViewEl.querySelector('#cmp-copy').onclick = async (e) => {
    const ok = await copyText(text);
    flashCopy(e.currentTarget, ok);
  };
  compareViewEl.querySelector('#cmp-open').onclick = () => showArtifact(cur);
  const dbtn = compareViewEl.querySelector('#cmp-diff');
  if (dbtn) dbtn.onclick = renderCompareDiff;
  if (sameTool > 1) {
    // 同一工具多份时，标一下当前看的是第几份
    const tab = compareViewEl.querySelectorAll('.cmp-tooltab')[idx];
    if (tab) tab.title = `${connName(cur.connector)} 第 ${nth} 份`;
  }
}

function lcsDiff(aLines, bLines) {
  const n = aLines.length,
    m = bLines.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = aLines[i] === bLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      rows.push({ a: aLines[i], b: bLines[j], st: 'eq' });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ a: aLines[i], b: null, st: 'del' });
      i++;
    } else {
      rows.push({ a: null, b: bLines[j], st: 'add' });
      j++;
    }
  }
  while (i < n) rows.push({ a: aLines[i], b: null, st: 'del' }), i++;
  while (j < m) rows.push({ a: null, b: bLines[j], st: 'add' }), j++;
  return rows;
}

function renderCompareDiff() {
  const { arts, contents, name, idx } = currentCompare;
  if (arts.length < 2) return;
  // 以当前选中的那份为基准，和「另一个工具」的第一份对比
  const bi = idx || 0;
  let ai = arts.findIndex((a, i) => i !== bi && a.connector !== arts[bi].connector);
  if (ai < 0) ai = bi === 0 ? 1 : 0;
  const rows = lcsDiff((contents[ai] || '').split('\n'), (contents[bi] || '').split('\n'));
  const added = rows.filter((r) => r.st === 'add').length;
  const removed = rows.filter((r) => r.st === 'del').length;
  const whoA = esc(connName(arts[ai].connector));
  const whoB = esc(connName(arts[bi].connector));
  let html = `<div class="cmp-dhead">
      <button id="cmp-close" class="cmp-back" title="返回分组列表">← 列表</button>
      <span class="cmp-title" title="${esc(name)}">${esc(name)}</span>
    </div>
    <div class="cmp-dact">
      <span class="cmp-diff-stat"><b class="add-n">+${added}</b> / <b class="del-n">−${removed}</b></span>
      <span class="cmp-lines">左：${whoA}　右：${whoB}</span>
      <button id="cmp-back" class="cmp-btn ghost" type="button">分份查看</button>
    </div>`;
  html += `<div class="cmp-diff-wrap"><table class="diff-table"><tr class="hd"><td class="a">${whoA}</td><td class="b">${whoB}</td></tr>`;
  for (const r of rows) {
    if (r.st === 'eq') html += `<tr class="eq"><td class="a">${esc(r.a)}</td><td class="b">${esc(r.b)}</td></tr>`;
    else if (r.st === 'add') html += `<tr class="add"><td class="a"></td><td class="b">${esc(r.b)}</td></tr>`;
    else html += `<tr class="del"><td class="a">${esc(r.a)}</td><td class="b"></td></tr>`;
  }
  html += '</table></div>';
  compareViewEl.innerHTML = html;
  compareViewEl.scrollTop = 0;
  compareViewEl.querySelector('#cmp-back').onclick = renderCompareDetail;
  compareViewEl.querySelector('#cmp-close').onclick = () => {
    closeCompareDetail();
    renderCompareList();
  };
}

// ---------- 时间 / 名称 / 预览 ----------
function relTime(secs) {
  if (!secs) return '';
  const diff = Date.now() / 1000 - secs;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' 天前';
  const d = new Date(secs * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtSize(n) {
  if (!n) return '';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

// ---------- token 展示 ----------
// token 数量级很大（单个会话能到几十万），用「万 / 亿」压缩更好读。
function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + ' 万';
  return v.toLocaleString('zh-CN');
}

// 缓存命中率：cache_read / input（后端只给原始计数，比率在这里算 ——
// 反序列化时后端算好的派生值不可靠，自己算一份最稳）。
function tokenRate(u) {
  if (!u) return 0;
  const input = Number(u.input) || 0;
  const cache = Number(u.cache_read) || 0;
  if (!input) return 0;
  return Math.min(cache / input, 1);
}

// 比率 → 百分比文本
function fmtRate(r) {
  const v = Number(r) || 0;
  return (v * 100).toFixed(v >= 0.1 ? 0 : 1) + '%';
}

// 缓存命中的绝对量 + 折算后的节省量，两个口径都给。
// 折算依据：缓存读价约为普通输入价的 1/10（Claude Sonnet：$0.30 vs $3 / MTok）
// → 命中的部分相当于省下 90% 的输入成本。
function tokenSaved(u) {
  if (!u) return 0;
  return Math.round((Number(u.cache_read) || 0) * 0.9);
}
function kindIcon(kind) {
  return { conversation: '💬', file: '📄', log: '🖥' }[kind] || '•';
}
// 产物 / 对比都按这三种类型做分类展示
const ART_KINDS = [
  { key: 'conversation', label: '对话', icon: '💬' },
  { key: 'file', label: '文件', icon: '📄' },
  { key: 'log', label: '日志', icon: '🖥' },
];
// 每个分类各自的「目标游标 / 已追加条数 / 上次日期分组」，支持分类型无限滚动
let shownKind = { conversation: PAGE, file: PAGE, log: PAGE };
let appendedKind = { conversation: 0, file: 0, log: 0 };
let lastDayByKind = { conversation: null, file: null, log: null };
function kindItems(kind) {
  return state.artifacts.filter((a) => a.kind === kind);
}
function artifactsAllShown() {
  const activeKind = filterKindEl.value;
  return ART_KINDS.every((k) => {
    if (activeKind && activeKind !== k.key) return true;
    return shownKind[k.key] >= kindItems(k.key).length;
  });
}
// 文件产物用文件名（比一长串相对路径好读），会话用清理后的标题。
function displayName(a) {
  let n = (a.name || '').trim();
  if (a.kind === 'file') {
    // 远程文件 name 形如 "host:rel/path"，先剥掉 host 前缀，再取最后一段文件名
    if (n.includes(':')) n = n.slice(n.indexOf(':') + 1);
    if (n) return n.split('/').pop() || n;
    if (a.path) return a.path.split('/').pop() || '(文件)';
  }
  return n || '(未命名)';
}
function snippet(a) {
  if (a.kind === 'conversation' || a.kind === 'log') {
    return (a.content || '')
      .replace(/^### (user|assistant)\s*/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (a.path) {
    const parts = a.path.split('/').filter(Boolean);
    return parts.slice(-2).join('/');
  }
  return '';
}

// 日期分组
function dayLabel(secs) {
  if (!secs) return '更早';
  const d = new Date(secs * 1000);
  const today = new Date();
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dd = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((t0 - dd) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff > 1 && diff < 7) return `${diff} 天前`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dayKey(secs) {
  if (!secs) return 'old';
  const d = new Date(secs * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function renderArtifacts() {
  artifactsEl.innerHTML = '';
  moreEl.innerHTML = '';
  shownKind = { conversation: PAGE, file: PAGE, log: PAGE };
  appendedKind = { conversation: 0, file: 0, log: 0 };
  lastDayByKind = { conversation: null, file: null, log: null };
  const list = state.artifacts;
  const activeKind = filterKindEl.value;
  if (!list.length) {
    const scope = currentScope();
    artifactsEl.innerHTML = `<div class="empty-state">
      <div class="empty-ico">🗂</div>
      <div class="empty-title">${scope ? '这个工具还没有产物' : '还没有产物'}</div>
      <div class="empty-sub">${
        scope
          ? '点右上角「同步全部」拉取它已有的会话与产物。'
          : '点右上角「同步全部」拉取各工具已有的会话与产物。'
      }</div></div>`;
    return;
  }
  // 按 对话 / 文件 / 日志 三个分类区块展示；filter-kind 选了某类时只渲染那一块
  ART_KINDS.forEach((k) => {
    if (activeKind && activeKind !== k.key) return;
    const arr = kindItems(k.key);
    if (!arr.length) return;
    const sec = document.createElement('div');
    sec.className = 'art-sec';
    sec.dataset.kind = k.key;
    sec.innerHTML = `<div class="art-sec-head">
        <span class="art-sec-ico">${k.icon}</span>
        <span class="art-sec-label">${k.label}</span>
        <span class="art-sec-count">${arr.length}</span>
        <span class="art-sec-fold">▾</span>
      </div>
      <div class="art-sec-body"></div>`;
    sec.querySelector('.art-sec-head').addEventListener('click', () => {
      sec.classList.toggle('collapsed');
    });
    artifactsEl.appendChild(sec);
  });
  appendMoreArtifacts();
  updateMoreBar();
}

// 单件产物的卡片 DOM（含删除按钮），供分类区块复用
function makeArtifactEl(a) {
  const el = document.createElement('div');
  el.className = `artifact k-${a.kind}`;
  const sn = snippet(a);
  // 远端产物不在本机索引里，删不掉 → 不显示删除按钮（避免点了报错）
  const isRemote = !!a.origin;
  el.innerHTML = `<div class="a-head">
      <span class="a-icon">${kindIcon(a.kind)}</span>
      <span class="a-name" title="${esc(a.name)}">${esc(displayName(a))}</span>
      ${isRemote ? '' : '<button class="a-del" title="删除该产物">×</button>'}
    </div>
    ${sn ? `<div class="a-snip">${esc(sn)}</div>` : ''}
    <div class="a-meta">
      <span class="a-kind ${a.kind}">${kindLabel(a.kind)}</span>
      <span class="a-conn"><i style="background:${connColor(a.connector)}"></i>${esc(connName(a.connector))}</span>
      ${a.origin_name ? `<span class="a-origin" title="来自 ${esc(a.origin_name)}">${esc(a.origin_name)}</span>` : ''}
      <span class="a-time">${relTime(a.created_at)}</span>
      ${a.size ? `<span class="a-size">${fmtSize(a.size)}</span>` : ''}
    </div>`;
  el.addEventListener('click', () => showArtifact(a));
  const delBtn = el.querySelector('.a-del');
  if (delBtn) {
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await invoke('delete_artifact', { id: a.id });
        await refreshArtifacts();
        await refreshStats();
        if (!comparePaneEl.classList.contains('hidden')) refreshCompare();
        toast('已删除');
      } catch (err) {
        toast('删除失败：' + err, 'err');
      }
    });
  }
  return el;
}

// 把每个分类里「已追加条数」到「目标游标」之间的条目追加进对应区块，不清空已有节点，滚动位置不跳
function appendMoreArtifacts() {
  const activeKind = filterKindEl.value;
  ART_KINDS.forEach((k) => {
    if (activeKind && activeKind !== k.key) return;
    const arr = kindItems(k.key);
    const sec = artifactsEl.querySelector(`.art-sec[data-kind="${k.key}"]`);
    if (!sec) return;
    const body = sec.querySelector('.art-sec-body');
    const end = Math.min(shownKind[k.key], arr.length);
    for (let i = appendedKind[k.key]; i < end; i++) {
      const a = arr[i];
      const dk = dayKey(a.created_at);
      if (dk !== lastDayByKind[k.key]) {
        lastDayByKind[k.key] = dk;
        const head = document.createElement('div');
        head.className = 'day-head';
        head.textContent = dayLabel(a.created_at);
        body.appendChild(head);
      }
      body.appendChild(makeArtifactEl(a));
    }
    appendedKind[k.key] = end;
  });
}

// 底部的「已加载 X / 共 Y」+ 兜底按钮（滚动到底会自动加载）
function updateMoreBar() {
  moreEl.innerHTML = '';
  const list = state.artifacts;
  const activeKind = filterKindEl.value;
  if (!list.length) return;
  let shown = 0,
    total = 0;
  ART_KINDS.forEach((k) => {
    if (activeKind && activeKind !== k.key) return;
    const arr = kindItems(k.key);
    total += arr.length;
    shown += Math.min(shownKind[k.key], arr.length);
  });
  const status = document.createElement('div');
  status.className = 'more-status';
  status.textContent =
    shown >= total
      ? `已显示全部 ${total} 项`
      : `已加载 ${shown} / 共 ${total} 项 · 继续向下滚动自动加载`;
  moreEl.appendChild(status);
  if (shown < total) {
    const btn = document.createElement('button');
    btn.className = 'more-btn';
    btn.textContent = `加载更多（还有 ${total - shown} 项）`;
    btn.onclick = loadMoreArtifacts;
    moreEl.appendChild(btn);
  }
}

function loadMoreArtifacts() {
  const activeKind = filterKindEl.value;
  let any = false;
  ART_KINDS.forEach((k) => {
    if (activeKind && activeKind !== k.key) return;
    const arr = kindItems(k.key);
    const next = Math.min(shownKind[k.key] + PAGE, arr.length);
    if (next > shownKind[k.key]) {
      shownKind[k.key] = next;
      any = true;
    }
  });
  if (!any) return;
  appendMoreArtifacts();
  updateMoreBar();
}

// ---------- 详情渲染 ----------
// 把 `### user / ### assistant` 切成一条条消息，渲染成对话气泡，而不是甩一坨原始文本。
function splitConversation(content) {
  const msgs = [];
  let cur = null;
  for (const line of String(content || '').split('\n')) {
    const m = /^#{2,4}\s+(user|assistant)\s*$/i.exec(line.trim());
    if (m) {
      cur = { role: m[1].toLowerCase(), lines: [] };
      msgs.push(cur);
    } else {
      if (!cur) {
        cur = { role: 'user', lines: [] };
        msgs.push(cur);
      }
      cur.lines.push(line);
    }
  }
  return msgs
    .map((m) => ({ role: m.role, text: m.lines.join('\n').trim() }))
    .filter((m) => m.text);
}

// ---------- 轻量 Markdown 渲染 ----------
// 不引第三方库：只覆盖标题/列表/引用/分隔线/代码块/行内代码/加粗/链接，
// 足够把工具输出、会话正文渲染成人能读的样子。
function inlineMd(text) {
  return esc(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
}

function renderMarkdown(src) {
  const lines = String(src ?? '').split('\n');
  const out = [];
  let para = [];
  let listBuf = [];
  let listType = null;
  let i = 0;

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.join('<br>')}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (listBuf.length) {
      out.push(`<${listType}>${listBuf.join('')}</${listType}>`);
      listBuf = [];
      listType = null;
    }
  };

  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();

    // 代码块
    if (t.startsWith('```')) {
      flushPara();
      flushList();
      i++;
      const buf = [];
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过结束围栏
      out.push(`<pre class="md-pre"><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    if (!t) {
      flushPara();
      i++;
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) {
      flushPara();
      flushList();
      const lvl = Math.min(h[1].length + 1, 5);
      out.push(`<h${lvl} class="md-h">${inlineMd(h[2])}</h${lvl}>`);
      i++;
      continue;
    }

    // 分隔线
    if (/^([-*_])\1{2,}$/.test(t)) {
      flushPara();
      flushList();
      out.push('<hr>');
      i++;
      continue;
    }

    // 引用
    if (t.startsWith('>')) {
      flushPara();
      flushList();
      out.push(`<blockquote>${inlineMd(t.replace(/^>\s?/, ''))}</blockquote>`);
      i++;
      continue;
    }

    // 有序 / 无序列表
    const ul = /^[-*+]\s+(.*)$/.exec(t);
    const ol = /^(\d+)[.)]\s+(.*)$/.exec(t);
    if (ul || ol) {
      flushPara();
      const type = ul ? 'ul' : 'ol';
      if (listType && listType !== type) flushList();
      listType = type;
      listBuf.push(`<li>${inlineMd(ul ? ul[1] : ol[2])}</li>`);
      i++;
      continue;
    }

    flushList();
    para.push(inlineMd(t));
    i++;
  }

  flushPara();
  flushList();
  return out.join('\n');
}

// 兼容旧调用点
function richText(text) {
  return renderMarkdown(text);
}

// ---------- 把「机器内容」渲染成「人看得懂的内容」----------
const ENVELOPE_KEYS = ['content', 'text', 'result', 'output', 'message', 'answer', 'body', 'data'];

// 很多工具结果被包了一层 {"content": "...真实正文..."}，先拆信封再渲染
function extractEnvelope(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    const parts = obj
      .map((it) => (typeof it === 'string' ? it : it && (it.text || it.content)))
      .filter((x) => typeof x === 'string');
    const joined = parts.join('\n').trim();
    return joined.length > 60 ? joined : null;
  }
  for (const k of ENVELOPE_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 60) return v;
    if (Array.isArray(v)) {
      const parts = v
        .map((it) => (typeof it === 'string' ? it : it && (it.text || it.content)))
        .filter((x) => typeof x === 'string');
      const joined = parts.join('\n').trim();
      if (joined.length > 60) return joined;
    }
  }
  return null;
}

function truncNote() {
  return '<p class="md-note">（内容较长，仅显示前 12 万字符；可点「原始内容」查看原始文本）</p>';
}

// 返回 { html, mode }。mode 用于 UI 提示（json / text / markdown）
function renderAnyContent(text, path) {
  let t = String(text ?? '');
  const LIMIT = 120000;
  let truncated = false;
  if (t.length > LIMIT) {
    t = t.slice(0, LIMIT);
    truncated = true;
  }
  const trimmed = t.trim();
  const tail = truncated ? truncNote() : '';

  // NDJSON：每行一个 JSON
  if (/\.ndjson$/i.test(path || '')) {
    const rows = [];
    for (const line of trimmed.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        rows.push(`<pre class="md-pre"><code>${esc(JSON.stringify(JSON.parse(s), null, 2))}</code></pre>`);
      } catch {
        rows.push(`<p>${inlineMd(s)}</p>`);
      }
      if (rows.length > 400) {
        rows.push('<p class="md-note">（仅显示前 400 条）</p>');
        break;
      }
    }
    return { html: rows.join('\n') + tail, text: t, mode: 'json' };
  }

  // 单个 JSON：优先拆出信封里的正文
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 2) {
    try {
      const obj = JSON.parse(trimmed);
      const inner = extractEnvelope(obj);
      if (inner) return { html: `<div class="md-body">${renderMarkdown(inner)}</div>`, text: inner, mode: 'markdown' };
      const pretty = JSON.stringify(obj, null, 2);
      return {
        html: `<pre class="md-pre"><code>${esc(pretty)}</code></pre>`,
        text: pretty,
        mode: 'json',
      };
    } catch {
      /* 不是合法 JSON，继续按文本处理 */
    }
  }

  return { html: `<div class="md-body">${renderMarkdown(t)}</div>`, text: t, mode: 'markdown' };
}

let detailRaw = false; // false = 美化视图；true = 原始文本
let detailCopyText = ''; // 「复制」按钮要复制的内容（会话按气泡拼成可读文本）
let detailMsgTexts = []; // 每一条消息的完整正文，供气泡上的单条「复制」使用

function renderDetailBody(a, fullContent) {
  const title = displayName(a);
  const sub = `${connName(a.connector)} · ${kindLabel(a.kind)} · ${relTime(a.created_at)}${
    a.size ? ' · ' + fmtSize(a.size) : ''
  }`;
  // token 明细：会话详情里给出输入 / 输出 / 缓存命中 / 节省 两个口径。
  // 没有 usage 记录的工具（Codex / Claude Code）不显示 —— 不显示 0，避免误导。
  const tok = a.tokens;
  const tokHtml = tok
    ? `<div class="dtok" title="输入 ${fmtTokens(tok.input)} · 输出 ${fmtTokens(
        tok.output,
      )} · 缓存命中 ${fmtTokens(tok.cache_read)}（${fmtRate(tokenRate(tok))}）· 节省 ${fmtTokens(
        tokenSaved(tok),
      )}">
        <span class="dtok-i">↓ 输入 <b>${fmtTokens(tok.input)}</b></span>
        <span class="dtok-i">↑ 输出 <b>${fmtTokens(tok.output)}</b></span>
        <span class="dtok-i">缓存命中 <b>${fmtTokens(tok.cache_read)}</b>（${fmtRate(tokenRate(tok))}）</span>
        <span class="dtok-save">省 <b>${fmtTokens(tokenSaved(tok))}</b></span>
      </div>`
    : '';
  let body = '';
  detailCopyText = fullContent || '';
  detailMsgTexts = [];
  if (a.kind === 'conversation') {
    const msgs = splitConversation(fullContent);
    if (msgs.length) {
      // 复制时按角色加标记，粘到聊天窗口/文档里也能看清谁说的
      detailCopyText = msgs
        .map((m) => `${m.role === 'user' ? '【你】' : '【助手】'}\n${m.text}`)
        .join('\n\n');
      detailMsgTexts = msgs.map((m) => m.text);
    }
    body =
      '<div class="dconv">' +
      msgs
        .map((m, i) => {
          const txt = m.text.length > 40000 ? m.text.slice(0, 40000) + '\n\n…（内容过长，已截断）' : m.text;
          const who = m.role === 'user' ? '你' : '助手';
          return `<div class="dmsg ${m.role}">
            <div class="drole"><i></i><span>${who}</span><button class="mini-copy" type="button" data-pick="detail" data-idx="${i}" title="复制这条${m.role === 'user' ? '提问' : '回答'}">复制</button></div>
            <div class="dtext">${renderMarkdown(txt)}</div>
          </div>`;
        })
        .join('') +
      '</div>';
    if (!msgs.length) body = '<div class="cmp-empty">（这条会话没有可显示的内容）</div>';
  } else if (detailRaw) {
    detailCopyText = fullContent || '';
    body = `<pre class="md-raw">${esc(fullContent || '(无内容)')}</pre>`;
  } else {
    // 关键：文件/日志不原样倒出来，先识别 JSON 信封再按 Markdown 渲染
    const r = renderAnyContent(fullContent, a.path);
    detailCopyText = r.text || fullContent || '';
    body = r.html;
  }
  const rawBtn =
    a.kind === 'conversation'
      ? ''
      : `<button id="ad-raw" title="在美化视图与原始文本之间切换">${detailRaw ? '美化视图' : '原始内容'}</button>`;
  detailEl.innerHTML = `<div class="detail-bar">
      <div class="dmain">
        <div class="dtitle" title="${esc(a.path || a.name || '')}">${esc(title)}</div>
        <div class="dsub">${esc(sub)}</div>
        ${tokHtml}
      </div>
      ${rawBtn}
      <button id="ad-copy" title="复制当前内容的原始文本（也可直接选中部分文字 ⌘C）">复制</button>
      <button id="ad-open">在访达中显示</button>
      <button id="ad-close" class="primary">关闭</button>
    </div>
    <div class="detail-body">${body}</div>`;
}

function hideDetail() {
  detailEl.classList.remove('show');
  backdropEl.classList.remove('show');
  // 等滑出动画结束再清空，避免内容瞬间消失
  clearTimeout(hideDetail._t);
  hideDetail._t = setTimeout(() => {
    if (!detailEl.classList.contains('show')) detailEl.innerHTML = '';
  }, 260);
}

// 从左栏「历史会话」打开：brief 里没有正文，先按 id 取完整产物
async function openArtifactById(id) {
  try {
    const a = await invoke('get_artifact', { id });
    if (!a) return toast('该会话已不存在', 'err');
    a._full = true;
    // 产物本身不带 token（那是会话级数据）—— 从左栏简表里补上，
    // 这样左栏点进来也能看到消耗与节省。
    if (!a.tokens) {
      const brief = (state.convs || []).find((c) => c.id === id);
      if (brief && brief.tokens) a.tokens = brief.tokens;
    }
    await showArtifact(a);
  } catch (err) {
    toast('打开失败：' + err, 'err');
  }
}

let detailCtx = null; // { a, content, path }

function paintDetail() {
  if (!detailCtx) return;
  const { a, content, path } = detailCtx;
  renderDetailBody(a, content);
  const openBtn = detailEl.querySelector('#ad-open');
  if (path) {
    openBtn.onclick = async () => {
      try {
        await invoke('open_in_finder', { path });
      } catch (err) {
        toast('打开失败：' + err, 'err');
      }
    };
  } else {
    openBtn.style.display = 'none';
  }
  detailEl.querySelector('#ad-close').onclick = hideDetail;
  // 每条提问/回答各自的「复制」
  bindMiniCopy(detailEl);
  const copyBtn = detailEl.querySelector('#ad-copy');
  if (copyBtn) {
    copyBtn.onclick = async () => {
      const ok = await copyText(detailCopyText);
      toast(ok ? '已复制到剪贴板' : '复制失败，可直接选中文字后 ⌘C', ok ? 'ok' : 'err');
    };
  }
  const rawBtn = detailEl.querySelector('#ad-raw');
  if (rawBtn) {
    rawBtn.onclick = () => {
      detailRaw = !detailRaw;
      paintDetail();
    };
  }
}

async function showArtifact(a) {
  detailRaw = false;
  detailEl.classList.add('show');
  backdropEl.classList.add('show');
  detailEl.innerHTML = '<div class="cmp-empty" style="padding:24px">加载中…</div>';
  let fullContent = a.content || '';
  let path = a.path;
  if (a.kind === 'file' && path) {
    try {
      // 统一读取：origin 是来源节点 id（非空即远端），后端据此转发到那台机器读文件
      fullContent = await invoke('read_artifact_any', { path, origin: a.origin || null });
    } catch (err) {
      fullContent = '读取失败：' + err;
    }
  } else if (!a._full) {
    // 列表/搜索里只有预览片段，完整内容从后端按 id 取
    try {
      // 统一读取：远端 id 带「节点名:」前缀，后端自动转发给那台代理
      const full = await invoke('get_artifact_any', { id: a.id });
      fullContent = (full && full.content) || a.content || '(无内容)';
      if (full && full.path) path = full.path;
    } catch {
      /* 用预览兜底 */
    }
  }
  detailCtx = { a, content: fullContent, path };
  paintDetail();
}

// ---------- 下达 / 停止 ----------
// 派发能力已移除：本机与远端都只展示各 AI 工具的执行状态（见 renderExecution / showPeerStatus）。

// ---------- 左栏分组：收起 / 展开（持久化）----------
const SEC_KEY = 'agentdesk.sections';

function readSecState() {
  try {
    return JSON.parse(localStorage.getItem(SEC_KEY)) || {};
  } catch {
    return {};
  }
}

function applySecState() {
  const st = readSecState();
  document.querySelectorAll('.section-title[data-sec]').forEach((head) => {
    const key = head.dataset.sec;
    const body = head.nextElementSibling;
    const collapsed = !!st[key];
    head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    if (body && body.classList.contains('sec-body')) body.classList.toggle('sec-collapsed', collapsed);
  });
}

function wireSectionHeads() {
  document.querySelectorAll('.section-title[data-sec]').forEach((head) => {
    head.addEventListener('click', () => {
      const st = readSecState();
      st[head.dataset.sec] = !st[head.dataset.sec];
      try {
        localStorage.setItem(SEC_KEY, JSON.stringify(st));
      } catch {
        /* 隐私模式下可能不可写，忽略 */
      }
      applySecState();
    });
  });
}

// ---------- 三栏宽度：拖动分隔条调节（持久化）----------
const COLS_KEY = 'agentdesk.cols';

function initSplitters() {
  const app = document.getElementById('app');
  const clampNum = (v, a, b) => Math.max(a, Math.min(b, v));
  const maxLeft = () => Math.min(420, Math.round(window.innerWidth * 0.3));
  const maxRight = () => Math.min(760, Math.round(window.innerWidth * 0.55));
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(COLS_KEY)) || {};
  } catch {
    saved = {};
  }
  if (saved.left) app.style.setProperty('--left-w', clampNum(saved.left, 180, maxLeft()) + 'px');
  if (saved.right) app.style.setProperty('--right-w', clampNum(saved.right, 320, maxRight()) + 'px');

  let drag = null;

  function start(which) {
    return (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      drag = {
        which,
        startX: e.clientX,
        startLeft: leftEl.getBoundingClientRect().width,
        startRight: rightEl.getBoundingClientRect().width,
      };
      document.body.classList.add('resizing');
      (which === 'left' ? splitLeftEl : splitRightEl).classList.add('dragging');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp, { once: true });
    };
  }

  function onMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    if (drag.which === 'left') {
      app.style.setProperty('--left-w', clampNum(drag.startLeft + dx, 180, maxLeft()) + 'px');
    } else {
      // 右分隔条往右拖 → 右栏变窄
      app.style.setProperty('--right-w', clampNum(drag.startRight - dx, 320, maxRight()) + 'px');
    }
  }

  function onUp() {
    if (!drag) return;
    document.body.classList.remove('resizing');
    splitLeftEl.classList.remove('dragging');
    splitRightEl.classList.remove('dragging');
    try {
      localStorage.setItem(
        COLS_KEY,
        JSON.stringify({
          left: Math.round(leftEl.getBoundingClientRect().width),
          right: Math.round(rightEl.getBoundingClientRect().width),
        })
      );
    } catch {
      /* 忽略 */
    }
    drag = null;
    window.removeEventListener('mousemove', onMove);
  }

  splitLeftEl.addEventListener('mousedown', start('left'));
  splitRightEl.addEventListener('mousedown', start('right'));

  // 窗口变窄时夹紧，避免三栏溢出
  window.addEventListener('resize', () => {
    if (leftEl.getBoundingClientRect().width > maxLeft()) {
      app.style.setProperty('--left-w', maxLeft() + 'px');
    }
    if (rightEl.getBoundingClientRect().width > maxRight()) {
      app.style.setProperty('--right-w', maxRight() + 'px');
    }
  });
}

// ---------- 滚动到底自动加载 ----------
function initInfiniteScroll() {
  // 产物列表自己滚动（#artifacts），左栏整体滚动（#left）
  artifactsEl.addEventListener(
    'scroll',
    () => {
      if (artifactsAllShown()) return;
      const nearBottom =
        artifactsEl.scrollTop + artifactsEl.clientHeight >= artifactsEl.scrollHeight - 420;
      if (nearBottom) loadMoreArtifacts();
    },
    { passive: true }
  );

  // 左栏会话：一次取全量简表 + 分组折叠渲染，不再需要滚动补量

  // 对比分组列表：滚到底自动续接（分组可能有上百个）
  compareGroupsEl.addEventListener(
    'scroll',
    () => {
      const arr = visibleCompareGroups();
      if (cmpRendered >= arr.length) return;
      const nearBottom =
        compareGroupsEl.scrollTop + compareGroupsEl.clientHeight >=
        compareGroupsEl.scrollHeight - 300;
      if (nearBottom) appendCompareRows(arr, CMP_PAGE);
    },
    { passive: true }
  );
}

// ---------- 绑定 ----------
function wire() {
  // 会话分类视图：整栏用事件委托，模式切换 / 分组折叠都只重渲染，不重复绑事件
  convsEl.addEventListener('click', (e) => {
    const modeBtn = e.target.closest('[data-conv-mode]');
    if (modeBtn) {
      setConvMode(modeBtn.dataset.convMode);
      return;
    }
    if (e.target.closest('[data-conv-all]')) {
      toggleAllConvGroups();
      return;
    }
    const more = e.target.closest('.cvg-more');
    if (more) {
      const key = more.closest('.cvg-group')?.dataset.g;
      if (key) {
        convShown.set(key, (convShown.get(key) || CONV_GROUP_PAGE) + CONV_GROUP_PAGE);
        renderConversations();
      }
      return;
    }
    const head = e.target.closest('.cvg-head');
    if (head) {
      const key = head.closest('.cvg-group')?.dataset.g;
      if (key) toggleConvGroup(key);
      return;
    }
    const item = e.target.closest('.conv-item');
    if (item && item.dataset.cid) openArtifactById(item.dataset.cid);
  });
  filterConnEl.addEventListener('change', () => {
    state.shown = PAGE;
    updateScopeBar();
    renderExecutionIfIdle();
    refreshConversations();
    refreshArtifacts();
    refreshStats();
  });
  // 执行情况（中栏）：整块用事件委托，因为每次刷新都会重建 DOM
  //   · 点「本机」某行 = 只看该工具（再点回到全部）
  //   · 点远端节点 / 「＋ 添加远端」= 打开远端面板
  //   · 刷新 = 重扫各工具的会话文件
  streamEl.addEventListener('click', async (e) => {
    if (e.target.closest('#exec-refresh')) {
      const btn = e.target.closest('#exec-refresh');
      btn.disabled = true;
      btn.textContent = '扫描中…';
      try {
        await refreshToolActivity();
        await refreshPeers();
      } finally {
        btn.disabled = false;
        btn.textContent = '刷新';
      }
      return;
    }
    if (e.target.closest('.exec-add-peer') || e.target.closest('.exec-row.peer')) {
      openProxy();
      return;
    }
    const row = e.target.closest('.exec-row[data-conn]');
    if (row && row.dataset.conn) {
      selectEl.value = row.dataset.conn;
      highlightConnector();
      toggleScope(row.dataset.conn);
    }
  });
  // 点遮罩关闭详情抽屉
  backdropEl.addEventListener('click', hideDetail);
  filterKindEl.addEventListener('change', () => {
    state.shown = PAGE;
    refreshArtifacts();
  });
  // 时间筛选在「产物 / 对比」两个页签间共享：任一页签改动，另一页同步同一个时间窗
  filterTimeEl.addEventListener('change', () => {
    filterTimeCompareEl.value = filterTimeEl.value;
    state.shown = PAGE;
    refreshArtifacts();
  });
  filterTimeCompareEl.addEventListener('change', () => {
    filterTimeEl.value = filterTimeCompareEl.value;
    state.shown = PAGE;
    refreshArtifacts();
    refreshCompare();
  });
  // 对比：搜索分组名 / 工具名（本地过滤，不重新请求后端）
  let cmpSearchTimer = null;
  cmpSearchEl.addEventListener('input', () => {
    clearTimeout(cmpSearchTimer);
    cmpSearchTimer = setTimeout(() => {
      cmpQ = cmpSearchEl.value;
      renderCompareList();
    }, 140);
  });
  // 对比：排序（份数 / 时间 / 名称）
  cmpSortEl.addEventListener('click', () => {
    cmpSort = cmpSort === 'count' ? 'time' : cmpSort === 'time' ? 'name' : 'count';
    renderCompareTabs();
    renderCompareList();
  });
  searchEl.addEventListener('input', () => {
    state.shown = PAGE;
    refreshArtifacts();
  });
  scopeClearEl.addEventListener('click', () => toggleScope(currentScope()));
  exportBtn.addEventListener('click', exportAll);
  clearBtn.addEventListener('click', clearAll);
  syncBtn.addEventListener('click', syncAll);
  selectEl.addEventListener('change', highlightConnector);
  tabBtns.forEach((b) => b.addEventListener('click', () => switchRightTab(b.dataset.tab)));

  // 代理节点弹窗 + 像素办公室
  proxyBtn.addEventListener('click', openProxy);
  proxyCloseBtn.addEventListener('click', closeProxy);
  hubStartBtn.addEventListener('click', toggleHub);
  hubRefreshBtn.addEventListener('click', refreshProxyList);
  openOfficeBtn.addEventListener('click', openOffice);
  officeBtn.addEventListener('click', openOffice);
  document.getElementById('office-close').addEventListener('click', closeOffice);
  document.getElementById('office-refresh').addEventListener('click', refreshOffice);
  document.getElementById('office-backdrop').addEventListener('click', closeOffice);
  proxyModalEl.addEventListener('click', (e) => {
    if (e.target === proxyModalEl) closeProxy();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!proxyModalEl.classList.contains('hidden')) return closeProxy();
      if (!document.getElementById('office').classList.contains('hidden')) return closeOffice();
      if (detailEl.classList.contains('show')) return hideDetail();
    }
  });
}

init();
