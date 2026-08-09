import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { hostname as systemHostname } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createClaudeConversationStore } from "./claude-conversation-store.mjs";
import { createProjectCatalog } from "./project-catalog.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const staticRoot = join(projectRoot, "dist-spa");
const stateRoot = resolve(process.env.REMOTE_SHELL_STATE_ROOT ?? join(projectRoot, ".runtime"));
const runtimeRoot = join(stateRoot, "commands");
const codexSessionPath = join(stateRoot, "codex-sessions.json");
const claudeSessionPath = join(stateRoot, "claude-sessions.json");
const claudeConversationPath = join(stateRoot, "claude-conversations.json");

function readPort(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

const host = process.env.REMOTE_SHELL_HOST ?? "127.0.0.1";
const port = readPort(process.env.REMOTE_SHELL_PORT, 3001);
const terminalPublicPort = readPort(
  process.env.REMOTE_SHELL_TTYD_PUBLIC_PORT ?? process.env.REMOTE_SHELL_TTYD_PORT,
  7681,
);
const tmuxBin = process.env.REMOTE_SHELL_TMUX ??
  (existsSync("/opt/homebrew/bin/tmux") ? "/opt/homebrew/bin/tmux" : "tmux");
const codexBin = process.env.REMOTE_SHELL_CODEX ??
  (existsSync("/opt/homebrew/bin/codex") ? "/opt/homebrew/bin/codex" : "codex");
const defaultClaudeBin = process.env.HOME ? join(process.env.HOME, ".local", "bin", "claude") : "";
const claudeBin = process.env.REMOTE_SHELL_CLAUDE ??
  (defaultClaudeBin && existsSync(defaultClaudeBin) ? defaultClaudeBin : "claude");
const projectsRoot = resolve(process.env.REMOTE_SHELL_PROJECTS_ROOT ?? resolve(projectRoot, ".."));
const workspaceSession = process.env.REMOTE_SHELL_WORKSPACE_SESSION ?? "remote-shell-mobile";
const projectCatalog = createProjectCatalog({
  machineName: process.env.REMOTE_SHELL_MACHINE_NAME ?? systemHostname(),
  rootPath: projectsRoot,
  sessionName: workspaceSession,
});

const terminalKeys = new Map([
  ["escape", "Escape"],
  ["tab", "Tab"],
  ["shift-tab", "BTab"],
  ["ctrl-c", "C-c"],
  ["up", "Up"],
  ["down", "Down"],
  ["clear", "C-l"],
]);

const claudePermissionModes = new Set(["manual", "acceptEdits", "plan", "auto"]);

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const runs = new Map();
const activeRuns = new Map();
const codexSessions = new Map();
const claudeSessions = new Map();
const claudeConversations = createClaudeConversationStore({ filePath: claudeConversationPath });

mkdirSync(runtimeRoot, { recursive: true });

try {
  const storedSessions = JSON.parse(readFileSync(codexSessionPath, "utf8"));
  for (const [projectId, threadId] of Object.entries(storedSessions)) {
    if (typeof threadId === "string" && threadId) codexSessions.set(projectId, threadId);
  }
} catch {
  // A missing or incomplete runtime session file simply starts a fresh Codex thread.
}

try {
  const storedSessions = JSON.parse(readFileSync(claudeSessionPath, "utf8"));
  for (const [projectId, sessionId] of Object.entries(storedSessions)) {
    if (typeof sessionId === "string" && sessionId) claudeSessions.set(projectId, sessionId);
  }
} catch {
  // A missing or incomplete runtime session file simply starts a fresh Claude session.
}

function json(res, statusCode, value) {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function noContent(res) {
  res.writeHead(204, { "Cache-Control": "no-store" });
  res.end();
}

function tmux(args, { allowFailure = false } = {}) {
  const result = spawnSync(tmuxBin, args, {
    encoding: "utf8",
    timeout: 5_000,
  });

  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error((result.stderr || `tmux exited with ${result.status}`).trim());
  }

  return {
    ok: result.status === 0,
    stderr: (result.stderr ?? "").trim(),
    stdout: result.stdout ?? "",
  };
}

function hasSession(project) {
  return tmux(["has-session", "-t", project.session], { allowFailure: true }).ok;
}

function projectTarget(project) {
  return `${project.session}:${project.windowName}`;
}

function ensureProjectTerminal(project) {
  if (!hasSession(project)) {
    tmux([
      "new-session",
      "-d",
      "-s",
      project.session,
      "-n",
      project.windowName,
      "-c",
      project.cwd,
    ]);
  } else {
    const windows = tmux([
      "list-windows",
      "-t",
      project.session,
      "-F",
      "#{window_name}",
    ]).stdout.split("\n");
    if (!windows.includes(project.windowName)) {
      tmux([
        "new-window",
        "-d",
        "-t",
        project.session,
        "-n",
        project.windowName,
        "-c",
        project.cwd,
      ]);
    }
  }
  tmux(["set-option", "-w", "-t", projectTarget(project), "history-limit", "10000"], {
    allowFailure: true,
  });
  return projectTarget(project);
}

function activateProjectTerminal(project) {
  const target = ensureProjectTerminal(project);
  tmux(["select-window", "-t", target]);
  return target;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function persistCodexSessions() {
  writeFileSync(
    codexSessionPath,
    `${JSON.stringify(Object.fromEntries(codexSessions), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function persistClaudeSessions() {
  writeFileSync(
    claudeSessionPath,
    `${JSON.stringify(Object.fromEntries(claudeSessions), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function publicRun(run) {
  return {
    activity: run.activity ?? "",
    assistantMessageId: run.assistantMessageId ?? null,
    exitCode: run.exitCode,
    id: run.id,
    interrupted: run.interrupted,
    mode: run.mode,
    output: run.output,
    permissionMode: run.permissionMode ?? null,
    running: run.running,
    turnId: run.turnId ?? null,
    updatedAt: run.updatedAt,
    userMessageId: run.userMessageId ?? null,
    usage: run.usage ?? null,
  };
}

function finishRun(run, exitCode, output = run.output) {
  if (!run.running) return;

  run.exitCode = exitCode;
  run.output = output;
  run.running = false;
  run.updatedAt = Date.now();
  activeRuns.delete(run.projectId);

  if (run.mode === "claude") {
    claudeConversations.updateRun(run.projectId, run, { final: true });
  }

  if (run.mode === "shell") {
    tmux(["kill-window", "-t", run.windowId], { allowFailure: true });
    rmSync(run.scriptPath, { force: true });
  }
  run.child = null;
}

function refreshRun(run) {
  if (!run.running) return run;
  if (run.mode !== "shell") return run;

  const capture = tmux(
    ["capture-pane", "-p", "-t", run.paneId, "-S", "-"],
    { allowFailure: true },
  );

  if (!capture.ok) {
    const suffix = run.interrupted ? "\n\n[任务已停止]" : "\n\n[终端窗口已结束]";
    finishRun(run, run.interrupted ? 130 : 1, `${run.output}${suffix}`.trim());
    return run;
  }

  const normalized = capture.stdout.replaceAll("\r", "");
  const marker = `${run.marker}:`;
  const markerIndex = normalized.lastIndexOf(marker);

  if (markerIndex === -1) {
    run.output = normalized.replace(/\n+$/u, "");
    run.updatedAt = Date.now();
    return run;
  }

  const statusMatch = normalized.slice(markerIndex + marker.length).match(/^(-?\d+)/u);
  const exitCode = statusMatch ? Number(statusMatch[1]) : 1;
  const output = normalized.slice(0, markerIndex).replace(/\n+$/u, "");
  finishRun(run, exitCode, output);
  return run;
}

function assertProjectIdle(projectId) {
  const existingId = activeRuns.get(projectId);
  if (existingId) {
    const existing = runs.get(existingId);
    if (existing?.running) {
      const error = new Error("当前项目已有命令正在运行");
      error.statusCode = 409;
      throw error;
    }
  }
}

function createShellRun(projectId, project, command) {
  assertProjectIdle(projectId);
  ensureProjectTerminal(project);

  const id = randomUUID().replaceAll("-", "").slice(0, 14);
  const marker = `__REMOTE_MOBILE_DONE_${id}__`;
  const scriptPath = join(runtimeRoot, `${id}.zsh`);
  writeFileSync(scriptPath, `${command}\n`, { encoding: "utf8", mode: 0o600 });

  const wrapper = [
    `/bin/zsh ${shellQuote(scriptPath)}`,
    "__remote_status=$?",
    `printf '\\n${marker}:%s\\n' "$__remote_status"`,
    "exec /bin/sleep 86400",
  ].join("; ");

  let windowId;
  let paneId;
  try {
    const created = tmux([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{window_id}|#{pane_id}",
      "-t",
      project.session,
      "-n",
      `chat-${id.slice(0, 6)}`,
      "-c",
      project.cwd,
      wrapper,
    ]).stdout.trim();
    [windowId, paneId] = created.split("|");
    if (!windowId || !paneId) throw new Error("无法取得 tmux 窗口信息");
    tmux(["set-option", "-w", "-t", windowId, "history-limit", "10000"], {
      allowFailure: true,
    });
  } catch (error) {
    rmSync(scriptPath, { force: true });
    if (windowId) tmux(["kill-window", "-t", windowId], { allowFailure: true });
    throw error;
  }

  const run = {
    activity: "正在接收终端输出",
    exitCode: null,
    id,
    interrupted: false,
    marker,
    mode: "shell",
    output: "",
    paneId,
    projectId,
    running: true,
    scriptPath,
    updatedAt: Date.now(),
    windowId,
  };
  runs.set(id, run);
  activeRuns.set(projectId, id);
  return refreshRun(run);
}

function compactActivity(value, limit = 72) {
  const text = Array.isArray(value) ? value.join(" ") : String(value ?? "");
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function appendCodexMessage(run, text) {
  const value = String(text ?? "").trim();
  if (!value) return;
  run.output = run.output ? `${run.output}\n\n${value}` : value;
}

function handleCodexEvent(run, event) {
  if (!event || typeof event !== "object") return;

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    run.threadId = event.thread_id;
    codexSessions.set(run.projectId, event.thread_id);
    persistCodexSessions();
    run.activity = "Codex 会话已连接";
  } else if (event.type === "turn.started") {
    run.activity = "Codex 正在分析";
  } else if (event.type === "item.started" || event.type === "item.updated") {
    const item = event.item ?? {};
    if (item.type === "command_execution") {
      run.activity = `正在执行：${compactActivity(item.command) || "项目命令"}`;
    } else if (item.type === "mcp_tool_call") {
      run.activity = `正在调用：${compactActivity(item.tool_name ?? item.name) || "工具"}`;
    } else if (item.type === "web_search") {
      run.activity = "正在搜索资料";
    } else if (item.type === "reasoning") {
      run.activity = "Codex 正在思考";
    }
  } else if (event.type === "item.completed") {
    const item = event.item ?? {};
    if (item.type === "agent_message") {
      appendCodexMessage(run, item.text);
      run.activity = "正在整理回复";
    } else if (item.type === "command_execution") {
      const command = compactActivity(item.command);
      run.activity = item.exit_code === 0
        ? `${command || "项目命令"} · 已完成`
        : `${command || "项目命令"} · 退出码 ${item.exit_code ?? 1}`;
    } else if (item.type === "error" && item.message) {
      run.lastError = String(item.message);
    }
  } else if (event.type === "turn.completed") {
    run.usage = event.usage ?? null;
    run.activity = "Codex 已完成";
  } else if (event.type === "turn.failed" || event.type === "error") {
    run.lastError = String(event.message ?? event.error?.message ?? "Codex 执行失败");
  }

  run.updatedAt = Date.now();
}

function consumeCodexOutput(run, chunk, flush = false) {
  run.stdoutBuffer += chunk;
  const lines = run.stdoutBuffer.split("\n");
  const remainder = lines.pop() ?? "";
  run.stdoutBuffer = flush ? "" : remainder;

  for (const line of lines) {
    const value = line.trim();
    if (!value) continue;
    try {
      handleCodexEvent(run, JSON.parse(value));
    } catch {
      run.stderr = `${run.stderr}\n${value}`.slice(-16_000);
    }
  }

  if (flush && remainder.trim()) {
    try {
      handleCodexEvent(run, JSON.parse(remainder.trim()));
    } catch {
      run.stderr = `${run.stderr}\n${remainder}`.slice(-16_000);
    }
  }
}

function createCodexRun(projectId, project, prompt) {
  assertProjectIdle(projectId);

  const id = randomUUID().replaceAll("-", "").slice(0, 14);
  const threadId = codexSessions.get(projectId) ?? null;
  const args = threadId
    ? ["exec", "resume", "--json", threadId, prompt]
    : [
        "exec",
        "--json",
        "--color",
        "never",
        "-s",
        "workspace-write",
        "-C",
        project.cwd,
        prompt,
      ];

  const run = {
    activity: threadId ? "正在恢复 Codex 会话" : "正在启动 Codex",
    child: null,
    exitCode: null,
    id,
    interrupted: false,
    lastError: "",
    mode: "codex",
    output: "",
    projectId,
    running: true,
    stderr: "",
    stdoutBuffer: "",
    threadId,
    updatedAt: Date.now(),
    usage: null,
  };

  runs.set(id, run);
  activeRuns.set(projectId, id);

  const child = spawn(codexBin, args, {
    cwd: project.cwd,
    detached: true,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  run.child = child;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => consumeCodexOutput(run, chunk));
  child.stderr.on("data", (chunk) => {
    run.stderr = `${run.stderr}${chunk}`.slice(-16_000);
    run.updatedAt = Date.now();
  });
  child.on("error", (error) => {
    run.lastError = error.message;
    finishRun(run, 1, `无法启动 Codex：${error.message}`);
  });
  child.on("close", (code) => {
    consumeCodexOutput(run, "", true);
    if (!run.running) return;

    if (run.interrupted) {
      finishRun(run, 130, `${run.output}\n\n[任务已停止]`.trim());
      return;
    }

    const exitCode = typeof code === "number" ? code : 1;
    if (exitCode === 0) {
      finishRun(run, 0, run.output || "Codex 已完成，但没有返回文本。");
      return;
    }

    const stderrLine = run.stderr.trim().split("\n").filter(Boolean).at(-1) ?? "";
    const errorText = run.lastError || stderrLine || `Codex 已退出，退出码 ${exitCode}`;
    finishRun(run, exitCode, run.output ? `${run.output}\n\n${errorText}` : errorText);
  });

  return run;
}

function rememberClaudeSession(run, sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return;
  run.sessionId = sessionId;
  claudeSessions.set(run.projectId, sessionId);
  persistClaudeSessions();
}

function handleClaudeEvent(run, event) {
  if (!event || typeof event !== "object") return;

  if (event.session_id) rememberClaudeSession(run, event.session_id);

  if (event.type === "system") {
    if (event.subtype === "init") run.activity = "Claude 会话已连接";
  } else if (event.type === "stream_event") {
    const streamEvent = event.event ?? {};
    const delta = streamEvent.delta ?? {};
    if (streamEvent.type === "content_block_start" && streamEvent.content_block?.type === "tool_use") {
      run.activity = `正在调用：${compactActivity(streamEvent.content_block.name) || "工具"}`;
    } else if (delta.type === "text_delta" && typeof delta.text === "string") {
      run.partialOutput += delta.text;
      run.output = run.partialOutput;
      run.activity = "Claude 正在回复";
    } else if (delta.type === "thinking_delta") {
      run.activity = "Claude 正在思考";
    }
  } else if (event.type === "assistant") {
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    const text = blocks
      .filter((block) => block?.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    const tool = blocks.find((block) => block?.type === "tool_use");
    if (!run.partialOutput && text) run.output = text;
    if (tool) run.activity = `正在调用：${compactActivity(tool.name) || "工具"}`;
  } else if (event.type === "user") {
    run.activity = "Claude 已收到工具结果";
  } else if (event.type === "result") {
    if (typeof event.result === "string" && event.result.trim()) run.output = event.result.trim();
    run.usage = event.usage ?? null;
    run.activity = event.is_error ? "Claude 执行失败" : "Claude 已完成";
    if (event.is_error) run.lastError = String(event.result ?? event.error ?? "Claude 执行失败");
  }

  run.updatedAt = Date.now();
  claudeConversations.updateRun(run.projectId, run);
}

function consumeClaudeOutput(run, chunk, flush = false) {
  run.stdoutBuffer += chunk;
  const lines = run.stdoutBuffer.split("\n");
  const remainder = lines.pop() ?? "";
  run.stdoutBuffer = flush ? "" : remainder;

  for (const line of lines) {
    const value = line.trim();
    if (!value) continue;
    try {
      handleClaudeEvent(run, JSON.parse(value));
    } catch {
      run.stderr = `${run.stderr}\n${value}`.slice(-16_000);
    }
  }

  if (flush && remainder.trim()) {
    try {
      handleClaudeEvent(run, JSON.parse(remainder.trim()));
    } catch {
      run.stderr = `${run.stderr}\n${remainder}`.slice(-16_000);
    }
  }
}

function createClaudeRun(projectId, project, prompt, requestedTurnId, requestedPermissionMode) {
  assertProjectIdle(projectId);

  const id = randomUUID().replaceAll("-", "").slice(0, 14);
  const turnId = typeof requestedTurnId === "string" && /^[a-z0-9_-]{1,96}$/iu.test(requestedTurnId)
    ? requestedTurnId
    : `claude-turn-${id}`;
  const messageIds = claudeConversations.beginTurn(projectId, {
    prompt,
    runId: id,
    turnId,
  });
  const storedSessionId = claudeSessions.get(projectId) ?? null;
  const requestedSessionId = storedSessionId ?? randomUUID();
  const permissionMode = claudePermissionModes.has(requestedPermissionMode)
    ? requestedPermissionMode
    : "auto";
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode",
    permissionMode,
    "--prompt-suggestions",
    "false",
    storedSessionId ? "--resume" : "--session-id",
    requestedSessionId,
    prompt,
  ];

  const run = {
    activity: storedSessionId ? "正在恢复 Claude 会话" : "正在启动 Claude",
    assistantMessageId: messageIds.assistantMessageId,
    child: null,
    exitCode: null,
    id,
    interrupted: false,
    lastError: "",
    mode: "claude",
    output: "",
    partialOutput: "",
    permissionMode,
    projectId,
    running: true,
    sessionId: storedSessionId,
    stderr: "",
    stdoutBuffer: "",
    turnId,
    updatedAt: Date.now(),
    usage: null,
    userMessageId: messageIds.userMessageId,
  };

  runs.set(id, run);
  activeRuns.set(projectId, id);

  const child = spawn(claudeBin, args, {
    cwd: project.cwd,
    detached: true,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  run.child = child;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => consumeClaudeOutput(run, chunk));
  child.stderr.on("data", (chunk) => {
    run.stderr = `${run.stderr}${chunk}`.slice(-16_000);
    run.updatedAt = Date.now();
  });
  child.on("error", (error) => {
    run.lastError = error.message;
    finishRun(run, 1, `无法启动 Claude：${error.message}`);
  });
  child.on("close", (code) => {
    consumeClaudeOutput(run, "", true);
    if (!run.running) return;

    if (run.interrupted) {
      finishRun(run, 130, `${run.output}\n\n[任务已停止]`.trim());
      return;
    }

    const exitCode = typeof code === "number" ? code : 1;
    if (exitCode === 0 && !run.lastError) {
      finishRun(run, 0, run.output || "Claude 已完成，但没有返回文本。");
      return;
    }

    const stderrLine = run.stderr.trim().split("\n").filter(Boolean).at(-1) ?? "";
    const errorText = run.lastError || stderrLine || `Claude 已退出，退出码 ${exitCode}`;
    finishRun(run, exitCode || 1, run.output ? `${run.output}\n\n${errorText}` : errorText);
  });

  return run;
}

function interruptRun(run) {
  refreshRun(run);
  if (!run.running) return run;

  run.interrupted = true;
  if (run.mode !== "shell") {
    try {
      if (run.child?.pid) process.kill(-run.child.pid, "SIGINT");
    } catch {
      finishRun(run, 130, `${run.output}\n\n[任务已停止]`.trim());
      return run;
    }

    setTimeout(() => {
      if (!run.running) return;
      try {
        if (run.child?.pid) process.kill(-run.child.pid, "SIGTERM");
      } catch {
        // The process may have already ended between the running check and signal.
      }
    }, 1_500).unref();
    setTimeout(() => {
      if (run.running) finishRun(run, 130, `${run.output}\n\n[任务已停止]`.trim());
    }, 3_000).unref();
    return run;
  }

  tmux(["send-keys", "-t", run.paneId, "C-c"], { allowFailure: true });

  setTimeout(() => {
    refreshRun(run);
    if (run.running) {
      const output = `${run.output}\n\n[任务已停止]`.trim();
      finishRun(run, 130, output);
    }
  }, 1_500).unref();

  return run;
}

function readJson(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        rejectBody(Object.assign(new Error("请求内容过大"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch {
        rejectBody(Object.assign(new Error("JSON 格式不正确"), { statusCode: 400 }));
      }
    });
    req.on("error", rejectBody);
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;

  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function sendSse(res, event, value) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(value)}\n\n`);
}

function streamRun(req, res, run) {
  res.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  let lastPayload = "";
  const push = () => {
    refreshRun(run);
    const value = publicRun(run);
    const payload = JSON.stringify(value);
    if (payload !== lastPayload) {
      sendSse(res, "output", value);
      lastPayload = payload;
    }
    if (!run.running) {
      sendSse(res, "done", value);
      clearInterval(timer);
      res.end();
    }
  };

  const timer = setInterval(push, 180);
  timer.unref();
  push();

  req.on("close", () => clearInterval(timer));
}

function projectFor(projectId) {
  return projectCatalog.get(projectId);
}

function publicProject(project) {
  const run = runs.get(activeRuns.get(project.id));
  return {
    activity: run?.running ? run.activity : project.activity,
    branch: project.branch,
    color: project.color,
    connected: true,
    id: project.id,
    machine: project.machine,
    name: project.name,
    path: project.path,
    shortName: project.shortName,
    status: run?.running ? "running" : "idle",
  };
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/projects" && req.method === "GET") {
    const refresh = url.searchParams.get("refresh") === "1";
    const availableProjects = projectCatalog.list({ refresh });
    json(res, 200, {
      projects: availableProjects.map(publicProject),
      root: projectCatalog.rootLabel,
      terminalPort: terminalPublicPort,
    });
    return true;
  }

  if (url.pathname === "/api/health" && req.method === "GET") {
    const availableProjects = projectCatalog.list();
    const projectStates = Object.fromEntries(
      availableProjects.map((project) => [project.id, {
        connected: true,
        running: Boolean(runs.get(activeRuns.get(project.id))?.running),
      }]),
    );
    json(res, 200, { ok: true, projectRoot: projectCatalog.rootLabel, projects: projectStates });
    return true;
  }

  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method ?? "") && !sameOrigin(req)) {
    json(res, 403, { error: "请求来源不匹配" });
    return true;
  }

  const resetSessionMatch = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/agents\/([^/]+)\/session$/u,
  );
  if (resetSessionMatch && req.method === "DELETE") {
    const projectId = decodeURIComponent(resetSessionMatch[1]);
    const mode = decodeURIComponent(resetSessionMatch[2]).toLowerCase();
    if (!projectFor(projectId)) {
      json(res, 404, { error: "这个项目还没有接入对话终端" });
      return true;
    }
    if (mode !== "codex" && mode !== "claude") {
      json(res, 400, { error: "只能退出 Codex 或 Claude 会话" });
      return true;
    }

    const activeRun = runs.get(activeRuns.get(projectId));
    if (activeRun?.running) {
      json(res, 409, { error: "请先停止当前任务，再退出会话" });
      return true;
    }

    if (mode === "codex") {
      codexSessions.delete(projectId);
      persistCodexSessions();
    } else {
      claudeSessions.delete(projectId);
      persistClaudeSessions();
      claudeConversations.reset(projectId);
    }
    noContent(res);
    return true;
  }

  const claudeConversationMatch = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/conversations\/claude$/u,
  );
  if (claudeConversationMatch && req.method === "GET") {
    const projectId = decodeURIComponent(claudeConversationMatch[1]);
    if (!projectFor(projectId)) {
      json(res, 404, { error: "这个项目还没有接入对话终端" });
      return true;
    }

    const activeRun = runs.get(activeRuns.get(projectId));
    const snapshot = claudeConversations.snapshot(projectId);
    json(res, 200, {
      activeRun: activeRun?.running && activeRun.mode === "claude" ? publicRun(activeRun) : null,
      hasSession: claudeSessions.has(projectId),
      messages: snapshot.messages,
      updatedAt: snapshot.updatedAt,
    });
    return true;
  }

  const createMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/runs$/u);
  if (createMatch && req.method === "POST") {
    const projectId = decodeURIComponent(createMatch[1]);
    const project = projectFor(projectId);
    if (!project) {
      json(res, 404, { error: "这个项目还没有接入对话终端" });
      return true;
    }

    const body = await readJson(req);
    const command = typeof body.command === "string" ? body.command.trim() : "";
    const mode = body.mode === "codex" || body.mode === "claude" ? body.mode : "shell";
    const permissionMode = body.permissionMode ?? "auto";
    if (mode === "claude" && !claudePermissionModes.has(permissionMode)) {
      json(res, 400, { error: "不支持这个 Claude 权限模式" });
      return true;
    }
    if (!command) {
      const emptyMessage = mode === "codex"
        ? "请输入要交给 Codex 的内容"
        : mode === "claude"
          ? "请输入要交给 Claude 的内容"
          : "请输入 Shell 命令";
      json(res, 400, { error: emptyMessage });
      return true;
    }
    if (command.length > 32_000) {
      json(res, 413, { error: "命令过长" });
      return true;
    }

    if (mode === "shell" && /^(?:codex|claude)(?:\s|$)/iu.test(command)) {
      json(res, 409, { error: "请使用 Codex 或 Claude 对话模式，不要在消息中启动交互式 TUI" });
      return true;
    }

    const run = mode === "codex"
      ? createCodexRun(projectId, project, command)
      : mode === "claude"
        ? createClaudeRun(projectId, project, command, body.turnId, permissionMode)
        : createShellRun(projectId, project, command);
    json(res, 201, publicRun(run));
    return true;
  }

  const runMatch = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/runs\/([^/]+)(\/events|\/interrupt)?$/u,
  );
  if (runMatch) {
    const projectId = decodeURIComponent(runMatch[1]);
    const run = runs.get(runMatch[2]);
    if (!run || run.projectId !== projectId) {
      json(res, 404, { error: "找不到这次任务" });
      return true;
    }

    if (runMatch[3] === "/events" && req.method === "GET") {
      streamRun(req, res, run);
      return true;
    }
    if (runMatch[3] === "/interrupt" && req.method === "POST") {
      json(res, 202, publicRun(interruptRun(run)));
      return true;
    }
    if (!runMatch[3] && req.method === "GET") {
      json(res, 200, publicRun(refreshRun(run)));
      return true;
    }
  }

  const keyMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/terminal\/keys$/u);
  if (keyMatch && req.method === "POST") {
    const projectId = decodeURIComponent(keyMatch[1]);
    const project = projectFor(projectId);
    if (!project) {
      json(res, 404, { error: "这个项目不在允许访问的目录中" });
      return true;
    }

    ensureProjectTerminal(project);
    const body = await readJson(req);
    const tmuxKey = terminalKeys.get(body.key);
    if (!tmuxKey) {
      json(res, 400, { error: "不支持这个终端按键" });
      return true;
    }
    tmux(["send-keys", "-t", projectTarget(project), tmuxKey]);
    noContent(res);
    return true;
  }

  const activateTerminalMatch = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/terminal\/activate$/u,
  );
  if (activateTerminalMatch && req.method === "POST") {
    const projectId = decodeURIComponent(activateTerminalMatch[1]);
    const project = projectFor(projectId);
    if (!project) {
      json(res, 404, { error: "这个项目不在允许访问的目录中" });
      return true;
    }
    activateProjectTerminal(project);
    noContent(res);
    return true;
  }

  return false;
}

function serveStatic(req, res, url) {
  if (!existsSync(staticRoot)) {
    json(res, 503, { error: "页面尚未构建" });
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    json(res, 400, { error: "地址格式不正确" });
    return;
  }

  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = normalize(join(staticRoot, relativePath));
  const insideStaticRoot = candidate === staticRoot || candidate.startsWith(`${staticRoot}${sep}`);
  const filePath = insideStaticRoot && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(staticRoot, "index.html");
  const body = readFileSync(filePath);

  res.writeHead(200, {
    "Cache-Control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
    "Content-Length": body.length,
    "Content-Type": mimeTypes.get(extname(filePath)) ?? "application/octet-stream",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") res.end();
  else res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url);
      if (!handled) json(res, 404, { error: "接口不存在" });
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      json(res, 405, { error: "请求方法不支持" });
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    const statusCode = Number(error.statusCode) || 500;
    json(res, statusCode, {
      error: statusCode >= 500 ? `终端服务错误：${error.message}` : error.message,
    });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Remote Shell ready on http://${host}:${port}\n`);
});
