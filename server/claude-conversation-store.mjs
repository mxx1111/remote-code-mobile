import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const MESSAGE_STATUSES = new Set(["running", "completed", "failed", "stopped"]);
const RESTART_NOTE = "[服务已重启，无法继续跟踪这次运行，请重新发送任务。]";

function cloneMessages(messages) {
  return messages.map((message) => ({ ...message }));
}

function normalizeMessage(value) {
  if (!value || typeof value !== "object") return null;
  if (value.role !== "user" && value.role !== "assistant") return null;
  if (typeof value.id !== "string" || !value.id) return null;
  if (typeof value.content !== "string") return null;

  const message = {
    content: value.content,
    id: value.id,
    mode: "claude",
    role: value.role,
  };

  if (typeof value.createdAt === "number") message.createdAt = value.createdAt;
  if (typeof value.updatedAt === "number") message.updatedAt = value.updatedAt;
  if (typeof value.runId === "string" && value.runId) message.runId = value.runId;
  if (typeof value.turnId === "string" && value.turnId) message.turnId = value.turnId;
  if (MESSAGE_STATUSES.has(value.status)) message.status = value.status;
  if (typeof value.exitCode === "number" || value.exitCode === null) {
    message.exitCode = value.exitCode;
  }
  if (typeof value.streaming === "boolean") message.streaming = value.streaming;
  return message;
}

function messageStatus(run) {
  if (run.running) return "running";
  if (run.interrupted) return "stopped";
  return run.exitCode === 0 ? "completed" : "failed";
}

function runContent(run) {
  if (run.output) return run.output;
  if (run.running) return "Claude 正在思考…";
  return run.exitCode === 0
    ? "Claude 已完成，但没有返回文本。"
    : "Claude 执行失败，没有返回文本。";
}

export function createClaudeConversationStore({
  filePath,
  flushDelayMs = 250,
  maxMessages = 400,
}) {
  const projects = new Map();
  let flushTimer = null;
  let recoveredStaleRun = false;

  mkdirSync(dirname(filePath), { recursive: true });

  try {
    const stored = JSON.parse(readFileSync(filePath, "utf8"));
    for (const [projectId, project] of Object.entries(stored.projects ?? {})) {
      if (!project || typeof project !== "object" || !Array.isArray(project.messages)) continue;

      let projectRecovered = false;
      const messages = project.messages
        .map(normalizeMessage)
        .filter(Boolean)
        .slice(-maxMessages);
      for (const message of messages) {
        if (message.role !== "assistant" || (message.status !== "running" && !message.streaming)) {
          continue;
        }
        message.content = message.content
          ? `${message.content}\n\n${RESTART_NOTE}`
          : RESTART_NOTE;
        message.exitCode = 130;
        message.status = "stopped";
        message.streaming = false;
        message.updatedAt = Date.now();
        projectRecovered = true;
        recoveredStaleRun = true;
      }

      projects.set(projectId, {
        messages,
        updatedAt: projectRecovered || typeof project.updatedAt !== "number"
          ? Date.now()
          : project.updatedAt,
      });
    }
  } catch {
    // Missing or incomplete state starts with an empty local conversation store.
  }

  function serializedState() {
    return {
      projects: Object.fromEntries(projects),
      version: 1,
    };
  }

  function persistNow() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(serializedState(), null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(temporaryPath, filePath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }

  function schedulePersist() {
    if (flushTimer) return;
    flushTimer = setTimeout(persistNow, flushDelayMs);
    flushTimer.unref();
  }

  function projectState(projectId) {
    let project = projects.get(projectId);
    if (!project) {
      project = { messages: [], updatedAt: Date.now() };
      projects.set(projectId, project);
    }
    return project;
  }

  function beginTurn(projectId, { prompt, runId, turnId }) {
    const now = Date.now();
    const project = projectState(projectId);
    const userMessageId = `${turnId}-user`;
    const assistantMessageId = `${turnId}-assistant`;
    project.messages = project.messages.filter(
      (message) => message.id !== userMessageId && message.id !== assistantMessageId,
    );
    project.messages.push(
      {
        content: prompt,
        createdAt: now,
        id: userMessageId,
        mode: "claude",
        role: "user",
        turnId,
      },
      {
        content: "正在连接 Claude…",
        createdAt: now,
        exitCode: null,
        id: assistantMessageId,
        mode: "claude",
        role: "assistant",
        runId,
        status: "running",
        streaming: true,
        turnId,
        updatedAt: now,
      },
    );
    project.messages = project.messages.slice(-maxMessages);
    project.updatedAt = now;
    persistNow();
    return { assistantMessageId, userMessageId };
  }

  function updateRun(projectId, run, { final = false } = {}) {
    const project = projects.get(projectId);
    if (!project) return;

    const assistant = project.messages.find(
      (message) => message.id === run.assistantMessageId || message.runId === run.id,
    );
    if (!assistant) return;

    const now = Date.now();
    assistant.content = runContent(run);
    assistant.exitCode = run.exitCode;
    assistant.runId = run.id;
    assistant.status = messageStatus(run);
    assistant.streaming = run.running;
    assistant.updatedAt = now;
    project.updatedAt = now;
    if (final || !run.running) persistNow();
    else schedulePersist();
  }

  function snapshot(projectId) {
    const project = projects.get(projectId);
    return {
      messages: project ? cloneMessages(project.messages) : [],
      updatedAt: project?.updatedAt ?? null,
    };
  }

  function reset(projectId) {
    projects.delete(projectId);
    persistNow();
  }

  if (recoveredStaleRun) persistNow();

  return {
    beginTurn,
    flush: persistNow,
    reset,
    snapshot,
    updateRun,
  };
}
