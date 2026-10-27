// 像素办公室 —— 把「本机 + 所有远端代理」的会话聚合成一间会动的像素办公室。
//
// 设计参考 pixel-agents（参考，不是照抄），并把它那套概念落到本工具的真实数据上：
//   · 一个 Agent            = 一个会话（一张工位 / 一个小人）
//   · Office / Areas        = 按文件夹分区（会话的真实 cwd / 项目目录 = 一个房间）
//   · 角色 sprite + 调色板   = 每个 AI 工具一套配色（小人身上的衣服 = 工具品牌色）
//   · 头像 icon             = 小人头顶直接顶对应 AI 办公软件的 App 图标
//   · 座位 seat             = 工位固定（按会话 id 排序分配，刷新不会串位）
//   · 闲 / 忙的区分          = 闲的坐在工位上发呆（画淡）· 忙的在工位上干活（敲键盘/托下巴/翻工具）
//   · 活动三态（由会话文件最后一条记录的**类型**判定，不是编出来的）：
//       function_call（调用已发出、结果未回）= 调工具
//       function_call_result（结果已回、正在产出回答）= 书写
//       reasoning（尾部是思考块）= 阅读
//   · 语音气泡              = 等待输入 / 等待权限时冒气泡
// 数据每 5 秒拉一次；画面用 requestAnimationFrame 做插值，移动不会瞬移。
//
// 注意：Tauri 的 invoke 是**动态 import** 的，不是顶层 import。
// 顶层 import 会让整个模块在普通浏览器里加载失败（解析不到 '@tauri-apps/api/core'），
// 于是 office-preview.html 这个离线预览页在浏览器中直接白屏。
// 动态 import 只有真正调 defaultSource 时才需要 Tauri 环境 —— 而预览页会覆盖数据源，走不到那里。
import { ICON_ART } from './office-icons.js';

/* ============================ 数据源 ============================ */

async function defaultSource() {
  const { invoke } = await import('@tauri-apps/api/core');
  const d = new Date();
  const midnight = Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000);
  const local = await invoke('tool_activity', { todayStart: midnight, activeWindow: 300 }).catch(() => []);
  const proxies = await invoke('list_proxies').catch(() => []);
  const nodes = [{ name: '本机', online: true, tools: Array.isArray(local) ? local : [] }];
  (proxies || []).forEach((p) => {
    nodes.push({
      name: p.name || '远端',
      online: !!p.online,
      tools: (p.activity && p.activity.tools) || [],
      seen: p.last_seen || 0,
    });
  });
  return nodes;
}

let dataSource = defaultSource;
/** 允许外部注入数据源（离线预览 / 测试用）；传 null 恢复默认。 */
/// 调试出口：把当前场景的房间坐标与相机参数暴露给预览页（排版问题定位用）。
export function officeDebug() {
  return {
    zoom: state.zoom,
    ox: state.ox,
    oy: state.oy,
    scrollY: state.scrollY,
    W,
    H,
    sceneW: state.sceneW,
    sceneH: state.sceneH,
    areas: state.areas.map((a) => ({
      label: a.label,
      x: a.x,
      y: a.y,
      w: a.w,
      h: a.h,
      head: a.head || ROOM_PAD,
      rows: a.rows,
      cols: a.cols,
      agents: a.agents.length,
      screenLeft: Math.round(a.x * state.zoom + state.ox),
      screenTop: Math.round(a.y * state.zoom + state.oy - state.scrollY),
    })),
  };
}

export function setOfficeSource(fn) {  dataSource = fn || defaultSource;
}

/* ============================ 品牌 / 图标 ============================ */

// 配色以「对应 App 的真实图标」为准（本机 .icns 取样，勿凭印象改）：
//   WorkBuddy = 青绿 #00c090（不是蓝色！之前用蓝色是错的），Cursor = 近黑 #0e0e10
//   Claude = 陶土橙 #d97757，Codex / OpenAI = 黑白，MCP = 紫（官方无 App 图标，保留高区分度）
// art 字段指向 office-icons.js 里的真实 PNG，有就优先用官方图标当头像。
const BRANDS = {
  workbuddy: { label: 'WorkBuddy', bg: '#00bf8a', bg2: '#3ad9a8', glyph: 'w', shirt: '#0d9c75', light: '#45d5ac', art: 'workbuddy' },
  codex: { label: 'Codex', bg: '#0f1115', bg2: '#2b3039', glyph: 'hex', shirt: '#3c4250', light: '#6f788a' },
  'claude-code': { label: 'Claude Code', bg: '#d97757', bg2: '#efa98e', glyph: 'star', shirt: '#c96c4c', light: '#f0a98f' },
  cursor: { label: 'Cursor', bg: '#121317', bg2: '#2f3238', glyph: 'cube', shirt: '#3a3d45', light: '#70747d', art: 'cursor' },
  mcp: { label: 'MCP', bg: '#6a5bd6', bg2: '#9b8cf5', glyph: 'mcp', shirt: '#7263dd', light: '#a99bf5' },
};

const FALLBACK_COLORS = ['#3d9b86', '#b4783a', '#8b5fb0', '#c0554f', '#3f7fa8'];

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = (h ^ s.charCodeAt(i)) * 16777619;
  return h >>> 0;
}

function brandOf(id, name) {
  const hay = `${id || ''} ${name || ''}`.toLowerCase();
  if (hay.includes('workbuddy') || hay.includes('codebuddy')) return BRANDS.workbuddy;
  if (hay.includes('codex') || hay.includes('openai')) return BRANDS.codex;
  if (hay.includes('claude') || hay.includes('anthropic')) return BRANDS['claude-code'];
  if (hay.includes('cursor')) return BRANDS.cursor;
  if (hay.includes('mcp')) return BRANDS.mcp;
  const c = FALLBACK_COLORS[hashStr(hay) % FALLBACK_COLORS.length];
  return { label: name || id || 'AI', bg: c, bg2: shade(c, 0.28), glyph: 'letter', shirt: c, light: shade(c, 0.3) };
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (amt >= 0) {
    r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt;
  } else {
    r *= 1 + amt; g *= 1 + amt; b *= 1 + amt;
  }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function rr(g, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rad, y);
  g.arcTo(x + w, y, x + w, y + h, rad);
  g.arcTo(x + w, y + h, x, y + h, rad);
  g.arcTo(x, y + h, x, y, rad);
  g.arcTo(x, y, x + w, y, rad);
  g.closePath();
}

const iconCache = new Map();
const artImages = new Map();

// ---------- token 展示 ----------
// token 量级很大（单个会话几十万），用「万 / 亿」压缩。
function fmtTok(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return String(v);
}
function fmtRate(r) {
  const v = Number(r) || 0;
  return (v * 100).toFixed(v >= 0.1 ? 0 : 1) + '%';
}

// 预载真实 App 图标；加载完成后清掉对应缓存，下一帧就会换成官方图标。
Object.entries(ICON_ART).forEach(([key, src]) => {
  const img = new Image();
  const rec = { img, ready: false };
  img.onload = () => {
    rec.ready = true;
    iconCache.delete(key);
  };
  img.onerror = () => {
    rec.failed = true;
  };
  img.src = src;
  artImages.set(key, rec);
});

/** 把某个 AI 工具的 App 图标画成一张 64×64 的小图（真实图标优先，否则圆角方 + 品牌符号）。 */
function iconCanvas(brand) {
  const key = brand.art || brand.label + brand.bg + brand.glyph;
  if (iconCache.has(key)) return iconCache.get(key);
  const cv = document.createElement('canvas');
  cv.width = 64;
  cv.height = 64;
  const g = cv.getContext('2d');

  // ① 有官方 PNG 就直接用（头像 = 该 AI 软件的真实 icon，颜色天然一致）
  const art = brand.art ? artImages.get(brand.art) : null;
  if (art && art.ready) {
    g.save();
    rr(g, 2, 2, 60, 60, 14);
    g.clip();
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(art.img, 0, 0, 64, 64);
    g.restore();
    g.strokeStyle = 'rgba(255,255,255,0.16)';
    g.lineWidth = 1.5;
    rr(g, 3, 3, 58, 58, 13);
    g.stroke();
    iconCache.set(key, cv);
    return cv;
  }

  // ② 没有官方图标的工具：按品牌色合成一个圆角 App 图标
  const grad = g.createLinearGradient(0, 0, 64, 64);
  grad.addColorStop(0, brand.bg2);
  grad.addColorStop(1, brand.bg);
  g.fillStyle = grad;
  rr(g, 2, 2, 60, 60, 15);
  g.fill();

  // 顶部一层薄高光，像真 App 图标的塑料感
  g.save();
  rr(g, 2, 2, 60, 60, 15);
  g.clip();
  const gl = g.createLinearGradient(0, 0, 0, 34);
  gl.addColorStop(0, 'rgba(255,255,255,0.28)');
  gl.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gl;
  g.fillRect(0, 0, 64, 34);
  g.restore();

  g.strokeStyle = 'rgba(255,255,255,0.92)';
  g.fillStyle = 'rgba(255,255,255,0.96)';
  g.lineWidth = 5.4;
  g.lineCap = 'round';
  g.lineJoin = 'round';

  switch (brand.glyph) {
    case 'w': {
      // WorkBuddy：圆润的 W + 一颗小火花
      g.beginPath();
      g.moveTo(14, 22);
      g.lineTo(23, 45);
      g.lineTo(32, 29);
      g.lineTo(41, 45);
      g.lineTo(50, 22);
      g.stroke();
      g.beginPath();
      g.moveTo(48, 14);
      g.lineTo(48, 20);
      g.moveTo(45, 17);
      g.lineTo(51, 17);
      g.lineWidth = 2.6;
      g.stroke();
      break;
    }
    case 'hex': {
      // Codex / OpenAI 风格的花结：六片花瓣
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3 - Math.PI / 6;
        g.save();
        g.translate(32 + Math.cos(a) * 7.5, 32 + Math.sin(a) * 7.5);
        g.rotate(a);
        g.beginPath();
        g.ellipse(0, 0, 13.5, 6.2, 0, 0, Math.PI * 2);
        g.lineWidth = 3.4;
        g.stroke();
        g.restore();
      }
      break;
    }
    case 'star': {
      // Claude：放射状星芒
      for (let i = 0; i < 9; i++) {
        const a = (i * Math.PI * 2) / 9 - Math.PI / 2;
        const r1 = 6, r2 = i % 2 ? 17 : 21;
        g.lineWidth = i % 2 ? 3.6 : 5;
        g.beginPath();
        g.moveTo(32 + Math.cos(a) * r1, 32 + Math.sin(a) * r1);
        g.lineTo(32 + Math.cos(a) * r2, 32 + Math.sin(a) * r2);
        g.stroke();
      }
      break;
    }
    case 'cube': {
      // Cursor：等距立方体
      const top = [[32, 12], [51, 23], [32, 34], [13, 23]];
      const left = [[13, 23], [32, 34], [32, 54], [13, 43]];
      const right = [[51, 23], [32, 34], [32, 54], [51, 43]];
      const poly = (pts, fill) => {
        g.beginPath();
        pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.closePath();
        g.fillStyle = fill;
        g.fill();
      };
      poly(top, 'rgba(255,255,255,0.98)');
      poly(left, 'rgba(255,255,255,0.66)');
      poly(right, 'rgba(255,255,255,0.4)');
      break;
    }
    case 'mcp': {
      // MCP：节点 + 连线
      g.lineWidth = 4.2;
      g.beginPath();
      g.moveTo(20, 22);
      g.lineTo(44, 22);
      g.moveTo(32, 24);
      g.lineTo(32, 42);
      g.stroke();
      [[20, 22], [44, 22], [32, 44]].forEach(([x, y]) => {
        g.beginPath();
        g.arc(x, y, 6.4, 0, Math.PI * 2);
        g.fill();
      });
      break;
    }
    default: {
      const ch = (brand.label || 'A').trim().charAt(0).toUpperCase();
      g.font = '700 34px system-ui, -apple-system, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(ch, 32, 34);
    }
  }
  iconCache.set(key, cv);
  return cv;
}

/* ============================ 场景布局 ============================ */

const CELL_W = 62;
const CELL_H = 78;
// 房间顶部的留白（世界单位）：只用来给房间一点呼吸空间。
//
// 之前这里是给「房间名牌」预留的高度，而名牌是**固定屏幕高度**（22px，为了文字不糊）。
// 问题在于：画布坐标系随缩放变化，名牌却是固定像素 —— 房间一多、窗口一小，zoom 降下来，
// 同样的 22px 换算到世界里就变高，名牌必然溢出留白带、压到第一排小人的头和显示器上
// （用户截图里那块横跨工位、盖住小人的深色牌子就是这么来的）。
// 现在房间信息改成顶部 HTML「房间条」（不在画布里），结构上不可能遮住任何工位或小人，
// 这条留白也就退化成普通的排版留白。
const ROOM_PAD = 16;
const PAD = 16;
const AISLE = 34;
const GAP = 18;
const WALL_H = 46;
const SCENE_MAX_W = 1300;
// 工位锚点：小人“落座”的位置（桌面上沿），与 drawDesk 的桌面齐平
const SEAT_DY = 40;

const C = {
  void: '#151a24',
  wall: '#46516b',
  wallTop: '#5a6787',
  floor: '#e8d6b7',
  floorAlt: '#e2cfad',
  plank: 'rgba(150,118,78,0.15)',
  // 地毯用中性冷灰：WorkBuddy 是青绿图标，地毯要是也偏绿就会糊成一片
  rug: '#dee4ea',
  rugEdge: '#c4ccd6',
  deskTop: '#d29a63',
  deskEdge: '#a9764a',
  deskLeg: '#7c5029',
  bezel: '#242936',
  screen: '#1b3b46',
  plant: '#4f9b62',
  pot: '#c47049',
  text: '#eef2f9',
  sub: '#9aa8c0',
};

/* ---------- 房间分类：把「一房一人」的时间戳目录归并成可读的分区 ----------
 * WorkBuddy 每开一段对话就会建一个带时间戳的工作区目录（本机已 200+ 个），
 * 一个目录一间房会得到几十个单人房间 —— 又乱又多。默认按「月」把它们归并，
 * 也可以切「项目」（每个目录一间）/「工具」（一个 AI 工具一间大办公室）。 */
const GROUP_MODES = [
  { id: 'project', label: '项目', hint: '每个真实项目一间房（推荐：房间名就是项目名）' },
  { id: 'month', label: '月', hint: '时间戳工作区按月份归并（想按时间看活动时用）' },
  { id: 'tool', label: '工具', hint: '每个 AI 工具一间大办公室' },
];
let groupMode = (() => {
  try {
    const saved = localStorage.getItem('agentdesk.officeGroup');
    // 偏好版本号：v2 起默认档位是「项目」，房间名用的是真实项目名（不再是「2026年8月」这种日期）。
    // 旧偏好是在「房间名只有日期」的前提下选的，迁移一次到新默认；
    // 迁移之后用户自己选什么就尊重什么（版本号已到 2，不会再被改回）。
    const ver = parseInt(localStorage.getItem('agentdesk.officePrefsVer') || '0', 10) || 0;
    if (ver < 2) {
      localStorage.setItem('agentdesk.officePrefsVer', '2');
      return 'project';
    }
    if (GROUP_MODES.some((m) => m.id === saved)) return saved;
    return 'project';
  } catch (_) {
    return 'project';
  }
})();

/** 把顶栏「分类」分段按钮的选中态对齐到 groupMode（跨会话记住上次选择）。 */
function syncGroupButtons() {
  const box = document.getElementById('office-group');
  if (!box) return;
  box.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.group === groupMode));
}

// 这类目录名只是「容器名 + 时间戳」，本身没有项目语义 → 归并到月份
const GENERIC_WS = new Set([
  'workbuddy', 'chats', 'chat', 'sessions', 'session', 'desktop', 'documents',
  'downloads', 'tmp', 'temp', 'workspace', 'projects', 'code', 'untitled',
]);
// 房间数上限：超出的工作区合并为一间「其他」，保证一屏能看全
const MAX_ROOMS = 10;

/** 解析工作区目录名 → { raw, name, pure, hasDate, stamp, y, mo }。 */
function parseWs(ws) {
  const raw = (ws || '').trim();
  const s = raw.replace(/^Users-[^-]+-/, '').replace(/^[A-Za-z]:[\\/]/, '');
  const m = s.match(/(\d{4})-(\d{2})(?:-(\d{2}))?(?:[-_\s](\d{2})[-_:](\d{2}))?/);
  let name = s;
  let pure = false;
  if (m) {
    const cut = s.slice(0, m.index).replace(/[-_\s]+$/, '');
    if (cut) name = cut;
    else {
      name = '';
      pure = true;
    }
  }
  // 目录名里的「月-日 时:分」，用于给同名的工作区（如一堆 WorkBuddy-2026-08-10-…）区分标签
  const stamp = m
    ? `${m[2]}-${m[3] || '01'}${m[4] ? ` ${m[4]}:${m[5] || '00'}` : ''}`
    : '';
  return {
    raw,
    name,
    pure,
    hasDate: !!m,
    stamp,
    y: m ? Number(m[1]) : 0,
    mo: m ? Number(m[2]) : 0,
  };
}

function prettyWs(ws) {
  const p = parseWs(ws);
  let s = p.name || (ws || '').trim() || '未命名工作区';
  if (/^subagents$/i.test(s)) s = '子代理';
  // 「WorkBuddy-agentry」这种容器名 + 项目名：去掉容器前缀，只留项目名
  s = s.replace(/^workbuddy[-_](?=.)/i, '');
  // 容器名（WorkBuddy 等）本身没有项目语义：只用目录里的时间戳，避免出现一堆同名的「WorkBuddy」
  if (p.stamp && (!p.name || GENERIC_WS.has(p.name.toLowerCase()))) s = p.stamp;
  if (!s) s = '未命名工作区';
  return s.length > 18 ? `${s.slice(0, 17)}…` : s;
}

/** 某个会话落在哪间房 → { key, label, kind }。 */
function groupOf(ws, brandLabel, project) {
  if (groupMode === 'tool') return { key: `t:${brandLabel}`, label: brandLabel, kind: 'tool' };
  const p = parseWs(ws);
  // 「月」＝纯粹的时间桶（想按时间看活动时用），不掺项目名，保持这一档语义单一。
  if (groupMode === 'month') {
    if (p.y && (p.pure || GENERIC_WS.has(p.name.toLowerCase()))) {
      return { key: `m:${p.y}-${p.mo}`, label: `${p.y}年${p.mo}月`, kind: 'month' };
    }
    // 有真实项目名的，直接按项目分房（比日期有信息量得多）
    const real = (project || '').trim();
    if (real) return { key: `p:${real.toLowerCase()}`, label: real, kind: 'project' };
    return { key: `p:${p.raw || '∅'}`, label: prettyWs(ws), kind: 'project' };
  }
  // 「项目」：优先用后端算好的真实项目名（用户自定义显示名 / 项目目录名）。
  // 没有它就只能落到「2026年8月」「18」这种日期或数字房间名 —— 用户完全看不懂。
  const real = (project || '').trim();
  if (real) return { key: `p:${real.toLowerCase()}`, label: real, kind: 'project' };
  return { key: `p:${p.raw || '∅'}`, label: prettyWs(ws), kind: 'project' };
}

function relTime(sec) {
  if (!sec) return '';
  const s = Math.floor(Date.now() / 1000) - sec;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

// 「仅活跃」：只保留正在工作 / 最近 1 小时有活动的会话，人多时用来降噪
let activeOnly = false;
const ACTIVE_WINDOW = 3600;

function keepSession(s) {
  if (!activeOnly) return true;
  if (s.busy) return true;
  const last = Number(s.last) || 0;
  return last > 0 && Math.floor(Date.now() / 1000) - last < ACTIVE_WINDOW;
}

/** head = 房间顶部留白高度（世界单位，给房间一点呼吸空间）。 */
function buildAreas(nodes, availW, availH, head = ROOM_PAD) {
  const map = new Map();
  (nodes || []).forEach((node) => {
    if (!node.online) return;
    (node.tools || []).forEach((tool) => {
      const brand = brandOf(tool.connector, tool.name);
      (tool.recent || []).filter(keepSession).forEach((s) => {
        const g = groupOf(s.workspace, brand.label, s.project);
        const key = `${node.name}|${g.key}`;
        const remote = node.name && node.name !== '本机';
        let a = map.get(key);
        if (!a) {
          a = {
            key,
            node: node.name,
            ws: s.workspace || '',
            // 远端房间把机器名并进名牌，避免牌外再挂一个 chip 压到隔壁房间的名牌
            label: remote ? `${node.name} · ${g.label}` : g.label,
            kind: g.kind,
            icon: g.kind === 'tool' ? iconCanvas(brand) : null,
            agents: [],
          };
          map.set(key, a);
        }
        a.agents.push({
          key: `${key}|${tool.connector}|${s.id}`,
          connector: tool.connector,
          toolName: tool.name,
          s,
          brand,
        });
      });
    });
  });

  let areas = [...map.values()];
  // 房间排序：有活儿的在前、人多的在前 —— 第一眼先看到正在干活的房间
  areas.forEach((a) => {
    a.busy = a.agents.filter((x) => x.s.busy).length;
  });
  areas.sort((a, b) => b.busy - a.busy || b.agents.length - a.agents.length || a.label.localeCompare(b.label, 'zh'));

  // 房间数上限：超出的工作区合并成一间「其他」，不让人数消失、也不让地板铺满小房间
  let mergedRooms = 0;
  if (areas.length > MAX_ROOMS) {
    const tail = areas.slice(MAX_ROOMS - 1);
    mergedRooms = tail.length;
    const extra = {
      key: 'other',
      node: '',
      ws: '',
      label: `其他 ${tail.length} 个工作区`,
      kind: 'project',
      icon: null,
      agents: [],
    };
    tail.forEach((a) => extra.agents.push(...a.agents));
    areas = areas.slice(0, MAX_ROOMS - 1).concat([extra]);
  }

  const MAX_COLS = 6;
  areas.forEach((a) => {
    // 同房间内先按工具分组、再按会话 id 固定排序 → 座位稳定，刷新不会串位
    a.agents.sort((x, y) => x.connector.localeCompare(y.connector) || x.s.id.localeCompare(y.s.id));
    // 房间的 token 汇总（名牌下方显示）：只统计带 usage 的会话
    a.tokens = a.agents.reduce(
      (acc, ag) => {
        const u = ag.s.tokens;
        if (u) {
          acc.input += Number(u.input) || 0;
          acc.output += Number(u.output) || 0;
          acc.cache_read += Number(u.cache_read) || 0;
          acc.count += 1;
        }
        return acc;
      },
      { input: 0, output: 0, cache_read: 0, count: 0 },
    );
    const n = Math.max(a.agents.length, 1);
    a.cols = Math.min(MAX_COLS, Math.max(1, Math.ceil(Math.sqrt(n * 1.6))));
    a.rows = Math.ceil(n / a.cols);
    // 右侧多留 12px 给工具柜，避免柜子压到最后一台桌子的显示器
    a.head = head;
    a.w = PAD * 2 + a.cols * CELL_W + 12;
    a.h = head + a.rows * CELL_H + AISLE;
    a.seats = a.agents.map((ag, i) => {
      const col = i % a.cols;
      const row = Math.floor(i / a.cols);
      const cellTop = head + row * CELL_H;
      const cx = PAD + col * CELL_W + CELL_W / 2;
      return { cx, cellTop, col, row };
    });
    a.aisleY = head + a.rows * CELL_H + 14;
    a.rackX = a.w - 20;
  });

  // 公共休息区（沙发 / 茶几 / 饮水机 / 绿植）：只画装饰，没有人，用来把空间填满
  const lounge = { w: 196, h: 150, lounge: true };
  const items = [...areas, lounge];

  // 排布：逐个试「每行几个」，挑缩放最大（最饱满）的那种，避免房间被压成指甲盖、
  // 也避免所有房间挤成一条细带子导致上下大片空白。
  const aw = Math.max(360, (availW || 900) - 40);
  const ah = Math.max(220, (availH || 600) - WALL_H - 24);
  let best = null;
  for (let k = 1; k <= items.length; k++) {
    const packed = packItems(items, k);
    const z = Math.min(aw / packed.w, ah / packed.h, 1.8);
    if (!best || z > best.z + 0.002) best = { ...packed, z };
  }
  const chosen = best || packItems(items, 3);
  // 把选中的坐标写回（packItems 只算坐标，不改对象 —— 否则会拿到最后一次试排的位置）
  items.forEach((it, i) => {
    it.x = chosen.pos[i].x;
    it.y = chosen.pos[i].y;
  });
  return { areas, lounge, mergedRooms, sceneW: chosen.w, sceneH: chosen.h };
}

/** 只计算坐标，不修改传入对象：返回每个条目的 x/y 与整体包围盒。每行居中，避免右侧一大片空地板。 */
function packItems(items, perRow) {
  const rows = [];
  for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow));
  const rowW = rows.map((r) => r.reduce((s, a) => s + a.w, 0) + GAP * Math.max(0, r.length - 1));
  const w = Math.max(320, Math.max(0, ...rowW) + GAP * 2);
  const pos = [];
  let y = GAP;
  rows.forEach((r, ri) => {
    let x = (w - rowW[ri]) / 2;
    let rowH = 0;
    r.forEach((a) => {
      pos.push({ x: Math.round(x), y });
      x += a.w + GAP;
      rowH = Math.max(rowH, a.h);
    });
    y += rowH + GAP;
  });
  return { pos, w, h: Math.max(200, y) };
}

/* ============================ 静态图层（地板 / 墙 / 工位 / 装饰） ============================ */

let scene = null;
let sceneSS = 2;

/**
 * 房间肉眼看到的那块地毯（世界坐标）。
 * 「房间矩形」a.x/a.w 比地毯大：顶部有 head 留白、底部留出 AISLE 的过道（绿植 / 工具柜在那儿），
 * 所以悬停高亮必须用**地毯矩形**而不是房间矩形 —— 否则虚线框会明显大出房间一圈。
 * 画地毯和高亮都走这里，两个矩形不可能各走一条可能对不上的线。
 */
function roomCarpet(a) {
  const head = a.head || ROOM_PAD;
  return { x: a.x + 4, y: a.y + head - 6, w: a.w - 8, h: a.h - head - AISLE + 6 };
}

/** 分区地毯：一整间办公室里，一个「Areas」就是一块地毯 + 一排工位。 */
function drawZone(g, a) {
  const { x: rx, y: ry, w: rw, h: rh } = roomCarpet(a);

  g.fillStyle = 'rgba(105,80,50,0.10)';
  rr(g, rx + 2, ry + 3, rw, rh, 10);
  g.fill();

  g.fillStyle = C.rugEdge;
  rr(g, rx, ry, rw, rh, 9);
  g.fill();
  g.fillStyle = C.rug;
  rr(g, rx + 3, ry + 3, rw - 6, rh - 6, 7);
  g.fill();

  // 地毯纹理：细横线，避免大片纯色
  g.fillStyle = 'rgba(120,140,105,0.10)';
  for (let y = ry + 8; y < ry + rh - 6; y += 7) {
    g.fillRect(rx + 6, y, rw - 12, 1);
  }
}

function drawPlant(g, x, y) {
  g.fillStyle = 'rgba(0,0,0,0.12)';
  g.beginPath();
  g.ellipse(x + 6, y + 20, 9, 3.2, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = C.pot;
  g.fillRect(x, y + 10, 13, 10);
  g.fillStyle = shade(C.pot, -0.2);
  g.fillRect(x, y + 17, 13, 3);
  g.fillStyle = C.plant;
  g.fillRect(x + 4, y - 2, 5, 12);
  g.fillRect(x - 1, y + 2, 6, 8);
  g.fillRect(x + 8, y + 1, 6, 9);
  g.fillStyle = shade(C.plant, 0.22);
  g.fillRect(x + 4, y - 2, 2, 5);
  g.fillRect(x + 9, y + 1, 2, 4);
}

/** 公共休息区：沙发 / 茶几 / 书架 / 饮水机 / 绿植。只装饰，不坐人。 */
function drawLounge(g, x, y, w, h) {
  // 地毯铺满整块公共区：跟房间地毯同款但偏暖，看着是「一间休息室」而不是散落的道具
  g.fillStyle = 'rgba(105,80,50,0.10)';
  rr(g, x + 8, y + 10, w - 12, h - 12, 10);
  g.fill();
  g.fillStyle = '#cdbfa6';
  rr(g, x + 4, y + 5, w - 8, h - 10, 10);
  g.fill();
  g.fillStyle = '#e9e0cd';
  rr(g, x + 7, y + 8, w - 14, h - 16, 8);
  g.fill();
  g.fillStyle = 'rgba(120,100,70,0.10)';
  for (let yy = y + 14; yy < y + h - 16; yy += 8) g.fillRect(x + 12, yy, w - 24, 1);

  // 书架（左上）
  g.fillStyle = '#8a6440';
  rr(g, x + 14, y + 18, 40, 40, 3);
  g.fill();
  g.fillStyle = '#6f4d30';
  g.fillRect(x + 17, y + 22, 34, 14);
  g.fillRect(x + 17, y + 40, 34, 14);
  const books = ['#cf6b57', '#5b8dc9', '#e0b25a', '#6ba97b', '#b06aa8'];
  books.forEach((c, i) => {
    g.fillStyle = c;
    g.fillRect(x + 19 + i * 6.5, y + 24, 5, 10);
    g.fillRect(x + 19 + ((i + 2) % 5) * 6.5, y + 42, 5, 10);
  });

  // 饮水机（右上）
  g.fillStyle = '#cfd6e2';
  rr(g, x + w - 44, y + 22, 20, 32, 2);
  g.fill();
  g.fillStyle = '#8fc7e8';
  rr(g, x + w - 41, y + 9, 14, 15, 4);
  g.fill();
  g.fillStyle = '#9aa3b4';
  g.fillRect(x + w - 40, y + 34, 12, 3);
  g.fillStyle = '#5b6478';
  g.fillRect(x + w - 34, y + 38, 2, 6);

  // 沙发（居中偏下）
  const sw = 96;
  const sx = Math.round(x + (w - sw) / 2);
  const sy = y + h - 78;
  g.fillStyle = 'rgba(70,52,32,0.16)';
  rr(g, sx + 2, sy + 6, sw, 34, 8);
  g.fill();
  g.fillStyle = '#6d7d99';
  rr(g, sx, sy, sw, 34, 8); // 靠背
  g.fill();
  g.fillStyle = '#8292ad';
  rr(g, sx + 3, sy + 11, sw - 6, 22, 6); // 坐垫
  g.fill();
  g.fillStyle = '#5c6b85';
  rr(g, sx + 2, sy + 4, 12, 30, 5); // 扶手
  g.fill();
  rr(g, sx + sw - 14, sy + 4, 12, 30, 5);
  g.fill();
  g.fillStyle = '#94a3bc';
  g.fillRect(sx + 16, sy + 13, 28, 15);
  g.fillRect(sx + sw - 44, sy + 13, 28, 15);

  // 茶几 + 咖啡
  g.fillStyle = '#a9764a';
  rr(g, x + 70, y + h - 34, 56, 20, 4);
  g.fill();
  g.fillStyle = '#c98f5b';
  rr(g, x + 72, y + h - 36, 52, 10, 4);
  g.fill();
  g.fillStyle = '#fdfbf3';
  g.fillRect(x + 80, y + h - 34, 5, 5);
  g.fillRect(x + 96, y + h - 34, 5, 5);
  g.fillStyle = '#8a5f3a';
  g.fillRect(x + 110, y + h - 34, 8, 6);

  // 绿植 + 落地灯
  drawPlant(g, x + w - 26, y + h - 40);
  g.fillStyle = '#4b5468';
  g.fillRect(x + 16, y + h - 54, 3, 30);
  g.fillStyle = '#f2d98d';
  rr(g, x + 9, y + h - 66, 17, 14, 4);
  g.fill();
}

function drawRack(g, a) {
  // 工具柜：正在「调工具」的小人会跑到这里
  const x = a.x + a.rackX;
  const y = a.y + (a.head || ROOM_PAD) + 6;
  g.fillStyle = '#5b6478';
  rr(g, x, y, 14, 38, 3);
  g.fill();
  g.fillStyle = '#464e60';
  g.fillRect(x + 2, y + 3, 10, 9);
  g.fillRect(x + 2, y + 15, 10, 9);
  g.fillRect(x + 2, y + 27, 10, 8);
  g.fillStyle = '#8fd6c4';
  g.fillRect(x + 5, y + 6, 4, 3);
  g.fillStyle = '#e8b96a';
  g.fillRect(x + 5, y + 18, 4, 3);
  g.fillStyle = '#c58fdc';
  g.fillRect(x + 5, y + 30, 4, 3);
}

function drawDesk(g, a, seat, idx) {
  const cx = a.x + seat.cx;
  const topY = a.y + seat.cellTop + SEAT_DY; // 桌面上沿，与小人落座锚点齐平
  // 落地影子
  g.fillStyle = 'rgba(90,66,40,0.14)';
  g.beginPath();
  g.ellipse(cx, topY + 20, 27, 7, 0, 0, Math.PI * 2);
  g.fill();
  // 桌腿
  g.fillStyle = C.deskLeg;
  g.fillRect(cx - 21, topY + 6, 4, 13);
  g.fillRect(cx + 17, topY + 6, 4, 13);
  // 桌身
  g.fillStyle = C.deskEdge;
  g.fillRect(cx - 24, topY, 48, 9);
  g.fillStyle = C.deskTop;
  g.fillRect(cx - 24, topY - 3, 48, 6);
  g.fillStyle = shade(C.deskTop, 0.22);
  g.fillRect(cx - 24, topY - 3, 48, 1);

  // 显示器（桌面左侧 —— 让开中间的头像，人坐中间、屏在左手边）
  const mx = cx - 22;
  const my = topY - 20;
  g.fillStyle = C.bezel;
  rr(g, mx, my, 18, 16, 2);
  g.fill();
  g.fillStyle = C.screen;
  g.fillRect(mx + 2, my + 2, 14, 11);
  // 屏幕上的「代码行」
  const lines = [[3, 5], [5, 4], [3, 7], [6, 3], [4, 5]];
  lines.forEach(([ox, w], i) => {
    g.fillStyle = i % 3 === 0 ? 'rgba(140,230,200,0.9)' : 'rgba(150,190,240,0.55)';
    g.fillRect(mx + 3 + (i % 2 ? 2 : 0), my + 3 + i * 2, w, 1);
  });
  g.fillStyle = C.bezel;
  g.fillRect(mx + 7, my + 16, 4, 3);
  g.fillRect(mx + 3, my + 19, 14, 2);

  // 键盘 / 纸 / 杯子（桌面右侧，正对坐下的手）
  g.fillStyle = '#cfd6e2';
  g.fillRect(cx + 4, topY + 3, 18, 3);
  g.fillStyle = '#f4f0e6';
  g.fillRect(cx + 5, topY - 5, 12, 7);
  g.fillStyle = 'rgba(120,120,140,0.5)';
  g.fillRect(cx + 7, topY - 3, 8, 1);
  g.fillRect(cx + 7, topY - 1, 6, 1);
  if ((seat.col + seat.row) % 3 === 1) {
    g.fillStyle = '#e0705a';
    g.fillRect(cx + 19, topY - 8, 5, 6);
    g.fillStyle = '#fff';
    g.fillRect(cx + 19, topY - 8, 5, 1);
  }
}

function renderStatic() {
  // 超采样：小场景 2× 保证像素边缘锐利；房间很多时降到 1×，
  // 避免 2600×6000 的离屏画布吃掉几十 MB 显存（人多时内存比锐利更重要）
  const ss = state.sceneW * state.sceneH > 1600000 ? 1 : 2;
  sceneSS = ss;
  scene = document.createElement('canvas');
  scene.width = Math.max(1, Math.round(state.sceneW * ss));
  scene.height = Math.max(1, Math.round(state.sceneH * ss));
  const g = scene.getContext('2d');
  g.scale(ss, ss);
  g.imageSmoothingEnabled = false;

  state.areas.forEach((a) => {
    drawZone(g, a);
    a.seats.forEach((seat, i) => drawDesk(g, a, seat, i));
    drawPlant(g, a.x + 6, a.y + a.h - 24);
    drawPlant(g, a.x + a.w - 18, a.y + a.h - 24);
    drawRack(g, a);
  });
  if (state.lounge) {
    drawLounge(g, state.lounge.x, state.lounge.y, state.lounge.w, state.lounge.h);
  }
}

/* ---------- 背景（整间办公室的木地板 + 顶墙，屏幕坐标，尺寸变化才重绘） ---------- */
let bg = null;
let bgW = 0;
let bgH = 0;

function renderBackground() {
  if (bg && bgW === W && bgH === H) return;
  bg = document.createElement('canvas');
  bg.width = Math.max(1, Math.floor(W * dpr));
  bg.height = Math.max(1, Math.floor(H * dpr));
  const g = bg.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.imageSmoothingEnabled = false;

  // 木地板
  g.fillStyle = C.floor;
  g.fillRect(0, 0, W, H);
  const plankH = 26;
  for (let y = WALL_H, row = 0; y < H; y += plankH, row++) {
    // 每行木板的冷暖/明暗略有差别
    const k = (row * 2654435761) >>> 0;
    g.fillStyle = k % 3 === 0 ? C.floorAlt : k % 7 === 0 ? '#ecdcc0' : C.floor;
    g.fillRect(0, y, W, plankH);
    g.fillStyle = C.plank;
    g.fillRect(0, y, W, 1);
    const off = (k % 120) + 30;
    for (let x = off; x < W; x += 124) {
      g.fillRect(x, y, 1, plankH);
    }
  }

  // 顶部墙面 + 窗（光从上方打进来）
  g.fillStyle = C.wall;
  g.fillRect(0, 0, W, WALL_H);
  g.fillStyle = C.wallTop;
  g.fillRect(0, 0, W, 6);
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(0, WALL_H - 3, W, 3);
  for (let x = 90; x < W - 60; x += 300) {
    const ww = 96, wh = 30, wy = 9;
    g.fillStyle = '#8fc7e8';
    rr(g, x, wy, ww, wh, 4);
    g.fill();
    const sky = g.createLinearGradient(0, wy, 0, wy + wh);
    sky.addColorStop(0, 'rgba(190,232,255,0.95)');
    sky.addColorStop(1, 'rgba(122,186,220,0.9)');
    g.fillStyle = sky;
    rr(g, x + 2, wy + 2, ww - 4, wh - 4, 3);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fillRect(x + 8, wy + 7, 26, 3);
    g.fillStyle = C.wallTop;
    g.fillRect(x + ww / 2 - 1, wy, 2, wh);
  }

  // 墙面投到地板上的光
  const glow = g.createLinearGradient(0, WALL_H, 0, WALL_H + 220);
  glow.addColorStop(0, 'rgba(255,246,214,0.30)');
  glow.addColorStop(1, 'rgba(255,246,214,0)');
  g.fillStyle = glow;
  g.fillRect(0, WALL_H, W, 220);

  // 四周压暗一点，画面不至于发飘
  const vig = g.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.25, W / 2, H * 0.5, Math.max(W, H) * 0.78);
  vig.addColorStop(0, 'rgba(24,18,10,0)');
  vig.addColorStop(1, 'rgba(24,18,10,0.22)');
  g.fillStyle = vig;
  g.fillRect(0, 0, W, H);

  bgW = W;
  bgH = H;
}

/* ============================ 小人绘制 ============================ */

const ACT_LABEL = { writing: '书写', thinking: '阅读', tooling: '调工具', waiting: '等待', idle: '闲坐' };
// 活动对应的强调色（与底部图例的 lg-dot 同色）：头顶小色点 + 忙碌光环用它，一眼看出在干嘛
const ACT_PIP = { writing: '#4a7df0', thinking: '#8f7bd8', tooling: '#e0a24a', waiting: '#f2c14e' };

// 画一个人。**「闲人画淡」的 save/restore 放在外层 wrapper 里，不放在函数体内**：
// 之前 save() 在体首、restore() 在体尾，而「坐着」那条分支在中途 `return`
// —— 每画一个坐着的闲人就漏一次 restore()，画布状态栈一帧涨几十层。
// 后果不只是那十几个人没变淡：draw() 末尾那次 restore() 弹回的是更早压进去的
// 世界坐标变换，于是「悬停房间的高亮框」被又平移缩放了一次 ——
// 看起来就是虚线框飘去了别的地方（这是用户看到的那个 bug 的根因）。
function drawPerson(g, st, t, lod) {
  const act = st.agent.s.busy ? st.agent.s.act : 'idle';
  if (act !== 'idle') {
    paintPerson(g, st, t, lod, act);
    return;
  }
  g.save();
  g.globalAlpha = 0.62;
  try {
    paintPerson(g, st, t, lod, act);
  } finally {
    g.restore();
  }
}

function paintPerson(g, st, t, lod, act) {
  const b = st.agent.brand;
  const s = st.agent.s;
  const x = Math.round(st.x);
  const y = Math.round(st.y);
  const bob = Math.round(Math.sin(t / 260 + st.phase) * 1);
  const moving = st.moving;

  if (st.seated) {
    // 坐着：只画上半身，落座在桌面上沿，腿被桌子挡住；头顶图标露在显示器上方
    const baseY = y + bob;
    // 身体（胸口以下被桌面挡住，只露上半身）
    g.fillStyle = b.shirt;
    g.fillRect(x - 7, baseY - 15, 15, 14);
    g.fillStyle = b.light;
    g.fillRect(x - 7, baseY - 15, 15, 2);
    g.fillStyle = shade(b.shirt, -0.2);
    g.fillRect(x - 7, baseY - 2, 15, 2);
    // 手臂搭到桌面 / 键盘（远景简化成两条短臂）
    g.fillStyle = b.light;
    if (lod) {
      g.fillRect(x - 11, baseY - 10, 3, 6);
      g.fillRect(x + 8, baseY - 10, 3, 6);
    } else if (act === 'writing') {
      const tap = Math.sin(t / 90) > 0 ? 1 : 0;
      g.fillRect(x - 12, baseY - 11 + tap, 4, 8);
      g.fillRect(x + 8, baseY - 11 - tap, 4, 8);
    } else if (act === 'thinking') {
      g.fillRect(x - 12, baseY - 11, 4, 7);
      g.fillRect(x + 7, baseY - 15, 4, 7);
    } else if (act === 'tooling') {
      // 坐在工位上调工具：手在抽屉/工具盒里翻找（左右交替上下动）
      const dig = Math.sin(t / 130 + st.phase) > 0 ? 1 : 0;
      g.fillRect(x - 12, baseY - 11 + dig, 4, 7);
      g.fillRect(x + 8, baseY - 11 - dig, 4, 7);
    } else if (act === 'waiting') {
      g.fillRect(x - 12, baseY - 11, 4, 7);
      g.fillRect(x + 8, baseY - 11, 4, 7);
    } else if (act === 'idle') {
      // 闲人坐在工位上：身体有**呼吸起伏**，偶尔换个姿势（托腮 ↔ 搭手）。
      // 生动感靠身体微动给，不靠位移 —— 这样工位永远整齐，「谁在忙」一眼可见。
      const breathe = Math.sin(t / 620 + st.phase) > 0 ? 1 : 0;
      const lean = Math.sin(t / 700 + st.phase) > 0.6 ? 1 : 0;
      g.fillRect(x - 12, baseY - 11 - breathe, 4, 7);
      g.fillRect(x + 7, baseY - (lean ? 14 : 11), 4, 7 - (lean ? 0 : 3));
    } else {
      g.fillRect(x - 12, baseY - 11, 4, 7);
      g.fillRect(x + 8, baseY - 11, 4, 7);
    }
    drawIconHead(g, x, baseY - 31, b, act, t, st);
    return;
  }

  // 站着 / 走路 / 奔跑
  const walking = moving ? Math.sin(t / 110 + st.phase) : 0;
  const legOff = Math.round(walking * 2);
  g.fillStyle = 'rgba(60,45,30,0.18)';
  g.beginPath();
  g.ellipse(x, y + 2, 9, 3, 0, 0, Math.PI * 2);
  g.fill();

  // 腿
  g.fillStyle = '#3b4660';
  g.fillRect(x - 6, y - 10, 5, 8 + legOff);
  g.fillRect(x + 1, y - 10, 5, 8 - legOff);
  g.fillStyle = '#232a3a';
  g.fillRect(x - 7, y - 3 + legOff, 7, 3);
  g.fillRect(x + 1, y - 3 - legOff, 7, 3);

  // 身体
  const bodyTop = y - 23 + bob;
  g.fillStyle = b.shirt;
  g.fillRect(x - 7, bodyTop, 14, 14);
  g.fillStyle = b.light;
  g.fillRect(x - 7, bodyTop, 14, 2);
  g.fillStyle = shade(b.shirt, -0.2);
  g.fillRect(x - 7, bodyTop + 12, 14, 2);

  // 手臂
  g.fillStyle = b.light;
  if (act === 'tooling') {
    g.fillRect(x - 11, bodyTop + 3, 4, 7);
    g.fillRect(x + 7, bodyTop + 5, 4, 7);
  } else if (act === 'thinking') {
    g.fillRect(x - 11, bodyTop + 4, 4, 6);
    g.fillRect(x + 7, bodyTop + 1, 4, 6);
  } else {
    const sw = moving ? Math.round(walking * 2) : 0;
    g.fillRect(x - 11, bodyTop + 4 + sw, 4, 7);
    g.fillRect(x + 7, bodyTop + 4 - sw, 4, 7);
  }
  drawIconHead(g, x, y - 40 + bob, b, act, t, st);

  // 奔跑：脚下的尘土（远景省略）
  if (act === 'tooling' && moving && !lod) {
    for (let i = 0; i < 3; i++) {
      const p = ((t / 240 + i / 3) % 1);
      g.fillStyle = `rgba(210,190,160,${0.5 * (1 - p)})`;
      g.fillRect(x - 10 - p * 10, y - 1 - p * 3, 2, 2);
    }
  }
}

function drawIconHead(g, x, topY, brand, act, t, st, size = 16) {
  const bob = act === 'tooling' ? Math.round(Math.sin(t / 90 + st.phase) * 1) : 0;
  const ix = Math.round(x - size / 2);
  const iy = Math.round(topY) + bob;

  // 正在工作：**不画光环 / 光圈**。
  // 之前版本在头上套一圈暖色描边环 + 一层外发光，实测有两个问题：
  //   ① 环画在「头像」上、离子还有距离，看上去像一圈和人对不上位的悬浮光圈；
  //   ② 一圈亮环盖住头像轮廓，人多时整排都是黄圈，反而看不出谁在干嘛。
  // 忙闲的区分交给姿态（敲键盘 / 托下巴 / 翻工具柜）与「闲人画得更淡」，
  // 这里只留一个头顶的小实心色点跟活动类型对应（书写/阅读/调工具，与底部图例同色）。
  if (st.agent.s.busy && ACT_PIP[act]) {
    g.save();
    g.fillStyle = ACT_PIP[act];
    g.beginPath();
    g.arc(x, iy - 5, 2.6, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }

  g.save();
  g.imageSmoothingEnabled = true;
  g.drawImage(iconCanvas(brand), ix, iy, size, size);
  g.restore();

  // 头框：1px 描边让图标像"脑袋"，而不是一张贴纸
  g.strokeStyle = 'rgba(38,30,22,0.34)';
  g.lineWidth = 1;
  rr(g, ix + 0.5, iy + 0.5, size - 1, size - 1, 4);
  g.stroke();

  // 脖子（图标下沿与身体之间的 2px 深色，避免头身连成一块）
  g.fillStyle = 'rgba(60,45,32,0.22)';
  g.fillRect(x - 3, iy + size, 6, 1);

  // 等待气泡
  if (act === 'waiting') drawBubble(g, x, iy, t, st);
}

function drawBubble(g, x, topY, t, st) {
  const w = 22, h = 14;
  const bx = Math.round(x - w / 2);
  const by = Math.round(topY - h - 5 + Math.sin(t / 320 + st.phase) * 1);

  g.fillStyle = 'rgba(20,26,38,0.18)';
  rr(g, bx + 1, by + 2, w, h, 4);
  g.fill();
  g.fillStyle = '#fdfbf3';
  g.strokeStyle = '#2b3242';
  g.lineWidth = 2;
  rr(g, bx, by, w, h, 4);
  g.fill();
  g.stroke();
  // 像素尾巴
  g.fillStyle = '#fdfbf3';
  g.fillRect(x - 2, by + h - 1, 5, 3);
  g.fillRect(x - 1, by + h + 2, 3, 2);
  g.strokeStyle = '#2b3242';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x - 3, by + h - 1);
  g.lineTo(x - 1, by + h + 4);
  g.lineTo(x + 4, by + h - 1);
  g.stroke();

  // 三点跳动
  const active = Math.floor(t / 260) % 3;
  for (let i = 0; i < 3; i++) {
    const on = i === active;
    g.fillStyle = on ? '#3d4a63' : '#c3c9d6';
    const dy = on ? -2 : 0;
    g.fillRect(bx + 6 + i * 4, by + 6 + dy, 3, 3);
  }
}

/* ============================ 运行时状态 ============================ */

const state = {
  nodes: [],
  areas: [],
  lounge: null,
  mergedRooms: 0,
  agents: new Map(),
  sceneW: 0,
  sceneH: 0,
  zoom: 1,
  ox: 0,
  oy: 0,
  scrollY: 0,
  hover: null,
  // 顶部房间条上正在悬停的房间 key（悬停在 chip 上时给对应房间描一个高亮框，
  // 用来代替「画在画布里的名牌」建立「名字 ↔ 房间」的对应关系）
  hoverRoom: null,
  mouse: { x: 0, y: 0 },
  spawnAt: 0,
};

let canvas = null;
let ctx = null;
let stage = null;
let tipEl = null;
let dpr = 1;
let W = 0, H = 0;
let officeOpen = false;
let dataTimer = null;
let rafId = null;
let lastFrame = 0;

// 轻量运行指标（DevTools 里 `__officePerf()` 可查；用于确认「人多也不卡」）
const perf = { agents: 0, drawn: 0, plates: 0, frames: 0, ms: 0 };
if (typeof window !== 'undefined') {
  window.__officePerf = () => ({
    ...perf,
    msAvg: +perf.ms.toFixed(2),
    fps: perf.ms > 0 ? Math.round(1000 / Math.max(perf.ms, 1)) : 0,
    zoom: +state.zoom.toFixed(2),
    rooms: state.areas.length,
    online: state.nodes.filter((n) => n.online).length,
  });
  // DevTools 里 `__officeDebug()` 可查画面几何（相机 + 每个房间的世界坐标），
  // 用来核对「房间高亮框有没有对准房间」这类坐标换算问题。
  window.__officeDebug = () => ({
    W, H, dpr,
    zoom: state.zoom, ox: state.ox, oy: state.oy, scrollY: state.scrollY,
    sceneW: state.sceneW, sceneH: state.sceneH,
    hoverRoom: state.hoverRoom,
    canvas: canvas ? [canvas.getBoundingClientRect().x, canvas.getBoundingClientRect().y, canvas.width, canvas.height] : null,
    areas: state.areas.map((a) => {
      const car = roomCarpet(a);
      return {
        key: a.key, label: a.label,
        x: a.x, y: a.y, w: a.w, h: a.h, n: a.agents.length,
        // 期望的屏幕坐标（CSS 像素，相对画布左上角）：房间高亮框应当正好落在这里
        sx: car.x * state.zoom + state.ox,
        sy: car.y * state.zoom + state.oy - state.scrollY,
        sw: car.w * state.zoom,
        sh: car.h * state.zoom,
      };
    }),
  });
}

function syncAgents(areas, nowMs) {
  const seen = new Set();
  areas.forEach((a) => {
    a.agents.forEach((ag, i) => {
      seen.add(ag.key);
      const seat = a.seats[i];
      let st = state.agents.get(ag.key);
      if (!st) {
        st = {
          // 初始位置在**自己的工位**（不是过道）：忙的人直接坐在工位上开工，
          // 闲的人就从工位起身去倒水再回来 —— 符合「座位按会话固定分配」的概念。
          x: a.x + seat.cx,
          y: a.y + seat.cellTop + SEAT_DY,
          tx: a.x + seat.cx,
          ty: a.y + seat.cellTop + SEAT_DY,
          speed: 0.6,
          phase: Math.random() * Math.PI * 2,
          nextTool: nowMs + 6000 + Math.random() * 8000, // 下次去工具柜取工具
          toolTrip: false, // 当前是否在「取工具」这一趟里
          toolAtRack: false, // 是否已经走到工具柜前
          moving: false,
          seated: false,
          spawn: nowMs,
        };
        state.agents.set(ag.key, st);
      }
      st.area = a;
      st.agent = ag;
      st.seat = seat;
      st.seatX = a.x + seat.cx;
      st.seatY = a.y + seat.cellTop + SEAT_DY;
      st.aisleY = a.y + a.aisleY;
      st.rackX = a.x + a.rackX;
    });
  });
  for (const k of [...state.agents.keys()]) {
    if (!seen.has(k)) state.agents.delete(k);
  }
}

function stepBehaviors(dt, t) {
  for (const st of state.agents.values()) {
    const act = st.agent.s.busy ? st.agent.s.act : 'idle';
    const seatDist = Math.hypot(st.seatX - st.x, st.seatY - st.y);

    if (act === 'tooling') {
      // 调工具 = **大多数时间在工位上操作**，偶尔去工具柜拿一次东西。
      //
      // 之前是「一直在工位与工具柜之间来回跑」—— 工具柜在最右侧，
      // 横穿整个房间，既夸张又吵；而调工具恰恰是 AI agent 的**主活动**，
      // 不是异常事件，不该占用那么多动态注意力。
      // 现在：坐在工位干活 → 每 7~13 秒起身去柜子拿一次 → 在柜前翻找 1~2 秒 → 回来。
      if (t > st.nextTool) {
        st.nextTool = t + 7000 + Math.random() * 6000;
        st.toolTrip = !st.toolTrip;
        st.toolAtRack = false;
      }
      if (st.toolTrip) {
        if (!st.toolAtRack) {
          // 去柜子
          st.tx = st.rackX - 14;
          st.ty = st.aisleY;
          if (Math.hypot(st.tx - st.x, st.ty - st.y) < 3) {
            st.toolAtRack = true;
            st.nextTool = t + 1000 + Math.random() * 1500; // 在柜前翻找一会儿
          }
        } else if (t > st.nextTool) {
          // 拿完了，回工位
          st.toolTrip = false;
          st.tx = st.seatX;
          st.ty = st.seatY;
        } else {
          // 原地翻找
          st.tx = st.x;
          st.ty = st.y;
        }
      } else {
        // 在工位上操作
        st.tx = st.seatX;
        st.ty = st.seatY;
      }
      st.speed = 1.4;
      st.seated = !st.toolTrip && Math.hypot(st.seatX - st.x, st.seatY - st.y) < 3;
      st.runBack = false;
    } else if (act === 'writing' || act === 'thinking' || act === 'waiting') {
      st.tx = st.seatX;
      st.ty = st.seatY;
      st.speed = 1.0;
      st.seated = seatDist < 3;
      st.runBack = false;
    } else {
      // 空闲：**固定坐在自己的工位上**（偶尔换个姿势，但不离席）。
      //
      // 之前这个 FSM 有三个问题，导致「一堆人站在过道不动」：
      //   1. 初始位置在过道、目标却指向工位 → 头几秒朝工位乱走；
      //   2. 停顿占了约 29% 的时间，且 8 个人常同时停 → 看起来就是「站着」；
      //   3. 速度 0.55×dt×0.06 ≈ 32px/s，走 200px 要 6 秒，而 4-8 秒就换目标
      //      → 永远走不到位，视觉上完全静止。
      //
      // 中间试过「坐在工位 + 偶尔起身去接水」，但那样会在工位与过道之间来回走，
      // 画面上表现为**工位空着、小人杵在房间边缘**（看着像掉到房间外面去了），
      // 实测截图里 9 个工位空了 2 个，「谁在忙」的信号反而被稀释。
      //
      // 办公场景里「闲着」本来就该是**坐在椅子上**。生动感靠身体微动
      // （呼吸起伏 + 偶尔换个姿势）来给，**不靠位移**：
      // 于是站着 / 有明显动作的才是忙的，坐着且颜色淡的 = 闲的。
      st.runBack = false;
      st.tx = st.seatX;
      st.ty = st.seatY;
      st.speed = 0.9;
      st.seated = Math.hypot(st.seatX - st.x, st.seatY - st.y) < 3;
    }

    const dx = st.tx - st.x;
    const dy = st.ty - st.y;
    const d = Math.hypot(dx, dy);
    if (d > 1.2) {
      const step = Math.min(d, st.speed * dt * 0.06);
      st.x += (dx / d) * step;
      st.y += (dy / d) * step;
      st.moving = true;
    } else {
      st.moving = false;
    }
  }
}

/* ============================ 主循环 ============================ */

/** 给定场景尺寸时的相机缩放（排版时也想先知道缩放，所以单独拎出来）。 */
function cameraZoomFor(sw, sh) {
  const availW = W - 40;
  const availH = H - WALL_H - 24;
  let z = Math.min(availW / sw, availH / sh, 1.8);
  z = Math.max(0.58, z);
  // 房间很多时上下可以滚动，但左右没有平移手段 —— 宽度一旦超出就再缩一点，保证不被裁掉
  if (sw * z > W - 12) z = (W - 12) / sw;
  return z;
}

function computeCamera() {
  const availH = H - WALL_H - 24;
  state.zoom = Math.round(cameraZoomFor(state.sceneW, state.sceneH) * 1000) / 1000;
  state.ox = Math.round((W - state.sceneW * state.zoom) / 2);
  const contentH = state.sceneH * state.zoom;
  state.oy = Math.round(WALL_H + 12 + Math.max(0, (availH - contentH) / 2));
  const maxScroll = Math.max(0, contentH - availH);
  state.scrollY = Math.min(state.scrollY, maxScroll);
}


function drawEmpty(t) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(72,54,32,0.86)';
  ctx.font = '600 16px system-ui, -apple-system, sans-serif';
  ctx.fillText(activeOnly ? '当前筛选下没有活跃会话' : '办公室今天还没开张', W / 2, H / 2 - 14);
  ctx.fillStyle = 'rgba(104,84,58,0.72)';
  ctx.font = '12px system-ui, -apple-system, sans-serif';
  ctx.fillText(
    activeOnly ? '点顶栏「仅活跃」取消筛选，查看全部会话' : '在今天用过的 AI 工具里开一段对话，小人就会出现在工位上',
    W / 2, H / 2 + 12,
  );
  ctx.restore();
}

function draw(t) {
  if (!officeOpen || !ctx) return;
  const t0 = performance.now();
  const dt = lastFrame ? Math.min(48, t - lastFrame) : 16;
  lastFrame = t;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, H);
  renderBackground();
  if (bg) ctx.drawImage(bg, 0, 0, W, H);

  if (!state.areas.length) {
    drawEmpty(t);
    rafId = requestAnimationFrame(draw);
    return;
  }

  stepBehaviors(dt, t);

  // ---- 视口裁剪：只画看得见的人 / 名牌。房间再多，单帧成本只跟「屏幕上」的数量有关 ----
  const z = state.zoom;
  const vx0 = -state.ox / z;
  const vy0 = (state.scrollY - state.oy) / z;
  const vx1 = (W - state.ox) / z;
  const vy1 = (H - state.oy + state.scrollY) / z;
  const M = 96; // 边缘余量（奔跑/走动会越界一点）
  const lod = z < 0.68 ? 1 : 0; // 缩得很小时省掉四肢细节

  ctx.save();
  ctx.translate(state.ox, state.oy - state.scrollY);
  ctx.scale(z, z);
  // 只把「看得见的那块」静态图搬到屏幕上，不要每帧整张 2600×6000 全画一遍
  if (scene) {
    const ss = sceneSS;
    const sx0 = Math.max(0, Math.floor(vx0) - 2);
    const sy0 = Math.max(0, Math.floor(vy0) - 2);
    const sx1 = Math.min(state.sceneW, Math.ceil(vx1) + 2);
    const sy1 = Math.min(state.sceneH, Math.ceil(vy1) + 2);
    const bw = sx1 - sx0;
    const bh = sy1 - sy0;
    if (bw > 0 && bh > 0) {
      ctx.drawImage(scene, sx0 * ss, sy0 * ss, bw * ss, bh * ss, sx0, sy0, bw, bh);
    }
  }

  // 小人按 y 排序，靠下（近）的后画，遮挡关系正确
  const list = [...state.agents.values()].sort((a, b) => a.y - b.y);
  let drawn = 0;
  for (const st of list) {
    if (st.x < vx0 - M || st.x > vx1 + M || st.y < vy0 - M || st.y > vy1 + M) continue;
    drawn++;
    // 出现特效：数字雨
    const age = t - st.spawn;
    if (age < 520) {
      const p = age / 520;
      ctx.save();
      ctx.globalAlpha = (1 - p) * 0.85;
      ctx.fillStyle = st.agent.brand.light;
      for (let i = 0; i < 4; i++) {
        const hh = 14 + ((i * 37) % 22);
        const yy = st.y - 46 - hh * p + i * 4;
        ctx.fillRect(Math.round(st.x) - 9 + i * 6, Math.round(yy), 2, hh);
      }
      ctx.restore();
    }
    drawPerson(ctx, st, t, lod);
  }
  ctx.restore();
  perf.agents = list.length;
  perf.drawn = drawn;

  // 房间的名字 / 人数 / token **不画在画布里**（改成顶部的 HTML 房间条）：
  // 画布坐标随缩放变化，而文字为了保证清晰是固定屏幕高度，两者永远可能对不齐，
  // 一旦没对齐就会压到第一排工位的显示器和小人头上。放到房间里以外就没这个问题。

  // 悬停：**不画脚环**。
  // 之前给被悬停的小人脚底画一圈椭圆环做选中标记，结果环是「屏幕坐标画的固定偏移」，
  // 缩放一变就和人对不上位（看起来像落在地毯上的孤立光圈），而且跟忙碌状态容易混淆。
  // 现在悬停反馈只有两处：头顶的信息浮框 + 顶部房间条上的房间高亮，干净也算得准。
  if (state.hoverRoom) {
    const ha = state.areas.find((a) => a.key === state.hoverRoom);
    if (ha) {
      // 用**地毯**矩形而不是房间矩形：房间矩形底部还含一条过道 AISLE，
      // 直接框它会明显比房间大出一圈（看着就像「框歪了」）。
      const car = roomCarpet(ha);
      const hx = car.x * z + state.ox;
      const hy = car.y * z + state.oy - state.scrollY;
      const hw = car.w * z;
      const hh = car.h * z;
      ctx.save();
      // 轻轻铺一层冷色：只描边在满屏小人的画面里很容易看漏，
      // 而这一层是半透明的，不会挡住任何桌子或小人。
      ctx.fillStyle = 'rgba(122,196,255,0.10)';
      rr(ctx, hx + 1, hy + 1, hw - 2, hh - 2, 12);
      ctx.fill();
      ctx.strokeStyle = 'rgba(122,196,255,0.9)';
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]);
      rr(ctx, hx + 1, hy + 1, hw - 2, hh - 2, 12);
      ctx.stroke();
      ctx.restore();
    }
  }

  // 滚动条
  const contentH = state.sceneH * state.zoom + 24;
  if (contentH > H + 4) {
    const barH = Math.max(30, (H / contentH) * H);
    const maxScroll = contentH - H;
    const y = 8 + (state.scrollY / maxScroll) * (H - barH - 16);
    ctx.fillStyle = 'rgba(200,215,240,0.18)';
    rr(ctx, W - 8, y, 4, barH, 2);
    ctx.fill();
  }

  // 悬停浮框跟着小人走（走动 / 滚动时都贴住头顶，不会飘到别处盖住邻座）
  if (state.hover) positionTip();

  perf.frames += 1;
  perf.ms = perf.ms * 0.85 + (performance.now() - t0) * 0.15;
  rafId = requestAnimationFrame(draw);
}

/* ============================ 悬停 / 交互 ============================ */

function pickAgent(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const mx = clientX - rect.left;
  const my = clientY - rect.top;
  const sx = (mx - state.ox) / state.zoom;
  const sy = (my - state.oy + state.scrollY) / state.zoom;
  let best = null;
  let bestD = 26;
  for (const st of state.agents.values()) {
    const headY = st.y - (st.seated ? 30 : 44);
    const dx = Math.abs(sx - st.x);
    const dy = sy < headY - 4 ? headY - 4 - sy : Math.max(0, sy - st.y);
    const d = Math.hypot(dx, dy * 0.8);
    if (d < bestD) {
      bestD = d;
      best = st;
    }
  }
  return best;
}

function showTip(st, clientX, clientY) {
  if (!tipEl) return;
  if (!st) {
    tipEl.classList.add('hidden');
    return;
  }
  const s = st.agent.s;
  const brand = st.agent.brand;
  const busy = !!s.busy;
  const act = busy ? ACT_LABEL[s.act] || s.act : '空闲';
  // 项目：优先用真实工作目录名，否则用工作区目录名（通常是有意义的工程名，不是日期）
  const proj = s.cwd ? s.cwd.split(/[\\/]/).pop() : prettyWs(s.workspace);
  // 任务标题：优先真实标题；没有则用项目名兜底，保证浮框始终看得到「在处理什么」
  const hasTitle = !!(s.title && s.title.trim());
  const title = hasTitle ? s.title.trim() : (proj || '（无标题会话）');
  const room = (st.area && st.area.label) || prettyWs(s.workspace) || '—';
  // token 行：只在该会话记录了 usage 时显示（没数据不显示 0，避免误导）
  const tk = s.tokens;
  const tokRow = tk
    ? `<div class="tip-row"><span>Token</span><b>${fmtTok(
        (Number(tk.input) || 0) + (Number(tk.output) || 0),
      )} · 缓存 ${fmtRate(
        tk.input ? Math.min((Number(tk.cache_read) || 0) / (Number(tk.input) || 1), 1) : 0,
      )} · 省 ${fmtTok(Math.round((Number(tk.cache_read) || 0) * 0.9))}</b></div>`
    : '';
  tipEl.innerHTML = `
    <div class="tip-head">
      <span class="tip-icon" style="background:${brand.bg}"></span>
      <span class="tip-kicker" style="color:${busy ? '#8ef0c6' : '#8f9cb3'}">${busy ? '正在处理' : '最近会话'}</span>
      <span class="tip-title">${escapeHtml(title)}</span>
    </div>
    <div class="tip-row"><span>工具</span><b>${escapeHtml(st.agent.toolName || st.agent.connector)}</b></div>
    ${hasTitle || proj !== title ? `<div class="tip-row"><span>项目</span><b>${escapeHtml(proj || '—')}</b></div>` : ''}
    <div class="tip-row"><span>房间</span><b>${escapeHtml(room)}</b></div>
    <div class="tip-row"><span>状态</span><b class="${busy ? 'on' : ''}">${busy ? act : '空闲 · 闲坐中'}</b></div>
    ${tokRow}
    <div class="tip-row"><span>最近</span><b>${relTime(s.last)}</b></div>`;
  tipEl.classList.remove('hidden');
  positionTip();
}

// 把浮框锚定在被悬停小人「头顶上方」，而不是跟着鼠标飘到旁边盖住邻座。
// 顶栏太近就翻到身下；小人走动 / 滚动时由 draw() 每帧调一次，始终贴着本人。
function positionTip() {
  if (!tipEl || tipEl.classList.contains('hidden') || !state.hover) return;
  const st = state.hover;
  const stageRect = stage.getBoundingClientRect();
  const tw = tipEl.offsetWidth;
  const th = tipEl.offsetHeight;
  const headX = st.x * state.zoom + state.ox;
  const headY = (st.y - (st.seated ? 30 : 44)) * state.zoom + state.oy - state.scrollY;
  let x = headX - tw / 2;
  let y = headY - th - 10;                              // 默认浮在头顶上方（空地带，不挡邻座）
  if (y < 6) y = headY + (st.seated ? 36 : 50);          // 贴顶就翻到身下，仍紧挨本人
  if (x < 6) x = 6;
  if (x + tw > stageRect.width - 6) x = stageRect.width - tw - 6;
  if (y + th > stageRect.height - 6) y = stageRect.height - th - 6;
  tipEl.style.left = `${Math.round(x)}px`;
  tipEl.style.top = `${Math.round(y)}px`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * 顶部「房间条」：每个房间一枚 chip（房间名 · 忙碌/人数 · token）。
 *
 * 房间信息原来画在画布里（房间头顶一块深色名牌），但画布坐标随缩放变化、文字却是固定屏幕高度，
 * 两者永远算不齐 —— 房间一多、窗口一小就会出现名牌压在第一排小人头和显示器上。
 * 挪出画布之后这是结构上不可能再发生的事；顺带也解决了「名字太长挤到隔壁房间」的问题。
 */
function renderRoomChips() {
  const box = document.getElementById('office-rooms');
  if (!box) return;
  if (!state.areas.length) {
    box.innerHTML = '<span class="rm-empty">暂无房间</span>';
    return;
  }
  box.innerHTML = state.areas
    .map((a) => {
      const n = a.agents.length;
      const busy = a.agents.filter((x) => x.s.busy).length;
      const tk = a.tokens;
      let tok = '';
      let tip = '';
      if (tk && tk.count > 0) {
        const total = tk.input + tk.output;
        const rate = tk.input ? Math.min(tk.cache_read / tk.input, 1) : 0;
        const saved = Math.round(tk.cache_read * 0.9);
        tok = `${fmtTok(total)} tok · 省 ${fmtTok(saved)}`;
        tip = `${fmtTok(tk.input + tk.output)} token · 缓存命中 ${fmtRate(rate)} · 省 ${fmtTok(saved)}（${tk.count} 个会话有用量数据）`;
      }
      const color = (a.agents[0] && a.agents[0].brand && a.agents[0].brand.bg) || '#8fbcda';
      // 「忙/总」写法与会话列表一致，色点标出正在工作的那部分
      const busyTxt = busy ? `<span class="rm-busy">${busy}</span>/` : '';
      return (
        `<span class="rm-chip${state.hoverRoom === a.key ? ' on' : ''}" data-room="${escapeHtml(a.key)}"` +
        ` title="${escapeHtml(`${a.label}｜${n} 个工位${busy ? ` · ${busy} 个正在工作` : ''}${tip ? ` · ${tip}` : ''}`)}">` +
        `<i class="rm-dot" style="background:${escapeHtml(color)}"></i>` +
        `<b>${escapeHtml(a.label)}</b>` +
        `<span class="rm-n">${busyTxt}${n}</span>` +
        (tok ? `<span class="rm-tok">${escapeHtml(tok)}</span>` : '') +
        `</span>`
      );
    })
    .join('');
}

/* ============================ 图例 / 概念面板 ============================ */

function updateChrome() {
  const sub = document.getElementById('office-sub');
  const legend = document.getElementById('office-legend');
  const concepts = document.getElementById('office-concepts');
  if (!sub) return;

  const counts = { writing: 0, thinking: 0, tooling: 0, waiting: 0, idle: 0 };
  let total = 0;
  state.areas.forEach((a) => a.agents.forEach((ag) => {
    total += 1;
    counts[ag.s.busy ? ag.s.act : 'idle'] = (counts[ag.s.busy ? ag.s.act : 'idle'] || 0) + 1;
  }));
  const busy = counts.writing + counts.thinking + counts.tooling + counts.waiting;
  const offline = state.nodes.filter((n) => !n.online).length;
  const raw = (state.nodes || []).reduce(
    (m, nd) => (nd.online ? m + (nd.tools || []).reduce((k, t) => k + (t.recent || []).length, 0) : m),
    0,
  );
  const filterNote = activeOnly ? ` · 仅活跃（全部 ${raw}）` : '';
  const modeLabel = (GROUP_MODES.find((m) => m.id === groupMode) || {}).label || '';
  const mergedNote = state.mergedRooms ? `（另有 ${state.mergedRooms} 个工作区已并入「其他」）` : '';
  sub.textContent =
    `${state.areas.length} 个房间 · ${total} 个工位 · 正在工作 ${busy}` +
    `${filterNote ? filterNote : ''} · 分类：${modeLabel}${mergedNote}${offline ? ` · 远端离线 ${offline}` : ''}`;

  renderRoomChips();

  if (legend) {
    const chip = (c, label, n, tip) =>
      `<span class="lg-item"${tip ? ` title="${escapeHtml(tip)}"` : ''}><i class="lg-dot" style="background:${c}"></i>${label}<b>${n}</b></span>`;
    legend.innerHTML =
      `<span class="lg-group">活动</span>` +
      chip('#4a7df0', '书写', counts.writing, '最后一条是工具结果：工具已返回，正在产出回答') +
      chip('#8f7bd8', '阅读', counts.thinking, '最后一条是思考块：正在读上下文 / 盘算（思考块落盘窗口很窄，出现较少）') +
      chip('#e0a24a', '调工具', counts.tooling, '最后一条是工具调用：已派出去，结果还没回来') +
      chip('#8b94a8', '闲坐', counts.idle, '本轮已结束（助手回答已落盘）') +
      `<span class="lg-sep"></span>` +
      `<span class="lg-group">气泡</span><span class="lg-item"><i class="lg-bubble">…</i>等待输入 / 权限 <b>${counts.waiting}</b></span>` +
      `<span class="lg-spacer"></span>` +
      `<span class="lg-note">房间＝${modeLabel === '工具' ? 'AI 工具' : modeLabel === '月' ? '按月份归并的工作区' : '项目文件夹'} · 工位固定 · 头像＝AI 工具图标</span>`;
  }

  if (concepts) {
    const row = (k, v) => `<div class="cp-row"><span>${k}</span><b>${v}</b></div>`;
    concepts.innerHTML =
      `<div class="cp-head">pixel-agents 概念 → 本工具的实现</div>` +
      row('一个 Agent', `一个会话 = 一张工位（目前 ${total} 个）`) +
      row('Office / Areas', `${modeLabel}分类 · ${state.areas.length} 个房间（${total} 个工位）`) +
      row('角色 sprite + 调色板', `每个 AI 工具一套配色（衣服颜色）`) +
      row('座位 seat', `按会话 id 固定分配，刷新不串位`) +
      row('闲 / 忙的区分', `闲的<b>坐在工位上</b>（画得更淡）· 忙的坐在工位上敲键盘 / 托下巴 / 翻工具`) +
      row('忙碌标记', `头顶一个实心小色点（书写 / 阅读 / 调工具同图例色）—— 不给小人套光环`) +
      row('房间名 + token', `顶部房间条：每个房间一枚 chip（名字 · 人数 · token），不占画布`) +
      row('忙碌姿态怎么来的', `看会话文件最后一条记录：已派出工具未回＝调工具（${counts.tooling}）· 工具结果已回、正在产出回答＝书写（${counts.writing}）· 尾部是思考块＝阅读（${counts.thinking}）`) +
      row('语音气泡（等输入 / 权限）', `Waiting ${counts.waiting} 人`) +
      `<div class="cp-tip">滚轮上下滚动 · 拖动平移 · 悬停小人看会话标题 · 悬停房间条上的房间名会高亮对应房间</div>`;
  }
}

/* ============================ 尺寸 / 生命周期 ============================ */

function sizeCanvas() {
  if (!canvas || !stage) return;
  const rect = stage.getBoundingClientRect();
  const prevW = W;
  dpr = window.devicePixelRatio || 1;
  W = Math.max(320, Math.floor(rect.width));
  H = Math.max(240, Math.floor(rect.height));
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (state.nodes.length && Math.abs(W - prevW) > 24) rebuildLayout();
  else if (state.areas.length) computeCamera();
}

/**
 * 按当前视口重新排房间。
 *
 * 以前这里要排两趟：先用默认 head 排一次，再用「由此得到的缩放」反推房间头顶该给名牌留多高，
 * 然后重排 —— 因为名牌是固定 22px 屏幕高度，缩放一低换算到世界里就变高，会压到第一排工位。
 * 现在房间信息搬到了画布外的「房间条」，房间里再也没有固定像素的文字需要预留位置，
 * 于是这里回到一次性排版（head 就是一个固定的小留白）。
 */
function rebuildLayout() {
  const aw = W - 40;
  const ah = H - WALL_H - 24;
  const built = buildAreas(state.nodes, aw, ah, ROOM_PAD);
  state.areas = built.areas;
  state.lounge = built.lounge;
  state.mergedRooms = built.mergedRooms || 0;
  state.sceneW = built.sceneW;
  state.sceneH = built.sceneH;
  syncAgents(state.areas, performance.now());
  computeCamera();
  renderStatic();
  updateChrome();
}

// 上一次拉数据还没回来时，不再发起新请求。
// 没有这个守卫，一旦后端某次变慢（比如扫描的会话文件突然变多），
// 5 秒一次的定时器会不断堆叠请求，界面越来越卡 —— 请求永远追不上。
let officeFetching = false;

export async function refreshOffice() {
  if (officeFetching) return;
  officeFetching = true;
  try {
    state.nodes = (await dataSource().catch(() => [])) || [];
    if (!W && canvas) sizeCanvas();
    rebuildLayout();
  } finally {
    officeFetching = false;
  }
}

export function openOffice() {
  const ov = document.getElementById('office');
  const back = document.getElementById('office-backdrop');
  if (!ov || !back) return;
  ov.classList.remove('hidden');
  back.classList.remove('hidden');
  stage = document.getElementById('office-stage');
  tipEl = document.getElementById('office-tip');
  canvas = document.getElementById('office-canvas');
  if (!canvas) return;
  ctx = canvas.getContext('2d');
  officeOpen = true;
  wire();
  sizeCanvas();
  refreshOffice();
  if (dataTimer) clearInterval(dataTimer);
  dataTimer = setInterval(refreshOffice, 5000);
  window.addEventListener('resize', sizeCanvas);
  if (rafId) cancelAnimationFrame(rafId);
  lastFrame = 0;
  rafId = requestAnimationFrame(draw);
}

export function closeOffice() {
  officeOpen = false;
  const ov = document.getElementById('office');
  const back = document.getElementById('office-backdrop');
  if (ov) ov.classList.add('hidden');
  if (back) back.classList.add('hidden');
  if (dataTimer) {
    clearInterval(dataTimer);
    dataTimer = null;
  }
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  window.removeEventListener('resize', sizeCanvas);
  if (tipEl) tipEl.classList.add('hidden');
}

/* ============================ 一次性事件绑定 ============================ */

let wired = false;
function wire() {
  if (wired || !canvas) return;
  wired = true;

  canvas.addEventListener('pointermove', (e) => {
    const st = pickAgent(e.clientX, e.clientY);
    state.hover = st;
    canvas.style.cursor = st ? 'pointer' : 'grab';
    showTip(st, e.clientX, e.clientY);
  });
  canvas.addEventListener('pointerleave', () => {
    state.hover = null;
    showTip(null);
  });
  // 顶部房间条：悬停某枚 chip → 画布上给对应房间描一个高亮虚线框（名字 ↔ 房间 的对应关系）
  const roomsBox = document.getElementById('office-rooms');
  if (roomsBox) {
    roomsBox.addEventListener('pointerover', (e) => {
      const c = e.target.closest ? e.target.closest('.rm-chip') : null;
      const key = c ? c.dataset.room : null;
      if (key !== state.hoverRoom) {
        state.hoverRoom = key;
        renderRoomChips(); // chip 自己的高亮状态也跟着变
      }
    });
    roomsBox.addEventListener('pointerleave', () => {
      if (state.hoverRoom !== null) {
        state.hoverRoom = null;
        renderRoomChips();
      }
    });
  }

  canvas.addEventListener('wheel', (e) => {
    const contentH = state.sceneH * state.zoom + 24;
    if (contentH <= H) return;
    e.preventDefault();
    state.scrollY = Math.max(0, Math.min(contentH - H, state.scrollY + e.deltaY));
  }, { passive: false });

  // 拖动平移（纵向滚动 + 横向备用）
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, sy: state.scrollY };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const contentH = state.sceneH * state.zoom + 24;
    state.scrollY = Math.max(0, Math.min(Math.max(0, contentH - H), drag.sy - (e.clientY - drag.y)));
  });
  canvas.addEventListener('pointerup', (e) => {
    drag = null;
    canvas.style.cursor = 'grab';
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
  });

  const help = document.getElementById('office-help');
  const cp = document.getElementById('office-concepts');
  if (help && cp) {
    help.addEventListener('click', () => {
      cp.classList.toggle('hidden');
      help.classList.toggle('active');
    });
  }

  // 房间分类：月 / 项目 / 工具（重排房间，不重新拉数据）
  const groupBox = document.getElementById('office-group');
  if (groupBox) {
    syncGroupButtons();
    groupBox.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-group]');
      if (!btn) return;
      const id = btn.dataset.group;
      if (id === groupMode) return;
      groupMode = id;
      try { localStorage.setItem('agentdesk.officeGroup', id); } catch (_) {}
      syncGroupButtons();
      state.hover = null;
      if (tipEl) tipEl.classList.add('hidden');
      state.scrollY = 0;
      rebuildLayout();
    });
  }

  // 「仅活跃」：过滤掉 1 小时内没有活动的会话，人多时降噪（重排布局）
  const onlyActive = document.getElementById('office-active');
  if (onlyActive) {
    onlyActive.addEventListener('click', () => {
      activeOnly = !activeOnly;
      onlyActive.classList.toggle('active', activeOnly);
      state.hover = null;
      if (tipEl) tipEl.classList.add('hidden');
      rebuildLayout();
    });
  }

  // 架构分析浮层：顶栏「架构」按钮 <-> 浮层开关
  const arch = document.getElementById('office-arch');
  const archBtn = document.getElementById('office-arch-btn');
  const archClose = document.getElementById('office-arch-close');
  if (arch && archBtn) {
    const openArch = () => { arch.classList.remove('hidden'); archBtn.classList.add('active'); };
    const closeArch = () => { arch.classList.add('hidden'); archBtn.classList.remove('active'); };
    archBtn.addEventListener('click', () => {
      if (arch.classList.contains('hidden')) openArch(); else closeArch();
    });
    if (archClose) archClose.addEventListener('click', closeArch);
    arch.addEventListener('click', (e) => { if (e.target === arch) closeArch(); });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !arch.classList.contains('hidden')) {
        closeArch();
        e.stopPropagation();
      }
    }, true);
  }
}
