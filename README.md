# codex

Codex desktop-automation plugin.

This release uses the public `@rokid-prism/pluginbridge-plugin-sdk` package and the
Hub-managed Node 22 runtime. It does not search for an SDK or a Node binary in
the Prism application tree.

Current behavior:

- reads `~/.codex/session_index.jsonl` to enumerate existing Codex threads
- controls Codex Desktop through a plugin-local Codex controller built on the SDK generic CDP runtime
- selects an existing thread from the Codex sidebar by `data-app-action-sidebar-thread-id`
- creates a new Codex thread from the actual desktop sidebar / project row instead of deep-linking a thread route
- sends text by focusing the real ProseMirror composer and using CDP text injection + Enter
- switches model / reasoning / permission from the actual desktop menus through CDP
- reads and controls Codex goal state (set, edit, pause, resume, clear) from the actual desktop goal card through CDP
- reads and toggles plan mode from the actual desktop composer and `/` command panel through CDP
- resolves approval requests from the actual desktop approval UI through CDP
- interrupts the current Codex turn through the same desktop shortcut semantics, but dispatched via CDP
- waits for the Codex rollout file to produce an assistant summary after send
- verifies visibility by scanning `~/.codex/sessions/**/*.jsonl`

Current limits:

- full Codex Mini-style reliability is currently verified on macOS first
- Windows / Linux still need real-machine validation for the CDP-only launch path
- does not implement reverse sync
- approval event delivery / mobile-side lifecycle still needs further regression, but desktop-side resolve is now CDP-driven
- if Codex is already running without a CDP port, the plugin will refuse to attach unless you close Codex and let Prism manage startup, configure `PRISM_CODEX_CDP_PORT` / `PRISM_CODEX_CDP_URL`, or enable managed relaunch
- `/` command panel automation is limited to the verified goal and plan-mode entries. Skill selection, context compact, MCP selection, target selection, and other entries remain unsupported until their real Codex Desktop UI can be verified and controlled through CDP without adding Prism-side shadow state or non-CDP fallback paths.

官方推荐配置入口是 Prism Desktop 的插件页：

- 普通用户优先使用“应用路径”“数据目录”“托管启动”这些明确字段
- 只有开发者模式才会显示原始 env 覆盖
- 不要再要求用户通过一次性的 shell `export` 来启动 daemon

Recent Codex desktop builds may be hosted by `ChatGPT.app` instead of a standalone
`Codex.app`. The plugin detects both `/Applications/Codex.app` and
`/Applications/ChatGPT.app` by default。只有非标准安装位置时，才需要在
Dashboard 插件页手动指定应用路径；原始 `PRISM_CODEX_APP_PATH` 仅保留给开发者模式。

开发者模式下可用的 env 覆盖：

- `PRISM_SQLITE3_BIN`
- `PRISM_CODEX_CDP_URL`
- `PRISM_CODEX_CDP_PORT`
- `PRISM_CODEX_DEVTOOLS_FILE`
- `PRISM_CODEX_APP_PATH`
- `PRISM_CODEX_USER_DATA_DIR`
- `PRISM_PLUGIN_MANAGED_LAUNCH`

Control-path notes:

- Prism 这条线已经收口成 CDP-only，不再混用 app-server、深链切线程、剪贴板粘贴发送
  - 例外：账号额度投影（`agent_usage`）是只读诊断通道，投影 5 小时（300 分钟）和每周（10080 分钟）两个窗口；仍走 App Server 的 `account/rateLimits/read`、`account/usage/read` 与 `account/rateLimits/updated`，不参与任何 thread 控制；可执行体解析桌面 app 内置 `Contents/Resources/codex` 以复用 `~/.codex/auth.json`，PATH/npm CLI `codex` 会因 `-32600 chatgpt authentication required` 失败
- 模型 / 推理 / 权限优先走桌面 live 菜单索引点击，减少对中英文文案匹配的依赖
- manifest 将 Desktop 的模型、推理、权限声明为 `runtime_controls.*=interactive`；组合 intelligence 控件携带 `semantic_kinds: [model, reasoning]`，权限控件携带 `[permission]`。Plugin 不再同时对外发布稳定 `current_*` 控件。
- manifest 将重命名、置顶、归档、删除声明为 `runtime_operations.*=menu`；这些操作只从当前真实 Header menu-session 暴露，不再与 direct `actions[]` 重复。
- 图片发送现在通过 `ClipboardEvent + File + DataTransfer` 直接注入 Codex composer，不再回退到系统剪贴板
- `/` 命令面板能力后续也必须按 CDP-only 原则补齐；在未验证桌面真实 UI 前，不把这些能力暴露成正式手机端操作。
