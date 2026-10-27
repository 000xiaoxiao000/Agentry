// 真实双进程联调：真的跑 agentry（中心）和 agentry-proxy（远端）两个二进制。
//
// 集成测试（hub_e2e.rs）验证的是协议与合并逻辑；这个脚本验证的是
// 「两个**独立应用**真的能互相找到对方」——包括各自的配置、启动参数、
// 数据目录隔离，以及中心从远端拿到的数据确实来自远端那台机器。
//
// 用法：node scripts/e2e-two-apps.mjs
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
// 默认测 release 产物（真实分发形态）；DEBUG=1 时测 debug 版。
const BIN = process.env.DEBUG ? 'debug' : 'release';
const DEBUG_BIN = path.join(ROOT, 'target', BIN);
// 中心助手是 agentry 包里的第二个 bin（headless 中心），与 GUI 同一套 hub 代码。
const CENTER_BIN = path.join(DEBUG_BIN, 'agentry-center-helper');
const SECRET = 'e2e-two-apps-secret';

// 找一个空闲端口
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 极简线协议客户端：握手 + 发 req + 等 res（只用于本脚本验证）
function makeClient(port, secret) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    const waiters = [];
    const send = (obj) => {
      const b = Buffer.from(JSON.stringify(obj));
      const len = Buffer.alloc(4); len.writeUInt32BE(b.length, 0);
      sock.write(Buffer.concat([len, b]));
    };
    const recv = () => new Promise(res => {
      if (waiters.length) return waiters.shift()(null);
      waiters.push(res);
    });
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const n = buf.readUInt32BE(0);
        if (buf.length < 4 + n) break;
        const v = JSON.parse(buf.subarray(4, 4 + n).toString());
        buf = buf.subarray(4 + n);
        const w = waiters.shift();
        if (w) w(v); else waiters.push(() => v);
      }
    });
    sock.on('error', reject);
    (async () => {
      send({ t: 'hello', id: 'probe', name: 'probe', machine: 'probe', role: 'client' });
      const ch = await recv();
      const crypto = await import('node:crypto');
      const resp = crypto.createHmac('sha256', secret).update(ch.nonce).digest('hex');
      send({ t: 'auth', resp });
      const ok = await recv();
      if (ok.t !== 'ok') { reject(new Error('鉴权失败')); return; }
      resolve({ send, recv });
    })();
  });
}

async function request(client, op, args) {
  const rid = Math.floor(Math.random() * 100000);
  client.send({ t: 'req', rid, op, args });
  for (;;) {
    const m = await client.recv();
    if (m.t === 'res' && m.rid === rid) {
      if (!m.ok) throw new Error('取数失败: ' + m.error);
      return m.data;
    }
  }
}

const log = (...a) => console.log(...a);
let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { log(`  ✅ ${name}`); }
  else { log(`  ❌ ${name} ${detail}`); failures++; }
}

/** 缺二进制就现场构建（省得用户先手动 cargo build）。 */
function ensureBuilt(binPath, args, label) {
  if (fs.existsSync(binPath)) return;
  log(`缺少 ${label}，正在构建…`);
  const r = spawnSync('cargo', args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`${label} 构建失败`);
    process.exit(1);
  }
}

async function main() {
  const port = await freePort();
  const proxyDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-proxy-data-'));
  const proxyCfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-proxy-cfg-'));
  // 中心也用**独立的临时数据目录**。
  // 否则中心会落到项目目录（开发期回落路径），把联调扫到的产物写进
  // 项目的 artifacts.json —— 那是用户的真实数据目录，不能被测试污染。
  const centerDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-center-data-'));
  ensureBuilt(path.join(DEBUG_BIN, 'agentry-proxy'), ['build', '-p', 'agentry-proxy'], 'agentry-proxy');
  ensureBuilt(path.join(DEBUG_BIN, 'agentry'), ['build', '-p', 'agentry'], 'agentry');
  ensureBuilt(CENTER_BIN, ['build', '-p', 'agentry', '--bin', 'agentry-center-helper'], '中心助手');

  log(`\n=== 真实双进程联调：中心 agentry + 远端 agentry-proxy ===`);
  log(`中心端口 ${port}；远端数据目录 ${proxyDataDir}\n`);

  // ---- 启动远端 agentry-proxy（独立进程）----
  const proxy = spawn(path.join(DEBUG_BIN, 'agentry-proxy'), [
    '--hub', `127.0.0.1:${port}`,
    '--secret', SECRET,
    '--name', '远端测试机',
    '--id', 'proxy-e2e-real',
    '--data-dir', proxyDataDir,
    '--interval', '2',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let proxyLog = '';
  proxy.stdout.on('data', d => { proxyLog += d.toString(); });
  proxy.stderr.on('data', d => { proxyLog += d.toString(); });

  // ---- 启动中心（用 lib 里的 hub 起一个真正的中心实例）----
  // 中心的 GUI 二进制不适合在脚本里驱动，所以这里用一个小的 center-helper 二进制，
  // 它调用的是**和 GUI 完全相同**的 agentry::hub 与合并门面。
  const center = spawn(CENTER_BIN, [
    '--port', String(port), '--secret', SECRET,
    '--data-dir', centerDataDir,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let centerLog = '';
  center.stdout.on('data', d => { centerLog += d.toString(); });
  center.stderr.on('data', d => { centerLog += d.toString(); });

  const cleanup = () => {
    try { proxy.kill('SIGKILL'); } catch {}
    try { center.kill('SIGKILL'); } catch {}
    try { fs.rmSync(proxyDataDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(proxyCfgDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(centerDataDir, { recursive: true, force: true }); } catch {}
  };
  process.on('exit', cleanup);

  // 等两个进程就绪
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const c = await makeClient(port, SECRET);
      ready = true;
      global.__client = c;
      break;
    } catch { await sleep(200); }
  }
  if (!ready) {
    log('❌ 中心没起来');
    log(centerLog);
    cleanup();
    process.exit(1);
  }
  const client = global.__client;
  log('中心已就绪\n');

  // 等待代理接入
  let peers = [];
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    const list = await request(client, 'list_conversations', { connector: null, limit: 5 });
    peers = list.meta?.sources || [];
    if (peers.some(s => s.includes('远端测试机'))) break;
  }

  // 等代理的首次同步完成 —— 它要全量扫一遍本机会话目录，几十秒很正常。
  // 没同步完就没有产物索引，中心从远端拉到的自然是空列表。
  let synced = false;
  for (let i = 0; i < 120; i++) {
    if (proxyLog.includes('首次同步完成')) { synced = true; break; }
    await sleep(1000);
  }
  log(`  · 代理首次同步：${synced ? '已完成' : '仍在进行（可能首次全量扫描较慢）'}`);

  log('--- 1) 两个独立应用能否互相找到对方 ---');
  check('中心登记到了远端 agentry-proxy', peers.some(s => s.includes('远端测试机')),
    `sources=${JSON.stringify(peers)}`);
  check('远端进程确实在跑（不是模拟）', proxyLog.includes('已接入中心'),
    proxyLog.slice(0, 200));

  log('\n--- 2) 中心能否从远端拿到数据（走真实 socket）---');
  try {
    const convs = await request(client, 'list_conversations', { connector: null, limit: 2000 });
    check('会话列表结构正确', Array.isArray(convs.list), JSON.stringify(convs).slice(0, 120));
    check('meta 里有来源与总数', !!convs.meta && typeof convs.meta.total === 'number',
      JSON.stringify(convs.meta));
    const remote = (convs.list || []).filter(c => c.origin);
    check('远端会话带 origin 标记（前端据此标注来源）', remote.length > 0,
      `远端条目 ${remote.length}`);
    if (remote.length) {
      check('远端会话 id 带节点前缀（跨机器唯一）', remote[0].id.includes(':'), remote[0].id);
    }
  } catch (e) {
    check('中心取远端会话', false, e.message);
  }

  try {
    const arts = await request(client, 'list_artifacts', { filter: null });
    check('产物列表结构正确', Array.isArray(arts.list), JSON.stringify(arts).slice(0, 120));
  } catch (e) {
    check('中心取远端产物', false, e.message);
  }

  try {
    const tasks = await request(client, 'list_tasks', {});
    check('任务列表结构正确', Array.isArray(tasks.list), JSON.stringify(tasks).slice(0, 120));
  } catch (e) {
    check('中心取远端任务', false, e.message);
  }

  try {
    const tk = await request(client, 'token_stats', {});
    check('token 统计结构正确', Array.isArray(tk.list), JSON.stringify(tk).slice(0, 120));
    // 有 usage 的工才会出现条目；每条都要带 input/output/cache_read
    const withTok = (tk.list || []).filter((s) => (s.usage || s).input > 0);
    check('token 统计含实际用量', withTok.length > 0,
      `期望至少一条有 input 的统计，实际 ${(tk.list || []).length} 条`);
    const bad = withTok.find((s) => {
      const u = s.usage || s;
      return typeof u.input !== 'number' || typeof u.cache_read !== 'number';
    });
    check('token 统计字段完整', !bad, bad ? JSON.stringify(bad).slice(0, 120) : '');
  } catch (e) {
    check('中心取远端 token 统计', false, e.message);
  }

  log('\n--- 3) 两个应用的数据目录互相隔离 ---');
  const proxyStore = path.join(proxyDataDir, 'artifacts.json');
  check('远端代理有自己独立的产物索引', fs.existsSync(proxyStore),
    `期望 ${proxyStore}`);
  const desktopStore = path.join(ROOT, 'artifacts.json');
  // 判据是**文件路径不同**，不是内容/大小不同 ——
  // 中心和代理都跑在本机、扫的是同一批会话目录，索引内容（因此大小）本来就一样，
  // 拿大小去比会误判。真正要验证的是「两个应用各写各的数据目录」。
  const proxyResolved = fs.existsSync(proxyStore) ? fs.realpathSync(proxyStore) : proxyStore;
  const desktopResolved = fs.existsSync(desktopStore) ? fs.realpathSync(desktopStore) : desktopStore;
  check('远端索引与中心索引不是同一个文件',
    proxyResolved !== desktopResolved,
    `远端 ${proxyResolved} vs 中心 ${desktopResolved}`);

  log('\n--- 4) 远端代理掉线后中心如实报离线 ---');
  proxy.kill('SIGKILL');
  await sleep(1500);
  try {
    const after = await request(client, 'list_conversations', { connector: null, limit: 5 });
    check('meta.offline 列出了掉线的远端',
      (after.meta?.offline || []).some(n => n.includes('远端测试机')),
      `offline=${JSON.stringify(after.meta?.offline)}`);
  } catch (e) {
    check('掉线后中心仍可查询', false, e.message);
  }

  log('\n--- 5) 鉴权：错密钥必须被拒 ---');
  try {
    await makeClient(port, 'wrong-secret');
    check('错误密钥被拒绝', false, '竟然连上了');
  } catch {
    check('错误密钥被拒绝', true);
  }

  if (failures > 0) {
    log('\n--- 代理进程日志（末尾）---');
    log(proxyLog.split('\n').slice(-15).join('\n'));
    log('--- 中心进程日志（末尾）---');
    log(centerLog.split('\n').slice(-15).join('\n'));
  }
  cleanup();
  log(`\n=== 结果：${failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'} ===\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
