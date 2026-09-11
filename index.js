#!/usr/bin/env node

process.title = process.env.PRISM_PLUGIN_PROCESS_LABEL || "prism-plugin-codex-desktop";


const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const crypto = require("crypto");
const { createCodexDesktopController, probeCodexMainPage } = require("./codex_cdp");

const execFileAsync = promisify(execFile);
const SESSION_INDEX = path.join(os.homedir(), ".codex", "session_index.jsonl");
const SESSION_ROOT = path.join(os.homedir(), ".codex", "sessions");
const PLUGIN_STATE_FILE = path.join(os.homedir(), ".prism", "codex.state.json");
const STATE_DB_CANDIDATES = [
  path.join(os.homedir(), ".codex", "state_5.sqlite"),
  path.join(os.homedir(), ".codex", "sqlite", "state_5.sqlite"),
];
const SQLITE3_BIN = process.env.PRISM_SQLITE3_BIN || "sqlite3";
const VISIBILITY_TIMEOUT_MS = 8000;
const VISIBILITY_POLL_MS = 300;
const THREAD_CREATE_TIMEOUT_MS = 12000;
const THREAD_POST_SEND_RESOLVE_MS = 8000;
const RUN_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const SQLITE_TIMEOUT_MS = 5000;
const SQLITE_QUERY_TIMEOUT_MS = 15000;
const HISTORY_PAGE_LIMIT_MAX = 80;
// Keep history reads bounded even when one native rollout contains a very
// large tool result. The remote surface prefers the newest complete turns to
// retaining an arbitrarily large JSONL file in the long-lived adapter heap.
const HISTORY_TAIL_BYTES = 4 * 1024 * 1024;
const HISTORY_RECENT_SCAN_MIN_BYTES = 16 * 1024 * 1024;
const HISTORY_RECENT_SCAN_BYTES_PER_TURN = 2 * 1024 * 1024;
const HISTORY_RECENT_SCAN_MAX_BYTES = 64 * 1024 * 1024;
const HISTORY_BODY_TURN_LIMIT_MAX = 20;
const HISTORY_REVERSE_CHUNK_BYTES = 256 * 1024;
const ROLLOUT_FULL_READ_MAX_BYTES = 2 * 1024 * 1024;
const ROLLOUT_SESSION_METADATA_HEAD_BYTES = 256 * 1024;
const RUN_TRACE_CACHE_MAX = 8;
// Remote detail is an interactive surface, not a raw rollout export. Keep a
// generous per-message budget so one malformed model response or inline image
// cannot make the Hub, Realtime relay, and Mobile renderer retain many copies
// of the same unbounded payload.
const HISTORY_MESSAGE_MAX_CHARS = 48 * 1024;
const HISTORY_PROGRESS_STEP_LIMIT = 64;
const SESSION_FILE_CACHE_MS = 1200;
const SESSION_LIST_CACHE_MS = 2500;
// listSessions feeds the compact mobile directory. It only needs a short
// title; message bodies belong to the single-session detail path.
const SESSION_LIST_TITLE_MAX_CHARS = 256;
const SESSION_LIST_DEFAULT_LIMIT = 500;
const EMPTY_SESSION_LIST_CONFIRM_DELAY_MS = 750;
const DIRECTORY_WATCH_DEBOUNCE_MS = 180;
const DIRECTORY_WATCH_RETRY_DELAYS_MS = [120, 360];
const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MODEL_OPTIONS = [];
let sessionFilesCache = { at: 0, files: [] };
let stateQueryTail = Promise.resolve();
let sessionListCache = { at: 0, threads: null, inFlight: null };
let codexDesktopControllerPromise = null;
const desktopWatchSubscribers = new Map();
const agentUsageSubscribers = new Set();
let codexAccountUsageClient = null;
let codexAccountUsageProjection = null;
let codexAccountUsageRefresh = null;
let codexAccountUsagePollTimer = null;
let codexAccountUsagePollInFlight = false;
const CODEX_ACCOUNT_USAGE_POLL_INTERVAL_MS = 60 * 1000;
// Drafts are intentionally process-local. They are not native sessions and
// must never participate in session listing, bindings, or watcher snapshots.
const mobileDrafts = new Map();
const LIVE_CONTROL_CACHE_MAX = 256;
const THREAD_METADATA_CACHE_MAX = 256;
const liveControlOptionsCache = new Map();
let desktopWatchTimer = null;
let desktopWatchInFlight = false;
let desktopControlInFlight = false;
// A control can finish after the native UI has already accepted a send, while
// the watcher is still barred from reading that transient DOM. Preserve the
// requested refresh until the exclusive CDP section releases it.
const deferredDesktopWatchBursts = new Map();
const DESKTOP_WATCH_UNAVAILABLE_AFTER_POLLS = 3;
let desktopWatchState = createDesktopWatchState();
let desktopDirectoryState = createDesktopDirectoryState();
let desktopDirectoryWatchers = [];
const DESKTOP_WATCH_BURST_DELAYS_MS = [0, 180, 500, 1100, 2200, 4500];
const DESKTOP_WATCH_EVENT_QUEUE_MAX = 64;
const DESKTOP_WATCH_TELEMETRY_INTERVAL_MS = 60 * 1000;
let desktopWatchTelemetry = createDesktopWatchTelemetry();
const PLUGIN_EVENT_NAME = "plugin.event";
// A menu session is one-shot and revalidated immediately before its click, so
// it may tolerate normal time spent reading a native menu without replay risk.
const MENU_SESSION_TTL_MS = 2 * 60 * 1000;
const MENU_SESSION_MAX = 64;
const MOBILE_DRAFT_TTL_MS = 30 * 60 * 1000;
const MOBILE_DRAFT_MAX = 32;
const CONTROL_CREATED_SURFACE_MAX = 128;
const HEADER_ARCHIVE_CONFIRM_TIMEOUT_MS = 2000;
const HEADER_ARCHIVE_CONFIRM_POLL_MS = 75;
const menuSessions = new Map();
const controlCreatedSurfaceByThread = new Map();
const DESKTOP_WATCH_SIGNATURE_DIAGNOSTIC_INTERVAL_MS = 10000;
let lastDesktopWatchSignatureDrift = { key: "", at: 0 };
// All menu readers mutate the same visible Codex UI. Serialize cold-cache
// sampling so one reader cannot close another reader's menu mid-read.
let desktopControlMenuWarmQueue = Promise.resolve();

function now() {
  return new Date().toISOString();
}

function createDesktopWatchTelemetry() {
  return {
    polls_started: 0,
    polls_completed: 0,
    polls_failed: 0,
    polls_skipped_in_flight: 0,
    polls_skipped_control: 0,
    poll_cost_ms_total: 0,
    poll_cost_ms_max: 0,
    queue_events_coalesced: 0,
    queue_overflow_closures: 0,
    queue_max_depth: 0,
    last_logged_at: Date.now(),
  };
}

function recordDesktopWatchMetric(name, value = 1) {
  if (!Object.prototype.hasOwnProperty.call(desktopWatchTelemetry, name)) return;
  desktopWatchTelemetry[name] += value;
}

function observeDesktopWatchQueueDepth(depth) {
  desktopWatchTelemetry.queue_max_depth = Math.max(
    desktopWatchTelemetry.queue_max_depth,
    Math.max(0, Number(depth) || 0),
  );
}

function logDesktopWatchTelemetry(force = false) {
  const elapsedMs = Date.now() - desktopWatchTelemetry.last_logged_at;
  if (!force && elapsedMs < DESKTOP_WATCH_TELEMETRY_INTERVAL_MS) return;
  const metrics = desktopWatchTelemetry;
  const averageMs = metrics.polls_completed > 0
    ? Math.round(metrics.poll_cost_ms_total / metrics.polls_completed)
    : 0;
  console.error(
    `[codex] watcher.metrics polls_started=${metrics.polls_started}`
      + ` polls_completed=${metrics.polls_completed}`
      + ` polls_failed=${metrics.polls_failed}`
      + ` polls_skipped_in_flight=${metrics.polls_skipped_in_flight}`
      + ` polls_skipped_control=${metrics.polls_skipped_control}`
      + ` poll_cost_ms_avg=${averageMs}`
      + ` poll_cost_ms_max=${metrics.poll_cost_ms_max}`
      + ` queue_events_coalesced=${metrics.queue_events_coalesced}`
      + ` queue_overflow_closures=${metrics.queue_overflow_closures}`
      + ` queue_max_depth=${metrics.queue_max_depth}`,
  );
  desktopWatchTelemetry = createDesktopWatchTelemetry();
}

function randomID() {
  return crypto.randomUUID();
}

function finiteNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function unixMillis(value) {
  const number = finiteNonNegativeNumber(value);
  if (number === null) return null;
  return number > 0 && number < 10_000_000_000 ? Math.round(number * 1000) : Math.round(number);
}

function mergeSparseObject(previous, next) {
  if (!next || typeof next !== "object" || Array.isArray(next)) return previous;
  const base = previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {};
  const merged = { ...base };
  for (const [key, value] of Object.entries(next)) {
    merged[key] = value && typeof value === "object" && !Array.isArray(value)
      ? mergeSparseObject(base[key], value)
      : value;
  }
  return merged;
}

function rateLimitForWindow(rateLimits, expectedWindowMinutes) {
  if (!rateLimits || typeof rateLimits !== "object") return null;
  const candidates = [];
  if (rateLimits.rateLimits && typeof rateLimits.rateLimits === "object") candidates.push(rateLimits.rateLimits);
  if (rateLimits.rateLimitsByLimitId && typeof rateLimits.rateLimitsByLimitId === "object") {
    candidates.push(...Object.values(rateLimits.rateLimitsByLimitId));
  }
  // Limits are identified by their duration, not by slot. Codex can surface a
  // window as either `primary` or `secondary` depending on the account.
  for (const candidate of candidates) {
    for (const slot of ["primary", "secondary"]) {
      const window = candidate && typeof candidate === "object" ? candidate[slot] : null;
      if (!window || typeof window !== "object") continue;
      const windowMinutes = finiteNonNegativeNumber(window.windowDurationMins);
      const usedPercent = finiteNonNegativeNumber(window.usedPercent);
      const resetsAt = unixMillis(window.resetsAt);
      if (windowMinutes !== expectedWindowMinutes || usedPercent === null || resetsAt === null) continue;
      return {
        used_percent: Math.min(100, Math.round(usedPercent)),
        window_minutes: expectedWindowMinutes,
        resets_at: resetsAt,
      };
    }
  }
  return null;
}

function fiveHourRateLimit(rateLimits) {
  return rateLimitForWindow(rateLimits, 300);
}

function weeklyRateLimit(rateLimits) {
  return rateLimitForWindow(rateLimits, 10080);
}

function accountUsageSummary(usage) {
  const summary = usage && typeof usage === "object" ? usage.summary : null;
  if (!summary || typeof summary !== "object") return null;
  const lifetimeTokens = finiteNonNegativeNumber(summary.lifetimeTokens);
  const peakDailyTokens = finiteNonNegativeNumber(summary.peakDailyTokens);
  const currentStreakDays = finiteNonNegativeNumber(summary.currentStreakDays);
  const longestStreakDays = finiteNonNegativeNumber(summary.longestStreakDays);
  if ([lifetimeTokens, peakDailyTokens, currentStreakDays, longestStreakDays].some((value) => value === null)) return null;
  return {
    lifetime_tokens: Math.round(lifetimeTokens),
    peak_daily_tokens: Math.round(peakDailyTokens),
    current_streak_days: Math.round(currentStreakDays),
    longest_streak_days: Math.round(longestStreakDays),
  };
}

// Resolve the Codex App Server executable. The CLI `codex` on PATH (npm global)
// does not share the ChatGPT desktop login and the app-server it spawns returns
// `-32600 chatgpt authentication required to read rate limits`. The desktop app
// bundles its own `codex` binary under Contents/Resources (macOS), which reuses
// the desktop session in ~/.codex/auth.json and authenticates successfully.
function codexAppServerExecutable() {
  const override = String(process.env.PRISM_CODEX_APP_SERVER_EXECUTABLE || "").trim();
  if (override) return override;
  if (process.platform === "darwin") {
    const bundles = ["/Applications/Codex.app", "/Applications/ChatGPT.app"];
    for (const bundle of bundles) {
      const cli = path.join(bundle, "Contents", "Resources", "codex");
      if (fs.existsSync(cli)) return cli;
    }
    // Honor a developer-supplied app bundle / main executable override too.
    const appPath = String(process.env.PRISM_CODEX_APP_PATH || "").trim();
    const marker = ".app/";
    const idx = appPath.indexOf(marker);
    const bundle = idx >= 0 ? appPath.slice(0, idx + marker.length - 1) : (appPath.endsWith(".app") ? appPath : "");
    if (bundle) {
      const cli = path.join(bundle, "Contents", "Resources", "codex");
      if (fs.existsSync(cli)) return cli;
    }
  }
  // Windows / Linux bundled layout is not confirmed yet; fall back to PATH.
  return "codex";
}

class CodexAppServerClient {
  constructor(onNotification, onDisconnect) {
    this.onNotification = onNotification;
    this.onDisconnect = onDisconnect;
    this.child = null;
    this.pending = new Map();
    this.nextID = 1;
    this.closed = false;
  }

  async start() {
    const executable = codexAppServerExecutable();
    this.child = spawn(executable, ["app-server", "--listen", "stdio://"], {
      argv0: "prism-codex-app-server",
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.child.stdout.setEncoding("utf8");
    let buffered = "";
    this.child.stdout.on("data", (chunk) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) this.receive(line);
        newline = buffered.indexOf("\n");
      }
    });
    this.child.once("error", (error) => this.disconnect(error));
    this.child.once("exit", () => this.disconnect(new Error("Codex App Server disconnected")));
    await this.request("initialize", {
      clientInfo: { name: "prism-codex-plugin", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
  }

  receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message && Object.prototype.hasOwnProperty.call(message, "id")) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(new Error(String(message.error.message || message.error.code || "Codex App Server request failed")));
      else pending.resolve(message.result);
      return;
    }
    if (message && message.method) this.onNotification(String(message.method), message.params);
  }

  request(method, params) {
    if (this.closed || !this.child || !this.child.stdin.writable) return Promise.reject(new Error("Codex App Server unavailable"));
    const id = String(this.nextID++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method, params) {
    if (!this.closed && this.child && this.child.stdin.writable) {
      this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    }
  }

  disconnect(error) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(error || new Error("Codex App Server disconnected"));
    this.pending.clear();
    this.onDisconnect(error);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(new Error("Codex App Server closed"));
    this.pending.clear();
    this.child?.kill();
  }
}

function emitAgentUsageUpdated() {
  for (const push of agentUsageSubscribers) {
    push({
      ID: randomID(),
      Type: "agent.usage.updated",
      Status: "completed",
      Summary: "Codex 账户用量已更新。",
      Payload: {},
      CreatedAt: now(),
    });
  }
}

function setCodexAccountUsageProjection(next) {
  const normalized = next && (next.five_hour || next.weekly || next.account_summary) ? next : null;
  if (JSON.stringify(normalized) === JSON.stringify(codexAccountUsageProjection)) return;
  codexAccountUsageProjection = normalized;
  emitAgentUsageUpdated();
}

async function refreshCodexAccountUsage(client, latestRateLimits = null) {
  if (!client || client !== codexAccountUsageClient) return;
  try {
    const rateLimits = latestRateLimits || await client.request("account/rateLimits/read", null);
    const usage = await client.request("account/usage/read", null);
    if (client !== codexAccountUsageClient) return;
    const fiveHour = fiveHourRateLimit(rateLimits);
    const weekly = weeklyRateLimit(rateLimits);
    const accountSummary = accountUsageSummary(usage);
    setCodexAccountUsageProjection({
      ...(fiveHour ? { five_hour: fiveHour } : {}),
      ...(weekly ? { weekly } : {}),
      ...(accountSummary ? { account_summary: accountSummary } : {}),
      updated_at: Date.now(),
    });
    client.latestRateLimits = rateLimits;
  } catch (error) {
    if (client === codexAccountUsageClient) {
      console.error(`[codex] account usage unavailable: ${error && error.message ? error.message : String(error)}`);
      setCodexAccountUsageProjection(null);
    }
  }
}

// Codex normally notifies rate-limit changes, but a weekly reset may happen
// without a notification on an otherwise healthy App Server connection. The
// dashboard already polls as a fallback; the plugin must do the same so the
// catalog snapshot sent to Panel cannot remain stale indefinitely.
function startCodexAccountUsagePolling() {
  if (codexAccountUsagePollTimer) return;
  codexAccountUsagePollTimer = setInterval(() => {
    if (!agentUsageSubscribers.size) {
      stopCodexAccountUsagePolling();
      return;
    }
    if (codexAccountUsagePollInFlight) return;
    codexAccountUsagePollInFlight = true;
    void (async () => {
      const client = await ensureCodexAccountUsageClient();
      if (client) await refreshCodexAccountUsage(client);
    })().finally(() => {
      codexAccountUsagePollInFlight = false;
    });
  }, CODEX_ACCOUNT_USAGE_POLL_INTERVAL_MS);
}

function stopCodexAccountUsagePolling() {
  if (!codexAccountUsagePollTimer) return;
  clearInterval(codexAccountUsagePollTimer);
  codexAccountUsagePollTimer = null;
}

async function ensureCodexAccountUsageClient() {
  if (codexAccountUsageClient && !codexAccountUsageClient.closed) return codexAccountUsageClient;
  const client = new CodexAppServerClient((method, params) => {
    if (method !== "account/rateLimits/updated") return;
    client.latestRateLimits = mergeSparseObject(client.latestRateLimits, params);
    const previous = codexAccountUsageProjection && codexAccountUsageProjection.account_summary;
    const fiveHour = fiveHourRateLimit(client.latestRateLimits);
    const weekly = weeklyRateLimit(client.latestRateLimits);
    setCodexAccountUsageProjection({
      ...(fiveHour ? { five_hour: fiveHour } : {}),
      ...(weekly ? { weekly } : {}),
      ...(previous ? { account_summary: previous } : {}),
      updated_at: Date.now(),
    });
    void refreshCodexAccountUsage(client, client.latestRateLimits);
  }, () => {
    if (codexAccountUsageClient === client) {
      codexAccountUsageClient = null;
      setCodexAccountUsageProjection(null);
    }
  });
  codexAccountUsageClient = client;
  try {
    await client.start();
    codexAccountUsageRefresh = refreshCodexAccountUsage(client);
    await codexAccountUsageRefresh;
    return client;
  } catch (error) {
    if (codexAccountUsageClient === client) codexAccountUsageClient = null;
    client.close();
    setCodexAccountUsageProjection(null);
    return null;
  }
}

async function readAgentUsage() {
  await ensureCodexAccountUsageClient();
  return codexAccountUsageProjection ? JSON.parse(JSON.stringify(codexAccountUsageProjection)) : null;
}

async function codexDesktopController() {
  if (!codexDesktopControllerPromise) {
    codexDesktopControllerPromise = Promise.resolve(
      createCodexDesktopController({
        connectTimeoutMs: 15000,
        readyTimeoutMs: 15000,
      }),
    );
  }
  const controller = await codexDesktopControllerPromise;
  await controller.ensureReady();
  return controller;
}

function logTiming(label, startedAt, extra = {}) {
  const costMs = Date.now() - startedAt;
  const suffix = Object.entries(extra)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== "")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  console.error(`[codex] ${label} costMs=${costMs}${suffix ? ` ${suffix}` : ""}`);
}

function logControlDebug(stage, extra = {}) {
  const suffix = Object.entries(extra)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== "")
    .map(([key, value]) => `${key}=${truncateText(String(value), 240)}`)
    .join(" ");
  console.error(`[codex] control.${stage}${suffix ? ` ${suffix}` : ""}`);
}

function truncateText(value, max = 700) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function compactListText(value, max = 180) {
  const text = String(value || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
  return truncateText(text, max);
}

function cloneOptionRows(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return [];
  return rows
    .filter((row) => row && typeof row === "object")
    .map((row) => ({ ...row }));
}

function cloneInteractiveControls(controls = []) {
  if (!Array.isArray(controls)) return [];
  return controls
    .filter((control) => control && typeof control === "object")
    .map((control) => ({
      control_id: String(control.control_id || "").trim(),
      display_label: String(control.display_label || "").trim(),
      current_value: String(control.current_value || "").trim(),
      menu_available: control.menu_available !== false,
      semantic_kinds: Array.from(new Set(
        (Array.isArray(control.semantic_kinds) ? control.semantic_kinds : [])
          .map((kind) => String(kind || "").trim().toLowerCase())
          .filter((kind) => ["model", "reasoning", "permission"].includes(kind)),
      )),
    }));
}

function liveControlOptionsCacheEntry(threadID = "") {
  if (!isThreadID(threadID)) return null;
  const cached = liveControlOptionsCache.get(threadID);
  if (!cached || typeof cached !== "object") return null;
  retainRecentCacheEntry(liveControlOptionsCache, threadID, cached, LIVE_CONTROL_CACHE_MAX);
  return {
    modelOptions: cloneOptionRows(cached.modelOptions),
    reasoningOptions: cloneOptionRows(cached.reasoningOptions),
    approvalOptions: cloneOptionRows(cached.approvalOptions),
    interactiveControls: cloneInteractiveControls(cached.interactiveControls),
    updatedAt: cached.updatedAt || 0,
  };
}

function rememberLiveControlOptions(threadID = "", details = {}) {
  if (!isThreadID(threadID) || !details || typeof details !== "object") return;
  const previous = liveControlOptionsCache.get(threadID) || {};
  const nextModelOptions = preserveStructuredControlOptions(previous.modelOptions, details.modelOptions);
  const nextReasoningOptions = preserveStructuredControlOptions(previous.reasoningOptions, details.reasoningOptions);
  const nextApprovalOptions = preserveStructuredControlOptions(previous.approvalOptions, details.approvalOptions);
  const nextInteractiveControls = Object.prototype.hasOwnProperty.call(details, "interactiveControls")
    ? cloneInteractiveControls(details.interactiveControls)
    : cloneInteractiveControls(previous.interactiveControls);
  retainRecentCacheEntry(liveControlOptionsCache, threadID, {
    modelOptions: nextModelOptions,
    reasoningOptions: nextReasoningOptions,
    approvalOptions: nextApprovalOptions,
    interactiveControls: nextInteractiveControls,
    updatedAt: Date.now(),
  }, LIVE_CONTROL_CACHE_MAX);
}

// React Fiber exposes labels and current values, but not an executable menu
// row. Retain options from a visible desktop menu until another menu read
// replaces them.
function preserveStructuredControlOptions(previous = [], candidate = []) {
  const previousRows = cloneOptionRows(previous);
  const candidateRows = cloneOptionRows(candidate);
  if (!candidateRows.length) return previousRows;
  if (hasStructuredControlOptions(previousRows) && !hasStructuredControlOptions(candidateRows)) {
    return previousRows;
  }
  return candidateRows;
}

// Kept for legacy cache migration only. Codex's live path now stores
// interactive_controls and never promotes Fiber candidates into this shape.
function hasStructuredControlOptions(options) {
  return Array.isArray(options) && options.some((option) =>
    option && option.menuVerified === true && String(option.id || "").trim(),
  );
}

function invalidatePermissionOptions(threadID = "") {
  if (!isThreadID(threadID)) return;
  const cached = liveControlOptionsCache.get(threadID) || {};
  retainRecentCacheEntry(liveControlOptionsCache, threadID, {
    modelOptions: cloneOptionRows(cached.modelOptions),
    reasoningOptions: cloneOptionRows(cached.reasoningOptions),
    approvalOptions: [],
    interactiveControls: cloneInteractiveControls(cached.interactiveControls),
    updatedAt: Date.now(),
  }, LIVE_CONTROL_CACHE_MAX);
}

function invalidateIntelligenceOptions(threadID = "", kind = "") {
  if (!isThreadID(threadID)) return;
  const cached = liveControlOptionsCache.get(threadID) || {};
  const next = {
    modelOptions: cloneOptionRows(cached.modelOptions),
    reasoningOptions: cloneOptionRows(cached.reasoningOptions),
    approvalOptions: cloneOptionRows(cached.approvalOptions),
    interactiveControls: cloneInteractiveControls(cached.interactiveControls),
    updatedAt: Date.now(),
  };
  if (kind === "model" || !kind) next.modelOptions = [];
  if (kind === "reasoning" || !kind) next.reasoningOptions = [];
  retainRecentCacheEntry(liveControlOptionsCache, threadID, next, LIVE_CONTROL_CACHE_MAX);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return "";
}

function isThreadID(value) {
  return THREAD_ID_RE.test(String(value || "").trim());
}

function createDesktopWatchState() {
  return {
    lastValidThreadID: "",
    consecutiveInvalidPolls: 0,
    unavailable: false,
  };
}

function createDesktopDirectoryState() {
  return {
    initialized: false,
    threads: new Map(),
    debounceTimer: null,
    running: false,
    dirty: false,
    retryAttempt: 0,
  };
}

function desktopDirectoryEntrySignature(thread = {}) {
  return JSON.stringify({
    id: firstNonEmpty(thread && thread.id),
    title: firstNonEmpty(thread && thread.title),
    cwd: firstNonEmpty(thread && thread.cwd),
    sort_at_ms: firstNonEmpty(thread && thread.metadata && thread.metadata.sort_at_ms),
    pinned: firstNonEmpty(thread && thread.metadata && thread.metadata.pinned),
  });
}

function desktopDirectoryDiff(previous = new Map(), threads = []) {
  const next = new Map();
  const added = [];
  const changed = [];
  const removed = [];
  for (const thread of Array.isArray(threads) ? threads : []) {
    const threadID = firstNonEmpty(thread && thread.id);
    if (!isThreadID(threadID)) continue;
    next.set(threadID, thread);
    const before = previous.get(threadID);
    if (!before) {
      added.push(thread);
    } else if (desktopDirectoryEntrySignature(before) !== desktopDirectoryEntrySignature(thread)) {
      changed.push(thread);
    }
  }
  for (const [threadID, thread] of previous.entries()) {
    if (!next.has(threadID)) removed.push(thread);
  }
  return { next, added, changed, removed };
}

// A valid observation is the only source of foreground truth. Keeping this
// state separate from individual subscriptions lets one desktop watcher report
// the same outage consistently to every affected canonical conversation.
function observeDesktopWatchForeground(state, threadID) {
  const next = state && typeof state === "object" ? state : createDesktopWatchState();
  if (!isThreadID(threadID)) {
    next.consecutiveInvalidPolls += 1;
    const becameUnavailable = next.consecutiveInvalidPolls >= DESKTOP_WATCH_UNAVAILABLE_AFTER_POLLS && !next.unavailable;
    if (becameUnavailable) {
      next.unavailable = true;
    }
    return {
      valid: false,
      becameUnavailable,
      recovered: false,
      previousThreadID: next.lastValidThreadID,
      switched: false,
    };
  }

  const previousThreadID = next.lastValidThreadID;
  const recovered = next.unavailable;
  next.lastValidThreadID = threadID;
  next.consecutiveInvalidPolls = 0;
  next.unavailable = false;
  return {
    valid: true,
    becameUnavailable: false,
    recovered,
    previousThreadID,
    switched: isThreadID(previousThreadID) && previousThreadID !== threadID,
  };
}

// A raw Codex dialog is not automatically a remote interaction. A one-shot
// Mobile result may register it directly; Desktop permission confirmation is
// registered by the page's structural capability tracker. Other dialogs stay
// deny-by-default.
function surfaceCapability(surface, fallback = "") {
  const actual = String(surface && surface.capability || "").trim();
  const expected = String(fallback || actual).trim();
  return actual && expected && actual !== expected ? "" : expected;
}

function rememberControlCreatedSurface(threadID, surface, capability = "") {
  const surfaceID = String(surface && surface.surface_id || "").trim();
  const expectedCapability = surfaceCapability(surface, capability);
  if (!isThreadID(threadID)) return;
  controlCreatedSurfaceByThread.delete(threadID);
  if (!surfaceID || !expectedCapability) return;
  controlCreatedSurfaceByThread.set(threadID, { surfaceID, capability: expectedCapability });
  while (controlCreatedSurfaceByThread.size > CONTROL_CREATED_SURFACE_MAX) {
    controlCreatedSurfaceByThread.delete(controlCreatedSurfaceByThread.keys().next().value);
  }
}

function registeredSurfaceForPublication(surface, expectedCapability) {
  const actualCapability = surfaceCapability(surface);
  if (actualCapability && actualCapability !== expectedCapability) return null;
  if (actualCapability) return surface;
  return { ...surface, capability: expectedCapability };
}

function interactiveSurfaceForForeground(state, transition, threadID, surface) {
  void state;
  if (transition && transition.switched && isThreadID(transition.previousThreadID)) {
    controlCreatedSurfaceByThread.delete(transition.previousThreadID);
  }
  const surfaceID = String(surface && surface.surface_id || "").trim();
  if (!isThreadID(threadID)) return null;
  const expected = controlCreatedSurfaceByThread.get(threadID);
  const expectedSurfaceID = String(expected && expected.surfaceID || "").trim();
  const expectedCapability = String(expected && expected.capability || "").trim();
  if (surfaceID && surfaceID === expectedSurfaceID && expectedCapability) {
    const published = registeredSurfaceForPublication(surface, expectedCapability);
    if (published) return published;
  }
  if (surfaceID && surfaceCapability(surface) === "permission_confirmation") {
    controlCreatedSurfaceByThread.delete(threadID);
    controlCreatedSurfaceByThread.set(threadID, { surfaceID, capability: "permission_confirmation" });
    while (controlCreatedSurfaceByThread.size > CONTROL_CREATED_SURFACE_MAX) {
      controlCreatedSurfaceByThread.delete(controlCreatedSurfaceByThread.keys().next().value);
    }
    return surface;
  }
  controlCreatedSurfaceByThread.delete(threadID);
  return null;
}

function readCodexConfigText() {
  try {
    return fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
  } catch {
    return "";
  }
}

function tomlStringValue(text, key) {
  const escaped = String(key || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(text || "").match(new RegExp(`^\\s*${escaped}\\s*=\\s*"([^"]*)"\\s*$`, "m"));
  return match ? match[1] : "";
}

function runtimeSandboxPolicyFromResult(result = {}) {
  const sandbox = result && result.sandbox && typeof result.sandbox === "object" ? result.sandbox : null;
  if (!sandbox || !sandbox.type) {
    return "";
  }
  if (sandbox.type === "dangerFullAccess") {
    return JSON.stringify({ type: "disabled" });
  }
  return JSON.stringify(sandbox);
}

// The plugin state file is read once per thread row on every session-list
// refresh. Cache the parsed object while size + mtime are unchanged; the
// file is only written by this process, and writes refresh the cache.
const pluginStateCache = { fingerprint: "", state: null };

function readPluginState() {
  try {
    const stat = safeStat(PLUGIN_STATE_FILE);
    if (!stat) {
      return {};
    }
    const fingerprint = `${stat.size}|${stat.mtimeMs}`;
    if (pluginStateCache.state && pluginStateCache.fingerprint === fingerprint) {
      return pluginStateCache.state;
    }
    const parsed = JSON.parse(fs.readFileSync(PLUGIN_STATE_FILE, "utf8"));
    const state = parsed && typeof parsed === "object" ? parsed : {};
    pluginStateCache.fingerprint = fingerprint;
    pluginStateCache.state = state;
    return state;
  } catch {
    return {};
  }
}

function writePluginState(state) {
  fs.mkdirSync(path.dirname(PLUGIN_STATE_FILE), { recursive: true });
  fs.writeFileSync(PLUGIN_STATE_FILE, `${JSON.stringify(state || {}, null, 2)}\n`, "utf8");
  const stat = safeStat(PLUGIN_STATE_FILE);
  pluginStateCache.fingerprint = stat ? `${stat.size}|${stat.mtimeMs}` : "";
  pluginStateCache.state = state && typeof state === "object" ? state : {};
}

function threadPluginState(threadID) {
  const state = readPluginState();
  const threads = state.threads && typeof state.threads === "object" ? state.threads : {};
  return threads[threadID] && typeof threads[threadID] === "object" ? threads[threadID] : {};
}

function updateThreadPluginState(threadID, patch) {
  if (!isThreadID(threadID)) return {};
  const state = readPluginState();
  const threads = state.threads && typeof state.threads === "object" ? state.threads : {};
  const next = {
    ...(threads[threadID] || {}),
    ...patch,
    updatedAt: now(),
  };
  state.threads = { ...threads, [threadID]: next };
  writePluginState(state);
  return next;
}

function startedSessionState(messageID) {
  const state = readPluginState();
  const starts = state.starts && typeof state.starts === "object" ? state.starts : {};
  const value = starts[messageID];
  return value && typeof value === "object" ? value : null;
}

function updateStartedSessionState(messageID, patch) {
  const normalized = firstNonEmpty(messageID);
  if (!normalized) return null;
  const state = readPluginState();
  const starts = state.starts && typeof state.starts === "object" ? state.starts : {};
  const next = { ...(starts[normalized] || {}), ...patch, updatedAt: now() };
  state.starts = { ...starts, [normalized]: next };
  writePluginState(state);
  return next;
}

function truthyString(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "true" || text === "1" || text === "yes";
}

function recentlyUpdated(isoText = "", windowMs = 5000) {
  const value = Date.parse(String(isoText || "").trim());
  if (!Number.isFinite(value) || value <= 0) return false;
  return Math.abs(Date.now() - value) <= windowMs;
}

function validLocalDirectory(value) {
  const normalized = value ? path.normalize(value) : "";
  if (!normalized || !path.isAbsolute(normalized)) return "";
  try {
    return fs.statSync(normalized).isDirectory() ? normalized : "";
  } catch {
    return "";
  }
}

function classifyThreadProject(cwd = "") {
  const normalized = cwd ? path.normalize(cwd) : "";
  const codexScratchRoot = path.join(os.homedir(), "Documents", "Codex");
  const relativeToScratch = normalized ? path.relative(codexScratchRoot, normalized) : "";
  const isGeneratedProjectless = Boolean(
    normalized &&
    relativeToScratch &&
    !relativeToScratch.startsWith("..") &&
    !path.isAbsolute(relativeToScratch) &&
    /^\d{4}-\d{2}-\d{2}(?:$|[\\/])/.test(relativeToScratch)
  );
  if (!normalized || isGeneratedProjectless) {
    return {
      isProjectThread: false,
      projectKey: "conversation",
      projectName: "对话",
      projectPath: "",
    };
  }
  return {
    isProjectThread: true,
    projectKey: normalized,
    projectName: path.basename(normalized) || normalized,
    projectPath: normalized,
  };
}

function projectCwdOrEmpty(value = "") {
  const cwd = validLocalDirectory(value);
  if (!cwd) return "";
  return classifyThreadProject(cwd).isProjectThread ? cwd : "";
}

function labelFromModelName(name = "") {
  const text = String(name || "").trim();
  if (!text) return "";
  return text
    .replace(/[（(].*?[）)]/g, "")
    .replace(/^GPT-/i, "")
    .replace(/^gpt-/i, "")
    .replace(/^codex-/i, "")
    .trim() || text;
}

function normalizeControlLabel(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizedKey(value = "") {
  return normalizeControlLabel(value).toLowerCase();
}

function isGenericDesktopModelLabel(value = "") {
  const normalized = normalizedKey(value);
  if (!normalized) return false;
  return normalized === "custom"
    || normalized === "advanced"
    || normalized === "高级"
    || normalized === "advanced options"
    || normalized === "自定义";
}

function normalizeModelOption(row = {}) {
  const id = String(row.slug || row.id || row.model || "").trim();
  if (!id) return null;
  const displayName = String(row.display_name || row.name || row.label || id).trim();
  return {
    key: id,
    id,
    label: labelFromModelName(displayName || id),
    displayName: displayName || id,
    source: "local",
  };
}

let modelCatalogCache = { mtimeMs: -1, path: "", models: null };

function builtinModelOptions(current = "") {
  const items = DEFAULT_MODEL_OPTIONS.map((row) => ({ ...row }));
  const currentID = String(current || "").trim();
  if (currentID && !items.some((row) => row.id === currentID || row.key === currentID)) {
    items.unshift({
      key: currentID,
      id: currentID,
      label: labelFromModelName(currentID),
      displayName: currentID,
      source: "builtin-current",
    });
  }
  return items;
}

function readModelCatalogOptions() {
  const configText = readCodexConfigText();
  const catalogPath = tomlStringValue(configText, "model_catalog_json");
  const resolvedPath = catalogPath.startsWith("~") ? path.join(os.homedir(), catalogPath.slice(1)) : catalogPath;
  const fallback = () => {
    const current = tomlStringValue(configText, "model");
    return builtinModelOptions(current);
  };
  if (!resolvedPath) return fallback();
  let stat;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    return fallback();
  }
  if (modelCatalogCache.models && modelCatalogCache.path === resolvedPath && modelCatalogCache.mtimeMs === stat.mtimeMs) {
    return modelCatalogCache.models;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
    const models = (Array.isArray(parsed.models) ? parsed.models : [])
      .filter((row) => row && row.visibility !== "hide")
      .map(normalizeModelOption)
      .filter(Boolean);
    modelCatalogCache = { path: resolvedPath, mtimeMs: stat.mtimeMs, models };
    return models.length ? models : fallback();
  } catch {
    return fallback();
  }
}

function hasModelCatalogConfigured() {
  const configText = readCodexConfigText();
  return Boolean(tomlStringValue(configText, "model_catalog_json"));
}

function findModelOption(id = "") {
  const targetID = String(id || "").trim();
  if (!targetID) return null;
  return readModelCatalogOptions().find((item) => item.id === targetID || item.key === targetID) || null;
}

function findModelOptionByText(value = "") {
  const target = normalizedKey(value)
    .replace(/^gpt-/i, "")
    .replace(/^codex-/i, "")
    .trim();
  if (!target) return null;
  return readModelCatalogOptions().find((item) => {
    const texts = [
      item.id,
      item.key,
      item.label,
      item.displayName,
      labelFromModelName(item.displayName),
    ]
      .map((part) => normalizedKey(part).replace(/^gpt-/i, "").replace(/^codex-/i, "").trim())
      .filter(Boolean);
    return texts.includes(target);
  }) || null;
}

async function queryDistinctThreadColumn(column) {
  const safe = String(column || "").trim();
  if (!/^[a-z_][a-z0-9_]*$/i.test(safe)) {
    return [];
  }
  const rows = await queryStateRows(`
    SELECT DISTINCT TRIM(${safe}) AS value
    FROM threads
    WHERE COALESCE(archived, 0) = 0
      AND TRIM(COALESCE(${safe}, '')) != ''
    ORDER BY value;
  `).catch(() => []);
  return rows
    .map((row) => String(row && row.value || "").trim())
    .filter(Boolean);
}

let observedApprovalOptionsCache = { at: 0, items: [] };

function codexInstalled() {
  if (process.platform === "darwin") {
    const configured = process.env.PRISM_CODEX_APP_PATH;
    if (configured) {
      return fs.existsSync(configured);
    }
    return fs.existsSync("/Applications/Codex.app") || fs.existsSync("/Applications/ChatGPT.app");
  }
  if (process.platform === "win32") {
    return Boolean(process.env.PRISM_CODEX_APP_PATH || process.env.PRISM_CODEX_WINDOW_TITLE);
  }
  if (process.platform === "linux") {
    return Boolean(process.env.PRISM_CODEX_APP_COMMAND || process.env.PRISM_CODEX_WINDOW_TITLE);
  }
  return false;
}

function stateDBPath() {
  for (const candidate of STATE_DB_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "";
}

function sqliteEscape(value) {
  return String(value || "").replace(/'/g, "''");
}

async function queryStateRows(sql) {
  // Codex updates its local state database while the desktop watcher, index
  // publisher, and explicit RPCs may all read it. sqlite3 child processes are
  // not safe to fan out here: concurrent reads have produced truncated JSON
  // and transient empty results. Keep the local DB read path serialized.
  const previous = stateQueryTail;
  let release;
  stateQueryTail = new Promise((resolve) => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  try {
    const db = stateDBPath();
    if (!db) {
      return [];
    }
    const { stdout } = await execFileAsync(
      SQLITE3_BIN,
      ["-cmd", `.timeout ${SQLITE_TIMEOUT_MS}`, "-json", db, sql],
      {
        timeout: SQLITE_QUERY_TIMEOUT_MS,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    const raw = String(stdout || "").trim();
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } finally {
    release();
  }
}

async function execStateSQL(sql) {
  const db = stateDBPath();
  if (!db) {
    throw new Error("Codex state database not found");
  }
  await execFileAsync(
    SQLITE3_BIN,
    ["-cmd", `.timeout ${SQLITE_TIMEOUT_MS}`, db, sql],
    {
      timeout: SQLITE_QUERY_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    },
  );
}

async function updateThreadStateColumns(threadID, columns) {
  if (!isThreadID(threadID)) {
    throw new Error("线程 ID 不正确。");
  }
  const assignments = [];
  for (const [key, value] of Object.entries(columns || {})) {
    const column = String(key || "").trim();
    if (!/^[a-z_][a-z0-9_]*$/i.test(column)) continue;
    if (typeof value === "number" && Number.isFinite(value)) {
      assignments.push(`${column} = ${value}`);
    } else {
      assignments.push(`${column} = '${sqliteEscape(String(value ?? ""))}'`);
    }
  }
  if (!assignments.length) return;
  await execStateSQL(`
    UPDATE threads
    SET ${assignments.join(", ")}
    WHERE id = '${sqliteEscape(threadID)}';
  `);
}

function rowToThreadItem(row, sessionIndexTitle = "", options = {}) {
  const updatedAtMs = Number(row && row.updated_at_ms) || 0;
  const createdAtMs = Number(row && row.created_at_ms) || 0;
  const recencyAtMs = Number(row && row.recency_at_ms) || updatedAtMs || createdAtMs || 0;
  const id = firstNonEmpty(row && row.id);
  const localState = threadPluginState(id);
  const pinned = typeof localState.pinned === "boolean"
    ? String(localState.pinned)
    : firstNonEmpty(row && row.pinned, row && row.is_pinned);
  const metadata = {
    provider: firstNonEmpty(row && row.model_provider),
    model: firstNonEmpty(row && row.model, localState.model),
    reasoning_effort: firstNonEmpty(row && row.reasoning_effort, localState.reasoning_effort),
    sandbox_policy: firstNonEmpty(localState.sandbox_policy, row && row.sandbox_policy),
    approval_mode: firstNonEmpty(row && row.approval_mode, localState.approval_mode),
    memory_mode: firstNonEmpty(row && row.memory_mode),
    agent_nickname: firstNonEmpty(row && row.agent_nickname),
    thread_source: firstNonEmpty(row && row.thread_source),
    recency_at_ms: String(recencyAtMs || ""),
    sort_at_ms: String(recencyAtMs || updatedAtMs || ""),
    pinned,
  };
  if (options.includeMessageFallback) {
    metadata.first_user_message = compactListText(row && row.first_user_message, 220);
    metadata.preview = compactListText(row && row.preview, 220);
  }
  const title = firstNonEmpty(
    compactListText(localState.title, 120),
    compactListText(sessionIndexTitle, 120),
    compactListText(row && row.title, 120),
    options.includeMessageFallback ? metadata.first_user_message : "",
    options.includeMessageFallback ? metadata.preview : "",
  );
  return {
    id,
    title,
    updatedAt: updatedAtMs > 0 ? new Date(updatedAtMs).toISOString() : now(),
    sortAt: recencyAtMs > 0 ? new Date(recencyAtMs).toISOString() : (updatedAtMs > 0 ? new Date(updatedAtMs).toISOString() : now()),
    updatedAtMs,
    recencyAtMs,
    createdAtMs,
    cwd: firstNonEmpty(row && row.cwd),
    rolloutPath: firstNonEmpty(row && row.rollout_path),
    metadata: Object.fromEntries(Object.entries(metadata).filter(([, value]) => value)),
  };
}

// Head metadata is re-derived on every watcher refresh for every listed
// thread. Eagerly JSON-parsing the whole head buffer (rows can each be
// multi-megabyte response items) pegged the plugin CPU, so cache by the
// file fingerprint and stop parsing at the first session_meta row.
const ROLLOUT_HEAD_METADATA_SCAN_LINES = 64;
const rolloutHeadMetadataCache = new Map();

function rolloutSessionMetadata(file) {
  if (!file) {
    return {};
  }
  const stat = safeStat(file);
  if (!stat || stat.size <= 0) {
    return {};
  }
  const fingerprint = `${file}|${stat.size}|${stat.mtimeMs}`;
  const cached = rolloutHeadMetadataCache.get(file);
  if (cached && cached.fingerprint === fingerprint) {
    return cached.metadata;
  }
  const metadata = readRolloutHeadMetadata(file, stat);
  retainRecentCacheEntry(rolloutHeadMetadataCache, file, { fingerprint, metadata }, HISTORY_AUX_CACHE_MAX);
  return metadata;
}

function readRolloutHeadMetadata(file, stat) {
  // session_meta is written at the very beginning of a rollout. Parse head
  // lines lazily and stop at the first session_meta row instead of parsing
  // every head line; a scan cap bounds the no-session_meta case.
  const size = Math.min(stat.size, ROLLOUT_SESSION_METADATA_HEAD_BYTES);
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(size);
    fs.readSync(fd, buffer, 0, size, 0);
    let scanned = 0;
    for (const line of buffer.toString("utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      scanned += 1;
      if (scanned > ROLLOUT_HEAD_METADATA_SCAN_LINES) break;
      let row;
      try {
        row = JSON.parse(trimmed);
      } catch {
        // Ignore partial rows still being written.
        continue;
      }
      if (!row || row.type !== "session_meta" || !row.payload || typeof row.payload !== "object") {
        continue;
      }
      const payload = row.payload;
      return {
        cwd: firstNonEmpty(payload.cwd),
        thread_source: firstNonEmpty(payload.thread_source, payload.source),
        model: firstNonEmpty(payload.model),
        model_provider: firstNonEmpty(payload.model_provider),
        approval_mode: firstNonEmpty(payload.approval_policy, payload.approval_mode),
      };
    }
  } finally {
    fs.closeSync(fd);
  }
  return {};
}

function enrichThreadItemWithRollout(item) {
  if (!item || !isThreadID(item.id)) {
    return item;
  }
  const file = item.rolloutPath && fs.existsSync(item.rolloutPath) && !isArchivedRolloutPath(item.rolloutPath)
    ? item.rolloutPath
    : findRolloutFileFromScan(item.id);
  const rollout = rolloutSessionMetadata(file);
  if (!rollout || Object.keys(rollout).length === 0) {
    return item;
  }
  const metadata = {
    ...(item.metadata || {}),
    provider: firstNonEmpty(item.metadata && item.metadata.provider, rollout.model_provider),
    model: firstNonEmpty(item.metadata && item.metadata.model, rollout.model),
    approval_mode: firstNonEmpty(item.metadata && item.metadata.approval_mode, rollout.approval_mode),
    thread_source: firstNonEmpty(rollout.thread_source, item.metadata && item.metadata.thread_source),
  };
  return {
    ...item,
    cwd: firstNonEmpty(rollout.cwd, item.cwd),
    rolloutPath: firstNonEmpty(file, item.rolloutPath),
    metadata: Object.fromEntries(Object.entries(metadata).filter(([, value]) => value)),
  };
}

function isArchivedRolloutPath(file) {
  const normalized = String(file || "");
  return normalized.includes(`${path.sep}.codex${path.sep}archived_sessions${path.sep}`) ||
    normalized.includes(`${path.sep}archived_sessions${path.sep}`);
}

function isUserVisibleThread(item) {
  const source = String(item && item.metadata && item.metadata.thread_source || "").trim().toLowerCase();
  return source === "" || source === "user";
}

function isDesktopVisibleThread(item, sessionIndexMap) {
  if (!item || !isThreadID(item.id)) {
    return false;
  }
  if (!sessionIndexMap || sessionIndexMap.size === 0) {
    return true;
  }
  if (sessionIndexMap.has(item.id)) {
    return true;
  }
  const updatedAtMs = Number(item.updatedAtMs) || 0;
  // Codex may write SQLite before session_index.jsonl for a brand-new thread.
  // Keep a short grace window so new mobile-created conversations appear
  // quickly, but old state-only test/probe threads stay hidden like Desktop.
  return updatedAtMs > 0 && Date.now() - updatedAtMs < 10 * 60 * 1000;
}

async function readThreadsFromState(limit = 0, options = {}) {
  const startedAt = Date.now();
  const sessionIndexMap = new Map(readSessionIndex().map((item) => [item.id, item.title]));
  const requestedLimit = Number(limit);
  const queryLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.max(1, Math.floor(requestedLimit))
    : SESSION_LIST_DEFAULT_LIMIT;
  const sqlLimit = `\n    LIMIT ${Math.max(queryLimit, Math.min(SESSION_LIST_DEFAULT_LIMIT, queryLimit * 4))}`;
  const rows = await queryStateRows(`
    SELECT
      id,
      substr(title, 1, ${SESSION_LIST_TITLE_MAX_CHARS}) AS title,
      cwd,
      rollout_path,
      tokens_used,
      model_provider,
      model,
      reasoning_effort,
      sandbox_policy,
      approval_mode,
      memory_mode,
      agent_nickname,
      thread_source,
      updated_at_ms,
      created_at_ms,
      recency_at_ms
    FROM threads
    WHERE archived = 0
    ORDER BY recency_at_ms DESC, updated_at_ms DESC${sqlLimit};
  `);
  let items = rows
    .map((row) => rowToThreadItem(row, sessionIndexMap.get(firstNonEmpty(row && row.id)) || ""))
    .map(enrichThreadItemWithRollout)
    .filter((item) => isThreadID(item.id) && isUserVisibleThread(item) && isDesktopVisibleThread(item, sessionIndexMap))
    .slice(0, queryLimit || undefined);
  if (options && options.includeDesktopSnapshot) {
    const desktopSnapshot = await currentDesktopConversationSnapshot().catch(() => null);
    items = items.map((item) => mergeThreadItemWithDesktopRuntime(item, desktopSnapshot));
  }
  logTiming("readThreadsFromState", startedAt, {
    limit: queryLimit,
    include_desktop_snapshot: options && options.includeDesktopSnapshot ? "true" : "false",
    count: items.length,
  });
  return items;
}

// Thread metadata cache. findThreadByID runs a sqlite3 subprocess (queryStateRows) plus a
// synchronous SESSION_INDEX read on every call. The watcher poll loop calls it multiple times
// per 900ms cycle (via threadMessagesSignature -> findRolloutFile, readLiveComposerControls, etc),
// which spawned dozens of sqlite3 processes per second and pegged the plugin at 100%+ CPU.
// Thread metadata (cwd, rollout_path, title) is quasi-static, so a short TTL is safe.
const THREAD_CACHE_TTL_MS = 3000;
const threadMetadataCache = new Map();

async function findThreadByID(threadID, options = {}) {
  const normalized = firstNonEmpty(threadID);
  if (!isThreadID(normalized)) {
    return null;
  }
  // includeDesktopSnapshot reads live desktop state, so it must not be cached.
  if (!options || !options.includeDesktopSnapshot) {
    const cached = threadMetadataCache.get(normalized);
    if (cached && Date.now() - cached.at < THREAD_CACHE_TTL_MS) {
      retainRecentCacheEntry(threadMetadataCache, normalized, cached, THREAD_METADATA_CACHE_MAX);
      return cached.item;
    }
  }
  const item = await findThreadByIDUncached(normalized, options);
  if (!options || !options.includeDesktopSnapshot) {
    retainRecentCacheEntry(threadMetadataCache, normalized, { item, at: Date.now() }, THREAD_METADATA_CACHE_MAX);
  }
  return item;
}

async function findThreadByIDUncached(threadID, options = {}) {
  const normalized = firstNonEmpty(threadID);
  if (!isThreadID(normalized)) {
    return null;
  }
  const sessionIndexMap = new Map(readSessionIndex().map((item) => [item.id, item.title]));
  const rows = await queryStateRows(`
    SELECT
      id,
      title,
      first_user_message,
      preview,
      cwd,
      rollout_path,
      tokens_used,
      model_provider,
      model,
      reasoning_effort,
      sandbox_policy,
      approval_mode,
      memory_mode,
      agent_nickname,
      thread_source,
      updated_at_ms,
      created_at_ms,
      recency_at_ms
    FROM threads
    WHERE id = '${sqliteEscape(normalized)}'
      AND archived = 0
    LIMIT 1;
  `);
  if (!rows.length) {
    return null;
  }
  let item = enrichThreadItemWithRollout(rowToThreadItem(rows[0], sessionIndexMap.get(normalized) || "", {
    includeMessageFallback: true,
  }));
  if (options && options.includeDesktopSnapshot) {
    const desktopSnapshot = await currentDesktopConversationSnapshot().catch(() => null);
    item = mergeThreadItemWithDesktopRuntime(item, desktopSnapshot);
  }
  return isUserVisibleThread(item) && isDesktopVisibleThread(item, sessionIndexMap) ? item : null;
}

// Header menu entries intentionally have no Prism-side semantic name. The
// only reliable archive outcome is Codex's own persisted archived flag after
// the opaque menu entry has been clicked.
async function threadArchivedInState(threadID = "") {
  if (!isThreadID(threadID)) return false;
  const rows = await queryStateRows(`
    SELECT COALESCE(archived, 0) AS archived
    FROM threads
    WHERE id = '${sqliteEscape(threadID)}'
    LIMIT 1;
  `).catch(() => []);
  return rows.length === 1 && Number(rows[0] && rows[0].archived) === 1;
}

async function waitForThreadArchived(threadID = "") {
  const deadline = Date.now() + HEADER_ARCHIVE_CONFIRM_TIMEOUT_MS;
  do {
    if (await threadArchivedInState(threadID)) return true;
    await sleep(HEADER_ARCHIVE_CONFIRM_POLL_MS);
  } while (Date.now() < deadline);
  return false;
}

// session_index.jsonl is re-read by every session-list refresh and every
// findThreadByID cache miss. The file rarely changes, so reuse the parsed
// result while size + mtime are unchanged.
const sessionIndexCache = { fingerprint: "", items: [] };

function readSessionIndex() {
  if (!fs.existsSync(SESSION_INDEX)) {
    return [];
  }
  const stat = safeStat(SESSION_INDEX);
  if (!stat) {
    return [];
  }
  const fingerprint = `${stat.size}|${stat.mtimeMs}`;
  if (sessionIndexCache.items.length && sessionIndexCache.fingerprint === fingerprint) {
    return sessionIndexCache.items;
  }
  const raw = fs.readFileSync(SESSION_INDEX, "utf8");
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const item = JSON.parse(trimmed);
      const id = firstNonEmpty(item.id);
      if (!isThreadID(id)) continue;
      out.push({
        id,
        title: firstNonEmpty(item.thread_name, item.name, id),
        updatedAt: firstNonEmpty(item.updated_at, item.created_at, now()),
      });
    } catch {
      // Best effort parsing; ignore malformed rows.
    }
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const deduped = [];
  const seen = new Set();
  for (const item of out) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }
  sessionIndexCache.fingerprint = fingerprint;
  sessionIndexCache.items = deduped;
  return deduped;
}

function walkFiles(dir, predicate, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, predicate, out);
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

function listSessionFiles(options = {}) {
  const nowMs = Date.now();
  if (!options.force && sessionFilesCache.files.length && nowMs - sessionFilesCache.at <= SESSION_FILE_CACHE_MS) {
    return sessionFilesCache.files;
  }
  const files = walkFiles(SESSION_ROOT, (file) => file.endsWith(".jsonl"));
  sessionFilesCache = { at: nowMs, files };
  return files;
}

function inferContextWindowTotal(model) {
  const normalized = String(model || "").trim().toLowerCase();
  if (!normalized) {
    return 0;
  }
  if (normalized.includes("gpt-5.4")) {
    return 258000;
  }
  if (normalized.includes("gpt-5")) {
    return 256000;
  }
  if (normalized.includes("gpt-4.1")) {
    return 1047576;
  }
  return 0;
}

function latestThread() {
  const items = readSessionIndex();
  return items.length ? items[0] : null;
}

function threadIDSet(items) {
  return new Set(items.map((item) => item.id).filter((id) => isThreadID(id)));
}

function threadIDFromRolloutPath(file) {
  const name = path.basename(String(file || ""));
  const match = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match ? match[1] : "";
}

function findRolloutFileFromScan(threadID) {
  if (!isThreadID(threadID) || !fs.existsSync(SESSION_ROOT)) {
    return "";
  }
  let newestPath = "";
  let newestMtime = 0;
  for (const file of listSessionFiles()) {
    if (!path.basename(file).includes(threadID)) continue;
    const stat = safeStat(file);
    if (!stat) continue;
    if (stat.mtimeMs >= newestMtime) {
      newestMtime = stat.mtimeMs;
      newestPath = file;
    }
  }
  return newestPath;
}

async function findRolloutFile(threadID) {
  // Body history only needs the append-only rollout. Resolving it through
  // Codex's SQLite first can wait behind the desktop writer for seconds;
  // prefer the short-lived directory cache and reserve SQLite for recovery.
  const scanned = findRolloutFileFromScan(threadID);
  if (scanned) return scanned;
  const thread = await findThreadByID(threadID);
  if (thread && thread.rolloutPath && fs.existsSync(thread.rolloutPath) && !isArchivedRolloutPath(thread.rolloutPath)) {
    return thread.rolloutPath;
  }
  return findRolloutFileFromScan(threadID);
}

async function rolloutCursor(threadID) {
  const file = await findRolloutFile(threadID);
  if (!file) {
    return { file: "", offset: 0 };
  }
  const stat = safeStat(file);
  return {
    file,
    offset: stat ? stat.size : 0,
  };
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

// These maps retain parsed rollout objects. Keep them tightly bounded: a
// rollout row may contain tool payloads much larger than its visible text.
const ROLLOUT_CACHE_MAX = 12;
const HISTORY_CACHE_MAX = 256;
const HISTORY_AUX_CACHE_MAX = 256;
const rolloutItemsCache = new Map();
const runTraceCache = new Map();

function retainRecentCacheEntry(cache, key, value, maxEntries = HISTORY_CACHE_MAX) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) {
    cache.delete(cache.keys().next().value);
  }
}

function readRolloutItems(file) {
  if (!file || !fs.existsSync(file)) {
    return [];
  }
  const stat = safeStat(file);
  if (!stat) {
    return [];
  }
  if (stat.size > ROLLOUT_FULL_READ_MAX_BYTES) {
    // Full rollout objects can be hundreds of megabytes. Generic consumers
    // only need a bounded recent tail; history uses its dedicated reader.
    return readRolloutTailItems(file, ROLLOUT_FULL_READ_MAX_BYTES);
  }
  const cached = rolloutItemsCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    rolloutItemsCache.delete(file);
    rolloutItemsCache.set(file, cached);
    return cached.items;
  }
  const items = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      items.push(JSON.parse(trimmed));
    } catch {
      // Ignore partial rows still being written.
    }
  }
  retainRecentCacheEntry(rolloutItemsCache, file, { mtimeMs: stat.mtimeMs, size: stat.size, items }, ROLLOUT_CACHE_MAX);
  return items;
}

function parseRolloutLines(raw, dropFirstLine = false) {
  const lines = String(raw || "").split(/\r?\n/);
  const items = [];
  for (let index = dropFirstLine ? 1 : 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;
    try {
      items.push(JSON.parse(trimmed));
    } catch {
      // Ignore partial rows still being written.
    }
  }
  return items;
}

function readRolloutTailItems(file, maxBytes = HISTORY_TAIL_BYTES) {
  if (!file || !fs.existsSync(file)) {
    return [];
  }
  const stat = safeStat(file);
  if (!stat) {
    return [];
  }
  if (stat.size <= maxBytes) {
    return readRolloutItems(file);
  }
  const fd = fs.openSync(file, "r");
  try {
    const start = Math.max(0, stat.size - maxBytes);
    const size = stat.size - start;
    const buffer = Buffer.allocUnsafe(size);
    fs.readSync(fd, buffer, 0, size, start);
    return parseRolloutLines(buffer.toString("utf8"), start > 0);
  } finally {
    fs.closeSync(fd);
  }
}

function readRolloutContextMetadata(file) {
  if (!file || !fs.existsSync(file)) {
    return {};
  }
  let contextWindowTotal = "";
  let contextTokensUsed = "";
  let contextWindowUsagePercent = "";
  let model = "";
  try {
    let latestUsage = null;
    for (const row of readRolloutTailItems(file)) {
      const payload = row && row.payload;
      if (!payload || typeof payload !== "object") continue;
      if (row.type === "event_msg" && payload.type === "task_started") {
        const windowValue = Number(payload.model_context_window) || 0;
        if (windowValue > 0) {
          contextWindowTotal = String(windowValue);
        }
      }
      if (row.type === "event_msg" && payload.type === "token_count") {
        const info = payload.info && typeof payload.info === "object" ? payload.info : {};
        const windowValue = Number(info.model_context_window) || 0;
        if (windowValue > 0) {
          contextWindowTotal = String(windowValue);
        }
        const usage = info.last_token_usage || info.current_token_usage || null;
        if (usage && typeof usage === "object") {
          latestUsage = usage;
        }
      }
      if (row.type === "turn_context") {
        model = firstNonEmpty(payload.model, model);
      }
    }
    const windowTotal = Number(contextWindowTotal) || 0;
    if (latestUsage && windowTotal > 0) {
      const inputTokens = Number(latestUsage.input_tokens || 0) || 0;
      const outputTokens = Number(latestUsage.output_tokens || 0) || 0;
      const totalTokens = Number(latestUsage.total_tokens || 0) || 0;
      let usedTokens = totalTokens || (inputTokens + outputTokens) || inputTokens;
      if (usedTokens > windowTotal * 1.15 && inputTokens > 0 && inputTokens <= windowTotal * 1.15) {
        usedTokens = inputTokens + outputTokens;
      }
      usedTokens = Math.max(0, Math.round(usedTokens));
      contextTokensUsed = String(usedTokens);
      contextWindowUsagePercent = String(
        Math.max(0, Math.min(100, Math.round((usedTokens / windowTotal) * 100))),
      );
    }
  } catch {
    return {};
  }
  return Object.fromEntries(
    Object.entries({
      model,
      context_tokens_used: contextTokensUsed,
      context_window_total: contextWindowTotal,
      context_window_usage_percent: contextWindowUsagePercent,
      context_window: contextWindowTotal ? `上下文窗口 ${contextWindowTotal}` : "",
    }).filter(([, value]) => value),
  );
}

function normalizeHistoryText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function boundedHistoryText(value, max = HISTORY_MESSAGE_MAX_CHARS) {
  const text = String(value || "")
    // Attachments are represented by metadata. Never relay their bytes in a
    // Markdown data URI, even before the Hub public projection applies the
    // same defence in depth.
    .replace(/data:[a-z][a-z0-9.+-]*\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+)*,[a-z0-9+/=_-]+/gi, "[附件内容已省略]")
    .replace(/\r\n/g, "\n")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[内容过长，已省略后续部分]`;
}

function extractPlainTextDeep(value, seen = new Set()) {
  if (value == null) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const out = [];
  if (Array.isArray(value)) {
    for (const item of value) out.push(...extractPlainTextDeep(item, seen));
    return out;
  }
  for (const key of ["message", "detail", "details", "error", "reason", "description", "status", "code", "title", "text"]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      out.push(...extractPlainTextDeep(value[key], seen));
    }
  }
  return out;
}

function isFailureLikePayload(payload = {}) {
  const type = String(payload.type || "").toLowerCase();
  const status = String(payload.status || "").toLowerCase();
  const code = String(payload.code || "").toLowerCase();
  return (
    /(?:error|fail|failed|failure|timeout|rate_limit|unavailable|overload|abort|cancel|interrupt)/.test(type) ||
    /(?:error|fail|failed|failure|timeout|rate_limit|unavailable|overload|abort|cancel|interrupt)/.test(status) ||
    /(?:error|fail|failed|failure|timeout|rate_limit|unavailable|overload|abort|cancel|interrupt)/.test(code) ||
    payload.error != null ||
    payload.detail != null ||
    payload.details != null ||
    payload.reason != null
  );
}

function isTerminalFailurePayload(payload = {}) {
  if (!payload || typeof payload !== "object") return false;
  const type = String(payload.type || "").toLowerCase();
  return (
    type === "turn_aborted" ||
    /(?:^|_)(?:failed|failure|error|timeout|cancelled|canceled|aborted|interrupted)$/.test(type) ||
    (isFailureLikePayload(payload) && /(?:abort|cancel|interrupt|fail|error|timeout|unavailable|overload)/.test(type))
  );
}

function extractFailureTextFromPayload(payload = {}) {
  if (!payload || typeof payload !== "object" || !isFailureLikePayload(payload)) return "";
  const text = extractPlainTextDeep(payload)
    .map((value) => normalizeHistoryText(value))
    .filter(Boolean)
    .filter((value) => !/^(true|false|null|undefined)$/i.test(value))
    .join("\n");
  return truncateText(text
    .replace(/(authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*[^\s,;]+/gi, "$1: [REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"), 1600);
}

function extractReasoningText(payload) {
  const parts = [];
  if (Array.isArray(payload.summary)) {
    for (const item of payload.summary) {
      if (typeof item === "string") parts.push(item);
      else if (item && typeof item.text === "string") parts.push(item.text);
      else if (item && typeof item.summary === "string") parts.push(item.summary);
    }
  }
  if (Array.isArray(payload.content)) {
    for (const item of payload.content) {
      if (typeof item === "string") parts.push(item);
      else if (item && typeof item.text === "string") parts.push(item.text);
    }
  }
  if (typeof payload.text === "string") parts.push(payload.text);
  return parts.map((item) => String(item).trim()).filter(Boolean).join("\n");
}

function parseToolArguments(payload) {
  const raw = payload.arguments || payload.input || "";
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw: String(raw) };
  }
}

function shortPath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const home = os.homedir();
  return text.startsWith(home) ? `~${text.slice(home.length)}` : text;
}

function commandFromToolInput(value) {
  const raw = String(value || "");
  const match = raw.match(/["']cmd["']\s*:\s*["']((?:\\.|[^"'])*)["']/);
  if (!match) return "";
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1].replace(/\\"/g, '"').replace(/\\n/g, " ");
  }
}

function commandTarget(command) {
  const matches = String(command || "").match(/(?:~?\/[^\s'"|;]+|(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)/g) || [];
  return shortPath(matches[matches.length - 1] || "");
}

function formatToolCall(payload, options = {}) {
  const rawName = String(payload.name || "tool");
  const name = rawName.split(".").pop();
  const args = parseToolArguments(payload);
  if (name === "exec_command" || name === "exec") {
    const cmd = String(args.cmd || args.raw || commandFromToolInput(payload.input) || "").trim();
    const target = commandTarget(cmd);
    if (/\bgit\s+status\b/.test(cmd)) return "检查项目状态";
    if (/\b(?:rg|grep|find)\b/.test(cmd)) return target ? `搜索 ${target}` : "搜索项目文件";
    if (/\b(?:cat|sed|head|tail|nl)\b/.test(cmd)) return target ? `读取 ${target}` : "读取项目文件";
    return `执行 ${truncateText(cmd, 90) || "本地命令"}`;
  }
  if (name === "apply_patch") {
    return options.complete ? "已编辑文件" : "正在编辑文件";
  }
  if (name === "wait") return "等待操作完成";
  if (name === "view_image") return `View image${args.path ? ` ${shortPath(args.path)}` : ""}`;
  return rawName;
}

function visibleToolCallDetail(payload, title = "") {
  const name = String(payload && payload.name || "").split(".").pop();
  if (name !== "exec_command" && name !== "exec") {
    return title;
  }
  const args = parseToolArguments(payload || {});
  const command = String(args.cmd || commandFromToolInput(payload && payload.input) || args.raw || "").trim();
  const executable = command.match(/^\s*(?:env\s+)?([A-Za-z0-9_.-]+)/)?.[1] || "";
  const target = commandTarget(command);
  // The tool call input is an internal orchestration payload. Keep only the
  // observable command shape and target, matching the Desktop activity UI,
  // rather than sending raw JSON, prompts, or code to Mobile.
  if (executable && target) return `${executable} ${target}`;
  return title;
}

function contextUsageFromItems(items) {
  let windowTokens = 0;
  let latestUsage = null;
  let updatedAt = "";
  for (const item of items) {
    const payload = item.payload || {};
    if (item.type === "event_msg" && payload.type === "task_started") {
      const value = Number(payload.model_context_window || 0);
      if (Number.isFinite(value) && value > 0) windowTokens = value;
    }
    if (item.type !== "event_msg" || payload.type !== "token_count") continue;
    const info = payload.info || {};
    const value = Number(info.model_context_window || 0);
    if (Number.isFinite(value) && value > 0) windowTokens = value;
    const usage = info.last_token_usage || info.current_token_usage || null;
    if (usage && typeof usage === "object") {
      latestUsage = usage;
      updatedAt = item.timestamp || updatedAt;
    }
  }
  if (!latestUsage || !windowTokens) {
    return {
      available: false,
      usedTokens: 0,
      windowTokens: windowTokens || 0,
      remainingTokens: windowTokens || 0,
      percent: null,
      updatedAt,
    };
  }
  const inputTokens = Number(latestUsage.input_tokens || 0) || 0;
  const outputTokens = Number(latestUsage.output_tokens || 0) || 0;
  const totalTokens = Number(latestUsage.total_tokens || 0) || 0;
  let usedTokens = totalTokens || (inputTokens + outputTokens) || inputTokens;
  if (usedTokens > windowTokens * 1.15 && inputTokens > 0 && inputTokens <= windowTokens * 1.15) {
    usedTokens = inputTokens + outputTokens;
  }
  usedTokens = Math.max(0, Math.round(usedTokens));
  const percent = Math.max(0, Math.min(100, (usedTokens / windowTokens) * 100));
  return {
    available: true,
    usedTokens,
    windowTokens,
    remainingTokens: Math.max(0, Math.round(windowTokens - usedTokens)),
    percent,
    updatedAt,
  };
}

function modelInfoFromID(modelID = "", updatedAt = "") {
  const id = String(modelID || "").trim();
  const option = findModelOption(id);
  if (option) {
    return { available: true, id, version: "", source: "local", label: option.label, displayName: option.displayName, updatedAt };
  }
  if (id === "gpt-5.6-sol") return { available: true, id, version: "5.6", source: "official", label: "5.6 Sol", displayName: "GPT-5.6 Sol", updatedAt };
  if (id === "gpt-5.6-terra") return { available: true, id, version: "5.6", source: "official", label: "5.6 Terra", displayName: "GPT-5.6 Terra", updatedAt };
  if (id === "gpt-5.5") return { available: true, id, version: "5.5", source: "official", label: "5.5", displayName: "GPT-5.5", updatedAt };
  if (id === "gpt-5.4") return { available: true, id, version: "5.4", source: "official", label: "5.4", displayName: "GPT-5.4", updatedAt };
  if (id === "gpt-5.4-mini") return { available: true, id, version: "mini", source: "official", label: "mini", displayName: "GPT-5.4 Mini", updatedAt };
  if (id === "gpt-5.3-codex") return { available: true, id, version: "5.3", source: "official", label: "5.3", displayName: "GPT-5.3 Codex", updatedAt };
  if (id === "gpt-5.2") return { available: true, id, version: "5.2", source: "official", label: "5.2", displayName: "GPT-5.2", updatedAt };
  return {
    available: Boolean(id),
    id,
    version: "",
    source: id.startsWith("gpt-") ? "official" : id ? "unknown" : "",
    label: "",
    displayName: id,
    updatedAt,
  };
}

function modelInfoFromLabel(value = "", updatedAt = "") {
  const text = normalizeControlLabel(value);
  if (!text) return modelInfoFromID("", updatedAt);
  if (isGenericDesktopModelLabel(text)) {
    return modelInfoFromID("", updatedAt);
  }
  const option = findModelOption(text) || findModelOptionByText(text);
  if (option) {
    return modelInfoFromID(option.id, updatedAt);
  }
  return {
    available: true,
    id: text,
    version: "",
    source: "desktop",
    label: labelFromModelName(text),
    displayName: text,
    updatedAt,
  };
}

function currentModelFromItems(items) {
  let modelID = "";
  let updatedAt = "";
  for (const item of items) {
    const payload = item.payload || {};
    if (item.type === "session_meta" && payload.model) {
      modelID = payload.model;
      updatedAt = item.timestamp || payload.timestamp || updatedAt;
    }
    if (item.type === "turn_context" && payload.model) {
      modelID = payload.model;
      updatedAt = item.timestamp || updatedAt;
    }
  }
  return modelInfoFromID(modelID, updatedAt);
}

function reasoningModeFromValue(value = "", updatedAt = "") {
  const raw = normalizeControlLabel(value);
  return {
    available: Boolean(raw),
    key: raw,
    value: raw,
    label: raw,
    displayName: raw,
    updatedAt,
  };
}

function currentReasoningModeFromItems(items) {
  let value = "";
  let updatedAt = "";
  for (const item of items) {
    const payload = item.payload || {};
    const settings = payload.collaboration_mode && typeof payload.collaboration_mode === "object"
      ? payload.collaboration_mode.settings || {}
      : {};
    const reasoning = payload.reasoning && typeof payload.reasoning === "object" ? payload.reasoning : {};
    const next = payload.reasoning_effort || payload.reasoningMode || payload.reasoning_mode || settings.reasoning_effort || reasoning.effort || "";
    if (item.type === "turn_context" && next) {
      value = next;
      updatedAt = item.timestamp || updatedAt;
    }
  }
  return reasoningModeFromValue(value, updatedAt);
}

function stepFromEvent(item) {
  const payload = item.payload || {};
  if (item.type === "event_msg") {
    const failureText = extractFailureTextFromPayload(payload);
    if (failureText) return { kind: "error", label: "失败", text: failureText, time: item.timestamp };
    if (payload.type === "task_started") return { kind: "start", label: "开始", text: "开始处理这条消息", time: item.timestamp };
    if (payload.type === "task_complete") return { kind: "complete", label: "完成", text: "回复完成", time: item.timestamp };
    if (payload.type === "agent_reasoning" && payload.text) {
      return { kind: "thinking", label: "思考", text: String(payload.text).trim(), time: item.timestamp };
    }
    if (payload.type === "agent_message" && payload.message) {
      return { kind: "thinking", label: "思考", text: String(payload.message).trim(), time: item.timestamp };
    }
    return null;
  }
  if (item.type === "response_item") {
    if (payload.type === "reasoning") {
      const text = extractReasoningText(payload);
      return text ? { kind: "thinking", label: "思考", text, time: item.timestamp } : null;
    }
    if (payload.type === "function_call") {
      return { kind: "tool", label: "工具", text: formatToolCall(payload), callId: payload.call_id || "", time: item.timestamp };
    }
    if (payload.type === "message") {
      const text = extractTextFromContent(payload.content, payload.role);
      if (text && payload.role === "assistant") {
        return {
          kind: payload.phase === "final_answer" ? "final" : "assistant",
          label: "回复",
          text: truncateText(text, 1200),
          time: item.timestamp,
        };
      }
    }
  }
  return null;
}

function runTraceFromSteps(steps = []) {
  const trace = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index] || {};
    const detail = String(step.text || "").trim();
    if (!detail) continue;
    const sourceKind = String(step.kind || "").trim().toLowerCase();
    const kind = sourceKind === "thinking" ? "reasoning" : sourceKind === "tool" ? "tool" : "status";
    const status = sourceKind === "error" ? "failed" : sourceKind === "start" ? "running" : "completed";
    trace.push({
      id: firstNonEmpty(String(step.callId || ""), `${step.time || "trace"}:${index}`),
      kind,
      title: firstNonEmpty(step.label, kind === "tool" ? "工具" : kind === "reasoning" ? "推理" : "状态"),
      detail,
      status,
      created_at: firstNonEmpty(step.time),
    });
  }
  return trace.slice(-80);
}

function runTraceFromThread(thread = null) {
  const threadID = firstNonEmpty(thread && thread.id);
  if (!isThreadID(threadID)) return [];
  const file = firstNonEmpty(thread && thread.rolloutPath, findRolloutFileFromScan(threadID));
  if (!file) return [];
  const stat = safeStat(file);
  if (!stat) return [];
  const fingerprint = `${file}|${stat.size}|${stat.mtimeMs}`;
  const cached = runTraceCache.get(file);
  if (cached && cached.fingerprint === fingerprint) {
    return cached.items.map((item) => ({ ...item }));
  }
  const steps = [];
  // Detail trace is only the latest turn's bounded process summary. Reading
  // the entire append-only rollout on every 900ms watcher poll retains large
  // object graphs and can exhaust the Plugin process heap.
  for (const item of readRecentRolloutRows(file, 1)) {
    const step = stepFromEvent(item);
    if (step && ["start", "thinking", "tool", "complete", "error"].includes(step.kind)) steps.push(step);
  }
  const items = runTraceFromSteps(steps);
  runTraceCache.set(file, { fingerprint, items });
  while (runTraceCache.size > RUN_TRACE_CACHE_MAX) {
    runTraceCache.delete(runTraceCache.keys().next().value);
  }
  return items.map((item) => ({ ...item }));
}

function inferPhaseFromSteps(steps = []) {
  const visible = Array.isArray(steps) ? steps.filter((step) => step && step.text) : [];
  if (!visible.length) return null;
  for (let i = visible.length - 1; i >= 0; i -= 1) {
    const step = visible[i];
    if (step.kind === "tool") {
      return {
        id: "tool",
        label: step.text,
        detail: "",
        source: "rollout_step",
        updated_at: step.time || "",
      };
    }
    if (step.kind === "thinking") {
      return {
        id: "thinking",
        label: step.text,
        detail: "",
        source: "rollout_step",
        updated_at: step.time || "",
      };
    }
  }
  return null;
}

async function markerVisible(threadID, marker) {
  const file = await findRolloutFile(threadID);
  if (!file) {
    return { visible: false, evidence: "", failureReason: "codex rollout file not found" };
  }
  try {
    if (rolloutContainsVisibilityMarker(file, marker)) {
      return { visible: true, evidence: file, failureReason: "" };
    }
    return { visible: false, evidence: file, failureReason: "marker not found in Codex thread/read history" };
  } catch (err) {
    return { visible: false, evidence: file, failureReason: String(err.message || err) };
  }
}

function rolloutContainsVisibilityMarker(file, marker) {
  const expected = String(marker || "").trim();
  if (!expected) return false;
  for (const row of readRecentRolloutRows(file, 1)) {
    const payload = row && row.payload && typeof row.payload === "object" ? row.payload : null;
    if (!payload) continue;
    if (payload.type === "user_message" && typeof payload.message === "string" && payload.message.includes(expected)) {
      return true;
    }
    if (payload.type !== "message" || String(payload.role || "").toLowerCase() !== "user") continue;
    if (extractTextFromContent(payload.content, "user").includes(expected)) {
      return true;
    }
    if (attachmentsFromContent(payload.content).some((attachment) => attachment.name === expected)) {
      return true;
    }
  }
  return false;
}

function encodeRunContext(ctx) {
  return `codexrun:${Buffer.from(JSON.stringify(ctx), "utf8").toString("base64url")}`;
}

function decodeRunContext(runID) {
  const raw = String(runID || "");
  if (!raw.startsWith("codexrun:")) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(raw.slice("codexrun:".length), "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function extractTextFromContent(content, role = "") {
  if (!Array.isArray(content)) {
    return "";
  }
  const normalizedRole = String(role || "").trim().toLowerCase();
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (normalizedRole === "assistant" && item.type === "output_text" && typeof item.text === "string") {
      parts.push(item.text);
      continue;
    }
    if (normalizedRole === "user" && item.type === "input_text" && typeof item.text === "string") {
      parts.push(item.text);
      continue;
    }
    if (!normalizedRole && (item.type === "output_text" || item.type === "input_text") && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("\n").trim();
}

function unwrapUserPromptText(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return "";
  }
  const normalized = raw
    .replace(/<image[^>]*>/gi, "")
    .replace(/<\/image>/gi, "")
    .trim();
  // Codex prepends ambient UI state (for example browser context) to the
  // persisted user message. The request heading is the protocol boundary:
  // only text after it is user-authored and safe to relay to remote clients.
  // Recent Codex builds shortened the legacy "My request for Codex" heading
  // to "My request", so support both forms rather than exposing the prefix.
  const marker = /(?:^|\n)[ \t]*#{1,6}[ \t]*My[ \t]+request(?:[ \t]+for[ \t]+Codex)?[ \t]*:[ \t]*/im;
  const match = marker.exec(normalized);
  if (match) {
    return normalized.slice(match.index + match[0].length).trim();
  }
  return normalized
    .replace(/^#\s*Files mentioned by the user:\s*/i, "")
    .trim();
}

function attachmentNameFromPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw.replace(/^file:\/\//i, ""));
  } catch {
    // Keep the original value when a desktop-provided path is not URI encoded.
  }
  const name = path.posix.basename(decoded.replace(/\\/g, "/"));
  return name === "." || name === "/" ? "" : name;
}

function attachmentNamesFromContent(content) {
  if (!Array.isArray(content)) return [];
  const names = [];
  for (const item of content) {
    if (!item || item.type !== "input_text" || typeof item.text !== "string") continue;
    const matcher = /<image\b[^>]*\bpath\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi;
    for (const match of item.text.matchAll(matcher)) {
      const name = attachmentNameFromPath(firstNonEmpty(match[1], match[2], match[3]));
      if (name) names.push(name);
    }
  }
  return names;
}

function isGenericAttachmentName(value) {
  return /^\[?image(?:\s*#?\d+)?\]?$/i.test(String(value || "").trim());
}

function attachmentsFromContent(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  const pathNames = attachmentNamesFromContent(content);
  const attachments = [];
  let imageIndex = 0;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (item.type !== "input_image") continue;
    // Codex rollouts currently expose an image URL, often a data URI, but not
    // a stable filename. The companion <image> tag has a local path we reduce
    // to its basename; remote clients must never receive that path, URL or bytes.
    const directName = attachmentNameFromPath(firstNonEmpty(item.name, item.filename));
    const pathName = pathNames[imageIndex] || "";
    imageIndex += 1;
    attachments.push({
      name: firstNonEmpty(isGenericAttachmentName(directName) ? "" : directName, pathName, directName, "image"),
      kind: "image",
    });
  }
  return attachments;
}

function historyMessageID(row, payload, role) {
  const existing = firstNonEmpty(payload && payload.id, row && row.id);
  if (existing) return existing;
  // Older Codex rollouts omit message IDs. Hash the immutable local row fields
  // so reconnects replace the same message rather than inventing a new one.
  const identity = JSON.stringify({
    role,
    timestamp: row && (row.timestamp_ms ?? row.timestamp ?? ""),
    content: payload && payload.content,
    text: payload && payload.text,
  });
  return `legacy-message-${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

function asISOString(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  // A missing source timestamp is not an observation timestamp. Returning
  // `now()` here caused a stable rollout row to acquire a new message/trace
  // identity on every watcher poll.
  return "";
}

function extractMessageText(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const role = firstNonEmpty(payload.role).toLowerCase();
  const contentText = extractTextFromContent(payload.content, role);
  if (contentText) {
    return role === "user" ? unwrapUserPromptText(contentText) : contentText;
  }
  if (typeof payload.text === "string" && payload.text.trim() !== "") {
    return role === "user" ? unwrapUserPromptText(payload.text.trim()) : payload.text.trim();
  }
  return "";
}

function isInternalUserEnvelope(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return false;
  }
  if (
    (trimmed.startsWith("<environment_context>") && trimmed.endsWith("</environment_context>")) ||
    (/^<codex_internal_context\b[^>]*>[\s\S]*<\/codex_internal_context>$/i.test(trimmed)) ||
    isTurnAbortedMarker(trimmed)
  ) {
    return true;
  }
  // Codex emits approval-assessment prompts as user messages in the rollout.
  // They contain an internal transcript and headings such as "Current Task";
  // the desktop does not render them as conversation turns, so neither may
  // remote history. This is a protocol envelope prefix, not UI copy matching.
  return /^the following is the codex agent history\b/i.test(trimmed);
}

function isTurnAbortedMarker(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  return /^<turn_aborted\b[\s\S]*(?:<\/turn_aborted>)?$/i.test(trimmed);
}

function visibleUserHistoryText(text) {
  return unwrapUserPromptText(text)
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .replace(/<turn_aborted\b[\s\S]*(?:<\/turn_aborted>)?/gi, "")
    .trim();
}

function goalObjectiveFromInternalUserEnvelope(text) {
  const raw = String(text || "").trim();
  // Goal is a Codex protocol envelope. Its objective is user-authored content
  // rendered in the Desktop body, unlike approval/compaction envelopes which
  // must remain private. Match the stable source attribute, never UI copy.
  const openingTag = raw.match(/^<codex_internal_context\b([^>]*)>/i);
  if (!openingTag || !/\bsource\s*=\s*(["'])goal\1/i.test(openingTag[1])) {
    return "";
  }
  const objective = raw.match(/<objective>\s*([\s\S]*?)\s*<\/objective>/i);
  return objective ? objective[1].trim() : "";
}

function isInternalAssistantNote(text) {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!normalized) {
    return false;
  }
  const lower = normalized.toLowerCase();
  const plainHeading = lower
    .replace(/^[#>*\s-]+/, "")
    .replace(/[*_\s:：-]+$/g, "");
  if (
    lower.startsWith("another language model started to solve this problem") ||
    lower.startsWith("handoff summary") ||
    lower.startsWith("# handoff summary") ||
    lower.startsWith("## handoff summary") ||
    lower.startsWith("current progress") ||
    lower.startsWith("# current progress") ||
    lower.startsWith("## current progress") ||
    plainHeading.startsWith("handoff summary") ||
    plainHeading.startsWith("current progress") ||
    lower.startsWith("i’ll treat this as the next continuation marker") ||
    lower.startsWith("i'll treat this as the next continuation marker")
  ) {
    return true;
  }
  if (
    /next continuation marker|re-ground in the current worktree|current worktree still has the intended modified files|validation passed again/i.test(normalized)
  ) {
    return true;
  }
  if (
    (plainHeading.startsWith("task") || plainHeading.startsWith("goal") || plainHeading.startsWith("current task")) &&
    /(?:current progress|active repos|remaining work|next steps|user wants|user asked|verification already run|working repo|current state)/i.test(normalized)
  ) {
    return true;
  }
  if (/^(?:pro)?gress\s*[-:]/i.test(normalized)) {
    return /we were debugging|current progress|remaining work|next steps|key findings|verification already run/i.test(normalized);
  }
  return false;
}

function isCodexCompactionEnvelope(row) {
  const payload = row && row.payload;
  // This is a rollout protocol envelope emitted after Codex has generated an
  // internal continuation summary. It is not Desktop-visible conversation
  // text, unlike an ordinary assistant message that happens to mention a
  // similarly named task.
  return Boolean(
    row && row.type === "compacted" && payload && typeof payload === "object"
    && /^another language model started to solve this problem\b/i.test(String(payload.message || "").trim()),
  );
}

function internalCompactionSummaryIndexes(rows = []) {
  const hidden = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    if (!isCodexCompactionEnvelope(rows[index])) continue;
    // Codex emits its private summary as the final assistant response directly
    // before the compaction envelope, with only non-message bookkeeping rows
    // in between. A visible user/assistant row ends that bounded relationship.
    for (let previous = index - 1; previous >= 0 && previous >= index - 8; previous -= 1) {
      const row = rows[previous];
      const payload = row && row.payload;
      if (!payload || typeof payload !== "object" || row.type !== "response_item" || payload.type !== "message") {
        continue;
      }
      const role = firstNonEmpty(payload.role).toLowerCase();
      if (role === "assistant" && String(payload.phase || "").trim().toLowerCase() === "final_answer") {
        hidden.add(previous);
      }
      break;
    }
  }
  return hidden;
}

// Codex renders commentary messages in the active conversation body. Remote
// history must retain them so the live body matches the desktop surface.
function isDesktopVisibleAssistantMessage(_payload = {}) {
  return true;
}

// Rollout revisions of one message are already collapsed by ID while parsing.
// Different IDs are distinct completed messages and must remain separate.
function historyMessagesForDisplay(items) {
  return Array.isArray(items) ? items.slice() : [];
}

const historyTurnRevisionCache = new Map();
const historyRuntimeNoticeCache = new Map();
// A goal is active state as well as a native rollout event. Detail snapshots
// learn it immediately, while a small remote history window can otherwise
// omit the original goal envelope after a long-running task produces many
// ordinary turns. Keep only the user-provided objective for a body projection.
const visibleGoalBodyByThread = new Map();

function normalizeRuntimeNotices(notices = []) {
  const seen = new Set();
  const out = [];
  for (const notice of Array.isArray(notices) ? notices : []) {
    const title = normalizeHistoryText(notice && notice.title);
    const detail = normalizeHistoryText(notice && notice.detail);
    const text = firstNonEmpty(title, detail);
    if (!text) continue;
    const key = `${title}\n${detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ID: `progress:status:${crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)}`,
      Kind: "status",
      Title: title || "状态",
      Detail: detail,
      Status: String(notice && notice.status || "running").trim().toLowerCase() || "running",
      CreatedAt: asISOString(notice && notice.created_at) || now(),
    });
  }
  return out.slice(-8);
}

function updateHistoryRuntimeNotices(threadID, notices = []) {
  if (!isThreadID(threadID)) return;
  const normalized = normalizeRuntimeNotices(notices);
  const signature = JSON.stringify(normalized.map((notice) => [notice.Title, notice.Detail, notice.Status]));
  const previous = historyRuntimeNoticeCache.get(threadID);
  if (previous && previous.signature === signature) return;
  retainRecentCacheEntry(historyRuntimeNoticeCache, threadID, {
    signature,
    notices: normalized,
    revision: Number(previous?.revision || 0) + 1,
  }, HISTORY_AUX_CACHE_MAX);
}

function rememberVisibleGoalBody(threadID, goal = {}) {
  if (!isThreadID(threadID)) return;
  const status = String(goal && goal.status || "").trim().toLowerCase();
  const objective = String(goal && goal.objective || "").trim();
  if (!["running", "paused"].includes(status) || !objective) {
    visibleGoalBodyByThread.delete(threadID);
    return;
  }
  retainRecentCacheEntry(visibleGoalBodyByThread, threadID, {
    objective,
    revision: crypto.createHash("sha256").update(objective).digest("hex").slice(0, 16),
  }, HISTORY_AUX_CACHE_MAX);
}

function visibleGoalBodyTurn(threadID, objective = "") {
  const content = String(objective || "").trim();
  if (!isThreadID(threadID) || !content) return null;
  const revision = crypto.createHash("sha256").update(`${threadID}\n${content}`).digest("hex").slice(0, 16);
  return {
    turn_id: `goal:${revision}`,
    // Goal activation time is not available in the stable Desktop contract.
    // Make its reconstructed user turn precede the bounded recent window.
    order_key: `0000-goal:${revision}`,
    revision,
    messages: [{
      ID: `goal:${revision}`,
      Role: "user",
      Type: "text",
      Content: content,
      Status: "",
      CreatedAt: "",
      UpdatedAt: "",
      Metadata: { synthetic: "goal" },
    }],
  };
}

function historyRuntimeNotices(threadID) {
  return historyRuntimeNoticeCache.get(threadID) || { notices: [], revision: 0 };
}

function historyMessageFromRolloutRow(row, threadID) {
  const payload = row && row.payload;
  if (!payload || typeof payload !== "object" || row.type !== "response_item" || payload.type !== "message") {
    return null;
  }
  const role = firstNonEmpty(payload.role, "assistant").toLowerCase();
  if (role !== "user" && role !== "assistant") return null;
  if (role === "assistant" && !isDesktopVisibleAssistantMessage(payload)) return null;
  const content = extractMessageText(payload);
  const goalObjective = role === "user" ? goalObjectiveFromInternalUserEnvelope(content) : "";
  const visibleContent = boundedHistoryText(role === "user" ? firstNonEmpty(goalObjective, visibleUserHistoryText(content)) : content);
  if ((role === "user" && (!visibleContent || (isInternalUserEnvelope(content) && !goalObjective))) || (role === "assistant" && isInternalAssistantNote(content))) {
    return null;
  }
  const attachments = attachmentsFromContent(payload.content);
  const timestamp = asISOString(row.timestamp_ms ?? row.timestamp ?? payload.updated_at ?? payload.created_at);
  return {
    ID: historyMessageID(row, payload, role),
    TurnID: firstNonEmpty(
      payload.turn_id,
      payload.internal_chat_message_metadata_passthrough && payload.internal_chat_message_metadata_passthrough.turn_id,
    ),
    Role: role,
    Type: "text",
    Phase: String(payload.phase || "").trim().toLowerCase(),
    Content: visibleContent,
    Status: "",
    CreatedAt: timestamp,
    UpdatedAt: timestamp,
    Metadata: attachments.length ? { attachments } : {},
  };
}

function isInternalUserHistoryRow(row) {
  const payload = row && row.payload;
  if (!payload || typeof payload !== "object" || row.type !== "response_item" || payload.type !== "message") {
    return false;
  }
  if (String(payload.role || "").trim().toLowerCase() !== "user") {
    return false;
  }
  const content = extractMessageText(payload);
  return isInternalUserEnvelope(content) && !goalObjectiveFromInternalUserEnvelope(content);
}

function historyActivityFromRolloutRow(row) {
  const payload = row && row.payload;
  if (!payload || typeof payload !== "object" || row.type !== "response_item") return null;
  const type = String(payload.type || "").trim();
  if (type !== "function_call" && type !== "custom_tool_call") return null;
  const callID = firstNonEmpty(payload.call_id, payload.id, row.id);
  if (!callID) return null;
  const title = formatToolCall(payload);
  const detail = visibleToolCallDetail(payload, title);
  if (!detail) return null;
  const timestamp = asISOString(row.timestamp_ms ?? row.timestamp ?? payload.updated_at ?? payload.created_at);
  return {
    ID: `progress:tool:${callID}`,
    Kind: "tool",
    CallID: callID,
    Title: title,
    Detail: detail,
    Status: String(payload.status || "running").trim().toLowerCase(),
    CreatedAt: timestamp,
  };
}

function historyToolResultFromRolloutRow(row, callTitles = new Map()) {
  const payload = row && row.payload;
  if (!payload || typeof payload !== "object" || row.type !== "response_item") return null;
  const type = String(payload.type || "").trim();
  if (type !== "function_call_output" && type !== "custom_tool_call_output") return null;
  const callID = firstNonEmpty(payload.call_id, payload.id, row.id);
  if (!callID) return null;
  const raw = firstNonEmpty(payload.output, payload.result, payload.content, payload.text);
  const detail = truncateText(typeof raw === "string" ? raw : JSON.stringify(raw || ""), 360);
  if (!detail) return null;
  // `function_call_output` has no status while a terminal command is still
  // attached to Codex's process manager. Treat only its explicit running
  // sentinel as active; arbitrary output containing the word "running" is
  // not enough to override the normal completed default.
  const explicitStatus = String(payload.status || "").trim().toLowerCase();
  const inferredStatus = /process running with session id\b/i.test(detail)
    ? "running"
    : "completed";
  return {
    ID: `progress:tool_result:${callID}`,
    Kind: "tool_result",
    CallID: callID,
    Title: callTitles.get(callID) || "执行结果",
    Detail: detail,
    Status: explicitStatus || inferredStatus,
    CreatedAt: asISOString(row.timestamp_ms ?? row.timestamp ?? payload.updated_at ?? payload.created_at),
  };
}

function boundedHistoryTurnLimit(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) return HISTORY_BODY_TURN_LIMIT_MAX;
  return Math.min(numeric, HISTORY_BODY_TURN_LIMIT_MAX);
}

function historyRecentScanBudget(requiredTurns) {
  const turns = boundedHistoryTurnLimit(requiredTurns);
  return Math.min(
    HISTORY_RECENT_SCAN_MAX_BYTES,
    Math.max(HISTORY_RECENT_SCAN_MIN_BYTES, turns * HISTORY_RECENT_SCAN_BYTES_PER_TURN),
  );
}

function readRecentRolloutRows(file, requiredTurns = HISTORY_BODY_TURN_LIMIT_MAX) {
  const stat = safeStat(file);
  if (!stat || stat.size <= 0) return [];
  const scanBudget = historyRecentScanBudget(requiredTurns);
  const fd = fs.openSync(file, "r");
  try {
    const rows = [];
    let end = stat.size;
    let scannedBytes = 0;
    let carry = "";
    const userIDs = new Set();
    while (end > 0 && userIDs.size < requiredTurns && scannedBytes < scanBudget) {
      const remainingBudget = scanBudget - scannedBytes;
      const size = Math.min(HISTORY_REVERSE_CHUNK_BYTES, end, remainingBudget);
      if (size <= 0) break;
      const start = end - size;
      const buffer = Buffer.allocUnsafe(size);
      fs.readSync(fd, buffer, 0, size, start);
      scannedBytes += size;
      const parts = `${buffer.toString("utf8")}${carry}`.split(/\r?\n/);
      carry = start > 0 ? parts.shift() || "" : "";
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        const text = parts[index].trim();
        if (!text) continue;
        try {
          const row = JSON.parse(text);
          rows.push(row);
          const message = historyMessageFromRolloutRow(row, "");
          if (message && message.Role === "user") userIDs.add(message.ID);
        } catch {
          // Ignore a partial row while Codex is appending the rollout.
        }
      }
      end = start;
    }
    return rows.reverse();
  } finally {
    fs.closeSync(fd);
  }
}

function taskStateAfterRolloutRow(previous, row) {
  const payload = row && row.payload;
  if (!payload || typeof payload !== "object" || row.type !== "event_msg") return previous;
  if (payload.type === "task_started") {
    return { terminal: false, status: "running", completedAt: "", error: "", durationMs: 0 };
  }
  if (payload.type === "task_complete") {
    const error = extractFailureTextFromPayload(payload);
    return {
      terminal: true,
      status: error ? "failed" : "completed",
      completedAt: row.timestamp || "",
      error,
      durationMs: 0,
    };
  }
  if (payload.type === "turn_aborted") {
    return {
      terminal: true,
      status: "interrupted",
      completedAt: row.timestamp || "",
      error: "",
      durationMs: Number(payload.duration_ms || 0),
    };
  }
  if (payload.type === "task_failed" || isTerminalFailurePayload(payload)) {
    return {
      terminal: true,
      status: "failed",
      completedAt: row.timestamp || "",
      error: extractFailureTextFromPayload(payload),
      durationMs: 0,
    };
  }
  return previous;
}

function historyTurnStates(rows, threadID) {
  const statesByNativeTurnID = new Map();
  for (const row of rows) {
    const payload = row && row.payload;
    const nativeTurnID = firstNonEmpty(
      payload && payload.turn_id,
      payload && payload.internal_chat_message_metadata_passthrough && payload.internal_chat_message_metadata_passthrough.turn_id,
    );
    if (!nativeTurnID) continue;
    const previous = statesByNativeTurnID.get(nativeTurnID) || {
      terminal: true,
      status: "completed",
      completedAt: "",
      error: "",
      durationMs: 0,
    };
    const next = taskStateAfterRolloutRow(previous, row);
    if (next !== previous) statesByNativeTurnID.set(nativeTurnID, next);
  }

  // Codex writes task_started before the corresponding user message. Bind
  // lifecycle state to its native turn_id before mapping it to a user anchor;
  // otherwise the next turn's start can overwrite the prior completed turn.
  const states = new Map();
  for (const row of rows) {
    const message = historyMessageFromRolloutRow(row, threadID);
    if (message && message.Role === "user") {
      states.set(message.ID, statesByNativeTurnID.get(message.TurnID) || {
        terminal: true,
        status: "completed",
        completedAt: "",
        error: "",
        durationMs: 0,
      });
    }
  }
  return states;
}

// The composer can retain its stop action briefly after Codex writes
// task_complete. Only an explicit terminal lifecycle event may override that
// DOM state, so a newly created turn cannot be mistaken for a completed one.
function latestRecordedTurnLifecycle(file, threadID) {
  if (!file || !isThreadID(threadID)) return null;
  const rows = readRecentRolloutRows(file, 1);
  if (!rows.length) return null;
  const statesByNativeTurnID = new Map();
  let latestUser = null;
  for (const row of rows) {
    const payload = row && row.payload;
    const nativeTurnID = firstNonEmpty(
      payload && payload.turn_id,
      payload && payload.internal_chat_message_metadata_passthrough && payload.internal_chat_message_metadata_passthrough.turn_id,
    );
    if (nativeTurnID && row && row.type === "event_msg") {
      const previous = statesByNativeTurnID.get(nativeTurnID) || {
        terminal: false,
        status: "",
        completedAt: "",
        error: "",
        durationMs: 0,
      };
      const next = taskStateAfterRolloutRow(previous, row);
      if (next !== previous) statesByNativeTurnID.set(nativeTurnID, next);
    }
    const message = historyMessageFromRolloutRow(row, threadID);
    if (message && message.Role === "user") latestUser = message;
  }
  if (!latestUser || !latestUser.TurnID) return null;
  const state = statesByNativeTurnID.get(latestUser.TurnID);
  return state && state.terminal ? state : null;
}

function runtimeWithRecordedTerminal(runtime, terminalState = null) {
  if (!runtime || typeof runtime !== "object" || !terminalState || terminalState.terminal !== true) {
    return runtime;
  }
  // Rollout files describe the last persisted user turn. They cannot override
  // a currently rendered approval, running turn, or Goal lifecycle surface.
  // Those are live Desktop state and must remain actionable on remote clients.
  const goalStatus = String(runtime.goal && runtime.goal.status || "none").trim().toLowerCase();
  if (runtime.running === true || runtime.waiting_approval === true || ["running", "paused"].includes(goalStatus)) {
    return runtime;
  }
  return {
    ...runtime,
    running: false,
    waiting_approval: false,
    queue_pending: false,
    can_queue: false,
    interrupt_available: false,
    primary_action: "send",
    approval: null,
    recorded_terminal: {
      status: firstNonEmpty(terminalState.status, "completed"),
      completed_at: firstNonEmpty(terminalState.completedAt),
      error: firstNonEmpty(terminalState.error),
    },
  };
}

function historyTurnRevision(threadID, turnID, messages) {
  const signature = crypto.createHash("sha256")
    .update(JSON.stringify(messages.map((message) => [message.ID, message.Content, message.UpdatedAt, message.Progress, message.Metadata])))
    .digest("hex");
  const key = `${threadID}:${turnID}`;
  const cached = historyTurnRevisionCache.get(key);
  if (cached && cached.signature === signature) return cached.revision;
  const revision = cached ? cached.revision + 1 : 1;
  retainRecentCacheEntry(historyTurnRevisionCache, key, { signature, revision }, HISTORY_AUX_CACHE_MAX);
  return revision;
}

function processedDuration(startedAt, completedAt) {
  const start = Date.parse(startedAt || "");
  const end = Date.parse(completedAt || "");
  const seconds = Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, Math.floor((end - start) / 1000))
    : 0;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function progressStepFromAssistantMessage(message, status = "completed") {
  return {
    ID: `progress:assistant_text:${message.ID}`,
    Kind: "assistant_text",
    Title: "回复中",
    Detail: message.Content,
    Status: status,
    CreatedAt: message.CreatedAt,
  };
}

function historyProgressMessage(user, entries, terminalState = {}) {
  const terminal = Boolean(terminalState.terminal);
  const terminalStatus = terminal ? firstNonEmpty(terminalState.status, "completed") : "running";
  // One native turn may contain thousands of tool records. The desktop keeps
  // the complete rollout; the remote view carries a bounded recent trace.
  const boundedEntries = Array.isArray(entries) ? entries.slice(-HISTORY_PROGRESS_STEP_LIMIT) : [];
  const assistantMessages = boundedEntries
    .filter((entry) => entry.kind === "message" && entry.message.Role === "assistant")
    .map((entry) => entry.message);
  const liveAssistantText = assistantMessages.at(-1)?.Content || "";
  const finalMessage = terminalStatus === "completed"
    ? assistantMessages.slice().reverse().find((message) => message.Phase === "final_answer") || assistantMessages.at(-1) || null
    : null;
  const priorEntries = boundedEntries.filter((entry) => entry.kind !== "message" || entry.message.ID !== finalMessage?.ID);
  const steps = priorEntries.map((entry) => {
    if (entry.kind === "message") {
      return progressStepFromAssistantMessage(entry.message, terminal ? "completed" : "running");
    }
    return {
      ID: entry.step.ID,
      Kind: entry.step.Kind,
      ...(entry.step.CallID ? { CallID: entry.step.CallID } : {}),
      Title: entry.step.Title,
      Detail: entry.step.Detail,
      Status: terminal && entry.step.Status === "running" ? "completed" : entry.step.Status,
      CreatedAt: entry.step.CreatedAt,
    };
  });
  const timestamp = firstNonEmpty(terminalState.completedAt, finalMessage?.UpdatedAt, steps.at(-1)?.CreatedAt, user.UpdatedAt, user.CreatedAt);
  const interruptedSummary = "已被打断";
  const progress = {
    ID: `progress:${user.ID}`,
    Role: "assistant",
    Type: "progress",
    Content: terminalStatus === "interrupted"
      ? interruptedSummary
      : terminalStatus === "failed"
        ? firstNonEmpty(terminalState.error, "Codex 执行失败。")
        : terminal ? `已处理 ${processedDuration(user.CreatedAt, timestamp)}` : liveAssistantText,
    Status: terminalStatus,
    CreatedAt: user.CreatedAt,
    UpdatedAt: timestamp,
    Progress: {
      Status: terminalStatus,
      StartedAt: user.CreatedAt,
      ...(terminal ? { CompletedAt: timestamp } : {}),
      Steps: steps,
    },
    Metadata: {},
  };
  const { Phase: _userPhase, TurnID: _userTurnID, ...publicUserMessage } = user;
  const messages = [publicUserMessage];
  if (!terminal || steps.length || progress.Content) messages.push(progress);
  if (finalMessage) {
    const { Phase, TurnID: _finalTurnID, ...publicFinalMessage } = finalMessage;
    messages.push(publicFinalMessage);
  }
  return messages;
}

// Build the newest user-anchored turns. Reverse chunk reads avoid waiting for a
// complete rollout parse and continue beyond a large active tool output until a
// user anchor is found.
function historyTurnsFromTail(file, threadID, limit = HISTORY_BODY_TURN_LIMIT_MAX) {
  const rows = readRecentRolloutRows(file, limit);
  const internalSummaryRows = internalCompactionSummaryIndexes(rows);
  const entries = [];
  const positions = new Map();
  const toolTitles = new Map();
  for (const [rowIndex, row] of rows.entries()) {
    if (internalSummaryRows.has(rowIndex)) continue;
    if (isInternalUserHistoryRow(row)) {
      // An internal user envelope starts a synthetic Codex-only exchange. It
      // also delimits the previous visible turn so its approval response is
      // not accidentally appended as the user's assistant reply.
      entries.push({ kind: "internal_boundary" });
      continue;
    }
    const message = historyMessageFromRolloutRow(row, threadID);
    if (message && message.ID) {
      const existing = positions.get(message.ID);
      if (existing === undefined) {
        positions.set(message.ID, entries.length);
        entries.push({ kind: "message", message });
      } else if (message.Content.length >= String(entries[existing].message?.Content || "").length) {
        entries[existing] = { kind: "message", message };
      }
      continue;
    }
    const activity = historyActivityFromRolloutRow(row);
    if (activity) {
      toolTitles.set(activity.CallID, activity.Title);
      entries.push({ kind: "step", step: activity });
      continue;
    }
    const toolResult = historyToolResultFromRolloutRow(row, toolTitles);
    if (toolResult) entries.push({ kind: "step", step: toolResult });
  }
  const goalBody = visibleGoalBodyByThread.get(threadID);
  const goalTurn = visibleGoalBodyTurn(threadID, goalBody && goalBody.objective);
  // A bounded rollout tail can begin after Codex's private goal envelope.
  // Insert the projected user objective before grouping so the retained
  // assistant replies and tool activity remain attached to that objective.
  // Appending a standalone goal turn afterwards loses those orphan entries.
  if (goalTurn && !entries.some((entry) => entry.kind === "message" && entry.message &&
    entry.message.Role === "user" && String(entry.message.Content || "").trim() === goalTurn.messages[0].Content,
  )) {
    entries.unshift({ kind: "message", message: goalTurn.messages[0] });
  }
  const turns = [];
  let current = null;
  for (const entry of entries) {
    if (entry.kind === "internal_boundary") {
      if (current) turns.push(current);
      current = null;
      continue;
    }
    const message = entry.kind === "message" ? entry.message : null;
    if (message && message.Role === "user") {
      if (current) turns.push(current);
      current = { user: message, entries: [] };
      continue;
    }
    if (current) current.entries.push(entry);
  }
  if (current) turns.push(current);
  const newestTurnID = current && current.user && current.user.ID;
  const terminalStates = historyTurnStates(rows, threadID);
  const runtimeNotices = historyRuntimeNotices(threadID).notices;
  const selectedTurns = turns.slice(-limit);
  if (goalTurn && !selectedTurns.some((turn) => turn.user && turn.user.ID === goalTurn.messages[0].ID)) {
    const projectedGoalTurn = turns.find((turn) => turn.user && turn.user.ID === goalTurn.messages[0].ID);
    if (projectedGoalTurn) selectedTurns.unshift(projectedGoalTurn);
  }
  const visibleTurns = selectedTurns.map((turn) => {
    const isNewestTurn = turn.user.ID === newestTurnID;
    const state = terminalStates.get(turn.user.ID) || { terminal: true, status: "completed" };
    const entries = isNewestTurn && !state.terminal && runtimeNotices.length
      ? [...turn.entries, ...runtimeNotices.map((step) => ({ kind: "step", step }))]
      : turn.entries;
    const messages = historyProgressMessage(turn.user, entries, state);
    return {
      turn_id: turn.user.ID,
      order_key: firstNonEmpty(turn.user.CreatedAt, turn.user.ID),
      revision: historyTurnRevision(threadID, turn.user.ID, messages),
      messages,
    };
  }).reverse();
  return visibleTurns;
}

async function* readHistoryStream(session, request = {}, signal) {
  const startedAt = Date.now();
  const threadID = firstNonEmpty(session && session.NativeThreadID, session && session.NativeSessionID);
  const streamID = String(request.stream_id || request.StreamID || randomID());
  if (!isThreadID(threadID)) {
    yield { stream_id: streamID, type: "error", source: "initial", operation: "append", error: "codex readHistoryStream requires a resolved Codex thread id" };
    return;
  }
  const file = await findRolloutFile(threadID);
  const resolvedAt = Date.now();
  if (!file) {
    yield { stream_id: streamID, type: "end", source: "initial", operation: "append" };
    return;
  }
  const limit = boundedHistoryTurnLimit(request.limit ?? request.Limit);
  // Detail and body requests are independent. On first open the body stream
  // can reach this point before the detail request has cached the active goal.
  // Reading the current runtime is passive and lets the goal become a normal
  // body turn without changing Desktop selection.
  const foregroundRuntime = await currentDesktopRuntimeSnapshot();
  rememberVisibleGoalBodyFromForegroundRuntime(threadID, foregroundRuntime);
  const historyFingerprint = () => {
    const stat = safeStat(file);
    const fileFingerprint = stat ? `${stat.size}:${stat.mtimeMs}` : "";
    return `${fileFingerprint}:${historyRuntimeNotices(threadID).revision}`;
  };
  const turns = historyTurnsFromTail(file, threadID, limit);
  const parsedAt = Date.now();
  const emitted = new Set();
  let latestTurnID = "";
  let observedFingerprint = historyFingerprint();
  for (const turn of turns) {
    emitted.add(turn.turn_id);
    if (!latestTurnID) latestTurnID = turn.turn_id;
    yield { stream_id: streamID, type: "turn", source: "initial", operation: "append", turn };
    if (emitted.size === 1) {
      logTiming("readHistoryStream.firstTurn", startedAt, {
        thread_id: threadID,
        resolve_rollout_ms: resolvedAt - startedAt,
        parse_turns_ms: parsedAt - resolvedAt,
      });
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  const updatedFingerprint = historyFingerprint();
  if (updatedFingerprint && updatedFingerprint !== observedFingerprint) {
    const latest = historyTurnsFromTail(file, threadID, limit)[0];
    if (latest) {
      const operation = latest.turn_id === latestTurnID ? "replace" : "append";
      latestTurnID = latest.turn_id;
      yield { stream_id: streamID, type: "turn", source: "live", operation, turn: latest };
    }
  }
  logTiming("readHistoryStream", startedAt, {
    thread_id: threadID,
    turns: emitted.size,
    resolve_rollout_ms: resolvedAt - startedAt,
    parse_turns_ms: parsedAt - resolvedAt,
  });
  const pageEvent = { stream_id: streamID, type: request.live ? "page_end" : "end", source: "initial", operation: "append" };
  yield pageEvent;
  if (!request.live) return;

  if (!latestTurnID && turns[0]) latestTurnID = turns[0].turn_id;
  let fingerprint = updatedFingerprint || observedFingerprint;
  while (!signal || !signal.aborted) {
    await sleep(300);
    const nextFingerprint = historyFingerprint();
    if (!nextFingerprint || nextFingerprint === fingerprint) continue;
    fingerprint = nextFingerprint;
    const latest = historyTurnsFromTail(file, threadID, limit)[0];
    if (!latest) continue;
    const operation = latest.turn_id === latestTurnID ? "replace" : "append";
    latestTurnID = latest.turn_id;
    yield { stream_id: streamID, type: "turn", source: "live", operation, turn: latest };
  }
}

function rememberVisibleGoalBodyFromForegroundRuntime(threadID, runtime = {}) {
  if (!isThreadID(threadID) || !runtime || typeof runtime !== "object") return false;
  if (firstNonEmpty(runtime.current_thread_id) !== threadID) return false;
  rememberVisibleGoalBody(threadID, goalDetailFromRuntime(runtime));
  return true;
}

async function loadVisibleHistory(threadID, limit = HISTORY_PAGE_LIMIT_MAX) {
  const pageLimit = Math.min(Math.max(Number(limit) || HISTORY_PAGE_LIMIT_MAX, 1), HISTORY_PAGE_LIMIT_MAX);
  const file = await findRolloutFile(threadID);
  if (!file) {
    return { file: "", items: [] };
  }
  const stat = safeStat(file);
  const usedTailRead = Boolean(stat && stat.size > HISTORY_TAIL_BYTES);
  const thread = await findThreadByID(threadID);
  const threadMetadata = {
    ...(thread && thread.metadata ? thread.metadata : {}),
    ...readRolloutContextMetadata(file),
  };
  const rows = readRolloutTailItems(file);
  const internalSummaryRows = internalCompactionSummaryIndexes(rows);
  const ordered = [];
  const byID = new Map();
  for (const [rowIndex, row] of rows.entries()) {
    if (internalSummaryRows.has(rowIndex)) continue;
    const payload = row && row.payload;
    if (!payload || typeof payload !== "object") continue;
    if (row.type !== "response_item" || payload.type !== "message") continue;
    const role = firstNonEmpty(payload.role, "assistant").toLowerCase();
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const id = historyMessageID(row, payload, role);
    if (role === "assistant" && !isDesktopVisibleAssistantMessage(payload)) {
      continue;
    }
    const extractedContent = extractMessageText(payload);
    const goalObjective = role === "user" ? goalObjectiveFromInternalUserEnvelope(extractedContent) : "";
    const content = role === "user" ? firstNonEmpty(goalObjective, visibleUserHistoryText(extractedContent)) : extractedContent;
    if ((role === "user" && ((isInternalUserEnvelope(extractedContent) && !goalObjective) || !content)) ||
        (role === "assistant" && isInternalAssistantNote(extractedContent))) {
      continue;
    }
    const attachments = attachmentsFromContent(payload.content);
    const createdAt = asISOString(
      row.timestamp_ms ?? row.timestamp ?? payload.updated_at ?? payload.created_at,
    );
    const item = {
      ID: id,
      Role: role,
      Type: role === "system" ? "system" : "text",
      Content: content,
      Status: "",
      CreatedAt: createdAt,
      UpdatedAt: createdAt,
      Metadata: {
        thread_id: threadID,
        ...(attachments.length ? { attachments } : {}),
        ...threadMetadata,
      },
    };
    if (!byID.has(id)) {
      if (role === "user" && isInternalUserEnvelope(extractedContent) && !goalObjective) {
        continue;
      }
      byID.set(id, ordered.length);
      ordered.push(item);
      continue;
    }
    const index = byID.get(id);
    if (content.length >= String(ordered[index].Content || "").length) {
      ordered[index] = item;
    }
  }
  const hasVisibleUserMessage = ordered.some((item) => item.Role === "user" && String(item.Content || "").trim() !== "");
  const syntheticUserMessage = firstNonEmpty(
    thread && thread.metadata && thread.metadata.first_user_message,
    thread && thread.metadata && thread.metadata.preview,
  );
  if (!hasVisibleUserMessage && syntheticUserMessage) {
    const createdAt = thread && thread.createdAtMs
      ? new Date(Number(thread.createdAtMs)).toISOString()
      : now();
    ordered.unshift({
      ID: `synthetic-user-${threadID}`,
      Role: "user",
      Type: "text",
      Content: syntheticUserMessage,
      Status: "",
      CreatedAt: createdAt,
      UpdatedAt: createdAt,
      Metadata: {
        thread_id: threadID,
        synthetic: "true",
        ...threadMetadata,
      },
    });
  }
  const visible = historyMessagesForDisplay(ordered);
  if (visible.length > pageLimit || usedTailRead) {
    const sliced = visible.slice(visible.length - pageLimit);
    if (sliced.length) {
      sliced[0] = {
        ...sliced[0],
        Metadata: {
          ...(sliced[0].Metadata || {}),
          truncated: "true",
          has_more: "true",
          omitted_count: String(Math.max(0, visible.length - sliced.length)),
        },
      };
    }
    return { file, items: sliced };
  }
  return { file, items: visible };
}

function historyMessageSignature(items = []) {
  if (!Array.isArray(items) || items.length === 0) {
    return "";
  }
  const hasher = crypto.createHash("sha256");
  for (const item of items) {
    const metadata = item && item.Metadata && typeof item.Metadata === "object" ? item.Metadata : {};
    for (const value of [
      firstNonEmpty(item && item.ID),
      firstNonEmpty(item && item.Role),
      firstNonEmpty(item && item.Type),
      normalizeHistoryText(item && item.Content),
      firstNonEmpty(item && item.Status),
      firstNonEmpty(item && item.CreatedAt),
      firstNonEmpty(item && item.UpdatedAt),
      JSON.stringify(metadata.attachments || []),
      firstNonEmpty(metadata.truncated),
      firstNonEmpty(metadata.has_more),
      firstNonEmpty(metadata.omitted_count),
    ]) {
      hasher.update(String(value || ""));
      hasher.update("\n");
    }
  }
  return hasher.digest("hex");
}

// Rollout dirty-check cache for messages signature. Reading the full history (up to 16MB
// tail) to recompute the signature on every 900ms watcher poll was the main cause of
// plugin process overload (130%+ CPU). Rollout files are append-only, so when the file
// size + mtime are unchanged the body is unchanged and the cached signature is reused.
const messagesSignatureCache = new Map();
const rolloutContextMetadataCache = new Map();

function rolloutContextMetadata(file = "") {
  const stat = safeStat(file);
  if (!stat) {
    return {};
  }
  const fingerprint = `${file}|${stat.size}|${stat.mtimeMs}`;
  const cached = rolloutContextMetadataCache.get(file);
  if (cached && cached.fingerprint === fingerprint) {
    return cached.metadata;
  }
  const metadata = readRolloutContextMetadata(file);
  retainRecentCacheEntry(rolloutContextMetadataCache, file, { fingerprint, metadata }, HISTORY_AUX_CACHE_MAX);
  return metadata;
}

function withRolloutContextMetadata(thread = null) {
  if (!thread || !isThreadID(thread.id)) {
    return thread;
  }
  const file = thread.rolloutPath && fs.existsSync(thread.rolloutPath) && !isArchivedRolloutPath(thread.rolloutPath)
    ? thread.rolloutPath
    : findRolloutFileFromScan(thread.id);
  const metadata = rolloutContextMetadata(file);
  if (!Object.keys(metadata).length) {
    return thread;
  }
  return {
    ...thread,
    rolloutPath: firstNonEmpty(file, thread.rolloutPath),
    metadata: {
      ...(thread.metadata || {}),
      ...metadata,
    },
  };
}

async function threadMessagesSignature(threadID = "") {
  if (!isThreadID(threadID)) {
    return "";
  }
  const file = await findRolloutFile(threadID).catch(() => "");
  if (file) {
    const stat = safeStat(file);
    if (stat) {
      const fingerprint = `${file}|${stat.size}|${stat.mtimeMs}`;
      const cached = messagesSignatureCache.get(threadID);
      if (cached && cached.fingerprint === fingerprint) {
        return cached.signature;
      }
      const history = await loadVisibleHistory(threadID, HISTORY_PAGE_LIMIT_MAX);
      const signature = historyMessageSignature(history.items);
      retainRecentCacheEntry(messagesSignatureCache, threadID, { fingerprint, signature }, HISTORY_AUX_CACHE_MAX);
      return signature;
    }
  }
  const history = await loadVisibleHistory(threadID, HISTORY_PAGE_LIMIT_MAX);
  return historyMessageSignature(history.items);
}

async function readHistory(session, limit) {
  const startedAt = Date.now();
  const threadID = firstNonEmpty(session && session.NativeThreadID, session && session.NativeSessionID);
  if (!isThreadID(threadID)) {
    throw new Error("codex readHistory requires a resolved Codex thread id");
  }
  const history = await loadVisibleHistory(threadID, limit);
  logTiming("readHistory", startedAt, { thread_id: threadID, items: history.items.length });
  return history.items;
}

async function readStatus(session, runID) {
  const threadID = firstNonEmpty(session && session.NativeThreadID, session && session.NativeSessionID);
  if (!isThreadID(threadID)) {
    throw new Error("codex readStatus requires a resolved Codex thread id");
  }
  const file = await findRolloutFile(threadID);
  if (!file || !fs.existsSync(file)) {
    return {
      available: false,
      active: false,
      status: "idle",
      thread_id: threadID,
      preview: "还没有找到这个线程的回复记录。",
      final: "",
      error: "",
      process_text: "",
      steps: [],
    };
  }
  const rawItems = readRolloutItems(file);
  const decoded = decodeRunContext(runID);
  const sinceMs = decoded && decoded.thread_id === threadID ? Number(decoded.started_at || 0) : 0;
  let startIndex = -1;
  if (sinceMs > 0) {
    for (let i = 0; i < rawItems.length; i += 1) {
      const t = Date.parse(rawItems[i].timestamp || "");
      if (Number.isFinite(t) && t >= sinceMs) {
        startIndex = i;
        break;
      }
    }
  }
  if (startIndex < 0) {
    for (let i = rawItems.length - 1; i >= 0; i -= 1) {
      const item = rawItems[i];
      if (item.type === "event_msg" && item.payload && item.payload.type === "task_started") {
        startIndex = i;
        break;
      }
    }
  }
  if (startIndex < 0) {
    startIndex = Math.max(0, rawItems.length - 80);
  }
  if (sinceMs > 0) {
    for (let i = startIndex; i < rawItems.length; i += 1) {
      const item = rawItems[i];
      const t = Date.parse(item.timestamp || "");
      if (Number.isFinite(t) && t >= sinceMs && item.type === "event_msg" && item.payload && item.payload.type === "task_started") {
        startIndex = i;
        break;
      }
    }
  }
  const turnItems = rawItems.slice(startIndex).filter((item) => {
    if (!sinceMs) return true;
    const t = Date.parse(item.timestamp || "");
    return !Number.isFinite(t) || t >= sinceMs;
  });
  let active = Boolean(sinceMs);
  let completed = false;
  let turnID = "";
  let finalText = "";
  let previewText = "";
  let startedAt = "";
  let completedAt = "";
  let sawTaskStarted = false;
  let failureText = "";
  let emptyComplete = false;
  const steps = [];
  const seenThinking = new Set();
  for (const item of turnItems) {
    const payload = item.payload || {};
    failureText = failureText || extractFailureTextFromPayload(payload);
    if (item.type === "event_msg" && payload.type === "task_started") {
      active = true;
      sawTaskStarted = true;
      turnID = firstNonEmpty(payload.turn_id, turnID);
      startedAt = startedAt || item.timestamp || "";
    }
    if (item.type === "turn_context") {
      turnID = firstNonEmpty(payload.turn_id, turnID);
    }
    if (item.type === "event_msg" && payload.type === "task_complete") {
      active = false;
      completed = true;
      completedAt = item.timestamp || completedAt;
      const lastMessage = normalizeHistoryText(payload.last_agent_message || "");
      finalText = lastMessage || finalText;
      if (!lastMessage && !finalText && !previewText && sawTaskStarted) {
        emptyComplete = true;
      }
    }
    if (item.type === "event_msg" && isTerminalFailurePayload(payload)) {
      active = false;
      completed = true;
      completedAt = item.timestamp || completedAt;
      turnID = firstNonEmpty(payload.turn_id, turnID);
    }
    const step = stepFromEvent(item);
    if (!step) continue;
    if (step.kind === "thinking") {
      const key = step.text || "thinking";
      if (seenThinking.has(key)) continue;
      seenThinking.add(key);
    }
    if ((step.kind === "assistant" || step.kind === "final") && step.text) previewText = step.text;
    if (step.kind === "final" && step.text) finalText = step.text;
    if (["start", "thinking", "tool", "complete", "error"].includes(step.kind)) {
      steps.push(step);
    }
  }
  const context = contextUsageFromItems(rawItems);
  const model = currentModelFromItems(rawItems);
  const reasoningMode = currentReasoningModeFromItems(rawItems);
  let liveComposer = null;
  const desktopState = await codexDesktopController()
    .then(async (controller) => {
      const snapshot = await controller.currentThreadRuntimeState().catch(() => null);
      const currentThreadId = snapshot && snapshot.current_thread_id ? String(snapshot.current_thread_id) : "";
      const sameThread = currentThreadId === threadID || currentThreadId.endsWith(`:${threadID}`);
      if (!sameThread) {
        return null;
      }
      liveComposer = await readLiveComposerControls(threadID, controller, { selectThread: false }).catch(() => null);
      return snapshot;
    })
    .catch(() => null);
  // Runtime-only notices such as Codex reconnect attempts are not persisted in
  // the rollout. Keep the latest watcher observation so the history relay can
  // emit a replacement for the active turn without polling CDP itself.
  updateHistoryRuntimeNotices(threadID, desktopState && desktopState.runtime_notices);
  const failed = completed && !finalText && (emptyComplete || Boolean(failureText));
  if (desktopState && desktopState.running) {
    active = true;
    completed = false;
  }
  const waitingApproval = Boolean(desktopState && desktopState.waiting_approval);
  const queuePending = Boolean(desktopState && desktopState.queue_pending);
  const status = waitingApproval
    ? "waiting_approval"
    : failed ? "error"
      : completed ? "complete"
        : active ? "running"
          : "idle";
  const primaryAction = desktopState && desktopState.primary_action ? String(desktopState.primary_action) : "";
  const waiting = sinceMs && !steps.length;
  const statusSteps = steps.slice(-80);
  const phase = inferPhaseFromSteps(statusSteps);
  const startMs = Date.parse(startedAt || "") || sinceMs || 0;
  const endMs = completedAt ? Date.parse(completedAt) : Date.now();
  const durationMs = startMs ? Math.max(0, endMs - startMs) : 0;
  const runtimeStatusValue = waitingApproval ? "waiting_approval" : (waiting ? "waiting" : status);
  const currentModel = liveComposer && liveComposer.model && firstNonEmpty(liveComposer.model.id, liveComposer.model.displayName)
    ? liveComposer.model
    : model;
  const currentReasoning = liveComposer && liveComposer.reasoning && firstNonEmpty(liveComposer.reasoning.key, liveComposer.reasoning.value)
    ? liveComposer.reasoning
    : reasoningMode;
  const currentApprovalMode = liveComposer && liveComposer.approval && firstNonEmpty(liveComposer.approval.key, liveComposer.approval.value)
    ? liveComposer.approval
    : currentApprovalModeFromItems(rawItems);
  if (liveComposer) {
    updateThreadPluginState(threadID, {
      model: firstNonEmpty(currentModel && currentModel.id, currentModel && currentModel.displayName),
      reasoning_effort: firstNonEmpty(currentReasoning && currentReasoning.key, currentReasoning && currentReasoning.value),
      approval_mode: firstNonEmpty(currentApprovalMode && currentApprovalMode.key, currentApprovalMode && currentApprovalMode.value),
    });
  }
  return {
    status: runtimeStatusValue,
    turn_id: turnID,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
    context,
    model: currentModel,
    reasoning_mode: currentReasoning,
    interruptible: Boolean(desktopState && desktopState.interrupt_available) || active,
    approval_blocked: waitingApproval,
    primary_action: primaryAction,
    phase,
    preview: finalText || previewText || failureText || (
      waitingApproval
        ? "Codex 正在等待审批…"
        : queuePending
          ? "消息已排队，等待当前任务结束后发送…"
          : (waiting ? "已发送，等待 Codex 开始回复…" : active ? "Codex 正在回复…" : "暂无可显示回复。")
    ),
    steps: statusSteps,
    trace: { items: runTraceFromSteps(statusSteps), truncated: steps.length > statusSteps.length },
  };
}

async function latestAssistantSummary(threadID) {
  const file = await findRolloutFile(threadID);
  if (!file) {
    return { summary: "", terminal: false, failed: false, evidence: "" };
  }
  try {
    let summary = "";
    let terminal = false;
    let failed = false;
    for (const row of readRecentRolloutRows(file, 1)) {
      const payload = row && row.payload;
      if (!payload || typeof payload !== "object") continue;
      if (row.type === "response_item" && payload.type === "message" && payload.role === "assistant") {
        const text = extractTextFromContent(payload.content);
        if (text) {
          summary = text;
        }
      }
      if (row.type === "event_msg" && payload.type === "task_complete") {
        terminal = true;
      }
      if (row.type === "event_msg" && payload.type === "task_failed") {
        terminal = true;
        failed = true;
      }
    }
    return { summary, terminal, failed, evidence: file };
  } catch {
    return { summary: "", terminal: false, failed: false, evidence: file };
  }
}

function summarizeRolloutChunk(file, offset = 0) {
  if (!file) {
    return { summary: "", terminal: false, failed: false, interrupted: false, evidence: "" };
  }
  try {
    const raw = fs.readFileSync(file, "utf8");
    const slice = offset > 0 ? raw.slice(offset) : raw;
    const lines = slice.split(/\r?\n/);
    let summary = "";
    let terminal = false;
    let failed = false;
    let interrupted = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let row;
      try {
        row = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const payload = row && row.payload;
      if (!payload || typeof payload !== "object") continue;
      if (row.type === "response_item" && payload.type === "message" && payload.role === "assistant") {
        const text = extractTextFromContent(payload.content);
        if (text) {
          summary = text;
        }
      }
      if (row.type === "event_msg" && payload.type === "task_complete") {
        terminal = true;
      }
      if (payload.type === "turn_aborted") {
        terminal = true;
        interrupted = true;
      }
      if (row.type === "event_msg" && payload.type === "task_failed") {
        terminal = true;
        failed = true;
      }
    }
    return { summary, terminal, failed, interrupted, evidence: file };
  } catch {
    return { summary: "", terminal: false, failed: false, interrupted: false, evidence: file };
  }
}

async function waitForMarker(threadID, marker) {
  const deadline = Date.now() + VISIBILITY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await markerVisible(threadID, marker);
    if (res.visible) {
      return res;
    }
    await sleep(VISIBILITY_POLL_MS);
  }
  return markerVisible(threadID, marker);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deepLink(threadID) {
  return `codex://threads/${threadID}`;
}

async function focusTarget(threadID = "") {
  if (!isThreadID(threadID)) {
    throw new Error("codex thread id required");
  }
  const controller = await codexDesktopController();
  await selectRequiredCodexThread(controller, threadID);
}

async function selectRequiredCodexThread(controller, threadID = "") {
  if (!controller || !isThreadID(threadID)) {
    throw new Error("control_target_stale: target conversation is unavailable");
  }
  const selected = await controller.selectThread(threadID);
  if (!selected || selected.selected !== true || !await controller.isThreadSelected(threadID)) {
    throw new Error("control_target_stale: target conversation is not the current desktop conversation");
  }
  return selected;
}

async function activateThread(threadID) {
  await focusTarget(threadID);
}

async function activateNewThread(cwd = "") {
  const controller = await codexDesktopController();
  if (cwd) {
    await controller.startNewThreadInProject(cwd);
    return;
  }
  await controller.startNewProjectlessThread();
}

async function activateNewProjectlessThread() {
  const controller = await codexDesktopController();
  await controller.startNewProjectlessThread();
}

function isNewDirectThreadID(threadID = "", previousThreadID = "") {
  if (!isThreadID(threadID)) return false;
  const previous = firstNonEmpty(previousThreadID);
  return !isThreadID(previous) || threadID !== previous;
}

async function waitForDirectActiveThread(previousThreadID = "", timeoutMs = THREAD_CREATE_TIMEOUT_MS) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    const snapshot = await currentDesktopRuntimeSnapshot().catch(() => null);
    const threadID = firstNonEmpty(snapshot && snapshot.current_thread_id);
    if (isNewDirectThreadID(threadID, previousThreadID)) {
      return threadID;
    }
    await sleep(VISIBILITY_POLL_MS);
  }
  return "";
}

async function resolveStartedThreadIDAfterSend(options = {}) {
  const existingThreadID = firstNonEmpty(options.existingThreadID);
  if (isThreadID(existingThreadID)) {
    return existingThreadID;
  }
  const previousThreadID = firstNonEmpty(options.previousThreadID);
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || THREAD_POST_SEND_RESOLVE_MS);
  const waitForDirect = typeof options.waitForDirect === "function"
    ? options.waitForDirect
    : (threadID, ms) => waitForDirectActiveThread(threadID, ms);
  return waitForDirect(previousThreadID, timeoutMs);
}

// This path intentionally reads only Codex Desktop's current active thread
// state after the new-thread action. It never chooses the newest SQLite row,
// rollout file, title, or list item as the newly created conversation.
async function startSessionWithMessage(req) {
  const message = req && req.Message && typeof req.Message === "object" ? req.Message : {};
  const messageID = firstNonEmpty(message.PrismMessageID);
  const text = firstNonEmpty(message.Text);
  const attachments = Array.isArray(message.Attachments) ? message.Attachments : [];
  const visibilityMarker = firstNonEmpty(text, attachments[0] && attachments[0].Name);
  if (!messageID || !visibilityMarker) {
    throw new Error("codex startSessionWithMessage requires PrismMessageID and text or attachments");
  }
  const previous = startedSessionState(messageID);
  if (previous) {
    let recoveredThreadID = isThreadID(previous.thread_id) ? previous.thread_id : "";
    if (!recoveredThreadID) {
      recoveredThreadID = await resolveStartedThreadIDAfterSend({
        previousThreadID: firstNonEmpty(previous.previous_thread_id),
        sinceMs: Date.parse(firstNonEmpty(previous.started_at, previous.updatedAt)) || 0,
        text: firstNonEmpty(previous.text, text),
        cwd: firstNonEmpty(previous.cwd),
        timeoutMs: Math.min(THREAD_POST_SEND_RESOLVE_MS, 2600),
      });
    }
    if (!isThreadID(recoveredThreadID)) {
      throw new Error("codex start outcome is unknown; refusing to create or send a duplicate first message");
    }
    if (recoveredThreadID !== previous.thread_id) {
      updateStartedSessionState(messageID, { thread_id: recoveredThreadID });
    }
    const session = toSession(recoveredThreadID, firstNonEmpty(previous.cwd));
    const visibility = await verifyVisibility(session, visibilityMarker);
    if (!visibility.Visible) {
      throw new Error("codex start outcome is unknown; refusing to create or send a duplicate first message");
    }
    return {
      Session: session,
      Receipt: {
        NativeMessageID: firstNonEmpty(previous.native_message_id, messageID),
        CanonicalNativeSessionID: recoveredThreadID,
        CanonicalNativeThreadID: recoveredThreadID,
        Accepted: true,
        Visible: true,
        Detail: "duplicate Codex conversation start",
      },
      Visibility: visibility,
    };
  }
  const cwd = projectCwdOrEmpty(req && req.Cwd ? req.Cwd : "");
  const previousRuntime = await currentDesktopRuntimeSnapshot().catch(() => null);
  const previousThreadID = firstNonEmpty(previousRuntime && previousRuntime.current_thread_id);
  if (!isThreadID(previousThreadID)) {
    throw new Error("codex desktop draft is already open; first message was not sent");
  }
  const controller = await codexDesktopController();
  await activateNewThread(cwd);
  try {
    await controller.waitForFreshDraft(previousThreadID, 2200);
  } catch {
    throw new Error("codex could not open a fresh draft; first message was not sent");
  }
  // Codex keeps a new project draft anonymous until the first message is
  // submitted. Waiting here only adds a fixed delay to every mobile start.
  const draftRuntime = await currentDesktopRuntimeSnapshot().catch(() => null);
  let threadID = firstNonEmpty(draftRuntime && draftRuntime.current_thread_id);
  if (!isNewDirectThreadID(threadID, previousThreadID)) {
    threadID = "";
  }
  await controller.focusComposer();
  const startedAt = Date.now();
  // Persist the start attempt before submit. If Codex delays the real thread id
  // until after first send, retries must still refuse to create a duplicate.
  updateStartedSessionState(messageID, {
    thread_id: threadID,
    previous_thread_id: previousThreadID,
    cwd,
    text,
    started_at: new Date(startedAt).toISOString(),
    status: isThreadID(threadID) ? "created" : "launching",
  });
  const preSendCursor = isThreadID(threadID) ? await rolloutCursor(threadID) : { file: "", offset: 0 };
  await controller.sendMessage({
    text,
    attachments: attachments.map((attachment) => ({
      localPath: attachment.LocalPath,
      name: attachment.Name,
      mimeType: attachment.MIMEType,
    })),
  });
  threadID = await resolveStartedThreadIDAfterSend({
    existingThreadID: threadID,
    previousThreadID,
    sinceMs: startedAt,
    text,
    cwd,
    timeoutMs: THREAD_POST_SEND_RESOLVE_MS,
  });
  if (!isThreadID(threadID)) {
    throw new Error("codex could not obtain a new direct active thread id after creating a new thread");
  }
  updateStartedSessionState(messageID, { thread_id: threadID, status: "created" });
  const runContext = {
    thread_id: threadID,
    started_at: startedAt,
    ...(preSendCursor.file || preSendCursor.offset ? preSendCursor : await rolloutCursor(threadID)),
  };
  const nativeMessageID = encodeRunContext(runContext);
  updateStartedSessionState(messageID, { native_message_id: nativeMessageID, status: "submitted" });
  const session = toSession(threadID, cwd);
  const visibility = await verifyVisibility(session, visibilityMarker);
  if (!visibility.Visible) {
    throw new Error(`codex could not verify the first message: ${firstNonEmpty(visibility.FailureReason)}`);
  }
  updateStartedSessionState(messageID, { status: "visible" });
  return {
    Session: session,
    Receipt: {
      NativeMessageID: nativeMessageID,
      CanonicalNativeSessionID: threadID,
      CanonicalNativeThreadID: threadID,
      Accepted: true,
      Visible: true,
      Detail: "first message pasted into a new Codex Desktop thread",
    },
    Visibility: visibility,
  };
}

function draftStale(message = "desktop draft is no longer the active empty draft") {
  return new Error(`draft_stale: ${message}`);
}

function anonymousDraftFingerprint(runtime = {}) {
  if (!runtime || isThreadID(firstNonEmpty(runtime.current_thread_id))) return "";
  return firstNonEmpty(runtime.client_thread_id);
}

function isReplaceableAnonymousDraft(runtime = {}) {
  if (!runtime || isThreadID(firstNonEmpty(runtime.current_thread_id))) return false;
  return Boolean(
    anonymousDraftFingerprint(runtime)
    && !String(runtime.composer_text || "").trim()
    && runtime.composer_available !== false
    && runtime.running !== true
    && runtime.waiting_approval !== true
  );
}

async function waitForFreshCodexDraft(controller, previousRuntime = {}, timeoutMs = 2200) {
  const previousThreadID = firstNonEmpty(previousRuntime && previousRuntime.current_thread_id);
  if (isThreadID(previousThreadID)) {
    await controller.waitForFreshDraft(previousThreadID, timeoutMs);
    return;
  }
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    const current = await controller.currentThreadRuntimeState().catch(() => null);
    const fingerprint = anonymousDraftFingerprint(current);
    // Codex may keep the same opaque client-thread identity when the exact
    // project new-thread action targets an already-empty draft. The action
    // itself has been resolved against the requested cwd, so an empty readable
    // anonymous draft is sufficient even when its fingerprint is unchanged.
    if (fingerprint && isReplaceableAnonymousDraft(current)) return;
    await sleep(100);
  }
  throw new Error("fresh anonymous Codex draft did not become active");
}

function isCurrentAnonymousMobileDraft(draft, runtime = {}) {
  const expected = firstNonEmpty(draft && draft.client_thread_id);
  const actual = anonymousDraftFingerprint(runtime);
  return Boolean(expected && actual && expected === actual);
}

function purgeExpiredMobileDrafts() {
  const deadline = Date.now() - MOBILE_DRAFT_TTL_MS;
  for (const [id, draft] of mobileDrafts.entries()) {
    const openedAt = Date.parse(String(draft && draft.opened_at || ""));
    if (!Number.isFinite(openedAt) || openedAt < deadline) mobileDrafts.delete(id);
  }
  while (mobileDrafts.size > MOBILE_DRAFT_MAX) {
    mobileDrafts.delete(mobileDrafts.keys().next().value);
  }
}

function publicDraftControlOptions(options = []) {
  return publicControlOptions(options);
}

async function describeCodexDraftControls(controller, expectedFingerprint = "") {
  const runtime = await controller.currentThreadRuntimeState().catch(() => null);
  const activeThreadID = firstNonEmpty(runtime && runtime.current_thread_id);
  if (isThreadID(activeThreadID)) {
    throw draftStale("desktop foreground changed to a conversation");
  }
  if (!runtime || String(runtime.composer_text || "").trim()) {
    throw draftStale("desktop draft is no longer empty");
  }
  const fingerprint = anonymousDraftFingerprint(runtime);
  if (!fingerprint) {
    throw draftStale("desktop draft fingerprint is not readable");
  }
  if (expectedFingerprint && fingerprint !== expectedFingerprint) {
    throw draftStale("desktop foreground changed to another anonymous draft");
  }
  const current = await controller.composerControlState().catch(() => null);
  if (!current || typeof current !== "object") {
    throw draftStale("desktop draft composer is not readable");
  }
  const interactiveControls = await readCodexInteractiveControls(controller);
  return {
    interactive_controls: interactiveControls,
    actions: [],
  };
}

async function assertActiveMobileDraft(draftID) {
  purgeExpiredMobileDrafts();
  const draft = mobileDrafts.get(String(draftID || "").trim());
  if (!draft) throw draftStale("draft is unknown to this plugin process");
  const controller = await codexDesktopController();
  const controls = await describeCodexDraftControls(controller, draft.client_thread_id);
  return { draft, controller, controls };
}

async function openDraft(req) {
  purgeExpiredMobileDrafts();
  const draftID = firstNonEmpty(req && req.DraftID, req && req.draft_id);
  if (!draftID) throw new Error("codex openDraft requires draft_id");
  const cwd = projectCwdOrEmpty(req && (req.Cwd || req.cwd) ? (req.Cwd || req.cwd) : "");
  const controller = await codexDesktopController();
  const previous = await currentDesktopRuntimeSnapshot().catch(() => null);
  const previousThreadID = firstNonEmpty(previous && previous.current_thread_id);
  if (!isThreadID(previousThreadID) && !isReplaceableAnonymousDraft(previous)) {
    throw new Error("codex cannot replace a non-empty or unreadable anonymous desktop draft");
  }
  await activateNewThread(cwd);
  try {
    await waitForFreshCodexDraft(controller, previous, 2200);
  } catch {
    throw new Error("codex could not open a fresh desktop draft");
  }
  const runtime = await controller.currentThreadRuntimeState().catch(() => null);
  const fingerprint = anonymousDraftFingerprint(runtime);
  if (!fingerprint) {
    throw draftStale("desktop draft fingerprint is not readable");
  }
  const controls = await describeCodexDraftControls(controller, fingerprint);
  // Desktop has only one foreground anonymous draft. Any older remote draft
  // handle is stale now, including the idempotent same-fingerprint case.
  mobileDrafts.clear();
  mobileDrafts.set(draftID, {
    draft_id: draftID,
    cwd,
    previous_thread_id: previousThreadID,
    client_thread_id: fingerprint,
    opened_at: now(),
  });
  purgeExpiredMobileDrafts();
  return { DraftID: draftID, Cwd: cwd, Controls: controls, draft_fingerprint: fingerprint };
}

async function controlDraft(req) {
  const draftID = firstNonEmpty(req && req.DraftID, req && req.draft_id);
  const action = String(firstNonEmpty(req && req.Action, req && req.action)).trim().toLowerCase();
  const target = req && (req.Target || req.target);
  const { draft, controller, controls } = await assertActiveMobileDraft(draftID);
  if (action === "menu_session.describe") {
    const owner = target && typeof target === "object" ? target.owner : null;
    const matching = owner && owner.kind === "interactive_control" &&
      Array.isArray(controls && controls.interactive_controls) &&
      controls.interactive_controls.some((control) => control && control.control_id === owner.control_id && control.menu_available !== false);
    if (!matching) throw draftStale("desktop draft menu owner is no longer available");
    const described = await describeCodexMenuSession("", owner, { controller, draftID });
    return {
      DraftID: draftID,
      Cwd: draft.cwd,
      Controls: controls,
      Details: described.details,
    };
  }
  if (action === "menu_session.apply") {
    const applied = await applyCodexMenuSession("", target, { controller, draftID });
    const nextControls = await describeCodexDraftControls(controller, draft.client_thread_id);
    if (applied && applied.details && applied.details.interactive_surface) {
      nextControls.interactive_surface = applied.details.interactive_surface;
    }
    return {
      DraftID: draftID,
      Cwd: draft.cwd,
      Controls: nextControls,
      Details: applied.details,
    };
  }
  if (action === "interactive.surface.apply") {
    return runExclusiveDesktopControl(async () => {
      // Re-read the opaque draft fingerprint under the same critical section
      // as surface apply so a watcher poll cannot race a desktop switch.
      const active = await assertActiveMobileDraft(draftID);
      const surfaceID = String(target && typeof target === "object" ? target.surface_id : "").trim();
      const actionID = String(target && typeof target === "object" ? target.action_id : "").trim();
      const input = String(target && typeof target === "object" ? target.input || "" : "");
      if (!surfaceID || !actionID) {
        throw new Error("control_target_stale: interactive.surface.apply requires surface_id and action_id from the current desktop draft");
      }
      await active.controller.applyInteractiveSurface(surfaceID, actionID, input);
      const nextControls = await describeCodexDraftControls(active.controller, active.draft.client_thread_id);
      return {
        DraftID: draftID,
        Cwd: active.draft.cwd,
        Controls: nextControls,
        Details: {},
      };
    });
  }
  throw new Error(`unsupported draft control action: ${action || "unknown"}`);
}

async function startDraftWithMessage(req) {
  const draftID = firstNonEmpty(req && req.DraftID, req && req.draft_id);
  const message = req && req.Message && typeof req.Message === "object" ? req.Message : {};
  const messageID = firstNonEmpty(message.PrismMessageID, message.prism_message_id);
  const text = firstNonEmpty(message.Text, message.text);
  const attachments = Array.isArray(message.Attachments) ? message.Attachments : [];
  const visibilityMarker = firstNonEmpty(text, attachments[0] && attachments[0].Name);
  if (!draftID || !messageID || !visibilityMarker) {
    throw new Error("codex startDraftWithMessage requires draft_id, PrismMessageID and text or attachments");
  }
  const { draft, controller } = await assertActiveMobileDraft(draftID);
  const previous = startedSessionState(messageID);
  if (previous) {
    const threadID = await resolveStartedThreadIDAfterSend({
      existingThreadID: firstNonEmpty(previous.thread_id), previousThreadID: firstNonEmpty(previous.previous_thread_id),
      timeoutMs: Math.min(THREAD_POST_SEND_RESOLVE_MS, 2600),
    });
    if (!isThreadID(threadID)) throw new Error("codex draft start outcome is unknown; refusing duplicate first message");
    const session = toSession(threadID, firstNonEmpty(previous.cwd, draft.cwd));
    const visibility = await verifyVisibility(session, visibilityMarker);
    if (!visibility.Visible) throw new Error("codex draft start outcome is unknown; refusing duplicate first message");
    return { Session: session, Receipt: { NativeMessageID: firstNonEmpty(previous.native_message_id, messageID), Accepted: true, Visible: true, Detail: "duplicate Codex draft start" }, Visibility: visibility };
  }
  const startedAt = Date.now();
  updateStartedSessionState(messageID, { previous_thread_id: draft.previous_thread_id, cwd: draft.cwd, text, started_at: now(), status: "launching" });
  await controller.sendMessage({
    text,
    attachments: attachments.map((attachment) => ({
      localPath: attachment.LocalPath,
      name: attachment.Name,
      mimeType: attachment.MIMEType,
    })),
  });
  const threadID = await resolveStartedThreadIDAfterSend({ previousThreadID: draft.previous_thread_id, timeoutMs: THREAD_POST_SEND_RESOLVE_MS });
  if (!isThreadID(threadID)) throw new Error("codex could not obtain a native thread id after draft submission");
  updateStartedSessionState(messageID, { thread_id: threadID, status: "created" });
  const runContext = { thread_id: threadID, started_at: startedAt, ...(await rolloutCursor(threadID)) };
  const nativeMessageID = encodeRunContext(runContext);
  updateStartedSessionState(messageID, { native_message_id: nativeMessageID, status: "submitted" });
  const session = toSession(threadID, draft.cwd);
  const visibility = await verifyVisibility(session, visibilityMarker);
  if (!visibility.Visible) throw new Error(`codex could not verify the draft first message: ${firstNonEmpty(visibility.FailureReason)}`);
  updateStartedSessionState(messageID, { status: "visible" });
  mobileDrafts.delete(draftID);
  return {
    Session: session,
    Receipt: { NativeMessageID: nativeMessageID, CanonicalNativeSessionID: threadID, CanonicalNativeThreadID: threadID, Accepted: true, Visible: true, Detail: "first message submitted from a Codex Desktop draft" },
    Visibility: visibility,
  };
}

function controlTargetForOption(option = {}) {
  const optionID = String(option && option.id || "").trim();
  if (!optionID || option.menuVerified !== true) return null;
  return { option_id: optionID };
}

function publicControlOption(option = {}) {
  const target = controlTargetForOption(option);
  const { menuIndex, menuVerified, ...publicOption } = option || {};
  return target ? { ...publicOption, target } : publicOption;
}

function publicControlOptions(options = []) {
  return (Array.isArray(options) ? options : []).map(publicControlOption);
}

function resolveStructuredControlTarget(action = "", target = null, options = []) {
  const optionID = String(target && typeof target === "object" ? target.option_id : "").trim();
  if (!optionID) {
    throw new Error(`control_target_stale: ${action} requires option_id from the current detail`);
  }
  const matches = (Array.isArray(options) ? options : []).filter((item) =>
    item && item.menuVerified === true && String(item.id || "").trim() === optionID,
  );
  if (matches.length !== 1) {
    throw new Error(`control_target_stale: ${action} target is not present in the current desktop menu`);
  }
  return matches[0];
}

function approvalModeFromValue(value = "") {
  const raw = normalizeControlLabel(value);
  return {
    available: Boolean(raw),
    key: raw,
    value: raw,
    label: raw,
    displayName: raw,
  };
}

function currentApprovalModeFromItems(items = []) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    const payload = item && item.payload ? item.payload : {};
    const value = firstNonEmpty(
      payload.approval_policy,
      payload.approval_mode,
      payload.metadata && payload.metadata.approval_mode,
    );
    if (value) {
      return approvalModeFromValue(value);
    }
  }
  return approvalModeFromValue(tomlStringValue(readCodexConfigText(), "approval_policy"));
}

function liveApprovalOptionFromRow(row = {}) {
  const optionID = String(firstNonEmpty(row.optionId, row.option_id)).trim();
  const label = normalizeControlLabel(firstNonEmpty(row.label, row.text, row.displayName));
  if (!optionID || !label || !Number.isInteger(row.index) || row.index < 0) return null;
  return {
    id: optionID,
    key: label,
    value: label,
    label,
    displayName: label,
    available: row.disabled !== true,
    current: Boolean(row.checked),
    menuIndex: row.index,
    menuVerified: true,
  };
}

function liveReasoningOptionFromRow(row = {}) {
  const optionID = String(firstNonEmpty(row.optionId, row.option_id)).trim();
  const text = normalizeControlLabel(firstNonEmpty(row.label, row.text, row.displayName));
  return text ? {
    id: optionID,
    key: text,
    value: text,
    label: text,
    displayName: text,
    available: true,
    current: Boolean(row.checked),
    menuIndex: row.index,
    menuVerified: true,
  } : null;
}

function liveModelOptionFromRow(row = {}) {
  const optionID = String(firstNonEmpty(row.optionId, row.option_id)).trim();
  const text = normalizeControlLabel(firstNonEmpty(row.label, row.text, row.displayName));
  if (!optionID || !text) return null;
  return {
    id: optionID,
    key: text,
    label: text,
    displayName: text,
    available: true,
    current: Boolean(row.checked),
    menuIndex: row.index,
    menuVerified: true,
  };
}

function desktopRawLabel(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function dynamicInteractiveControl(controlID = "", displayLabel = "", currentValue = "", semanticKinds = []) {
  const normalizedControlID = String(controlID || "").trim();
  const normalizedDisplayLabel = desktopRawLabel(displayLabel);
  const normalizedCurrentValue = desktopRawLabel(currentValue);
  if (!normalizedControlID || !normalizedDisplayLabel || !normalizedCurrentValue) {
    return null;
  }
  return {
    control_id: normalizedControlID,
    display_label: normalizedDisplayLabel,
    current_value: normalizedCurrentValue,
    menu_available: true,
    semantic_kinds: Array.from(new Set(
      (Array.isArray(semanticKinds) ? semanticKinds : [])
        .map((kind) => String(kind || "").trim().toLowerCase())
        .filter((kind) => ["model", "reasoning", "permission"].includes(kind)),
    )),
  };
}

async function readCodexInteractiveControls(controller) {
  // This is watcher-safe: it reads only the already-rendered composer. A
  // missing or ambiguous root is omitted rather than recovered by opening a
  // menu, matching text, or preserving a stale cache entry.
  const closed = await controller.closedComposerControls().catch(() => null);
  const controls = [];
  const intelligence = closed && closed.intelligence;
  // This is a product label only. The control itself is resolved exclusively
  // through data-codex-intelligence-trigger and session-time ARIA ownership.
  const intelligenceControl = dynamicInteractiveControl(
    intelligence && intelligence.controlId,
    "模型与推理",
    intelligence && intelligence.currentValue,
    ["model", "reasoning"],
  );
  if (intelligenceControl) controls.push(intelligenceControl);
  const permission = closed && closed.permission;
  // Codex renders only the current permission value. The stable DOM anchor is
  // technical (`permissions`), while this fixed product label keeps the
  // Mobile control readable without deriving any option from localized text.
  const permissionControl = dynamicInteractiveControl(
    "codex.permission",
    "权限",
    permission && permission.currentValue,
    ["permission"],
  );
  if (permissionControl) controls.push(permissionControl);
  return controls;
}

function purgeExpiredMenuSessions() {
  const nowMs = Date.now();
  for (const [id, session] of menuSessions.entries()) {
    if (!session || nowMs >= Number(session.expires_at || 0)) menuSessions.delete(id);
  }
}

function sameMenuOwner(left = null, right = null) {
  return JSON.stringify(left || {}) === JSON.stringify(right || {});
}

function menuSessionRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    option_id: String(row && (row.optionId || row.option_id || row.id) || "").trim(),
    label: desktopRawLabel(row && (row.label || row.text || row.displayName)),
    disabled: row && row.disabled === true,
    current: row && (row.current === true || row.checked === true),
  })).filter((row) => row.option_id && row.label);
}

function createPluginMenuSession(threadID, owner, rows, draftID = "", groups = []) {
  purgeExpiredMenuSessions();
  const normalizedRows = menuSessionRows(rows);
  const normalizedGroups = (Array.isArray(groups) ? groups : []).map((group) => ({
    control_id: String(group && group.control_id || "").trim(),
    label: desktopRawLabel(group && group.label),
    rows: menuSessionRows(group && group.rows),
  })).filter((group) => group.control_id && group.label && group.rows.length);
  if (!normalizedRows.length && !normalizedGroups.length) {
    throw new Error("control_target_stale: desktop menu has no readable entries");
  }
  if (normalizedRows.length && new Set(normalizedRows.map((row) => row.option_id)).size !== normalizedRows.length) {
    throw new Error("control_target_stale: desktop menu entries are not uniquely identifiable");
  }
  for (const group of normalizedGroups) {
    if (new Set(group.rows.map((row) => row.option_id)).size !== group.rows.length) {
      throw new Error("control_target_stale: desktop menu group entries are not uniquely identifiable");
    }
  }
  const id = `codex-menu-${randomID()}`;
  const entries = [];
  const publicGroups = normalizedGroups.map((group) => {
    const groupID = `codex-group-${randomID()}`;
    const groupEntries = group.rows.map((row) => {
      const entry = {
        entry_id: `codex-entry-${randomID()}`,
        label: row.label,
        available: !row.disabled,
        current: row.current === true,
        option_id: row.option_id,
        control_id: group.control_id,
        expected_rows: group.rows,
      };
      entries.push(entry);
      return entry;
    });
    return {
      group_id: groupID,
      label: group.label,
      entries: groupEntries.map(({ entry_id, label, available, current }) => ({ entry_id, label, available, current })),
    };
  });
  for (const row of normalizedRows) {
    entries.push({
      entry_id: `codex-entry-${randomID()}`,
      label: row.label,
      available: !row.disabled,
      current: row.current === true,
      option_id: row.option_id,
      control_id: "",
      expected_rows: normalizedRows,
    });
  }
  const expiresAt = Date.now() + MENU_SESSION_TTL_MS;
  menuSessions.set(id, {
    id,
    thread_id: threadID,
    draft_id: draftID,
    owner: { ...owner },
    rows: normalizedRows,
    entries,
    expires_at: expiresAt,
  });
  while (menuSessions.size > MENU_SESSION_MAX) {
    menuSessions.delete(menuSessions.keys().next().value);
  }
  return {
    menu_session_id: id,
    entries: entries.map(({ entry_id, label, available, current }) => ({ entry_id, label, available, current })),
    groups: publicGroups,
    expires_at: expiresAt,
  };
}

function resolvePluginMenuSession(menuSessionID, threadID, draftID = "") {
  purgeExpiredMenuSessions();
  const session = menuSessions.get(String(menuSessionID || "").trim());
  if (!session || session.thread_id !== String(threadID || "").trim() || session.draft_id !== String(draftID || "").trim()) {
    throw new Error("control_target_stale: menu session is no longer valid");
  }
  return session;
}

async function describeCodexMenuSession(threadID = "", owner = null, options = {}) {
  return runExclusiveDesktopControl(async () => {
    const ownerKind = String(owner && owner.kind || "").trim();
    if (ownerKind !== "interactive_control" && ownerKind !== "queue_item" && ownerKind !== "conversation") {
      throw new Error("control_target_stale: unsupported Codex menu owner");
    }
    const controlID = String(owner && owner.control_id || "").trim();
    const queueItemID = String(owner && owner.queue_item_id || "").trim();
    if (ownerKind === "interactive_control" && !controlID) {
      throw new Error("control_target_stale: menu owner requires control_id");
    }
    if (ownerKind === "queue_item" && !queueItemID) {
      throw new Error("control_target_stale: menu owner requires queue_item_id");
    }
    const controller = options.controller || await codexDesktopController();
    const draftID = String(options.draftID || "").trim();
    if (ownerKind === "queue_item" && draftID) {
      throw new Error("draft_stale: queue menus are unavailable for a desktop draft");
    }
    if (draftID) {
      await assertActiveMobileDraft(draftID);
    } else {
      // Panel can stay on a conversation after the Desktop user has navigated
      // to another thread. A menu read is a user-initiated control action, so
      // restore the exact native thread before inspecting its live menu.
      // The opaque rows are still captured afresh below and revalidated again
      // before apply; this does not weaken the stale-target guard.
      await selectRequiredCodexThread(controller, threadID);
    }
    if (ownerKind === "queue_item") {
      const queue = await controller.queuedMessageState();
      const item = queue && Array.isArray(queue.items)
        ? queue.items.find((candidate) => candidate && candidate.id === queueItemID && candidate.has_more_actions === true)
        : null;
      if (!item) {
        throw new Error("control_target_stale: queue item no longer declares a unique action menu");
      }
    }
    if (ownerKind === "conversation" && !await controller.conversationHeaderMenuAvailable()) {
      throw new Error("control_target_stale: conversation menu is no longer available");
    }
    const described = await controller.withTransparentNativeMenus(async () => {
      if (ownerKind === "queue_item") {
        return { rows: await controller.describeQueuedMessageMenu(queueItemID), groups: [] };
      }
      if (ownerKind === "conversation") {
        return { rows: await controller.describeConversationHeaderMenu(), groups: [] };
      }
      if (controlID === "codex.permission") {
        return { rows: await controller.listPermissionOptions(), groups: [] };
      }
      if (controlID === "codex.intelligence") {
        return { rows: [], groups: await controller.listIntelligenceMenuGroups() };
      }
      return { rows: await controller.listIntelligenceControlOptions(controlID), groups: [] };
    });
    const created = createPluginMenuSession(threadID, owner, described.rows, draftID, described.groups);
    return {
      ok: true,
      action: "menu_session.describe",
      thread_id: threadID,
      message: "桌面菜单已读取。",
      details: created,
    };
  });
}

async function applyCodexMenuSession(threadID = "", target = null, options = {}) {
  return runExclusiveDesktopControl(async () => {
    const menuSessionID = String(target && target.menu_session_id || "").trim();
    const entryID = String(target && target.entry_id || "").trim();
    const draftID = String(options.draftID || "").trim();
    const session = resolvePluginMenuSession(menuSessionID, threadID, draftID);
    const entry = session.entries.find((candidate) => candidate && candidate.entry_id === entryID && candidate.available !== false);
    if (!entry) throw new Error("control_target_stale: menu entry is no longer available");
    const controller = options.controller || await codexDesktopController();
    if (draftID) {
      await assertActiveMobileDraft(draftID);
    } else {
      // The user may have moved Desktop focus while choosing an item in the
      // Panel menu. Re-select the session, then verify the full menu shape
      // below before dispatching the opaque entry.
      await selectRequiredCodexThread(controller, threadID);
    }
    const queueBeforeApply = session.owner && session.owner.kind === "queue_item"
      ? await controller.queuedMessageState().catch(() => null)
      : null;
    let applied;
    try {
      applied = await controller.withTransparentNativeMenus(() => {
        if (session.owner && session.owner.kind === "queue_item") {
          return controller.applyQueuedMessageMenuSession(
            String(session.owner.queue_item_id || ""), entry.option_id, session.rows,
          );
        }
        if (session.owner && session.owner.kind === "conversation") {
          return controller.applyConversationHeaderMenuSession(entry.option_id, entry.expected_rows || session.rows);
        }
        if (!session.owner || session.owner.kind !== "interactive_control") {
          throw new Error("control_target_stale: menu session owner is unsupported");
        }
        const controlID = String(entry.control_id || session.owner.control_id || "");
        return controller.applyInteractiveComposerMenuSession(
          controlID, entry.option_id, entry.expected_rows || session.rows,
        );
      });
    } finally {
      // A session is one-shot even when the desktop click fails. A retry must
      // re-describe the current menu instead of replaying stale DOM identity.
      menuSessions.delete(session.id);
    }
    // Do not infer the selected Header action from labels or row positions.
    // Codex persists `threads.archived=1` when, and only when, the selected
    // opaque entry archived this exact native thread.
    if (session.owner && session.owner.kind === "conversation" && await waitForThreadArchived(threadID)) {
      applied = { ...(applied || {}), archived: true };
      emitDesktopWatchArchived(threadID);
    }
    if (session.owner && session.owner.kind === "queue_item") {
      await waitForDesktopQueueChange(controller, queueBeforeApply).catch(() => null);
    }
    scheduleDesktopWatchBurst(threadID, "menu_session.apply");
    let appliedSurface = null;
    if (applied && applied.surface) {
      const ownerKind = session.owner && session.owner.kind;
      const controlID = String(entry.control_id || (session.owner && session.owner.control_id) || "");
      const capability = ownerKind === "conversation"
        ? "conversation_rename"
        : controlID === "codex.permission"
          ? "permission_confirmation"
          : "";
      rememberControlCreatedSurface(threadID, applied.surface, capability);
      appliedSurface = capability ? registeredSurfaceForPublication(applied.surface, capability) : null;
    }
    // Model and reasoning menus do not expose a stable SDK option identity.
    // After the native click, read the closed composer once and return that
    // confirmed projection. The watcher remains authoritative afterwards,
    // while this prevents the initiating mobile detail from waiting for its
    // next polling tick to show the value already accepted by Desktop.
    let interactiveControls = [];
    if (!draftID && session.owner && session.owner.kind === "interactive_control") {
      await sleep(180);
      interactiveControls = await readCodexInteractiveControls(controller);
      rememberLiveControlOptions(threadID, { interactiveControls });
    }
    const details = {};
    if (interactiveControls.length > 0) details.interactive_controls = cloneInteractiveControls(interactiveControls);
    if (appliedSurface) details.interactive_surface = appliedSurface;
    return {
      ok: true,
      action: "menu_session.apply",
      thread_id: threadID,
      message: appliedSurface ? "桌面正在等待确认。" : "桌面菜单操作已提交，等待状态同步。",
      details,
    };
  });
}

function dedupeControlOptions(rows = []) {
  const seen = new Set();
  const next = [];
  for (const row of rows) {
    if (!row) continue;
    const key = normalizedKey(firstNonEmpty(row.id, row.key, row.displayName, row.label));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(row);
  }
  return next;
}

function sameControlOption(left = null, right = null) {
  if (!left || !right) return false;
  const leftKeys = [
    left.id,
    left.key,
    left.value,
    left.label,
    left.displayName,
  ].map((value) => normalizedKey(value)).filter(Boolean);
  const rightKeys = [
    right.id,
    right.key,
    right.value,
    right.label,
    right.displayName,
  ].map((value) => normalizedKey(value)).filter(Boolean);
  return leftKeys.some((value) => rightKeys.includes(value));
}

function sameControlTarget(left = null, right = null) {
  const leftID = String(left && left.id || "").trim();
  const rightID = String(right && right.id || "").trim();
  return Boolean(leftID && rightID && leftID === rightID);
}

function withOptionCurrent(rows = [], current = null) {
  const next = dedupeControlOptions(Array.isArray(rows) ? rows.slice() : []);
  if (!current || !(current.id || current.key || current.displayName || current.label)) {
    return next;
  }
  // Composer state is the current-value authority. Preserve menu row IDs while
  // clearing stale current flags from an earlier menu sample.
  for (const row of next) {
    row.current = false;
  }
  const currentOption = {
    ...current,
    available: true,
    current: true,
  };
  const matchedIndex = next.findIndex((row) => sameControlOption(row, currentOption));
  if (matchedIndex >= 0) {
    const preserved = next[matchedIndex];
    next[matchedIndex] = {
      ...preserved,
      ...currentOption,
      id: preserved.id,
      menuIndex: preserved.menuIndex,
      menuVerified: preserved.menuVerified === true,
    };
    return next;
  }
  if (next.some((row) => row && row.menuVerified === true)) {
    return next;
  }
  next.push(currentOption);
  return next;
}

// Fiber reports the semantic current value, while an opened menu supplies the
// opaque option_id required for a later control. Prefer that verified row when
// both describe the same value so a watcher never oscillates between the two
// identities for one unchanged desktop control.
function watcherCurrentControlOption(cachedRows = [], observedRows = [], current = null) {
  const cached = Array.isArray(cachedRows) ? cachedRows : [];
  const sourceRows = hasStructuredControlOptions(cached)
    ? cached
    : (Array.isArray(observedRows) ? observedRows : []);
  return currentControlOption(withOptionCurrent(sourceRows, current));
}

function withPermissionOptionCurrent(rows = [], current = null) {
  const next = dedupeControlOptions(Array.isArray(rows) ? rows.slice() : []);
  const currentLabel = normalizedKey(firstNonEmpty(
    current && current.label,
    current && current.displayName,
    current && current.value,
  ));
  if (!currentLabel) return next;
  const matchedIndex = next.findIndex((row) => normalizedKey(firstNonEmpty(row && row.label, row && row.displayName)) === currentLabel);
  if (matchedIndex < 0) {
    return next.map((row) => ({ ...row, current: false }));
  }
  return next.map((row, index) => ({ ...row, current: index === matchedIndex }));
}

function currentControlOption(rows = []) {
	if (!Array.isArray(rows) || !rows.length) return null;
	return rows.find((row) => row && row.current) || null;
}

function scheduleDesktopWatchBurst(threadID = "", reason = "") {
  if (!isThreadID(threadID) || desktopWatchSubscribers.size === 0) return;
  if (desktopControlInFlight) {
    deferredDesktopWatchBursts.set(threadID, String(reason || "control"));
    return;
  }
  for (const delayMs of DESKTOP_WATCH_BURST_DELAYS_MS) {
    setTimeout(() => {
      pollDesktopWatch().catch((error) => {
        console.error(`[codex] desktop watcher burst failed: thread_id=${threadID} reason=${reason || "unknown"} err=${error && error.message ? error.message : String(error)}`);
      });
    }, delayMs);
  }
}

function flushDeferredDesktopWatchBursts() {
  if (desktopControlInFlight || deferredDesktopWatchBursts.size === 0) return;
  const pending = [...deferredDesktopWatchBursts.entries()];
  deferredDesktopWatchBursts.clear();
  for (const [threadID, reason] of pending) {
    scheduleDesktopWatchBurst(threadID, reason);
  }
}

function detailContextFields(thread = null) {
  const metadata = thread && thread.metadata && typeof thread.metadata === "object" ? thread.metadata : {};
  const contextWindowTotal = firstNonEmpty(metadata.context_window_total);
  const contextTokensUsed = firstNonEmpty(metadata.context_tokens_used);
  const contextWindowUsagePercent = firstNonEmpty(metadata.context_window_usage_percent);
  return Object.fromEntries(
    Object.entries({
      context_window_total: contextWindowTotal,
      context_tokens_used: contextTokensUsed,
      context_window_usage_percent: contextWindowUsagePercent,
      context_window: contextWindowTotal ? `上下文窗口 ${contextWindowTotal}` : "",
    }).filter(([, value]) => value),
  );
}

function buildDetailActions(threadID = "", pinned = false, controlsLocked = false) {
  // Header actions are withheld until their own menu-session reader has the
  // same exact owner/path validation as composer controls. Publishing the old
  // direct actions would reintroduce locale text and side-bar fallbacks.
  void threadID;
  void pinned;
  void controlsLocked;
  return [];
}

function planModeDetailFromRuntime(runtime = {}, controlsLocked = false) {
  const raw = runtime && runtime.plan_mode && typeof runtime.plan_mode === "object"
    ? runtime.plan_mode
    : {};
  const available = raw.available === true && !controlsLocked;
  const enabled = raw.enabled === true;
  return {
    enabled,
    available: raw.available === true,
    actions: [{
      id: "plan.set",
      label: enabled ? "关闭计划模式" : "开启计划模式",
      available,
      target: { enabled: !enabled },
    }],
  };
}

function goalDetailFromRuntime(runtime = {}, controlsLocked = false) {
  const raw = runtime && runtime.goal && typeof runtime.goal === "object" ? runtime.goal : {};
  const status = ["running", "paused"].includes(String(raw.status || "").trim().toLowerCase())
    ? String(raw.status).trim().toLowerCase()
    : "none";
  const available = raw.available === true;
  const rawActions = raw.actions && typeof raw.actions === "object" ? raw.actions : null;
  const hasAction = (name) => !rawActions || rawActions[name] === true;
  const actions = [];
  if (status === "none") {
    actions.push({ id: "goal.set", label: "设置目标", available: available && !controlsLocked && runtime.running !== true, requires_input: true });
  } else {
    // Codex's native Edit Goal control opens a separate workspace page. It is
    // intentionally not exposed remotely: clearing and recreating a goal is
    // not an equivalent operation and can break the native send lifecycle.
    if (status === "running" && hasAction("pause")) actions.push({ id: "goal.pause", label: "暂停目标", available: available && !controlsLocked });
    if (status === "paused" && hasAction("resume")) actions.push({ id: "goal.resume", label: "恢复目标", available: available && !controlsLocked });
    if (hasAction("clear")) actions.push({ id: "goal.clear", label: "清除目标", available: available && !controlsLocked });
  }
  return {
    status,
    objective: firstNonEmpty(raw.objective),
    available,
    actions,
  };
}

async function conversationDetailSnapshotFromDesktop(threadID = "", options = {}) {
  if (!isThreadID(threadID)) {
    throw new Error("codex detail snapshot requires a resolved Codex thread id");
  }
  const controller = await codexDesktopController();
  const thread = await findThreadByID(threadID).catch(() => null);
  let selectResult = null;
  if (options.selectThread !== false) {
    selectResult = await controller.selectThread(threadID);
    await sleep(Number.isFinite(options.settleMs) ? options.settleMs : 180);
  }
  const rawRuntimeSnapshot = await currentDesktopRuntimeSnapshot().catch(() => null);
  const runtimeSnapshot = runtimeWithRecordedTerminal(
    rawRuntimeSnapshot,
    latestRecordedTurnLifecycle(thread && thread.rolloutPath, threadID),
  );
  const activeThreadID = firstNonEmpty(runtimeSnapshot && runtimeSnapshot.current_thread_id);
  if (options.selectThread === false && isThreadID(activeThreadID) && activeThreadID !== threadID) {
    throw new Error("codex desktop target is not foreground");
  }
  // Detail snapshots read only the closed composer state. Menu rows remain
  // unavailable until an explicit menu_session.describe made by a user tap.
  const desktopForeground = activeThreadID === threadID;
  const foregroundTransition = desktopForeground
    ? observeDesktopWatchForeground(desktopWatchState, activeThreadID)
    : null;
  const [liveCurrent, livePinned, liveQueue] = desktopForeground
    ? await Promise.all([
      readLiveComposerControls(threadID, controller, { selectThread: false, preferThreadMetadataFallback: false }).catch(() => null),
      controller.threadPinned(threadID).catch(() => null),
      currentDesktopQueueSnapshot(threadID, controller).catch(() => null),
    ])
    : [null, null, null];
  const messagesSignature = await threadMessagesSignature(threadID).catch(() => "");
  const cachedOptions = liveControlOptionsCacheEntry(threadID);
  const projectedRuntime = runtimeWithLiveQueue(runtimeSnapshot, liveQueue);
  rememberVisibleGoalBody(threadID, goalDetailFromRuntime(projectedRuntime));
  const currentRun = controlsRuntimeFromDesktopSnapshot(threadID, projectedRuntime) || {
    status: "idle",
    summary: "当前会话空闲。",
    primary_action: "send",
  };
  const runtimeStatus = String(currentRun && currentRun.status || "").trim().toLowerCase();
  const controlsLocked = runtimeStatus === "waiting_approval";
  let interactiveControls = desktopForeground && cachedOptions && Array.isArray(cachedOptions.interactiveControls)
    ? cachedOptions.interactiveControls
    : [];
  if (desktopForeground) {
    interactiveControls = await readCodexInteractiveControls(controller);
    rememberLiveControlOptions(threadID, { interactiveControls });
  }
  const approval = currentRun && currentRun.approval && typeof currentRun.approval === "object"
    ? currentRun.approval
    : null;
  const rawInteractiveSurface = desktopForeground
    ? await controller.readInteractiveSurface().catch(() => null)
    : null;
  const interactiveSurface = interactiveSurfaceForForeground(
    desktopWatchState,
    foregroundTransition,
    threadID,
    rawInteractiveSurface,
  );
  const [conversationMenuAvailable, actions] = await Promise.all([
    desktopForeground ? controller.conversationHeaderMenuAvailable().catch(() => false) : false,
    Promise.resolve(buildDetailActions(threadID, Boolean(livePinned), controlsLocked)),
  ]);
  const nowMs = Date.now();
  return {
    native_conversation_id: threadID,
    updated_at: nowMs,
    desktop_foreground: desktopForeground,
    detail_stale: !desktopForeground,
    pinned: typeof livePinned === "boolean" ? livePinned : undefined,
    // These are display-only values read from the already-open foreground
    // Composer. Keep option menus empty until the user explicitly opens one.
    current_model: liveCurrent && liveCurrent.model || null,
    current_reasoning: liveCurrent && liveCurrent.reasoning || null,
    current_permission: liveCurrent && liveCurrent.approval || null,
    model_options: [],
    reasoning_options: [],
    permission_options: [],
    interactive_controls: cloneInteractiveControls(interactiveControls),
    interactive_surface: interactiveSurface || null,
    conversation_menu_available: conversationMenuAvailable === true,
    run: currentRun,
    approval: approval || undefined,
    composer: {
      content: firstNonEmpty(runtimeSnapshot && runtimeSnapshot.composer_text),
      editable: Boolean(runtimeSnapshot && runtimeSnapshot.composer_available),
    },
    queue: liveQueue || undefined,
    plan_mode: planModeDetailFromRuntime(projectedRuntime, controlsLocked),
    goal: goalDetailFromRuntime(projectedRuntime, controlsLocked),
    primary_action: currentRun.primary_action || "send",
    actions,
    messages_signature: messagesSignature,
    ...detailContextFields(thread),
    desktop_already_selected: selectResult && selectResult.alreadySelected === true ? true : undefined,
  };
}

async function selectCodexConversation(threadID = "") {
  if (!isThreadID(threadID)) {
    throw new Error("codex conversation.select requires a resolved Codex thread id");
  }
  return runExclusiveDesktopControl(async () => {
    const controller = await codexDesktopController();
    const alreadySelected = await controller.isThreadSelected(threadID);
    const selectResult = await controller.selectThread(threadID);
    // selectThread reports that the deep link was dispatched. The only
    // meaningful success condition for a remote control is that the Codex
    // workspace has actually reached the requested thread.
    const selected = Boolean(selectResult && selectResult.selected !== false)
      && await controller.isThreadSelected(threadID);
    if (selected) {
      scheduleDesktopWatchBurst(threadID, "conversation.select");
    }
    return {
      selected,
      already_selected: alreadySelected,
      reason: selected ? undefined : firstNonEmpty(selectResult && selectResult.reason, "thread_row_not_visible"),
      selected_at: selected ? now() : undefined,
    };
  });
}

async function currentDesktopRuntimeSnapshot() {
  return codexDesktopController()
    .then((controller) => controller.currentThreadRuntimeState())
    .catch(() => null);
}

function queueDirectSignature(queue = null) {
  if (!queue || typeof queue !== "object") return "";
  const actions = (items = []) => (Array.isArray(items) ? items : []).map((item) =>
    `${firstNonEmpty(item && item.id)}:${firstNonEmpty(item && item.label)}:${item && item.available === false ? 0 : 1}`,
  ).join(",");
  const items = Array.isArray(queue.items) ? queue.items : [];
  return JSON.stringify({
    items: items.map((item) => ({
      id: firstNonEmpty(item && item.id),
      content: firstNonEmpty(item && item.content),
      actions: actions(item && item.actions),
      has_more_actions: item && item.has_more_actions === true,
    })),
    actions: actions(queue.actions),
  });
}

async function currentDesktopQueueSnapshot(threadID = "", controller = null) {
  if (!isThreadID(threadID)) return null;
  const activeController = controller || await codexDesktopController();
  return activeController.queuedMessageState().catch(() => null);
}

async function waitForDesktopQueueChange(controller, previousQueue, timeoutMs = 1800) {
  const previousSignature = queueDirectSignature(previousQueue);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await controller.queuedMessageState().catch(() => null);
    if (queueDirectSignature(current) !== previousSignature) return current;
    await sleep(120);
  }
  return null;
}

function runtimeWithLiveQueue(runtime = null, queue = null) {
  if (!runtime || typeof runtime !== "object") return runtime;
  const queuePending = Boolean(queue && Array.isArray(queue.items) && queue.items.length > 0);
  const waitingApproval = Boolean(runtime.waiting_approval);
  const running = Boolean(runtime.running);
  const canQueue = Boolean(
    !waitingApproval && running && runtime.primary_action === "queue" && runtime.can_queue === true,
  );
  const activeAction = canQueue
    ? "queue"
    : firstNonEmpty(runtime.primary_action === "queue" ? "guide" : runtime.primary_action, "interrupt");
  return {
    ...runtime,
    queue: queue || null,
    queue_pending: queuePending,
    can_queue: canQueue,
    primary_action: waitingApproval
      ? "approval"
      : (running ? activeAction : "send"),
  };
}

const WATCH_INTELLIGENCE_TTL_MS = 5000;

async function currentDesktopConversationSnapshot(options = {}) {
  const suppliedController = options && options.controller ? options.controller : null;
  const suppliedRuntime = options && options.runtime && typeof options.runtime === "object" ? options.runtime : null;
  return (suppliedController ? Promise.resolve(suppliedController) : codexDesktopController())
    .then(async (controller) => {
      const rawRuntime = suppliedRuntime || await controller.currentThreadRuntimeState().catch(() => null);
      const currentThreadId = firstNonEmpty(rawRuntime && rawRuntime.current_thread_id);
      let composer = null;
      let queue = null;
      let pinned = null;
      let conversationMenuAvailable = false;
      let thread = null;
      if (isThreadID(currentThreadId)) {
        thread = withRolloutContextMetadata(await findThreadByID(currentThreadId).catch(() => null));
        const liveComposer = await readLiveComposerControls(currentThreadId, controller, { selectThread: false }).catch(() => null);
        composer = liveComposer;
        queue = await currentDesktopQueueSnapshot(currentThreadId, controller).catch(() => null);
        pinned = await controller.threadPinned(currentThreadId).catch(() => null);
        conversationMenuAvailable = await controller.conversationHeaderMenuAvailable().catch(() => false);
      }
      const runtime = runtimeWithRecordedTerminal(
        rawRuntime,
        latestRecordedTurnLifecycle(thread && thread.rolloutPath, currentThreadId),
      );
      const projectedRuntime = runtimeWithLiveQueue(runtime, queue);
      return {
        runtime: projectedRuntime && typeof projectedRuntime === "object"
          ? { ...projectedRuntime, trace: { items: runTraceFromThread(thread), truncated: false } }
          : projectedRuntime,
        composer,
        pinned,
        conversation_menu_available: conversationMenuAvailable,
        thread,
      };
    })
    .catch(() => null);
}

function threadStatusFromDesktopRuntime(runtime = {}) {
  if (!runtime || typeof runtime !== "object") return "";
  if (runtime.waiting_approval) return "waiting_approval";
  if (runtime.queue_pending) return "running";
  if (runtime.running) return "running";
  return "";
}

function mergeThreadItemWithDesktopRuntime(item, desktop) {
  const runtime = desktop && typeof desktop === "object" && Object.prototype.hasOwnProperty.call(desktop, "runtime")
    ? desktop.runtime
    : desktop;
  const composer = desktop && typeof desktop === "object" ? desktop.composer : null;
  const pinned = desktop && typeof desktop === "object" ? desktop.pinned : null;
  if (!item || !runtime || typeof runtime !== "object") {
    return item;
  }
  const currentThreadId = firstNonEmpty(runtime.current_thread_id);
  if (!isThreadID(currentThreadId) || currentThreadId !== item.id) {
    return item;
  }
  const metadata = {
    ...(item.metadata || {}),
  };
  const status = threadStatusFromDesktopRuntime(runtime);
  if (status) {
    metadata.status = status;
    metadata.task_status = status;
  }
  const approval = runtime.approval && typeof runtime.approval === "object" ? runtime.approval : null;
  if (approval) {
    metadata.approval_request_id = firstNonEmpty(approval.approval_request_id, approval.id);
  }
  if (runtime.primary_action) {
    metadata.primary_action = String(runtime.primary_action);
  }
  if (typeof runtime.can_queue === "boolean") {
    metadata.can_queue = runtime.can_queue ? "true" : "false";
  }
  if (composer && composer.model && firstNonEmpty(composer.model.id, composer.model.displayName)) {
    metadata.model = firstNonEmpty(composer.model.id, composer.model.displayName);
  }
  if (composer && composer.reasoning && firstNonEmpty(composer.reasoning.key, composer.reasoning.value)) {
    metadata.reasoning_effort = firstNonEmpty(composer.reasoning.key, composer.reasoning.value);
  }
  if (composer && composer.approval && firstNonEmpty(composer.approval.key, composer.approval.value)) {
    metadata.approval_mode = firstNonEmpty(composer.approval.key, composer.approval.value);
  }
  if (typeof pinned === "boolean") {
    metadata.pinned = pinned ? "true" : "false";
    metadata.is_pinned = metadata.pinned;
  }
  return {
    ...item,
    metadata: Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== "" && value != null)),
  };
}

function controlsRuntimeFromDesktopSnapshot(threadID = "", runtime = null) {
  if (!isThreadID(threadID) || !runtime || typeof runtime !== "object") {
    return null;
  }
  const currentThreadId = firstNonEmpty(runtime.current_thread_id);
  if (!isThreadID(currentThreadId) || currentThreadId !== threadID) {
    return null;
  }
  const recordedTerminal = runtime.recorded_terminal && typeof runtime.recorded_terminal === "object"
    ? runtime.recorded_terminal
    : null;
  if (recordedTerminal) {
    const terminalStatus = firstNonEmpty(recordedTerminal.status, "completed");
    return {
      task_id: "",
      status: terminalStatus,
      summary: terminalStatus === "interrupted"
        ? "任务已被打断。"
        : terminalStatus === "failed"
          ? firstNonEmpty(recordedTerminal.error, "Codex 执行失败。")
          : "Codex 已完成。",
      active: false,
      interruptible: false,
      approval_blocked: false,
      approval_request_id: "",
      approval: null,
      primary_action: "send",
      can_queue: false,
      completed_at: firstNonEmpty(recordedTerminal.completed_at),
      trace: runtime.trace && typeof runtime.trace === "object" ? runtime.trace : { items: [], truncated: false },
    };
  }
  const waitingApproval = Boolean(runtime.waiting_approval);
  const running = Boolean(runtime.running);
  const queuePending = Boolean(runtime.queue && Array.isArray(runtime.queue.items) && runtime.queue.items.length > 0);
  const canQueue = Boolean(
    !waitingApproval && running && runtime.primary_action === "queue" && runtime.can_queue === true,
  );
  const activeAction = canQueue
    ? "queue"
    : firstNonEmpty(runtime.primary_action === "queue" ? "guide" : runtime.primary_action, "interrupt");
  let status = "idle";
  if (waitingApproval) status = "waiting_approval";
  else if (running) status = queuePending ? "waiting" : "running";
  const approval = runtime.approval && typeof runtime.approval === "object" ? runtime.approval : null;
  return {
    task_id: firstNonEmpty(approval && approval.approval_request_id, approval && approval.id),
    status,
    summary: waitingApproval
      ? "Codex 正在等待审批…"
      : queuePending
        ? "消息已排队，等待当前任务结束后发送…"
        : running
          ? "Codex 正在回复…"
          : "当前会话空闲。",
    active: waitingApproval || running,
    interruptible: running,
    approval_blocked: waitingApproval,
    approval_request_id: firstNonEmpty(approval && approval.approval_request_id, approval && approval.id),
    approval,
    primary_action: waitingApproval ? "approval" : (running ? activeAction : "send"),
    can_queue: canQueue,
    trace: runtime.trace && typeof runtime.trace === "object" ? runtime.trace : { items: [], truncated: false },
  };
}

async function readLiveComposerControls(threadID = "", controller = null, options = {}) {
  if (!isThreadID(threadID)) return null;
  const activeController = controller || await codexDesktopController();
  const preferThreadMetadataFallback = options.preferThreadMetadataFallback !== false;
  const thread = options.thread || (
    options.selectThread !== false || preferThreadMetadataFallback
      ? await findThreadByID(threadID).catch(() => null)
      : null
  );
  if (options.selectThread !== false) {
    try {
      await selectRequiredCodexThread(activeController, threadID);
    } catch {
      return null;
    }
    await sleep(Number.isFinite(options.settleMs) ? options.settleMs : 160);
  }
  const current = await activeController.composerControlState().catch(() => null);
  if (!current || typeof current !== "object") {
    return null;
  }
  const metadata = thread && thread.metadata && typeof thread.metadata === "object" ? thread.metadata : {};
  const model = modelInfoFromLabel(firstNonEmpty(current.model, metadata.model), now());
  const reasoning = reasoningModeFromValue(
    firstNonEmpty(current.reasoningEffort, current.reasoning, metadata.reasoning_effort),
    now(),
  );
  const approvalValue = normalizeControlLabel(firstNonEmpty(current.permission, metadata.approval_mode));
  return {
    raw: current,
    model: model.available ? model : null,
    reasoning: reasoning.available ? reasoning : null,
    approval: approvalValue ? {
      key: approvalValue,
      value: approvalValue,
      label: approvalValue,
      displayName: approvalValue,
      available: true,
      updatedAt: now(),
    } : null,
    updatedAt: now(),
  };
}

function queueItemIDFromTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return "";
  return firstNonEmpty(target.queue_item_id, target.queueItemID);
}

async function controlCodexQueue(threadID = "", action = "", target = null) {
  const startedAt = Date.now();
  const normalizedAction = String(action || "").trim();
  if (!normalizedAction.startsWith("queue.")) {
    throw new Error("control_target_stale: queue action is required");
  }
  const itemID = queueItemIDFromTarget(target);
  logControlDebug("queue.start", { action: normalizedAction, thread_id: threadID, queue_item_id: itemID });
  const controller = await codexDesktopController();
  logControlDebug("queue.controller_ready", {
    action: normalizedAction, thread_id: threadID, queue_item_id: itemID, cost_ms: Date.now() - startedAt,
  });
  await selectRequiredCodexThread(controller, threadID);
  logControlDebug("queue.thread_selected", {
    action: normalizedAction, thread_id: threadID, queue_item_id: itemID, cost_ms: Date.now() - startedAt,
  });
  // Direct actions are only available when their own DOM/Fiber ancestry proves
  // this queue item. Menu actions never enter a watcher snapshot and must use
  // menu_session.describe/apply instead. They must not wait behind a menu
  // session either: the user just opened that session to invoke this action.
  const liveQueue = await controller.queuedMessageState();
  logControlDebug("queue.state_read", {
    action: normalizedAction,
    thread_id: threadID,
    queue_item_id: itemID,
    item_count: liveQueue && Array.isArray(liveQueue.items) ? liveQueue.items.length : 0,
    cost_ms: Date.now() - startedAt,
  });
  const item = itemID && liveQueue && Array.isArray(liveQueue.items)
    ? liveQueue.items.find((candidate) => firstNonEmpty(candidate && candidate.id) === itemID)
    : null;
  const actions = itemID
    ? (item && Array.isArray(item.actions) ? item.actions : [])
    : (liveQueue && Array.isArray(liveQueue.actions) ? liveQueue.actions : []);
  const declared = actions.find((candidate) => candidate && candidate.id === normalizedAction && candidate.available !== false);
  if (!declared) {
    throw new Error("control_target_stale: queue action is no longer present in the current desktop UI");
  }
  logControlDebug("queue.target_verified", {
    action: normalizedAction, thread_id: threadID, queue_item_id: itemID, cost_ms: Date.now() - startedAt,
  });
  await controller.executeQueuedMessageAction(normalizedAction, itemID);
  logControlDebug("queue.click_submitted", {
    action: normalizedAction, thread_id: threadID, queue_item_id: itemID, cost_ms: Date.now() - startedAt,
  });
  await waitForDesktopQueueChange(controller, liveQueue).catch(() => null);
  scheduleDesktopWatchBurst(threadID, "queue.control");
  logControlDebug("queue.done", {
    action: normalizedAction, thread_id: threadID, queue_item_id: itemID, cost_ms: Date.now() - startedAt,
  });
  return {
    ok: true,
    action: normalizedAction,
    thread_id: threadID,
    message: "桌面排队消息操作已提交，等待状态同步。",
    details: {},
  };
}

async function applyCodexInteractiveSurface(threadID = "", target = null) {
  return runExclusiveDesktopControl(async () => {
    if (!isThreadID(threadID)) {
      throw new Error("codex interactive.surface.apply requires a resolved Codex thread id");
    }
    const surfaceID = String(target && typeof target === "object" ? target.surface_id : "").trim();
    const actionID = String(target && typeof target === "object" ? target.action_id : "").trim();
    const input = String(target && typeof target === "object" ? target.input || "" : "");
    if (!surfaceID || !actionID) {
      throw new Error("control_target_stale: interactive.surface.apply requires surface_id and action_id from the current detail");
    }
    const controller = await codexDesktopController();
    await selectRequiredCodexThread(controller, threadID);
    const currentSurface = await controller.readInteractiveSurface().catch(() => null);
    if (!interactiveSurfaceForForeground(desktopWatchState, null, threadID, currentSurface) ||
      String(currentSurface && currentSurface.surface_id || "").trim() !== surfaceID) {
      throw new Error("control_target_stale: interactive surface is no longer a pending mobile confirmation");
    }
    await controller.applyInteractiveSurface(surfaceID, actionID, input);
    // The native dialog has been consumed. Do not let a watcher poll replay
    // the previous, now-invalid confirmation surface to remote clients.
    controlCreatedSurfaceByThread.delete(threadID);
    scheduleDesktopWatchBurst(threadID, "interactive.surface.apply");
    return {
      ok: true,
      action: "interactive.surface.apply",
      thread_id: threadID,
      message: "桌面交互已提交，等待状态同步。",
      details: {},
    };
  });
}

function booleanControlTarget(target, key) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new Error(`control_target_stale: ${key} target is required`);
  }
  const value = target[key];
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`control_target_stale: ${key} target must be boolean`);
}

function objectiveControlTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new Error("control_target_stale: goal objective target is required");
  }
  const objective = String(target.objective || "").trim();
  if (!objective) throw new Error("control_target_stale: goal objective is required");
  if (objective.length > 8000) throw new Error("control_target_stale: goal objective is too long");
  return objective;
}

async function controlCodexPlanMode(threadID = "", target = null) {
  return runExclusiveDesktopControl(async () => {
    if (!isThreadID(threadID)) throw new Error("codex plan.set requires a resolved Codex thread id");
    const enabled = booleanControlTarget(target, "enabled");
    const controller = await codexDesktopController();
    await selectRequiredCodexThread(controller, threadID);
    const live = await controller.goalPlanState();
    if (!live || !live.plan_mode || live.plan_mode.available !== true) {
      throw new Error("control_target_stale: plan mode is unavailable");
    }
    const planMode = await controller.setPlanMode(enabled);
    scheduleDesktopWatchBurst(threadID, "plan.set");
    return {
      ok: true,
      action: "plan.set",
      thread_id: threadID,
      message: enabled ? "计划模式已开启。" : "计划模式已关闭。",
      details: { plan_mode: planModeDetailFromRuntime({ plan_mode: planMode }) },
    };
  });
}

async function controlCodexGoal(threadID = "", action = "", target = null) {
  return runExclusiveDesktopControl(async () => {
    if (!isThreadID(threadID)) throw new Error("codex goal control requires a resolved Codex thread id");
    const normalized = String(action || "").trim().toLowerCase();
    if (normalized === "goal.edit") {
      throw new Error("control_unsupported: Codex goal editing is not safely available remotely");
    }
    const controller = await codexDesktopController();
    await selectRequiredCodexThread(controller, threadID);
    const live = await controller.goalPlanState();
    const status = String(live && live.goal && live.goal.status || "none").trim().toLowerCase();
    let goal;
    if (normalized === "goal.set") {
      if (status !== "none") throw new Error("control_target_stale: a current goal already exists");
      goal = await controller.setGoal(objectiveControlTarget(target));
    } else if (["goal.pause", "goal.resume", "goal.clear"].includes(normalized)) {
      goal = await controller.controlGoal(normalized);
    } else {
      throw new Error(`unsupported goal action: ${normalized || "unknown"}`);
    }
    rememberVisibleGoalBody(threadID, goalDetailFromRuntime({ goal }));
    scheduleDesktopWatchBurst(threadID, normalized);
    return {
      ok: true,
      action: normalized,
      thread_id: threadID,
      message: normalized === "goal.clear" ? "目标已清除。" : "目标状态已更新。",
      details: { goal: goalDetailFromRuntime({ goal }) },
    };
  });
}

async function controlSession(req) {
  const startedAt = Date.now();
  const session = req && req.session;
  const threadID = firstNonEmpty(session && session.NativeThreadID, session && session.NativeSessionID);
  const action = String(req && req.action || "").trim().toLowerCase();
  const target = req && req.target;
  const name = req && req.name;
  const metadata = req && req.metadata ? req.metadata : {};
  const scope = String(metadata && metadata.control_scope ? metadata.control_scope : "").trim().toLowerCase();
  logControlDebug("request", {
    action,
    thread_id: threadID,
    target,
    name,
    scope,
    source_device: metadata && metadata.source_device,
    request_id: metadata && metadata.request_id,
  });
  try {
    let result;
    switch (action) {
      case "conversation.select":
      case "conversation_select":
        {
          const selected = await selectCodexConversation(threadID);
          result = {
            ok: selected.selected,
            action: "conversation.select",
            thread_id: threadID,
            message: selected.selected
              ? selected.already_selected ? "Codex 桌面已显示该会话。" : "Codex 桌面会话已切换。"
              : "Codex 桌面未能显示目标会话，请稍后重试同步。",
            details: {
              selected: selected.selected,
              already_selected: selected.already_selected,
              reason: selected.reason,
              selected_at: selected.selected_at,
            },
          };
          break;
        }
      case "controls.describe":
      case "describe_controls":
        result = await describeCodexControls(threadID, { scope, strictLive: true });
        break;
      case "menu_session.describe":
        result = await describeCodexMenuSession(threadID, target && target.owner);
        break;
      case "menu_session.apply":
        result = await applyCodexMenuSession(threadID, target);
        break;
      case "interactive.surface.apply":
        result = await applyCodexInteractiveSurface(threadID, target);
        break;
      case "plan.set":
        result = await controlCodexPlanMode(threadID, target);
        break;
      case "goal.set":
      case "goal.edit":
      case "goal.pause":
      case "goal.resume":
      case "goal.clear":
        result = await controlCodexGoal(threadID, action, target);
        break;
      default:
        if (action.startsWith("queue.")) {
          result = await controlCodexQueue(threadID, action, target);
        } else {
          throw new Error(`unsupported control action: ${action || "unknown"}`);
        }
    }
    const details = result && result.details && typeof result.details === "object"
      ? result.details
      : {};
    return {
      ok: result && result.ok !== false,
      action: firstNonEmpty(result && result.action, action),
      thread_id: firstNonEmpty(result && result.thread_id, threadID),
      message: firstNonEmpty(result && result.message),
      details,
    };
  } catch (error) {
    logControlDebug("failed", {
      action,
      thread_id: threadID,
      target,
      name,
      scope,
      request_id: metadata && metadata.request_id,
      cost_ms: Date.now() - startedAt,
      err: error && error.message ? error.message : String(error),
    });
    throw error;
  } finally {
    logTiming("controlSession", startedAt, {
      action,
      thread_id: threadID,
      target,
      request_id: metadata && metadata.request_id,
    });
  }
}

async function resolveApproval(req) {
  const session = req && req.Session ? req.Session : req && req.session ? req.session : req;
  const threadID = firstNonEmpty(
    req && req.Metadata && req.Metadata.codex_thread_id,
    req && req.Metadata && req.Metadata.thread_id,
    session && session.NativeThreadID,
    session && session.NativeSessionID,
  );
  if (!isThreadID(threadID)) {
    throw new Error("codex resolveApproval requires a resolved Codex thread id");
  }
  const actionID = String(firstNonEmpty(req && req.ActionID, req && req.action_id)).trim();
  if (!actionID) {
    throw new Error("codex resolveApproval requires an action id");
  }
  const input = String(firstNonEmpty(req && req.Input, req && req.input)).trim();
  const controller = await codexDesktopController();
  const thread = await findThreadByID(threadID).catch(() => null);
  await selectRequiredCodexThread(controller, threadID);
  await controller.resolveApproval(actionID, input);
}

async function describeCodexControls(threadID = "", options = {}) {
  if (!isThreadID(threadID)) {
    throw new Error("codex controls.describe requires a resolved Codex thread id");
  }
  const controller = await codexDesktopController();
  await selectRequiredCodexThread(controller, threadID);
  const runtimeSnapshot = await currentDesktopRuntimeSnapshot().catch(() => null);
  const currentRuntime = controlsRuntimeFromDesktopSnapshot(threadID, runtimeSnapshot) || { status: "idle" };
  const runtimeStatus = String(currentRuntime.status || "").trim().toLowerCase();
  const controlsLocked = runtimeStatus === "waiting_approval";
  const interactiveControls = await readCodexInteractiveControls(controller);
  rememberLiveControlOptions(threadID, { interactiveControls });
  const pinned = await controller.threadPinned(threadID).catch(() => false);
  const actions = buildDetailActions(threadID, Boolean(pinned), controlsLocked);
  return {
    ok: true,
    thread_id: threadID,
    message: "已读取 Codex 控制能力。",
    details: {
      supported: true,
      current_run: currentRuntime,
      current_pinned: Boolean(pinned),
      control_scope: "interactive",
      actions,
      interactive_controls: cloneInteractiveControls(interactiveControls),
      conversation_menu_available: await controller.conversationHeaderMenuAvailable().catch(() => false),
    },
  };

}

async function capability() {
  const localStateAvailable = codexInstalled() && (Boolean(stateDBPath()) || fs.existsSync(SESSION_INDEX));
  // Probe only the native CDP surface. Waiting for a visible workspace here
  // would block the 15s reverse-sync reconciliation that owns the watcher.
  const desktopControlAvailable = localStateAvailable && await probeCodexMainPage();
  const unavailableReason = !localStateAvailable
    ? "codex_desktop_or_state_db_unavailable"
    : desktopControlAvailable ? "" : "codex_desktop_control_unavailable";
  const available = localStateAvailable && desktopControlAvailable;
  return {
    PluginID: "codex",
    Available: available,
    NativeVisibleInput: available,
    NativeVisibleOutput: available,
    CanAttachSession: true,
    CanStartSessionWithMessage: true,
	CanOpenDraft: available,
    CanListSessions: true,
    CanReadHistory: true,
    CanInterrupt: true,
    CanApproval: true,
    CanForwardSync: available,
    CanReverseSync: true,
    CanPluginWideWatch: true,
    CanWaitRun: available,
    CanReadStatus: available,
    CanControlSession: available,
    IntegrationMode: "desktop-automation",
    VisibilitySurface: "codex-desktop",
    UnavailableReason: available ? "" : unavailableReason,
  };
}

async function discovery() {
  const currentCapability = await capability();
  return {
    PluginID: "codex",
    Surface: "codex-desktop",
    Endpoint: "codex-desktop://managed-thread/<id>",
    ProcessID: 0,
    SessionHints: {
      state_db: stateDBPath(),
      session_index: SESSION_INDEX,
      mode: "sqlite-thread-index-plus-automation",
    },
    Verified: currentCapability.Available,
    Detail: currentCapability.Available
      ? "Codex Desktop CDP surface + local thread state available"
      : currentCapability.UnavailableReason === "codex_desktop_control_unavailable"
        ? "Codex Desktop control surface is not reachable through CDP"
        : "Codex Desktop or ~/.codex/state_5.sqlite not available",
  };
}

function toSession(threadID, cwd = "", metadata = {}) {
  return {
    PluginID: "codex",
    NativeSessionID: threadID,
    NativeThreadID: threadID,
    Surface: "codex-desktop",
    Endpoint: isThreadID(threadID) ? deepLink(threadID) : "",
    Cwd: cwd,
    Visible: true,
    Metadata: metadata,
  };
}

async function listSessions() {
  const startedAt = Date.now();
  const threads = await readSessionListSnapshot();
  logTiming("listSessions", startedAt, {
    count: threads.length,
  });
  return threads.map((item) => ({
    PluginID: "codex",
    NativeSessionID: item.id,
    NativeThreadID: item.id,
    Surface: "codex-desktop",
    Endpoint: deepLink(item.id),
    Cwd: item.cwd,
    Title: item.title,
    PrismConversationID: "",
    Active: true,
    Visible: true,
    LastActivityAt: item.sortAt || item.updatedAt,
    Metadata: item.metadata || {},
  }));
}

async function readSessionListSnapshot(limit = 0, options = {}) {
  const nowMs = Date.now();
  if (!options.force && Array.isArray(sessionListCache.threads)
      && nowMs - sessionListCache.at < SESSION_LIST_CACHE_MS) {
    return sessionListCache.threads;
  }
  if (sessionListCache.inFlight) {
    return sessionListCache.inFlight;
  }

  const read = (async () => {
    let threads = await readThreadsFromState(limit);
    let indexedThreads = readSessionIndex();
    if (threads.length === 0 && indexedThreads.length === 0) {
      // Codex updates state_5.sqlite and session_index.jsonl independently.
      // A real empty list must remain empty across two complete observations;
      // otherwise this is an update window, not an authoritative deletion.
      await sleep(EMPTY_SESSION_LIST_CONFIRM_DELAY_MS);
      threads = await readThreadsFromState(limit);
      indexedThreads = readSessionIndex();
    }
    // An empty result is a complete snapshot only when the independent Codex
    // session index is also empty. Returning [] while that index still has
    // entries would erase a valid remote index during a transient SQLite read.
    if (threads.length === 0 && indexedThreads.length > 0) {
      throw new Error(`Codex session list incomplete: state query returned no visible threads while session index has ${indexedThreads.length}`);
    }
    sessionListCache.at = Date.now();
    sessionListCache.threads = threads;
    return threads;
  })();
  sessionListCache.inFlight = read;
  try {
    return await read;
  } finally {
    if (sessionListCache.inFlight === read) {
      sessionListCache.inFlight = null;
    }
  }
}

async function attachSession(req) {
  const threadID = firstNonEmpty(req && req.NativeThreadID, req && req.NativeSessionID);
  if (!isThreadID(threadID)) {
    throw new Error("codex attachSession requires a valid Codex thread id");
  }
  const thread = await findThreadByID(threadID);
  if (!thread) {
    throw new Error("codex attachSession target thread was not found in current Codex desktop state");
  }
  // Attach validates the durable Prism-to-Codex binding. It must not change
  // the foreground UI: send() owns the one serialized select-and-submit step.
  return toSession(threadID, req && req.Cwd ? req.Cwd : "", thread && thread.metadata ? thread.metadata : {});
}

async function send(session, msg) {
  return runExclusiveDesktopControl(async () => {
    const totalStartedAt = Date.now();
    let threadID = firstNonEmpty(session && session.NativeThreadID, session && session.NativeSessionID);
    const text = firstNonEmpty(msg && msg.Text);
    const attachments = Array.isArray(msg && msg.Attachments) ? msg.Attachments : [];
    const sendStartedAt = Date.now();
    let runContext = null;
    if (!text && attachments.length === 0) {
      throw new Error("codex send requires text or attachments");
    }
    if (isThreadID(threadID)) {
      runContext = {
        thread_id: threadID,
        started_at: sendStartedAt,
        ...(await rolloutCursor(threadID)),
      };
      const activateStartedAt = Date.now();
      await focusTarget(threadID, { assumeThreadSynced: false });
      logTiming("send.focusTarget", activateStartedAt, { thread_id: threadID });
    } else {
      throw new Error("codex send requires an existing Codex thread id");
    }
    const controller = await codexDesktopController();
    const sendActionLabel = attachments.length ? "send.cdpMessageWithAttachments" : "send.cdpMessage";
    const sendActionStartedAt = Date.now();
    let submission = null;
    try {
      submission = await controller.sendMessage({
        text,
        attachments: attachments.map((attachment) => ({
          localPath: attachment.LocalPath,
          name: attachment.Name,
          mimeType: attachment.MIMEType,
        })),
      });
    } catch (error) {
      throw error;
    }
    logTiming(sendActionLabel, sendActionStartedAt);
    if (!runContext) {
      runContext = {
        thread_id: threadID,
        started_at: sendStartedAt,
        ...(await rolloutCursor(threadID)),
      };
    }
    logTiming("send.total", totalStartedAt, { thread_id: threadID });
    if (submission?.outcome === "interactive_surface_opened" && submission.surface) {
      rememberControlCreatedSurface(threadID, submission.surface, "queue_send_confirmation");
      scheduleDesktopWatchBurst(threadID, "send.confirmation");
    } else {
      scheduleDesktopWatchBurst(threadID, "send");
    }
    return {
      NativeMessageID: encodeRunContext(runContext),
      CanonicalNativeSessionID: threadID,
      CanonicalNativeThreadID: threadID,
      Accepted: true,
      Visible: submission?.outcome === "message_visible",
      PendingConfirmation: submission?.outcome === "interactive_surface_opened",
      QueuePending: submission?.outcome === "queue_pending",
      Detail: submission?.outcome === "interactive_surface_opened"
        ? "Codex Desktop opened a confirmation surface before submitting the message"
        : submission?.outcome === "queue_pending"
          ? "Codex Desktop accepted the queue action; waiting for the native queue item"
        : "message pasted into Codex Desktop active thread",
    };
  });
}

function desktopWatchSignatureParts(snapshot = {}, messagesSignature = "", interactiveSurface = null) {
  const runtime = snapshot && snapshot.runtime && typeof snapshot.runtime === "object" ? snapshot.runtime : {};
  const composer = snapshot && snapshot.composer && typeof snapshot.composer === "object" ? snapshot.composer : {};
  const thread = snapshot && snapshot.thread && typeof snapshot.thread === "object" ? snapshot.thread : null;
  const approval = runtime && runtime.approval && typeof runtime.approval === "object" ? runtime.approval : {};
  const threadID = firstNonEmpty(runtime.current_thread_id);
  const cachedOptions = liveControlOptionsCacheEntry(threadID);
  const optionID = (option) => firstNonEmpty(option && option.id, option && option.key, option && option.value, option && option.displayName);
  return {
    thread_id: threadID,
    running: Boolean(runtime.running),
    waiting_approval: Boolean(runtime.waiting_approval),
    queue_pending: Boolean(runtime.queue_pending),
    primary_action: firstNonEmpty(runtime.primary_action),
    can_queue: Boolean(runtime.can_queue),
    composer_text: firstNonEmpty(runtime.composer_text),
    composer_available: Boolean(runtime.composer_available),
    queue: queueDirectSignature(runtime.queue),
    model: optionID(composer.model),
    reasoning: optionID(composer.reasoning),
    permission: optionID(composer.approval),
    approval_request_id: firstNonEmpty(approval.approval_request_id, approval.id),
    approval_actions: Array.isArray(approval.actions) ? approval.actions.map((item) => `${firstNonEmpty(item && item.id)}:${Boolean(item && item.requires_input)}`).join("|") : "",
    approval_input: firstNonEmpty(approval.input && approval.input.kind, approval.input && approval.input.label),
    interactive_controls: JSON.stringify(cloneInteractiveControls(cachedOptions && cachedOptions.interactiveControls)),
    interactive_surface: JSON.stringify(interactiveSurface || null),
    plan_mode: JSON.stringify(planModeDetailFromRuntime(runtime)),
    goal: JSON.stringify(goalDetailFromRuntime(runtime)),
    conversation_menu_available: snapshot && snapshot.conversation_menu_available === true,
    pinned: typeof snapshot.pinned === "boolean" ? snapshot.pinned : null,
    context_window_total: firstNonEmpty(thread && thread.metadata && thread.metadata.context_window_total),
    context_tokens_used: firstNonEmpty(thread && thread.metadata && thread.metadata.context_tokens_used),
    context_window_usage_percent: firstNonEmpty(thread && thread.metadata && thread.metadata.context_window_usage_percent),
    messages_signature: firstNonEmpty(messagesSignature),
  };
}

function desktopWatchSignature(snapshot = {}, messagesSignature = "", interactiveSurface = null) {
  return JSON.stringify(desktopWatchSignatureParts(snapshot, messagesSignature, interactiveSurface));
}

// A plugin-wide subscription drives the conversation index, not an open detail
// page. Body, composer and dynamic-menu changes must not reorder or re-render
// Mobile home while a Codex response is streaming. Queue changes are different:
// their direct actions mutate the native composer, so they must publish a fresh
// detail snapshot even when the coarse running status is unchanged.
function desktopIndexWatchSignature(snapshot = {}, status = "") {
  const runtime = snapshot && snapshot.runtime && typeof snapshot.runtime === "object" ? snapshot.runtime : {};
  const threadID = firstNonEmpty(runtime.current_thread_id);
  return JSON.stringify({
    thread_id: threadID,
    status: firstNonEmpty(status),
    title: desktopConversationTitle(threadID, snapshot),
    pinned: typeof snapshot.pinned === "boolean" ? snapshot.pinned : null,
    queue: queueDirectSignature(runtime.queue),
    plan_mode: planModeDetailFromRuntime(runtime),
    goal: goalDetailFromRuntime(runtime),
  });
}

// This diagnostic never changes what the watcher publishes. It records only
// field names, so an idle Desktop can reveal remaining non-semantic churn
// without writing composer or surface contents into the Hub log.
function logDesktopWatchSignatureDrift(previousSignature = "", nextSignature = "") {
  if (!previousSignature || previousSignature === nextSignature) return;
  let previous = null;
  let next = null;
  try {
    previous = JSON.parse(previousSignature);
    next = JSON.parse(nextSignature);
  } catch {
    return;
  }
  const changed = Object.keys({ ...previous, ...next })
    .filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]))
    .sort();
  if (!changed.length) return;
  const key = changed.join(",");
  const at = Date.now();
  if (lastDesktopWatchSignatureDrift.key === key && at - lastDesktopWatchSignatureDrift.at < DESKTOP_WATCH_SIGNATURE_DIAGNOSTIC_INTERVAL_MS) {
    return;
  }
  lastDesktopWatchSignatureDrift = { key, at };
  console.error(`[codex] desktop watcher semantic signature changed fields=${key}`);
}

function controlOptionsSignature(items = []) {
  if (!Array.isArray(items)) return "";
  return items.map((item) => {
    const optionID = firstNonEmpty(item && item.id, item && item.key, item && item.value, item && item.displayName);
    const availability = item && item.available === false ? 0 : 1;
    return `${optionID}:${availability}:${item && item.menuVerified === true ? 1 : 0}`;
  }).join("|");
}

function desktopWatchStatus(runtime = {}) {
  const recordedTerminal = runtime && runtime.recorded_terminal && typeof runtime.recorded_terminal === "object"
    ? firstNonEmpty(runtime.recorded_terminal.status)
    : "";
  if (recordedTerminal) return recordedTerminal;
  if (runtime.waiting_approval) return "waiting_approval";
  if (runtime.running || runtime.queue_pending) return "running";
  return "idle";
}

const DESKTOP_RUN_FILE_WATCH_POLL_MS = 2000;
const DESKTOP_RUN_FILE_WATCH_TIMEOUT_MS = 30 * 60 * 1000;
// Evidence-free fallback: same-status duplicates within this window are UI lag,
// not a new run.
const DESKTOP_TERMINAL_REARM_FALLBACK_MS = 10 * 1000;

// Desktop-initiated runs never pass through the hub's forward-run waiter, so
// their terminal push needs an explicit event here. Terminal state is data
// state: it comes from the thread's rollout file, never from the foreground
// watcher alone. Each emitted terminal records the rollout evidence (file
// content length) it was based on; a later terminal with more evidence is a
// genuinely new run. Desktop UI status lags the rollout data, so a non-
// terminal UI status never disarms an emitted terminal.
const desktopTerminalRunEmitted = new Map();

// Evidence survives plugin restarts via the plugin state file: the hub
// restarts plugin processes freely (updates, recovery), and a lost dedup
// record would re-push a run that completed just before the restart.
const DESKTOP_TERMINAL_RUN_STATE_LIMIT = 100;

function hydrateDesktopTerminalRuns() {
  try {
    const saved = readPluginState().desktopTerminalRuns;
    if (!saved || typeof saved !== "object") return;
    for (const [threadID, entry] of Object.entries(saved)) {
      if (!entry || typeof entry !== "object" || !isThreadID(threadID)) continue;
      const status = String(entry.status || "").toLowerCase();
      if (!["completed", "failed", "interrupted"].includes(status)) continue;
      desktopTerminalRunEmitted.set(threadID, {
        status,
        evidence: Number(entry.evidence) || 0,
        at: Number(entry.at) || 0,
      });
    }
  } catch {}
}

function persistDesktopTerminalRuns() {
  try {
    const state = readPluginState();
    const entries = [...desktopTerminalRunEmitted.entries()]
      .sort((a, b) => (Number(b[1].at) || 0) - (Number(a[1].at) || 0))
      .slice(0, DESKTOP_TERMINAL_RUN_STATE_LIMIT);
    const saved = {};
    for (const [threadID, entry] of entries) {
      saved[threadID] = { status: entry.status, evidence: entry.evidence, at: entry.at };
    }
    state.desktopTerminalRuns = saved;
    writePluginState(state);
  } catch {}
}

function desktopTerminalTransition(threadID, status, evidence = 0) {
  const normalized = String(status || "").toLowerCase();
  if (!["completed", "failed", "interrupted"].includes(normalized)) {
    return null;
  }
  const recorded = desktopTerminalRunEmitted.get(threadID);
  if (recorded) {
    const newerRun = normalized !== recorded.status
      || (evidence > 0 && recorded.evidence > 0 && evidence > recorded.evidence)
      || (evidence === 0 && recorded.evidence === 0 && Date.now() - recorded.at >= DESKTOP_TERMINAL_REARM_FALLBACK_MS);
    if (!newerRun) return null;
  }
  desktopTerminalRunEmitted.set(threadID, { status: normalized, evidence, at: Date.now() });
  return normalized;
}

hydrateDesktopTerminalRuns();

// Position marker for terminal dedup: the rollout file's size at detection
// time. Bytes appended after a terminal belong to the next run.
const rolloutPathCache = new Map();
const ROLLOUT_PATH_CACHE_TTL_MS = 60 * 1000;

async function resolveRolloutFile(threadID) {
  if (!isThreadID(threadID)) return "";
  const cached = rolloutPathCache.get(threadID);
  if (cached && (cached.path || Date.now() - cached.resolvedAt < ROLLOUT_PATH_CACHE_TTL_MS)) {
    return cached.path;
  }
  const path = await findRolloutFile(threadID).catch(() => "");
  rolloutPathCache.set(threadID, { path, resolvedAt: Date.now() });
  return path;
}

async function rolloutEvidence(threadID) {
  const file = await resolveRolloutFile(threadID);
  if (!file) return { path: "", size: 0, mtimeMs: 0 };
  try {
    const stat = fs.statSync(file);
    return { path: file, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return { path: file, size: 0, mtimeMs: 0 };
  }
}

// recorded_terminal survives long after a run ends. A completion observed in
// the desktop UI is only worth pushing when the rollout file was written
// recently; otherwise it is a stale projection (e.g. first visit after a
// plugin restart) and the tracker already handled any real completion.
const DESKTOP_TERMINAL_FRESH_MS = 15 * 60 * 1000;

function desktopTerminalFreshEnough(mtimeMs, now = Date.now()) {
  if (!mtimeMs) return false;
  return now - mtimeMs <= DESKTOP_TERMINAL_FRESH_MS;
}

// A run observed in the desktop UI keeps appending to its rollout file after
// the user switches to another conversation, so terminal detection must not
// depend on the thread being foreground. Track the rollout file directly.
const desktopRunFileWatchers = new Map();

function desktopRunFileWatchEvaluate(tracker, chunk, now) {
  if (chunk && chunk.terminal) {
    const status = chunk.failed ? "failed" : chunk.interrupted ? "interrupted" : "completed";
    return { action: "terminal", status };
  }
  if (now - tracker.startedAt >= DESKTOP_RUN_FILE_WATCH_TIMEOUT_MS) {
    return { action: "timeout" };
  }
  return { action: "continue" };
}

function desktopRunFileWatchStart(threadID, rolloutFile = "") {
  if (!isThreadID(threadID) || desktopRunFileWatchers.has(threadID)) return;
  const tracker = { file: rolloutFile, offset: 0, startedAt: Date.now() };
  if (rolloutFile) {
    try {
      tracker.offset = fs.readFileSync(rolloutFile, "utf8").length;
    } catch {
      tracker.offset = 0;
    }
  }
  tracker.timer = setInterval(() => {
    desktopRunFileWatchPoll(threadID).catch(() => {});
  }, DESKTOP_RUN_FILE_WATCH_POLL_MS);
  if (typeof tracker.timer.unref === "function") tracker.timer.unref();
  desktopRunFileWatchers.set(threadID, tracker);
}

function desktopRunFileWatchStop(threadID) {
  const tracker = desktopRunFileWatchers.get(threadID);
  if (!tracker) return;
  desktopRunFileWatchers.delete(threadID);
  if (tracker.timer) clearInterval(tracker.timer);
}

async function desktopRunFileWatchPoll(threadID) {
  const tracker = desktopRunFileWatchers.get(threadID);
  if (!tracker) return;
  let file = tracker.file;
  if (!file || !fs.existsSync(file)) {
    file = tracker.file = await findRolloutFile(threadID).catch(() => "");
    if (file) {
      try {
        tracker.offset = fs.readFileSync(file, "utf8").length;
      } catch {
        tracker.offset = 0;
      }
    }
  }
  const chunk = file ? summarizeRolloutChunk(file, tracker.offset) : null;
  const decision = desktopRunFileWatchEvaluate(tracker, chunk, Date.now());
  if (decision.action === "continue") return;
  desktopRunFileWatchStop(threadID);
  if (decision.action === "terminal") {
    await emitDesktopTerminalRunEvents(threadID, decision.status, null, null);
  }
}

function desktopTerminalRunSummary(status, runSummary, latestSummary) {
  if (status === "completed") {
    return firstNonEmpty(latestSummary, runSummary) || "Codex 已完成。";
  }
  return firstNonEmpty(runSummary) || (status === "interrupted" ? "Codex 任务已被打断。" : "Codex 执行失败。");
}

function desktopTerminalRunEvent(threadID, status, summary, sessionHint, detailSnapshot, evidence = 0) {
  return {
    // Deterministic per settled run: the gateway deduplicates on the payload
    // event_id, so a re-emission after a plugin restart must keep this stable.
    ID: `desktop-run:${threadID}:${status}:${evidence}`,
    Type: `run.${status}`,
    Status: status,
    Summary: summary,
    CreatedAt: new Date().toISOString(),
    Payload: {
      thread_id: threadID,
      native_session: {
        plugin_id: "codex",
        native_session_id: threadID,
        native_thread_id: threadID,
        surface: "codex-desktop",
        endpoint: deepLink(threadID),
        cwd: firstNonEmpty(sessionHint && sessionHint.cwd),
      },
      session_hint: sessionHint && typeof sessionHint === "object" ? sessionHint : desktopSessionHint(threadID, {}, status),
      detail_snapshot: detailSnapshot || undefined,
    },
  };
}

async function emitDesktopTerminalRunEvents(threadID, status, detailSnapshot, sessionHint, { requireFresh = false } = {}) {
  const evidenceInfo = await rolloutEvidence(threadID);
  if (requireFresh && !desktopTerminalFreshEnough(evidenceInfo.mtimeMs)) {
    return;
  }
  const normalized = desktopTerminalTransition(threadID, status, evidenceInfo.size);
  if (!normalized) return;
  persistDesktopTerminalRuns();
  desktopRunFileWatchStop(threadID);
  const run = detailSnapshot && typeof detailSnapshot.run === "object" ? detailSnapshot.run : null;
  const runSummary = run && String(run.status || "").toLowerCase() === normalized ? firstNonEmpty(run.summary) : "";
  let latestSummary = "";
  if (normalized === "completed") {
    const latest = await latestAssistantSummary(threadID).catch(() => null);
    latestSummary = firstNonEmpty(latest && latest.summary);
  }
  const event = desktopTerminalRunEvent(
    threadID,
    normalized,
    desktopTerminalRunSummary(normalized, runSummary, latestSummary),
    sessionHint,
    detailSnapshot,
    evidenceInfo.size,
  );
  for (const subscriber of desktopTerminalRunReceivers(threadID)) {
    emitDesktopWatchEvent(subscriber, event);
  }
}

// Terminal runs must reach the hub's plugin-wide desktop watch subscription;
// thread-scoped subscribers only receive events for their own thread.
function desktopTerminalRunReceivers(threadID, subscribers = desktopWatchSubscribers.values()) {
  return [...subscribers].filter(
    (subscriber) => subscriber.pluginWide || subscriber.threadID === threadID,
  );
}

function detailSnapshotFromDesktopWatch(threadID = "", snapshot = {}, messagesSignature = "", interactiveSurface = null) {
  if (!isThreadID(threadID)) return null;
  const runtime = snapshot && snapshot.runtime && typeof snapshot.runtime === "object" ? snapshot.runtime : {};
  const thread = snapshot && snapshot.thread && typeof snapshot.thread === "object" ? snapshot.thread : null;
  const cachedOptions = liveControlOptionsCacheEntry(threadID);
  const run = controlsRuntimeFromDesktopSnapshot(threadID, runtime) || {
    status: "idle",
    summary: "当前会话空闲。",
    primary_action: "send",
  };
  const runtimeStatus = String(run && run.status || "").trim().toLowerCase();
  const controlsLocked = runtimeStatus === "waiting_approval";
  rememberVisibleGoalBody(threadID, goalDetailFromRuntime(runtime, controlsLocked));
  const interactiveControls = cloneInteractiveControls(cachedOptions && cachedOptions.interactiveControls);
  return {
    native_conversation_id: threadID,
    updated_at: Date.now(),
    desktop_foreground: true,
    detail_stale: false,
    title: desktopConversationTitle(threadID, snapshot) || undefined,
    pinned: typeof snapshot.pinned === "boolean" ? snapshot.pinned : undefined,
    // The watcher only observes the foreground Composer; these remain
    // read-only until a user-initiated menu_session.describe verifies options.
    current_model: snapshot.composer && snapshot.composer.model || null,
    current_reasoning: snapshot.composer && snapshot.composer.reasoning || null,
    current_permission: snapshot.composer && snapshot.composer.approval || null,
    model_options: [],
    reasoning_options: [],
    permission_options: [],
    interactive_controls: interactiveControls,
    interactive_surface: interactiveSurface || null,
    conversation_menu_available: snapshot && snapshot.conversation_menu_available === true,
    approval: run.approval || null,
    composer: {
      content: firstNonEmpty(runtime.composer_text),
      editable: Boolean(runtime.composer_available),
    },
    queue: runtime.queue || null,
    plan_mode: planModeDetailFromRuntime(runtime, controlsLocked),
    goal: goalDetailFromRuntime(runtime, controlsLocked),
    primary_action: run.primary_action || "send",
    actions: buildDetailActions(threadID, Boolean(snapshot.pinned), controlsLocked),
    messages_signature: firstNonEmpty(messagesSignature),
    ...detailContextFields(thread),
    run,
  };
}

function desktopConversationTitle(threadID, snapshot = {}) {
  const thread = snapshot && snapshot.thread && typeof snapshot.thread === "object" ? snapshot.thread : {};
  const metadata = thread && thread.metadata && typeof thread.metadata === "object" ? thread.metadata : {};
  return [thread.title, metadata.title]
    .map((value) => String(value || "").trim())
    .find((value) => value && value !== threadID && !isThreadID(value)) || "";
}

function emitDesktopWatchEvent(subscriber, event) {
  if (!subscriber || typeof subscriber.push !== "function" || !event) return;
  subscriber.push(event);
}

function desktopSessionHint(threadID, snapshot = {}, status = "") {
  const thread = snapshot && snapshot.thread && typeof snapshot.thread === "object" ? snapshot.thread : {};
  return {
    plugin_id: "codex",
    native_session_id: threadID,
    native_thread_id: threadID,
    surface: "codex-desktop",
    endpoint: deepLink(threadID),
    cwd: firstNonEmpty(thread.cwd),
    title: desktopConversationTitle(threadID, snapshot),
    last_activity_at: new Date().toISOString(),
    metadata: {
      status: firstNonEmpty(status),
      sort_at: String(Date.now()),
      pinned: String(Boolean(snapshot && snapshot.pinned)),
    },
  };
}

function emitDesktopWatchDetail(subscriber, threadID, detailSnapshot, status, summary, sessionHint = null) {
  if (!subscriber || !isThreadID(threadID) || !detailSnapshot) return;
  subscriber.detailSnapshot = detailSnapshot;
  const hint = sessionHint && typeof sessionHint === "object"
    ? sessionHint
    : subscriber.sessionHint && typeof subscriber.sessionHint === "object"
      ? subscriber.sessionHint
      : desktopSessionHint(threadID, {}, status);
  subscriber.sessionHint = hint;
  emitDesktopWatchEvent(subscriber, {
    ID: `desktop-watch-${threadID}-${Date.now()}`,
    Type: "desktop.state.changed",
    Status: status,
    Summary: summary,
    CreatedAt: new Date().toISOString(),
    Payload: {
      desktop_live: true,
      primary_action: firstNonEmpty(detailSnapshot.primary_action),
      detail_snapshot: detailSnapshot,
      native_session: {
        plugin_id: "codex",
        native_session_id: threadID,
        native_thread_id: threadID,
        surface: "codex-desktop",
        endpoint: deepLink(threadID),
        cwd: firstNonEmpty(hint.cwd),
      },
      session_hint: hint,
    },
  });
}

function emitDesktopWatchArchived(threadID) {
  if (!isThreadID(threadID)) return;
  threadMetadataCache.delete(threadID);
  liveControlOptionsCache.delete(threadID);
  historyRuntimeNoticeCache.delete(threadID);
  messagesSignatureCache.delete(threadID);
  for (const key of historyTurnRevisionCache.keys()) {
    if (key.startsWith(`${threadID}:`)) historyTurnRevisionCache.delete(key);
  }
  sessionListCache = { at: 0, threads: null, inFlight: null };
  const hint = {
    plugin_id: "codex",
    native_session_id: threadID,
    native_thread_id: threadID,
    surface: "codex-desktop",
    endpoint: deepLink(threadID),
    last_activity_at: new Date().toISOString(),
    metadata: { archived: "true", sort_at: String(Date.now()) },
  };
  for (const subscriber of desktopWatchSubscribers.values()) {
    if (!subscriber.pluginWide && subscriber.threadID !== threadID) continue;
    emitDesktopWatchEvent(subscriber, {
      ID: `desktop-archived-${threadID}-${Date.now()}`,
      Type: "desktop.session.archived",
      Status: "idle",
      Summary: "Codex 会话已归档。",
      CreatedAt: new Date().toISOString(),
      Payload: {
        native_session: {
          plugin_id: "codex",
          native_session_id: threadID,
          native_thread_id: threadID,
          surface: "codex-desktop",
          endpoint: deepLink(threadID),
        },
        session_hint: hint,
      },
    });
  }
}

function hasPluginWideDesktopWatchSubscriber() {
  for (const subscriber of desktopWatchSubscribers.values()) {
    if (subscriber && subscriber.pluginWide) return true;
  }
  return false;
}

function desktopDirectorySessionHint(thread = {}) {
  const threadID = firstNonEmpty(thread && thread.id);
  return {
    plugin_id: "codex",
    native_session_id: threadID,
    native_thread_id: threadID,
    surface: "codex-desktop",
    endpoint: deepLink(threadID),
    cwd: firstNonEmpty(thread && thread.cwd),
    title: firstNonEmpty(thread && thread.title),
    last_activity_at: firstNonEmpty(thread && thread.sortAt, thread && thread.updatedAt),
    metadata: { ...(thread && thread.metadata && typeof thread.metadata === "object" ? thread.metadata : {}) },
  };
}

function emitDesktopDirectoryReconciled() {
  for (const subscriber of desktopWatchSubscribers.values()) {
    if (!subscriber || !subscriber.pluginWide) continue;
    emitDesktopWatchEvent(subscriber, {
      ID: `desktop-directory-${Date.now()}`,
      Type: "desktop.session.directory.reconciled",
      Status: "idle",
      Summary: "Codex 会话目录已更新。",
      CreatedAt: new Date().toISOString(),
      Payload: { source: "codex-storage" },
    });
  }
}

function emitDesktopDirectoryIndexChanged(thread) {
  const hint = desktopDirectorySessionHint(thread);
  if (!isThreadID(hint.native_thread_id)) return;
  for (const subscriber of desktopWatchSubscribers.values()) {
    if (!subscriber || !subscriber.pluginWide) continue;
    emitDesktopWatchEvent(subscriber, {
      ID: `desktop-directory-index-${hint.native_thread_id}-${Date.now()}`,
      Type: "desktop.session.index.changed",
      Status: "idle",
      Summary: "Codex 会话目录项已更新。",
      CreatedAt: new Date().toISOString(),
      Payload: {
        native_session: {
          plugin_id: hint.plugin_id,
          native_session_id: hint.native_session_id,
          native_thread_id: hint.native_thread_id,
          surface: hint.surface,
          endpoint: hint.endpoint,
          cwd: hint.cwd,
        },
        session_hint: hint,
      },
    });
  }
}

function requestDesktopDirectoryRefresh({ immediate = false } = {}) {
  if (!hasPluginWideDesktopWatchSubscriber()) return;
  desktopDirectoryState.dirty = true;
  if (desktopDirectoryState.running || desktopDirectoryState.debounceTimer) return;
  const delay = immediate ? 0 : DIRECTORY_WATCH_DEBOUNCE_MS;
  desktopDirectoryState.debounceTimer = setTimeout(() => {
    desktopDirectoryState.debounceTimer = null;
    reconcileDesktopDirectoryFromStorage().catch((error) => {
      console.error(`[codex] desktop directory reconciliation failed: ${error && error.message ? error.message : String(error)}`);
    });
  }, delay);
}

async function reconcileDesktopDirectoryFromStorage() {
  if (!hasPluginWideDesktopWatchSubscriber() || desktopDirectoryState.running) return;
  desktopDirectoryState.running = true;
  desktopDirectoryState.dirty = false;
  try {
    const threads = await readSessionListSnapshot(0, { force: true });
    const diff = desktopDirectoryDiff(desktopDirectoryState.threads, threads);
    const initial = !desktopDirectoryState.initialized;
    desktopDirectoryState.initialized = true;
    desktopDirectoryState.threads = diff.next;
    desktopDirectoryState.retryAttempt = 0;
    if (initial) {
      emitDesktopDirectoryReconciled();
      return;
    }
    for (const thread of [...diff.added, ...diff.changed]) {
      emitDesktopDirectoryIndexChanged(thread);
    }
    let requiresCompleteRebuild = false;
    for (const thread of diff.removed) {
      const threadID = firstNonEmpty(thread && thread.id);
      if (await threadArchivedInState(threadID)) {
        emitDesktopWatchArchived(threadID);
      } else {
        // A successful complete snapshot proves the item is gone, but only
        // Codex's archived flag can label it as an archive operation.
        requiresCompleteRebuild = true;
      }
    }
    if (requiresCompleteRebuild) emitDesktopDirectoryReconciled();
  } catch (error) {
    const retryDelay = DIRECTORY_WATCH_RETRY_DELAYS_MS[desktopDirectoryState.retryAttempt];
    desktopDirectoryState.retryAttempt += 1;
    if (retryDelay !== undefined && hasPluginWideDesktopWatchSubscriber()) {
      desktopDirectoryState.debounceTimer = setTimeout(() => {
        desktopDirectoryState.debounceTimer = null;
        reconcileDesktopDirectoryFromStorage().catch(() => {});
      }, retryDelay);
    }
    throw error;
  } finally {
    desktopDirectoryState.running = false;
    if (desktopDirectoryState.dirty && !desktopDirectoryState.debounceTimer) {
      requestDesktopDirectoryRefresh();
    }
  }
}

function directoryWatchPaths() {
  // Codex creates a rollout under ~/.codex/sessions before every related
  // SQLite/session-index mutation is observable. Watching that source keeps a
  // desktop-originated new thread on the remote index path without polling.
  const directories = new Set([path.dirname(SESSION_INDEX), SESSION_ROOT]);
  for (const candidate of STATE_DB_CANDIDATES) {
    directories.add(path.dirname(candidate));
  }
  return [...directories];
}

function directoryWatchEventIsRelevant(directory, filename) {
  if (directory === SESSION_ROOT) return true;
  if (!filename) return true;
  const name = path.basename(String(filename));
  if (name === path.basename(SESSION_INDEX)) return true;
  for (const candidate of STATE_DB_CANDIDATES) {
    if (directory !== path.dirname(candidate)) continue;
    const base = path.basename(candidate);
    if (name === base || name === `${base}-wal` || name === `${base}-shm`) return true;
  }
  return false;
}

function ensureDesktopDirectoryWatchRunning() {
  if (desktopDirectoryWatchers.length > 0 || !hasPluginWideDesktopWatchSubscriber()) return;
  for (const directory of directoryWatchPaths()) {
    try {
      const recursive = directory === SESSION_ROOT && (process.platform === "darwin" || process.platform === "win32");
      const watcher = fs.watch(directory, { recursive }, (eventType, filename) => {
        if (!directoryWatchEventIsRelevant(directory, filename)) return;
        sessionListCache = { at: 0, threads: null, inFlight: null };
        requestDesktopDirectoryRefresh();
      });
      watcher.on("error", (error) => {
        console.error(`[codex] desktop directory watcher failed for ${directory}: ${error && error.message ? error.message : String(error)}`);
      });
      desktopDirectoryWatchers.push(watcher);
    } catch (error) {
      console.error(`[codex] desktop directory watcher unavailable for ${directory}: ${error && error.message ? error.message : String(error)}`);
    }
  }
  requestDesktopDirectoryRefresh({ immediate: true });
}

function stopDesktopDirectoryWatchWhenIdle() {
  if (hasPluginWideDesktopWatchSubscriber()) return;
  for (const watcher of desktopDirectoryWatchers) watcher.close();
  desktopDirectoryWatchers = [];
  if (desktopDirectoryState.debounceTimer) clearTimeout(desktopDirectoryState.debounceTimer);
  desktopDirectoryState = createDesktopDirectoryState();
}

function emitDesktopWatchStale(subscriber, threadID) {
  if (!subscriber || !isThreadID(threadID)) return;
  const previous = subscriber.detailSnapshot && typeof subscriber.detailSnapshot === "object"
    ? subscriber.detailSnapshot
    : {};
  const staleSnapshot = {
    ...previous,
    native_conversation_id: threadID,
    updated_at: Date.now(),
    desktop_foreground: false,
    detail_stale: true,
    interactive_surface: null,
  };
  subscriber.signature = "";
  subscriber.detailSnapshot = staleSnapshot;
  emitDesktopWatchDetail(subscriber, threadID, staleSnapshot, "idle", "Codex 会话已切到其他桌面窗口。", subscriber.sessionHint);
}

function emitDesktopWatchUnavailable(subscriber) {
  if (!subscriber) return;
  subscriber.signature = "";
  emitDesktopWatchEvent(subscriber, {
    ID: `desktop-watch-unavailable-${subscriber.threadID}-${Date.now()}`,
    Type: "watcher.foreground.unavailable",
    Status: "unavailable",
    Summary: "Codex 前台会话状态暂时不可用。",
    CreatedAt: new Date().toISOString(),
    Payload: {
      watcher: "foreground",
      code: "foreground_watcher_unavailable",
      native_session: subscriber.pluginWide && isThreadID(desktopWatchState.lastValidThreadID) ? {
        plugin_id: "codex",
        native_session_id: desktopWatchState.lastValidThreadID,
        native_thread_id: desktopWatchState.lastValidThreadID,
        surface: "codex-desktop",
        endpoint: deepLink(desktopWatchState.lastValidThreadID),
      } : undefined,
    },
  });
}

function reportDesktopWatchFailure() {
  const transition = observeDesktopWatchForeground(desktopWatchState, "");
  if (!transition.becameUnavailable) return;
  for (const subscriber of desktopWatchSubscribers.values()) {
    emitDesktopWatchUnavailable(subscriber);
  }
}

function emitMobileDraftsStale(reason = "desktop draft is no longer the active empty draft", shouldMark = () => true) {
  for (const [draftID, draft] of mobileDrafts.entries()) {
    if (draft && draft.staleReported) continue;
    if (!shouldMark(draft)) continue;
    if (draft) draft.staleReported = true;
    for (const subscriber of desktopWatchSubscribers.values()) {
      if (!subscriber.pluginWide) continue;
      emitDesktopWatchEvent(subscriber, {
        ID: `desktop-draft-stale-${draftID}-${Date.now()}`,
        Type: "desktop.draft.stale",
        Status: "draft_stale",
        Summary: reason,
        CreatedAt: new Date().toISOString(),
        Payload: { draft_id: draftID },
      });
    }
  }
}

function enqueueDesktopControlMenuWarm(operation) {
  const run = desktopControlMenuWarmQueue.then(operation, operation);
  // Keep the queue usable after a failed menu read; the caller logs its error.
  desktopControlMenuWarmQueue = run.catch(() => {});
  return run;
}

async function runExclusiveDesktopControl(operation) {
  return enqueueDesktopControlMenuWarm(async () => {
    desktopControlInFlight = true;
    try {
      while (desktopWatchInFlight) {
        await sleep(25);
      }
      return await operation();
    } finally {
      desktopControlInFlight = false;
      flushDeferredDesktopWatchBursts();
    }
  });
}

async function pollDesktopWatch() {
  if (desktopWatchSubscribers.size === 0) return;
  if (desktopWatchInFlight) {
    recordDesktopWatchMetric("polls_skipped_in_flight");
    logDesktopWatchTelemetry();
    return;
  }
  if (desktopControlInFlight) {
    recordDesktopWatchMetric("polls_skipped_control");
    logDesktopWatchTelemetry();
    return;
  }
  const startedAt = Date.now();
  recordDesktopWatchMetric("polls_started");
  let pollFailed = false;
  desktopWatchInFlight = true;
  try {
    const controller = await codexDesktopController();
    const foregroundRuntime = await controller.currentThreadRuntimeState().catch(() => null);
    const rawInteractiveSurface = await controller.readInteractiveSurface().catch(() => null);
    const snapshot = await currentDesktopConversationSnapshot({
      controller,
      runtime: foregroundRuntime,
      // A watcher only reads the closed state. Opening a menu belongs to an
      // explicit describe/apply request and must never mutate the desktop UI.
      allowMenuSampling: false,
    });
    const runtime = snapshot && snapshot.runtime && typeof snapshot.runtime === "object" ? snapshot.runtime : {};
    const composer = snapshot && snapshot.composer && typeof snapshot.composer === "object" ? snapshot.composer : {};
    const threadID = firstNonEmpty(runtime.current_thread_id);
    if (!isThreadID(threadID)) {
      const fingerprint = anonymousDraftFingerprint(runtime);
      if (fingerprint) {
        emitMobileDraftsStale("desktop foreground changed to another anonymous draft", (draft) =>
          !isCurrentAnonymousMobileDraft(draft, runtime),
        );
        if (String(runtime.composer_text || "").trim()) {
          emitMobileDraftsStale("desktop draft is no longer empty", (draft) =>
            isCurrentAnonymousMobileDraft(draft, runtime),
          );
        }
        return;
      }
      reportDesktopWatchFailure();
      return;
    }
	if (mobileDrafts.size > 0) {
		emitMobileDraftsStale("desktop foreground changed to a conversation");
	}
    const messagesSignature = await threadMessagesSignature(threadID).catch(() => "");
    const transition = observeDesktopWatchForeground(desktopWatchState, threadID);
    const interactiveSurface = interactiveSurfaceForForeground(desktopWatchState, transition, threadID, rawInteractiveSurface);
    const liveRun = controlsRuntimeFromDesktopSnapshot(threadID, runtime) || { status: "idle" };
    const controlsLocked = String(liveRun.status || "").trim().toLowerCase() === "waiting_approval";
    // The watcher reads only the already-rendered composer. This keeps the
    // projection current without opening any Codex menu in the background.
    rememberLiveControlOptions(threadID, {
      interactiveControls: await readCodexInteractiveControls(controller),
    });
    const status = desktopWatchStatus(runtime);
    const detailSignature = desktopWatchSignature(snapshot, messagesSignature, interactiveSurface);
    const indexSignature = desktopIndexWatchSignature(snapshot, status);
    const detailSnapshot = detailSnapshotFromDesktopWatch(threadID, snapshot, messagesSignature, interactiveSurface);
    if (!detailSnapshot) {
      reportDesktopWatchFailure();
      return;
    }
    const sessionHint = desktopSessionHint(threadID, snapshot, status);
    if (transition.switched) {
      for (const subscriber of desktopWatchSubscribers.values()) {
        if (subscriber.pluginWide || subscriber.threadID === transition.previousThreadID) {
          emitDesktopWatchStale(subscriber, transition.previousThreadID);
        }
      }
    }
    await emitDesktopTerminalRunEvents(threadID, status, detailSnapshot, sessionHint, { requireFresh: true });
    if (status === "running" || status === "waiting_approval") {
      const trackedRollout = await resolveRolloutFile(threadID);
      desktopRunFileWatchStart(threadID, trackedRollout);
    }
    for (const subscriber of desktopWatchSubscribers.values()) {
      if (!subscriber.pluginWide && subscriber.threadID !== threadID) continue;
      const signature = subscriber.pluginWide ? indexSignature : detailSignature;
      if (!transition.recovered && !transition.switched && subscriber.signature === signature) continue;
      const messagesChanged = subscriber.messagesSignature !== messagesSignature;
      logDesktopWatchSignatureDrift(subscriber.signature, signature);
      subscriber.signature = signature;
      subscriber.messagesSignature = messagesSignature;
      emitDesktopWatchDetail(
        subscriber,
        threadID,
        detailSnapshot,
        status,
        runtime.waiting_approval ? "Codex 正在等待审批。" : runtime.running ? "Codex 会话状态已更新。" : "Codex 会话设置已更新。",
        sessionHint,
      );
      if (messagesChanged) {
        logTiming("desktopWatch.messagesChanged", startedAt, {
          thread_id: threadID,
          messages_signature: messagesSignature.slice(0, 12),
        });
      }
    }
  } catch (error) {
    pollFailed = true;
    recordDesktopWatchMetric("polls_failed");
    console.error(`[codex] desktop watcher poll failed: ${error && error.message ? error.message : String(error)}`);
    reportDesktopWatchFailure();
  } finally {
    const costMs = Date.now() - startedAt;
    if (!pollFailed) recordDesktopWatchMetric("polls_completed");
    recordDesktopWatchMetric("poll_cost_ms_total", costMs);
    desktopWatchTelemetry.poll_cost_ms_max = Math.max(desktopWatchTelemetry.poll_cost_ms_max, costMs);
    logDesktopWatchTelemetry();
    desktopWatchInFlight = false;
  }
}

function ensureDesktopWatchRunning() {
  if (desktopWatchTimer || desktopWatchSubscribers.size === 0) return;
  desktopWatchTimer = setInterval(() => {
    pollDesktopWatch().catch(() => {});
  }, 900);
  pollDesktopWatch().catch(() => {});
}

function stopDesktopWatchWhenIdle() {
  if (desktopWatchSubscribers.size !== 0 || !desktopWatchTimer) return;
  clearInterval(desktopWatchTimer);
  desktopWatchTimer = null;
  desktopWatchState = createDesktopWatchState();
  stopDesktopDirectoryWatchWhenIdle();
}

function desktopWatchEventCoalesceKey(event) {
  if (!event || typeof event !== "object") return "";
  const type = String(event.Type || event.type || "").trim();
  const payload = event.Payload && typeof event.Payload === "object" ? event.Payload : {};
  const session = payload.native_session && typeof payload.native_session === "object" ? payload.native_session : {};
  const threadID = firstNonEmpty(session.native_thread_id, session.native_session_id);
  if (type === "desktop.state.changed" && isThreadID(threadID)) return `${type}:${threadID}`;
  if (type === "desktop.session.index.changed" && isThreadID(threadID)) return `${type}:${threadID}`;
  if (type === "desktop.session.directory.reconciled" || type === "agent.usage.updated") return type;
  return "";
}

function createDesktopWatchEventQueue(signal, options = {}) {
  const maxPending = Math.max(1, Number(options.maxPending) || DESKTOP_WATCH_EVENT_QUEUE_MAX);
  const pending = [];
  const waiters = [];
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    while (waiters.length > 0) {
      waiters.shift()({ done: true, value: undefined });
    }
  };
  if (signal) {
    if (signal.aborted) close();
    else signal.addEventListener("abort", close, { once: true });
  }
  return {
    push(event) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ done: false, value: event });
        return;
      }
      const coalesceKey = desktopWatchEventCoalesceKey(event);
      if (coalesceKey) {
        const existingIndex = pending.findIndex((candidate) => desktopWatchEventCoalesceKey(candidate) === coalesceKey);
        if (existingIndex >= 0) {
          pending[existingIndex] = event;
          recordDesktopWatchMetric("queue_events_coalesced");
          return;
        }
      }
      if (pending.length >= maxPending) {
        // A slow Hub must reconnect and receive a new authoritative snapshot.
        // Dropping one arbitrary lifecycle event here would leave its directory
        // or detail state permanently stale without any recovery signal.
        recordDesktopWatchMetric("queue_overflow_closures");
        console.error(`[codex] watcher queue overloaded: max_pending=${maxPending}; closing subscription for resync`);
        close();
        logDesktopWatchTelemetry(true);
        return;
      }
      pending.push(event);
      observeDesktopWatchQueueDepth(pending.length);
    },
    next() {
      if (pending.length > 0) return Promise.resolve({ done: false, value: pending.shift() });
      if (closed) return Promise.resolve({ done: true, value: undefined });
      return new Promise((resolve) => waiters.push(resolve));
    },
    close,
  };
}

async function* subscribe(session, signal) {
  const threadID = firstNonEmpty(session && session.NativeThreadID, session && session.NativeSessionID);
  if (!isThreadID(threadID)) {
    throw new Error("codex subscribe requires a resolved Codex thread id");
  }
  const queue = createDesktopWatchEventQueue(signal);
  const subscriber = {
    id: randomID(),
    threadID,
    signature: "",
    messagesSignature: "",
    detailSnapshot: null,
    sessionHint: null,
    push: queue.push,
    close: queue.close,
  };
  desktopWatchSubscribers.set(subscriber.id, subscriber);
  ensureDesktopWatchRunning();
  try {
    while (true) {
      const next = await queue.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    queue.close();
    desktopWatchSubscribers.delete(subscriber.id);
    stopDesktopDirectoryWatchWhenIdle();
    stopDesktopWatchWhenIdle();
  }
}

async function* subscribePlugin(signal) {
  const queue = createDesktopWatchEventQueue(signal);
  const subscriber = {
    id: randomID(),
    threadID: "",
    pluginWide: true,
    signature: "",
    messagesSignature: "",
    detailSnapshot: null,
    sessionHint: null,
    push: queue.push,
    close: queue.close,
  };
  desktopWatchSubscribers.set(subscriber.id, subscriber);
  agentUsageSubscribers.add(queue.push);
  void ensureCodexAccountUsageClient();
  startCodexAccountUsagePolling();
  ensureDesktopDirectoryWatchRunning();
  ensureDesktopWatchRunning();
  try {
    while (true) {
      const next = await queue.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    queue.close();
    desktopWatchSubscribers.delete(subscriber.id);
    agentUsageSubscribers.delete(queue.push);
    if (!agentUsageSubscribers.size) stopCodexAccountUsagePolling();
    stopDesktopDirectoryWatchWhenIdle();
    stopDesktopWatchWhenIdle();
  }
}

async function interrupt(session) {
  const threadID = firstNonEmpty(session && session.NativeThreadID, session && session.NativeSessionID);
  if (!isThreadID(threadID)) {
    throw new Error("control_target_stale: interrupt requires a resolved Codex thread id");
  }
  const controller = await codexDesktopController();
  await selectRequiredCodexThread(controller, threadID);
  await controller.interrupt();
}

async function verifyVisibility(session, marker) {
  const threadID = firstNonEmpty(session && session.NativeThreadID, session && session.NativeSessionID);
  const result = await waitForMarker(threadID, marker);
  return {
    Visible: result.visible,
    Marker: marker,
    Evidence: result.evidence,
    CheckedAt: now(),
    FailureReason: result.failureReason,
  };
}

async function close() {
  for (const subscriber of desktopWatchSubscribers.values()) {
    subscriber.close?.();
  }
  desktopWatchSubscribers.clear();
  stopDesktopWatchWhenIdle();
  stopDesktopDirectoryWatchWhenIdle();
  desktopWatchState = createDesktopWatchState();
  visibleGoalBodyByThread.clear();
  agentUsageSubscribers.clear();
  stopCodexAccountUsagePolling();
  const usageClient = codexAccountUsageClient;
  codexAccountUsageClient = null;
  codexAccountUsageProjection = null;
  usageClient?.close();
  if (!codexDesktopControllerPromise) {
    return;
  }
  const controller = await codexDesktopControllerPromise.catch(() => null);
  codexDesktopControllerPromise = null;
  if (controller && typeof controller.close === "function") {
    await controller.close().catch(() => {});
  }
}

async function waitForRun(session, runID) {
  const threadID = firstNonEmpty(session && session.NativeThreadID, session && session.NativeSessionID);
  if (!isThreadID(threadID)) {
    throw new Error("codex waitForRun requires a resolved Codex thread id");
  }
  const decoded = decodeRunContext(runID);
  const runContext = decoded && decoded.thread_id === threadID
    ? decoded
    : {
        thread_id: threadID,
        started_at: Date.now(),
        file: await findRolloutFile(threadID),
        offset: 0,
      };
  const deadline = Date.now() + RUN_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const file = runContext.file || await findRolloutFile(threadID);
    const result = file
      ? summarizeRolloutChunk(file, Number(runContext.offset || 0))
      : await latestAssistantSummary(threadID);
    if (result.terminal) {
      const status = result.failed ? "failed" : result.interrupted ? "interrupted" : "completed";
      const summary = result.summary
        || (result.failed ? "Codex 自动化执行失败。" : result.interrupted ? "Codex 任务已被打断。" : "Codex 已完成。");
      const detailSnapshot = await terminalDetailSnapshot(threadID).catch(() => null);
      return {
        ID: String(runID || randomID()),
        Type: result.failed ? "run.failed" : result.interrupted ? "run.interrupted" : "run.completed",
        Status: status,
        Summary: summary,
        Payload: {
          thread_id: threadID,
          evidence: result.evidence,
          detail_snapshot: detailSnapshot || undefined,
        },
        CreatedAt: now(),
      };
    }
    if (result.summary) {
      // Keep waiting for terminal, but when the assistant has already produced
      // visible text we can tolerate Codex taking a little longer to append the
      // final task_complete marker.
      await sleep(700);
    } else {
      await sleep(VISIBILITY_POLL_MS);
    }
  }
  const fallbackFile = runContext.file || await findRolloutFile(threadID);
  const fallback = fallbackFile
    ? summarizeRolloutChunk(fallbackFile, Number(runContext.offset || 0))
    : await latestAssistantSummary(threadID);
  if (fallback.summary) {
    const detailSnapshot = await terminalDetailSnapshot(threadID).catch(() => null);
    return {
      ID: String(runID || randomID()),
      Type: "run.completed",
      Status: "completed",
      Summary: fallback.summary,
      Payload: {
        thread_id: threadID,
        evidence: fallback.evidence,
        timeout_fallback: true,
        detail_snapshot: detailSnapshot || undefined,
      },
      CreatedAt: now(),
    };
  }
  throw new Error("codex waitForRun timed out before any assistant summary appeared");
}

async function terminalDetailSnapshot(threadID = "") {
  if (!isThreadID(threadID)) return null;
  const messagesSignature = await threadMessagesSignature(threadID).catch(() => "");
  return {
    native_conversation_id: threadID,
    updated_at: Date.now(),
    messages_signature: firstNonEmpty(messagesSignature),
  };
}

const adapter = {
  id() {
    return "codex";
  },
  async probe() {
    return capability();
  },
  discover() {
    return discovery();
  },
  startSessionWithMessage,
	openDraft,
	controlDraft,
	startDraftWithMessage,
  listSessions,
  attachSession,
  readHistoryStream,
  // Compatibility-only while the deployed API still asks for the pre-stream
  // conversation.messages query. It is removed with that API route.
  readHistory,
  readStatus,
  controlSession,
  subscribe,
  subscribePlugin,
  readAgentUsage,
  resolveApproval,
  send,
  interrupt,
  verifyVisibility,
  waitForRun,
  close,
};

async function main() {
  const { serve } = await import("@rokid-prism/pluginbridge-plugin-sdk");
  await serve(adapter);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}

module.exports = {
  __test: {
    createDesktopWatchState,
    createDesktopDirectoryState,
    desktopDirectoryEntrySignature,
    desktopDirectoryDiff,
    directoryWatchPaths,
    directoryWatchEventIsRelevant,
    observeDesktopWatchForeground,
    desktopTerminalTransition,
    desktopTerminalRunSummary,
    desktopTerminalRunEvent,
    desktopTerminalRunReceivers,
    desktopRunFileWatchEvaluate,
    desktopRunFileWatchStart,
    desktopRunFileWatchStop,
    desktopTerminalFreshEnough,
    summarizeRolloutChunk,
    emitDesktopTerminalRunEvents,
    readHistoryStream,
    pluginEventName: PLUGIN_EVENT_NAME,
    historyMessagesForDisplay,
    historyToolResultFromRolloutRow,
    historyTurnsFromTail,
    readRecentRolloutRows,
    historyRecentScanBudget,
    boundedHistoryTurnLimit,
    latestRecordedTurnLifecycle,
    runtimeWithRecordedTerminal,
    updateHistoryRuntimeNotices,
    isDesktopVisibleAssistantMessage,
    asISOString,
    historyMessageID,
    historyMessageSignature,
    visibleUserHistoryText,
    goalObjectiveFromInternalUserEnvelope,
    rememberVisibleGoalBody,
    rememberVisibleGoalBodyFromForegroundRuntime,
    visibleGoalBodyTurn,
    historyMessageFromRolloutRow,
    readRolloutItems,
    runTraceFromThread,
    rolloutContextMetadata,
    withRolloutContextMetadata,
    liveApprovalOptionFromRow,
    liveModelOptionFromRow,
    liveReasoningOptionFromRow,
    desktopRawLabel,
    dynamicInteractiveControl,
    menuSessionRows,
    createPluginMenuSession,
    withPermissionOptionCurrent,
    controlOptionsSignature,
    preserveStructuredControlOptions,
    controlTargetForOption,
    resolveStructuredControlTarget,
    sameControlTarget,
    withOptionCurrent,
    watcherCurrentControlOption,
    desktopWatchSignature,
    desktopWatchSignatureParts,
    desktopIndexWatchSignature,
    desktopWatchEventCoalesceKey,
    createDesktopWatchEventQueue,
    createDesktopWatchTelemetry,
    queueDirectSignature,
    queueItemIDFromTarget,
    detailSnapshotFromDesktopWatch,
    desktopConversationTitle,
    isNewDirectThreadID,
    resolveStartedThreadIDAfterSend,
    anonymousDraftFingerprint,
    isReplaceableAnonymousDraft,
    waitForFreshCodexDraft,
    isCurrentAnonymousMobileDraft,
    rememberControlCreatedSurface,
    interactiveSurfaceForForeground,
    rolloutContainsVisibilityMarker,
    runtimeWithLiveQueue,
    controlsRuntimeFromDesktopSnapshot,
    mergeSparseObject,
    rateLimitForWindow,
    fiveHourRateLimit,
    weeklyRateLimit,
    accountUsageSummary,
    planModeDetailFromRuntime,
    goalDetailFromRuntime,
    booleanControlTarget,
    objectiveControlTarget,
  },
};
