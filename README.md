# Agentry

> 把分散各机的 AI agents，收进一块能看见他们在干活的玻璃。

**跨机器的 AI 智能体指挥中心与产物档案馆。**

把散落在各台机器上的 AI 编码工具（WorkBuddy / Cursor / Codex / Claude Code…）的会话与产物，
收拢进一个界面里检索、对比、查看；并用一间实时「像素办公室」让你看见每台机器上正在跑什么。

采用「中心桌面端 + 远端无头代理」的双应用架构，两者共享同一份 Rust 数据层 ——
远端零入站端口、主动出站接入中心，天然穿透 NAT；中心把本机与所有在线远端的会话、产物、任务
合并成统一视图，并解析各工具的 token 消耗与缓存节省。

你的 AI agents 是一支分散在各地的团队，Agentry 就是统观这支队伍的那块玻璃。

分两个独立应用：**中心 `agentry`**（桌面 GUI + 监听）与**远端 `agentry-proxy`**（headless 常驻），
两者共用一份数据层 `crates/agent-core` —— 所以远端数据和本机数据是同一种东西。

> 早期版本是 JS 内核（`agent-core/src/*.mjs`）+ Tauri 外壳，那套已整体废弃 ——
> 现在是 Rust workspace：共享数据层 + 两个独立应用。

## 两个应用：中心与远端代理

跨机器纳管拆成了**两个各自独立的应用**，不是一个二进制靠参数切换角色：

| 应用 | 位置 | 形态 | 跑在哪 |
|---|---|---|---|
| **agentry**（中心） | `src-tauri/` | 桌面 GUI + 中心 hub（监听端口） | 有屏幕的机器 |
| **agentry-proxy**（远端代理） | `apps/agentry-proxy/` | headless 常驻，570KB | 远端机器 |
| *agent-core*（共享数据层） | `crates/agent-core/` | lib，两者共用 | — |

**为什么拆开**：远端机器不需要装整个桌面 GUI（32MB、带 WebView），也不该靠
`agentry --proxy` 这种参数来切换角色 —— 那是同一个应用在扮演两个角色，
配置、数据目录、生命周期全混在一起。拆成两个应用后，远端只需拷一个 570KB 的可执行文件。

**数据目录各自独立**：中心用项目目录，远端全在 `~/.agentry-proxy/`
（配置 `config.json`、产物索引 `artifacts.json`、日志 `logs/` 都在这一处）。

**产物索引不跨机器搬运**：`artifacts.json` 是「扫描本机会话目录」得出的**派生数据**，
每台机器各自扫描即可。把旧机器的索引搬过来只会带一堆陈旧条目（旧路径、旧字段、
内容早已过时），所以 `resolve_data_root` 只搬运**用户设置**（`connectors.json`）——
否则换机器后连接器全空，得从零重配。

**两边共用 agent-core**：会话扫描、文本清洗、产物收录口径、线协议只有一份实现，
所以界面里看到的远端数据和本机数据是同一种东西（字段结构、筛选语义完全一致）。

### 接入一台远端机器

```bash
# 1) 中心：打开 agentry → 右上角「☖ 代理节点」→ 填中心地址/端口/密钥 → 启动中心
# 2) 远端：装好 agentry-proxy 后首次配置（写一次配置文件）
agentry-proxy --init --hub <中心>:47800 --secret <密钥> --name <机器名>
# 3) 远端：直接跑（读配置），要开机自启再加 --install-service
agentry-proxy
agentry-proxy --install-service     # macOS launchd / Linux systemd（用户级，免提权）
```

远端**零入站端口**（只出不进）—— 天然穿 NAT / 防火墙。

### 构建与验证

```bash
npm run build                     # 前端
cargo build --workspace           # 两个应用 + 共享库（不含前端）
./scripts/build-release.sh        # ⭐ 可分发的 release（嵌前端 + 构建后自检）

cargo test -p agentry --test hub_e2e         # 协议 + 合并门面的集成测试
node scripts/e2e-two-apps.mjs                     # 真实双进程联调（两个独立二进制）
```

> **构建注意**：
> - ⚠️ **release 必须带 `--features custom-protocol`**（`build-release.sh` 已固化并自检）。
>   `tauri-macros` 里是 `dev: cfg!(not(feature = "custom-protocol"))`：
>   开了 → 前端嵌进二进制；没开 → 运行时去连 `devUrl http://localhost:5173`
>   → **本机没有 vite dev server → 白屏一直等**。这坑很隐蔽：编译不报错、能跑、就是白屏。
> - **跑哪个应用**：在各自包目录里 `cargo run` 直接跑它（`cd src-tauri && cargo run` 是桌面端，
>   `cd apps/agentry-proxy && cargo run` 是代理）；在 workspace **根目录**因为有两个产品二进制，
>   要用 `cargo run -p agentry` 或 `cargo run -p agentry-proxy`。
> - 中心包里还有一个 headless 二进制 `agentry-center-helper`（起中心 hub，供脚本/无界面服务器场景用），
>   与 GUI 共用同一个 lib：`cargo run -p agentry --bin agentry-center-helper`。
>   包内 `default-run = "agentry"` 保证 `cargo run` 不会因两个 bin 而歧义。


## 已实现的能力

**产物与会话索引**
- `list_artifacts` / `list_conversations` / `list_tasks`：列出各 AI 工具（WorkBuddy / Cursor / Codex / Claude Code…）的历史会话与产出文件。
- `get_artifact` / `read_artifact`：取单个产物详情、读文件内容。
- `artifact_stats` / `compare_groups`：按连接器与类型分组统计、跨工具对比。
- `sync_all` / `sync_connector`：扫描各工具的 session_roots，把会话收为产物、抽取会话内引用的文件。
- `export_all` / `save_export` / `open_in_finder`：导出、在 Finder 中定位。

**像素办公室**（`src/office.js`）
把每个活跃会话画成一个按工具上色、按状态摆 pose 的人，busy 带光环；房间名用**真实项目名**
（用户自定义显示名 / 工作区下的项目目录），不是日期或数字。5 秒重拉、rAF 平滑移动。

**跨机器纳管**
- 中心 hub 监听端口，远端 `agentry-proxy` 主动出站接入（零入站端口，天然穿 NAT）。
- `list_all_conversations` / `list_all_artifacts` / `list_all_tasks`：合并「本机 + 所有在线远端」，
  条目带 `origin`（来源节点，路由用）与 `origin_name`（显示名）。
- `get_artifact_any` / `read_artifact_any`：按来源转发 —— 远端产物的路径是**那台机器上的**路径，
  本机读会读到同名错文件。
- `list_proxies` / `hub_start` / `hub_stop` / `hub_running`：节点面板的启停与状态。

**Token 用量与节省**（`crates/agent-core/src/tokens.rs`）
从会话文件的 `usage` 记录解析各工具的 token 消耗，并算出缓存命中省下的量。
界面在四处展示：产物面板顶部的统计栏、工具卡片、会话列表、像素办公室房间名牌与悬停浮框。

**连接器**（`connectors.json`）
配置各工具的 session_roots 与显示名；`list_connectors` / `remove_connector`。

## 目录结构

```
agentry/
├── Cargo.toml                    # workspace 根（[profile.release] 必须在这里）
├── Cargo.lock
├── apps/
│   └── agentry-proxy/              # 远端代理应用（headless，570KB）
│       ├── src/main.rs           #   常驻 + 断线重连 + 首次同步
│       ├── src/config.rs         #   ~/.agentry-proxy/config.json
│       └── src/service_install.rs#   launchd / systemd 用户级服务
├── crates/
│   └── agent-core/               # 共享数据层 lib（不依赖 tauri）
│       ├── src/model.rs          #   Artifact / Connector / TaskRec / ConvBrief
│       ├── src/store.rs          #   产物索引与连接器配置的读写
│       ├── src/session.rs        #   会话扫描、标题提取、正文清洗
│       ├── src/text.rs           #   文本清洗、路径提取、忽略名单
│       ├── src/workspace.rs      #   项目名解析（显示名 / 项目目录）
│       ├── src/activity.rs       #   各工具实时执行状态
│       ├── src/sync.rs           #   产物收录管线
│       ├── src/service.rs        #   数据服务层（本机命令与远端 op 共用）
│       ├── src/proto.rs          #   线协议（帧编解码 / HMAC / req-res）
│       ├── src/tokens.rs         #   token 用量解析（消耗 + 缓存节省）
│       ├── src/stats.rs  src/paths.rs
├── src/                          # 前端（Vite，root=src → 产物在 ../dist）
│   ├── index.html  main.js  style.css
│   └── office.js  office.css  office-icons.js  office-preview.html
├── src-tauri/                    # 中心应用（GUI + hub）
│   ├── src/lib.rs                #   业务逻辑（Tauri v2 标准 lib+bin 布局）
│   ├── src/main.rs               #   薄壳：fn main() { agentry::run() }
│   ├── src/hub.rs                #   中心 hub（接受远端接入、按需拉数据）
│   ├── src/bin/agentry-center-helper.rs  # headless 中心（脚本/无界面服务器用）
│   ├── tests/hub_e2e.rs          #   协议 + 合并门面的集成测试
│   └── Cargo.toml  tauri.conf.json  build.rs  icons/
├── scripts/e2e-two-apps.mjs      # 真实双进程联调
├── connectors.json               # 连接器配置（用户设置）
├── package.json  vite.config.js
└── .gitignore
```

## 构建与验证

```bash
npm install
npm run tauri dev                   # 开发（热更，窗口）

./scripts/build-release.sh          # ⭐ 构建可分发的 release（带自检，见下）

cargo build --workspace             # 两个应用 + 共享库（不含前端，仅供开发）
cargo test -p agentry --test hub_e2e    # 协议 + 合并门面的集成测试
node scripts/e2e-two-apps.mjs                # 真实双进程联调（真的跑两个二进制）
```



## 怎么继续扩展

1. **加一个远端节点的能力**：在 `crates/agent-core/src/proto.rs` 的 `ops` 里加一个 op，
   并在 `service.rs` 的 `handle_proxy_op` 里实现它 —— 中心与远端自动都支持了。
2. **加一个连接器**：`connectors.json` 里加一项（`session_roots` 指向该工具的会话目录），
   `crates/agent-core/src/activity.rs` 里补它的品牌色与图标。
3. **改产物收录口径**：只改 `crates/agent-core/src/sync.rs` —— 中心与远端共用这一份，
   不会出现「本机有、远端没有」。
4. **改界面**：`src/` 下改前端，`npm run tauri dev` 实时看效果。

## 许可证提醒

本项目（当前自写实现）以 **MIT 许可证**发布，详见 [LICENSE](./LICENSE)。
