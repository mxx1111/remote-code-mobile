"use client";

import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Project = {
  id: string;
  name: string;
  shortName: string;
  machine: string;
  path: string;
  branch: string;
  activity: string;
  status: "running" | "idle" | "offline";
  color: string;
  connected: boolean;
};

type MessageStatus = "running" | "completed" | "failed" | "stopped";
type ChatMode = "shell" | "codex" | "claude";
type ClaudePermissionMode = "manual" | "acceptEdits" | "plan" | "auto";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: number;
  output?: boolean;
  runId?: string;
  mode?: ChatMode;
  status?: MessageStatus;
  exitCode?: number | null;
  streaming?: boolean;
  turnId?: string;
  updatedAt?: number;
};

type ServerRun = {
  activity: string;
  assistantMessageId?: string | null;
  id: string;
  mode: ChatMode;
  output: string;
  permissionMode?: ClaudePermissionMode | null;
  running: boolean;
  interrupted: boolean;
  exitCode: number | null;
  turnId?: string | null;
  updatedAt?: number;
  userMessageId?: string | null;
};

type ClaudeConversationSnapshot = {
  activeRun: ServerRun | null;
  hasSession: boolean;
  messages: ChatMessage[];
  updatedAt: number | null;
};

type ProjectCatalogResponse = {
  projects: Project[];
  root: string;
  terminalPort: number;
};

type MessagesByMode = Record<ChatMode, ChatMessage[]>;
type MessagesByProject = Record<string, MessagesByMode>;

const FALLBACK_PROJECT: Project = {
  activity: "正在连接",
  branch: "loading",
  color: "violet",
  connected: false,
  id: "__loading__",
  machine: "This Mac",
  name: "正在读取项目",
  path: "~/Projects",
  shortName: "RS",
  status: "offline",
};

const PINNED_PROJECTS_KEY = "remote-shell-pinned-projects";
const SELECTED_PROJECT_KEY = "remote-shell-selected-project";
const CLAUDE_PERMISSION_MODE_KEY = "remote-shell-claude-permission-mode";
const CLAUDE_PERMISSION_MODES: Array<{
  label: string;
  value: ClaudePermissionMode;
}> = [
  { label: "Manual", value: "manual" },
  { label: "Edits", value: "acceptEdits" },
  { label: "Plan", value: "plan" },
  { label: "Auto", value: "auto" },
];

function isClaudePermissionMode(value: string | null): value is ClaudePermissionMode {
  return CLAUDE_PERMISSION_MODES.some((mode) => mode.value === value);
}

async function fetchProjectCatalog(refresh = false): Promise<ProjectCatalogResponse> {
  const response = await fetch(`/api/projects${refresh ? "?refresh=1" : ""}`);
  const payload = await response.json() as ProjectCatalogResponse | { error?: string };
  if (!response.ok || !("projects" in payload)) {
    throw new Error("error" in payload && payload.error ? payload.error : "无法读取 Mac 项目");
  }
  return payload;
}

async function fetchClaudeConversation(
  projectId: string,
  signal?: AbortSignal,
): Promise<ClaudeConversationSnapshot> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/conversations/claude`,
    { signal },
  );
  const payload = await response.json() as ClaudeConversationSnapshot | { error?: string };
  if (!response.ok || !("messages" in payload)) {
    throw new Error("error" in payload && payload.error ? payload.error : "无法恢复 Claude 对话");
  }
  return payload;
}

function initialMessagesForMode(mode: ChatMode): ChatMessage[] {
  if (mode === "codex") {
    return [
      {
        id: "codex-ready",
        role: "assistant",
        mode,
        content: "Codex 独立会话已就绪。这里只显示 Codex 的对话；输入 claude 或 shell 可以切换工作方式。",
      },
    ];
  }
  if (mode === "claude") {
    return [
      {
        id: "claude-ready",
        role: "assistant",
        mode,
        content: "Claude 独立会话已就绪。这里只显示 Claude 的对话；输入 codex 或 shell 可以切换工作方式。",
      },
    ];
  }
  return [
    {
      id: "shell-ready",
      role: "assistant",
      mode,
      content:
        "移动工作台已经连接。输入 codex、claude 或 shell 就能切换工作方式，也可以直接输入“codex 帮我检查改动”。",
    },
  ];
}

function createInitialMessagesByMode(): MessagesByMode {
  return {
    shell: initialMessagesForMode("shell"),
    codex: initialMessagesForMode("codex"),
    claude: initialMessagesForMode("claude"),
  };
}

const SHELL_QUICK_COMMANDS = [
  { label: "当前位置", command: "pwd" },
  { label: "当前改动", command: "git status --short" },
  { label: "最近提交", command: "git log -5 --oneline" },
];

const CODEX_QUICK_PROMPTS = [
  { label: "打个招呼", command: "你好，简单介绍一下你能在这个项目里做什么。" },
  { label: "检查改动", command: "检查当前项目改动并总结，先不要修改文件。" },
  { label: "了解项目", command: "快速了解这个项目的结构并简要说明。" },
];

const CLAUDE_QUICK_PROMPTS = [
  { label: "打个招呼", command: "你好，简单介绍一下你能在这个项目里做什么。" },
  { label: "检查改动", command: "检查当前项目改动并总结，先不要修改文件。" },
  { label: "继续任务", command: "查看当前项目状态，告诉我接下来适合做什么。" },
];

const TERMINAL_KEYS = [
  { key: "escape", label: "Esc", ariaLabel: "Escape" },
  { key: "tab", label: "Tab", ariaLabel: "Tab" },
  { key: "shift-tab", label: "⇧Tab", ariaLabel: "Shift Tab" },
  { key: "ctrl-c", label: "⌃C", ariaLabel: "Control C" },
  { key: "up", label: "↑", ariaLabel: "方向上" },
  { key: "down", label: "↓", ariaLabel: "方向下" },
  { key: "clear", label: "清屏", ariaLabel: "Control L 清屏" },
];

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function runStatus(run: ServerRun): MessageStatus {
  if (run.running) return "running";
  if (run.interrupted) return "stopped";
  return run.exitCode === 0 ? "completed" : "failed";
}

function resultLabel(message: ChatMessage) {
  if (message.status === "stopped") return "已停止";
  if (message.status === "completed") {
    if (message.mode === "codex") return "Codex 已回复";
    if (message.mode === "claude") return "Claude 已回复";
    return "执行完成";
  }
  if (message.status === "failed") return `退出码 ${message.exitCode ?? 1}`;
  return "执行中";
}

export function RemoteShellDemo() {
  const [projects, setProjects] = useState<Project[]>([FALLBACK_PROJECT]);
  const [pinnedProjectIds, setPinnedProjectIds] = useState<string[]>([FALLBACK_PROJECT.id]);
  const [selectedProjectId, setSelectedProjectId] = useState(FALLBACK_PROJECT.id);
  const [mobileScreen, setMobileScreen] = useState<"projects" | "chat">("projects");
  const [viewMode, setViewMode] = useState<"chat" | "terminal">("chat");
  const [chatMode, setChatMode] = useState<ChatMode>("shell");
  const [claudePermissionMode, setClaudePermissionMode] = useState<ClaudePermissionMode>("auto");
  const [messagesByProject, setMessagesByProject] = useState<MessagesByProject>(() => ({
    [FALLBACK_PROJECT.id]: createInitialMessagesByMode(),
  }));
  const [draft, setDraft] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isResettingSession, setIsResettingSession] = useState(false);
  const [isHydratingClaude, setIsHydratingClaude] = useState(false);
  const [activeActivity, setActiveActivity] = useState("");
  const [activeTab, setActiveTab] = useState<"projects" | "activity" | "settings">(
    "projects",
  );
  const [terminalBaseUrl, setTerminalBaseUrl] = useState("");
  const [terminalPort, setTerminalPort] = useState(7681);
  const [terminalFrameLoaded, setTerminalFrameLoaded] = useState(false);
  const [terminalReady, setTerminalReady] = useState(false);
  const [terminalKeyError, setTerminalKeyError] = useState("");
  const [projectRootLabel, setProjectRootLabel] = useState("~/java/project");
  const [projectSearch, setProjectSearch] = useState("");
  const [projectLoadError, setProjectLoadError] = useState("");
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const claudeHydrationRef = useRef(0);
  const pendingClaudeStartRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const activeRunRef = useRef<{
    runId: string;
    messageId: string;
    mode: ChatMode;
    projectId: string;
  } | null>(
    null,
  );

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? FALLBACK_PROJECT,
    [projects, selectedProjectId],
  );
  const visibleProjects = useMemo(() => {
    const byId = new Map(projects.map((project) => [project.id, project]));
    const pinned = pinnedProjectIds.map((id) => byId.get(id)).filter(Boolean) as Project[];
    if (!pinned.some((project) => project.id === selectedProject.id)) pinned.unshift(selectedProject);
    return pinned;
  }, [pinnedProjectIds, projects, selectedProject]);
  const filteredProjects = useMemo(() => {
    const keyword = projectSearch.trim().toLocaleLowerCase("zh-CN");
    if (!keyword) return projects;
    return projects.filter((project) =>
      `${project.name} ${project.path} ${project.branch}`.toLocaleLowerCase("zh-CN").includes(keyword),
    );
  }, [projectSearch, projects]);
  const terminalUrl = selectedProject.connected && terminalBaseUrl
    ? `${terminalBaseUrl}:${terminalPort}/`
    : null;
  const projectConnected = selectedProject.connected;
  const messages = messagesByProject[selectedProject.id]?.[chatMode] ?? initialMessagesForMode(chatMode);
  const chatModeName = chatMode === "codex" ? "Codex" : chatMode === "claude" ? "Claude" : "Shell";
  const claudePermissionLabel = CLAUDE_PERMISSION_MODES.find(
    (mode) => mode.value === claudePermissionMode,
  )?.label ?? "Auto";

  const loadProjects = useCallback(async (refresh = false) => {
    setIsLoadingProjects(true);
    setProjectLoadError("");
    try {
      const payload = await fetchProjectCatalog(refresh);
      setProjects(payload.projects);
      setProjectRootLabel(payload.root);
      setTerminalPort(payload.terminalPort);
      setSelectedProjectId((current) => {
        const next = payload.projects.some((project) => project.id === current)
          ? current
          : payload.projects.find((project) => project.id === FALLBACK_PROJECT.id)?.id
            ?? payload.projects[0]?.id
            ?? current;
        window.localStorage.setItem(SELECTED_PROJECT_KEY, next);
        return next;
      });
      setPinnedProjectIds((current) => {
        const availableIds = new Set(payload.projects.map((project) => project.id));
        const availablePinned = current.filter((id) => availableIds.has(id));
        const next = availablePinned.length
          ? availablePinned
          : payload.projects.find((project) => project.id === FALLBACK_PROJECT.id)
            ? [FALLBACK_PROJECT.id]
            : payload.projects[0]
              ? [payload.projects[0].id]
              : current;
        window.localStorage.setItem(PINNED_PROJECTS_KEY, JSON.stringify(next));
        return next;
      });
    } catch (error) {
      setProjectLoadError(error instanceof Error ? error.message : "无法读取 Mac 项目");
    } finally {
      setIsLoadingProjects(false);
    }
  }, []);

  useEffect(() => {
    setTerminalBaseUrl(`${window.location.protocol}//${window.location.hostname}`);
    const storedMode = window.localStorage.getItem("remote-shell-chat-mode");
    if (storedMode === "shell" || storedMode === "codex" || storedMode === "claude") {
      setChatMode(storedMode);
    }
    const storedClaudePermissionMode = window.localStorage.getItem(CLAUDE_PERMISSION_MODE_KEY);
    if (isClaudePermissionMode(storedClaudePermissionMode)) {
      setClaudePermissionMode(storedClaudePermissionMode);
    }
    const storedProject = window.localStorage.getItem(SELECTED_PROJECT_KEY);
    if (storedProject) setSelectedProjectId(storedProject);
    try {
      const storedProjects = JSON.parse(window.localStorage.getItem(PINNED_PROJECTS_KEY) ?? "[]");
      if (Array.isArray(storedProjects) && storedProjects.every((id) => typeof id === "string")) {
        setPinnedProjectIds(storedProjects);
      }
    } catch {
      // Ignore an incomplete device-local preference and keep the default project.
    }
    void loadProjects();
    return () => eventSourceRef.current?.close();
  }, [loadProjects]);

  useEffect(() => {
    const feed = feedRef.current;
    if (!feed || !stickToBottomRef.current) return;
    feed.scrollTop = feed.scrollHeight;
    setShowScrollToBottom(false);
  }, [messages, isStreaming, viewMode, mobileScreen]);

  useEffect(() => {
    const input = draftRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 128)}px`;
  }, [draft]);

  useEffect(() => {
    if (!showProjectPicker) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setShowProjectPicker(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [showProjectPicker]);

  useEffect(() => {
    setTerminalFrameLoaded(false);
    setTerminalReady(false);
    setTerminalKeyError("");
    if (viewMode !== "terminal" || !projectConnected) return;

    let cancelled = false;
    void fetch(
      `/api/projects/${encodeURIComponent(selectedProject.id)}/terminal/activate`,
      { method: "POST" },
    ).then(async (response) => {
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || "无法打开项目终端");
      }
      if (!cancelled) setTerminalReady(true);
    }).catch((error) => {
      if (!cancelled) setTerminalKeyError(error instanceof Error ? error.message : "无法打开项目终端");
    });
    return () => {
      cancelled = true;
    };
  }, [projectConnected, selectedProject.id, viewMode]);

  const openProject = (projectId: string) => {
    if ((isStreaming || isResettingSession) && projectId !== selectedProject.id) return;
    setPinnedProjectIds((current) => {
      const next = [projectId, ...current.filter((id) => id !== projectId)].slice(0, 10);
      window.localStorage.setItem(PINNED_PROJECTS_KEY, JSON.stringify(next));
      return next;
    });
    setMessagesByProject((current) => current[projectId]
      ? current
      : { ...current, [projectId]: createInitialMessagesByMode() });
    setSelectedProjectId(projectId);
    window.localStorage.setItem(SELECTED_PROJECT_KEY, projectId);
    setMobileScreen("chat");
    setActiveTab("projects");
    setViewMode("chat");
    setProjectSearch("");
    setShowProjectPicker(false);
  };

  const handleFeedScroll = () => {
    const feed = feedRef.current;
    if (!feed) return;
    const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 96;
    stickToBottomRef.current = nearBottom;
    setShowScrollToBottom(!nearBottom);
  };

  const scrollToLatest = () => {
    const feed = feedRef.current;
    if (!feed) return;
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    feed.scrollTop = feed.scrollHeight;
  };

  const updateModeMessages = useCallback((
    projectId: string,
    mode: ChatMode,
    updater: (current: ChatMessage[]) => ChatMessage[],
  ) => {
    setMessagesByProject((current) => {
      const projectMessages = current[projectId] ?? createInitialMessagesByMode();
      return {
        ...current,
        [projectId]: {
          ...projectMessages,
          [mode]: updater(projectMessages[mode]),
        },
      };
    });
  }, []);

  const replaceClaudeMessages = useCallback((
    projectId: string,
    messages: ChatMessage[],
    hasSession = false,
  ) => {
    const restoredMessages = messages.length
      ? messages
      : hasSession
        ? [
            {
              id: "claude-session-restored",
              role: "assistant" as const,
              mode: "claude" as const,
              content: "Claude 主会话已恢复。此前的模型上下文仍在；从现在起，新的对话记录也会保存在这台 Mac 上。",
            },
          ]
        : initialMessagesForMode("claude");
    setMessagesByProject((current) => {
      const projectMessages = current[projectId] ?? createInitialMessagesByMode();
      return {
        ...current,
        [projectId]: {
          ...projectMessages,
          claude: restoredMessages,
        },
      };
    });
  }, []);

  const updateRunMessage = useCallback((projectId: string, messageId: string, run: ServerRun) => {
    const agentName = run.mode === "codex" ? "Codex" : run.mode === "claude" ? "Claude" : "";
    const content = run.output || (run.running
      ? agentName ? `${agentName} 正在思考…` : "命令正在运行，等待终端输出…"
      : agentName ? `${agentName} 已完成，但没有返回文本。` : "命令执行完成，没有产生输出。");
    if (run.running) setActiveActivity(run.activity);
    updateModeMessages(projectId, run.mode, (current) =>
      current.map((message) =>
        message.id === messageId
          ? {
              ...message,
              content,
              exitCode: run.exitCode,
              mode: run.mode,
              output: run.mode === "shell",
              runId: run.id,
              status: runStatus(run),
              streaming: run.running,
            }
          : message,
        ),
    );
  }, [updateModeMessages]);

  const watchRun = useCallback((
    projectId: string,
    runId: string,
    messageId: string,
    mode: ChatMode,
  ) => {
    const settle = (source: EventSource, settledRunId: string) => {
      source.close();
      if (eventSourceRef.current === source) eventSourceRef.current = null;
      if (activeRunRef.current?.runId === settledRunId) activeRunRef.current = null;
      setActiveActivity("");
      setIsStreaming(false);
      setIsStopping(false);
    };

    const connect = (nextRunId: string, nextMessageId: string, nextMode: ChatMode) => {
      eventSourceRef.current?.close();
      const source = new EventSource(
        `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(nextRunId)}/events`,
      );
      let recoveryProbePending = false;
      eventSourceRef.current = source;

      source.addEventListener("output", (event) => {
        const run = JSON.parse((event as MessageEvent).data) as ServerRun;
        updateRunMessage(projectId, nextMessageId, run);
      });

      source.addEventListener("done", (event) => {
        const run = JSON.parse((event as MessageEvent).data) as ServerRun;
        updateRunMessage(projectId, nextMessageId, run);
        settle(source, nextRunId);
      });

      source.onerror = () => {
        if (activeRunRef.current?.runId !== nextRunId) {
          source.close();
          return;
        }
        setActiveActivity("连接中断，正在自动重连");
        if (recoveryProbePending) return;
        recoveryProbePending = true;

        void (async () => {
          try {
            const response = await fetch(
              `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(nextRunId)}`,
            );
            if (response.ok) {
              const run = await response.json() as ServerRun;
              updateRunMessage(projectId, nextMessageId, run);
              if (!run.running) {
                settle(source, nextRunId);
              } else if (source.readyState === EventSource.CLOSED) {
                source.close();
                window.setTimeout(() => {
                  if (activeRunRef.current?.runId === nextRunId) {
                    connect(nextRunId, nextMessageId, nextMode);
                  }
                }, 750);
              }
              return;
            }

            if (response.status === 404 && nextMode === "claude") {
              const snapshot = await fetchClaudeConversation(projectId);
              replaceClaudeMessages(projectId, snapshot.messages, snapshot.hasSession);
              const recoveredRun = snapshot.activeRun;
              const recoveredMessageId = recoveredRun?.assistantMessageId
                ?? snapshot.messages.find((message) => message.runId === recoveredRun?.id)?.id;
              if (recoveredRun?.running && recoveredMessageId) {
                source.close();
                activeRunRef.current = {
                  messageId: recoveredMessageId,
                  mode: "claude",
                  projectId,
                  runId: recoveredRun.id,
                };
                updateRunMessage(projectId, recoveredMessageId, recoveredRun);
                connect(recoveredRun.id, recoveredMessageId, "claude");
                return;
              }
              settle(source, nextRunId);
            }
          } catch {
            // EventSource keeps retrying while the phone or Mac network is temporarily unavailable.
            if (
              source.readyState === EventSource.CLOSED
              && activeRunRef.current?.runId === nextRunId
            ) {
              window.setTimeout(() => {
                if (activeRunRef.current?.runId === nextRunId) {
                  connect(nextRunId, nextMessageId, nextMode);
                }
              }, 1_500);
            }
          } finally {
            recoveryProbePending = false;
          }
        })();
      };
    };

    connect(runId, messageId, mode);
  }, [replaceClaudeMessages, updateRunMessage]);

  useEffect(() => {
    const hydrationId = ++claudeHydrationRef.current;
    if (chatMode !== "claude" || !projectConnected || pendingClaudeStartRef.current) {
      setIsHydratingClaude(false);
      return;
    }

    const projectId = selectedProject.id;
    const controller = new AbortController();
    setIsHydratingClaude(true);
    void fetchClaudeConversation(projectId, controller.signal)
      .then((snapshot) => {
        if (claudeHydrationRef.current !== hydrationId) return;
        replaceClaudeMessages(projectId, snapshot.messages, snapshot.hasSession);

        const activeRun = snapshot.activeRun;
        const assistantMessageId = activeRun?.assistantMessageId
          ?? snapshot.messages.find((message) => message.runId === activeRun?.id)?.id;
        if (!activeRun?.running || !assistantMessageId) return;

        activeRunRef.current = {
          messageId: assistantMessageId,
          mode: "claude",
          projectId,
          runId: activeRun.id,
        };
        updateRunMessage(projectId, assistantMessageId, activeRun);
        setActiveActivity(activeRun.activity || "正在恢复 Claude 输出");
        setIsStreaming(true);
        setIsStopping(false);
        watchRun(projectId, activeRun.id, assistantMessageId, "claude");
      })
      .catch((error) => {
        if (controller.signal.aborted || claudeHydrationRef.current !== hydrationId) return;
        updateModeMessages(projectId, "claude", (current) => [
          ...current,
          {
            id: makeId("claude-restore-error"),
            role: "assistant",
            mode: "claude",
            content: error instanceof Error ? error.message : "无法恢复 Claude 对话",
            status: "failed",
          },
        ]);
      })
      .finally(() => {
        if (claudeHydrationRef.current === hydrationId) setIsHydratingClaude(false);
      });

    return () => controller.abort();
  }, [
    chatMode,
    projectConnected,
    replaceClaudeMessages,
    selectedProject.id,
    updateModeMessages,
    updateRunMessage,
    watchRun,
  ]);

  const changeChatMode = (mode: ChatMode) => {
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    setDraft("");
    setChatMode(mode);
    window.localStorage.setItem("remote-shell-chat-mode", mode);
  };

  const cycleClaudePermissionMode = () => {
    if (isStreaming || isResettingSession || isHydratingClaude) return;
    setClaudePermissionMode((current) => {
      const currentIndex = CLAUDE_PERMISSION_MODES.findIndex((mode) => mode.value === current);
      const next = CLAUDE_PERMISSION_MODES[(currentIndex + 1) % CLAUDE_PERMISSION_MODES.length].value;
      window.localStorage.setItem(CLAUDE_PERMISSION_MODE_KEY, next);
      return next;
    });
  };

  const runCommand = async (rawCommand: string) => {
    const enteredCommand = rawCommand.trim();
    if (!enteredCommand || isStreaming || isResettingSession || isHydratingClaude) return;
    const projectId = selectedProject.id;

    const routeMatch = enteredCommand.match(/^(codex|claude|shell)(?:\s+([\s\S]+))?$/iu);
    const requestedMode = routeMatch
      ? routeMatch[1].toLowerCase() as ChatMode
      : chatMode;
    const command = routeMatch?.[2]?.trim() || (routeMatch ? "" : enteredCommand);

    const startsClaudeFromAnotherMode = Boolean(
      routeMatch && requestedMode === "claude" && chatMode !== "claude" && command,
    );
    if (startsClaudeFromAnotherMode) pendingClaudeStartRef.current = true;
    if (routeMatch) changeChatMode(requestedMode);
    if (!command) {
      const modeName = requestedMode === "codex" ? "Codex" : requestedMode === "claude" ? "Claude" : "Shell";
      setDraft("");
      updateModeMessages(projectId, requestedMode, (current) => [
        ...current,
        { id: makeId("user"), role: "user", content: enteredCommand, mode: requestedMode },
        {
          id: makeId("mode"),
          role: "assistant",
          content: requestedMode === "shell"
            ? "已切换到 Shell。接下来输入的内容会作为真实命令执行。"
            : `已进入 ${modeName}。接下来直接输入自然语言即可继续这个项目的会话。`,
          mode: requestedMode,
        },
      ]);
      return;
    }

    const turnId = requestedMode === "claude" ? makeId("claude-turn") : null;
    const userMessage: ChatMessage = {
      id: turnId ? `${turnId}-user` : makeId("user"),
      role: "user",
      content: routeMatch ? command : enteredCommand,
      mode: requestedMode,
      turnId: turnId ?? undefined,
    };
    const assistantMessageId = turnId ? `${turnId}-assistant` : makeId("terminal");
    const assistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: "assistant",
      content: requestedMode === "codex"
        ? "正在连接 Codex…"
        : requestedMode === "claude"
          ? "正在连接 Claude…"
          : "正在连接 Mac 终端…",
      mode: requestedMode,
      output: requestedMode === "shell",
      status: "running",
      streaming: true,
      turnId: turnId ?? undefined,
    };

    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    setDraft("");
    updateModeMessages(projectId, requestedMode, (current) => [
      ...current,
      userMessage,
      assistantMessage,
    ]);
    setIsStreaming(true);
    setIsStopping(false);
    setActiveActivity(requestedMode === "codex"
      ? "正在启动 Codex"
      : requestedMode === "claude"
        ? "正在启动 Claude"
        : "正在启动终端命令");

    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/runs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command,
            mode: requestedMode,
            permissionMode: requestedMode === "claude" ? claudePermissionMode : undefined,
            turnId,
          }),
        },
      );
      const payload = await response.json() as ServerRun | { error?: string };
      if (!response.ok || !("id" in payload)) {
        throw new Error("error" in payload && payload.error ? payload.error : "无法启动命令");
      }

      if (startsClaudeFromAnotherMode) {
        try {
          const snapshot = await fetchClaudeConversation(projectId);
          replaceClaudeMessages(projectId, snapshot.messages, snapshot.hasSession);
        } catch {
          // The new turn is already visible locally; normal SSE updates can continue.
        }
      }
      updateRunMessage(projectId, assistantMessageId, payload);
      activeRunRef.current = {
        messageId: assistantMessageId,
        mode: requestedMode,
        projectId,
        runId: payload.id,
      };
      watchRun(projectId, payload.id, assistantMessageId, requestedMode);
    } catch (error) {
      updateModeMessages(projectId, requestedMode, (current) =>
        current.map((message) =>
          message.id === assistantMessageId
            ? {
                ...message,
                content: error instanceof Error ? error.message : "无法连接终端服务",
                status: "failed",
                streaming: false,
              }
            : message,
        ),
      );
      setIsStreaming(false);
      setIsStopping(false);
      setActiveActivity("");
    } finally {
      if (startsClaudeFromAnotherMode) pendingClaudeStartRef.current = false;
    }
  };

  const handleSubmit = (event?: FormEvent) => {
    event?.preventDefault();
    void runCommand(draft);
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (chatMode === "claude" && event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      cycleClaudePermissionMode();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
  };

  const stopRun = async () => {
    const active = activeRunRef.current;
    if (!active || isStopping) return;
    setIsStopping(true);

    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(active.projectId)}/runs/${encodeURIComponent(active.runId)}/interrupt`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error("停止命令失败");
    } catch (error) {
      setIsStopping(false);
      updateModeMessages(active.projectId, active.mode, (current) => [
        ...current,
        {
          id: makeId("stop-error"),
          role: "assistant",
          content: error instanceof Error ? error.message : "停止命令失败",
        },
      ]);
    }
  };

  const exitAgentSession = async () => {
    if (isStreaming) {
      await stopRun();
      return;
    }
    if (chatMode === "shell" || isResettingSession || isHydratingClaude) return;

    const exitingMode = chatMode;
    const agentName = exitingMode === "codex" ? "Codex" : "Claude";
    const confirmed = window.confirm(
      exitingMode === "claude"
        ? "结束并清空当前项目的 Claude 主会话记录？下次发送消息时会创建全新会话。"
        : "结束当前项目的 Codex 会话？下次发送消息时会创建全新会话。",
    );
    if (!confirmed) return;
    const projectId = selectedProject.id;
    setIsResettingSession(true);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/agents/${exitingMode}/session`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || `无法退出 ${agentName} 会话`);
      }

      setMessagesByProject((current) => {
        const projectMessages = current[projectId] ?? createInitialMessagesByMode();
        return {
          ...current,
          [projectId]: {
            ...projectMessages,
            [exitingMode]: initialMessagesForMode(exitingMode),
            shell: [
              ...projectMessages.shell,
              {
                id: makeId("session-exited"),
                role: "assistant",
                mode: "shell",
                content: `${agentName} 会话已退出。下次进入 ${agentName} 时会从新会话开始。`,
              },
            ],
          },
        };
      });
      changeChatMode("shell");
    } catch (error) {
      updateModeMessages(projectId, exitingMode, (current) => [
        ...current,
        {
          id: makeId("session-exit-error"),
          role: "assistant",
          mode: exitingMode,
          content: error instanceof Error ? error.message : `无法退出 ${agentName} 会话`,
        },
      ]);
    } finally {
      setIsResettingSession(false);
    }
  };

  const sendTerminalKey = async (key: string) => {
    setTerminalKeyError("");
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(selectedProject.id)}/terminal/keys`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key }),
        },
      );
      if (!response.ok) throw new Error("快捷键发送失败");
    } catch (error) {
      setTerminalKeyError(error instanceof Error ? error.message : "快捷键发送失败");
    }
  };

  const renderProjectList = () => (
    <section className="project-panel" aria-label="项目列表">
      <header className="brand-header">
        <div>
          <p className="eyebrow">REMOTE SHELL</p>
          <h1>你的工作台</h1>
        </div>
        <button className="profile-button" type="button" aria-label="工作台设置">
          RS
        </button>
      </header>

      <div className="machine-overview">
        <div className="machine-topline">
          <span className="machine-icon" aria-hidden="true">⌘</span>
          <span className="online-label"><i /> {isLoadingProjects ? "正在读取项目" : `${projects.length} 个项目可选`}</span>
        </div>
        <strong>用消息调用终端</strong>
        <p>从 Mac 选择项目后，Codex、Claude 和终端都会在对应目录中工作。</p>
        <div className="machine-meta">
          <span>{selectedProject.machine} · 本机服务</span>
          <span>{projectRootLabel}</span>
        </div>
      </div>

      <div className="section-heading">
        <h2>最近项目</h2>
        <button
          disabled={isStreaming || isResettingSession}
          onClick={() => setShowProjectPicker(true)}
          type="button"
          aria-label="选择 Mac 项目"
        >
          ＋
        </button>
      </div>

      <div className="project-list">
        {visibleProjects.map((project) => (
          <button
            className={`project-card ${selectedProjectId === project.id ? "selected" : ""}`}
            disabled={(isStreaming || isResettingSession) && selectedProjectId !== project.id}
            key={project.id}
            onClick={() => openProject(project.id)}
            type="button"
          >
            <span className={`project-avatar ${project.color}`}>{project.shortName}</span>
            <span className="project-copy">
              <span className="project-title-row">
                <strong>{project.name}</strong>
                <time>{project.activity}</time>
              </span>
              <span className="project-path">{project.machine} · {project.branch}</span>
              <span className="project-status">
                <i className={project.status} />
                {selectedProjectId === project.id ? "当前项目" : "对话与终端可用"}
              </span>
            </span>
            <span className="chevron" aria-hidden="true">›</span>
          </button>
        ))}
      </div>

      {projectLoadError && <p className="project-load-error">{projectLoadError}</p>}
      <p className="demo-note"><span>●</span> 点击右上角＋选择其他 Mac 项目</p>
    </section>
  );

  const renderProjectPicker = () => (
    <div className="project-picker-backdrop">
      <button
        aria-label="关闭项目选择器"
        className="project-picker-scrim"
        onClick={() => setShowProjectPicker(false)}
        type="button"
      />
      <section aria-label="选择 Mac 项目" aria-modal="true" className="project-picker" role="dialog">
        <header className="project-picker-header">
          <div>
            <h2>选择 Mac 项目</h2>
            <p>{projectRootLabel} · 只显示一级目录</p>
          </div>
          <button aria-label="关闭项目选择器" onClick={() => setShowProjectPicker(false)} type="button">×</button>
        </header>

        <label className="project-search">
          <span aria-hidden="true">⌕</span>
          <input
            autoComplete="off"
            onChange={(event) => setProjectSearch(event.target.value)}
            placeholder="搜索项目名称、路径或分支"
            type="search"
            value={projectSearch}
          />
        </label>

        <div className="project-picker-list">
          {isLoadingProjects && <div className="project-picker-state"><span className="mini-spinner" />正在读取 Mac 项目…</div>}
          {!isLoadingProjects && !filteredProjects.length && (
            <div className="project-picker-state">没有找到匹配的项目</div>
          )}
          {!isLoadingProjects && filteredProjects.map((project) => (
            <button
              className={selectedProject.id === project.id ? "current" : ""}
              disabled={(isStreaming || isResettingSession) && selectedProject.id !== project.id}
              key={project.id}
              onClick={() => openProject(project.id)}
              type="button"
            >
              <span className={`project-avatar ${project.color}`}>{project.shortName}</span>
              <span className="project-picker-copy">
                <strong>{project.name}</strong>
                <small>{project.path}</small>
                <em>⑂ {project.branch}</em>
              </span>
              <span className="project-picker-action">
                {selectedProject.id === project.id
                  ? "当前"
                  : pinnedProjectIds.includes(project.id)
                    ? "打开"
                    : "添加"}
              </span>
            </button>
          ))}
        </div>

        <footer className="project-picker-footer">
          <span>{projects.length} 个项目</span>
          <button disabled={isLoadingProjects} onClick={() => void loadProjects(true)} type="button">
            {isLoadingProjects ? "刷新中" : "重新扫描"}
          </button>
        </footer>
      </section>
    </div>
  );

  const renderChat = () => (
    <>
      <div className="chat-feed" onScroll={handleFeedScroll} ref={feedRef}>
        <div className="shell-mode-note">
          <div className="chat-mode-switch" role="group" aria-label="对话执行模式">
            <button
              aria-pressed={chatMode === "codex"}
              className={chatMode === "codex" ? "active" : ""}
              disabled={isStreaming || isResettingSession}
              onClick={() => changeChatMode("codex")}
              type="button"
            >
              Codex
            </button>
            <button
              aria-pressed={chatMode === "claude"}
              className={chatMode === "claude" ? "active" : ""}
              disabled={isStreaming || isResettingSession}
              onClick={() => changeChatMode("claude")}
              type="button"
            >
              Claude
            </button>
            <button
              aria-pressed={chatMode === "shell"}
              className={chatMode === "shell" ? "active" : ""}
              disabled={isStreaming || isResettingSession}
              onClick={() => changeChatMode("shell")}
              type="button"
            >
              Shell
            </button>
          </div>
          {(isStreaming || chatMode !== "shell") && (
            <button
              className={`session-control ${isStreaming ? "running" : ""}`}
              disabled={isStopping || isResettingSession || isHydratingClaude}
              onClick={() => void exitAgentSession()}
              type="button"
              aria-label={isStreaming ? "停止当前任务" : `退出当前 ${chatMode} 会话`}
            >
              <kbd>⌃C</kbd>
              {isStreaming ? (isStopping ? "停止中" : "停止") : isResettingSession ? "退出中" : "结束会话"}
            </button>
          )}
          <p><i /> {isHydratingClaude
            ? "正在恢复 Claude 主会话"
            : chatMode === "shell"
              ? "直接执行真实命令"
              : chatMode === "claude"
                ? `正在延续 Claude 会话 · ${claudePermissionLabel}`
                : `正在延续 ${chatModeName} 会话`}</p>
        </div>
        {messages.map((message) => (
          <article className={`message ${message.role}`} key={message.id}>
            {message.role === "assistant" && (
              <span className={`assistant-mark ${message.mode ?? "remote"}`}>
                {message.mode === "codex" ? "C" : message.mode === "claude" ? "A" : "R"}
              </span>
            )}
            <div className={`message-body ${message.output ? "command-output" : ""}`}>
              {message.role === "assistant" && (
                <div className="message-author">
                  <strong>{message.mode === "codex" ? "Codex" : message.mode === "claude" ? "Claude" : "Shell"}</strong>
                  {message.streaming && <span>正在工作</span>}
                </div>
              )}
              {message.output ? (
                <pre>{message.content}</pre>
              ) : (
                message.content.split("\n").map((line, index) => (
                  <p key={`${message.id}-${index}`}>{line || <br />}</p>
                ))
              )}
              {message.streaming && <span className="stream-caret" />}
              {message.runId && (
                <span className={`run-result ${message.status ?? "running"}`}>
                  {resultLabel(message)}
                </span>
              )}
            </div>
          </article>
        ))}

        {(isStreaming || isHydratingClaude) && (
          <article aria-live="polite" className="activity-card">
            <div><span className="live-pulse" /> <span>{isHydratingClaude
              ? "正在恢复 Claude 对话"
              : isStopping
                ? "正在停止任务"
                : activeActivity || "正在接收输出"}</span><b>›</b></div>
            <small>{isHydratingClaude
              ? "从这台 Mac 读取当前项目的主会话"
              : chatMode === "shell"
                ? "命令在 Mac 的后台 tmux 窗口中运行"
                : `${chatMode === "codex" ? "Codex" : "Claude"} 在 Mac 的当前项目中工作`}</small>
          </article>
        )}
        {!isStreaming && !isHydratingClaude && projectConnected && (
          <div className="quick-prompts">
            {(chatMode === "codex"
              ? CODEX_QUICK_PROMPTS
              : chatMode === "claude"
                ? CLAUDE_QUICK_PROMPTS
                : SHELL_QUICK_COMMANDS).map((item) => (
              <button key={item.command} onClick={() => void runCommand(item.command)} type="button">
                {item.label}
              </button>
            ))}
          </div>
        )}
        {!projectConnected && (
          <article className="connection-notice">
            尚未连接到可用项目，请返回项目列表重新选择。
          </article>
        )}
      </div>

      {showScrollToBottom && (
        <button
          aria-label="回到最新消息"
          className="scroll-bottom-button"
          onClick={scrollToLatest}
          type="button"
        >
          ↓
        </button>
      )}

      <form aria-busy={isStreaming || isHydratingClaude} className="composer" onSubmit={handleSubmit}>
        <label className="sr-only" htmlFor="message-input">
          {chatMode === "codex" ? "发送给 Codex" : chatMode === "claude" ? "发送给 Claude" : "执行 Shell 命令"}
        </label>
        <textarea
          disabled={!projectConnected || isResettingSession || isHydratingClaude}
          enterKeyHint="send"
          id="message-input"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleComposerKeyDown}
          placeholder={projectConnected
            ? chatMode === "codex"
              ? "告诉 Codex 接下来做什么…"
              : chatMode === "claude"
                ? "告诉 Claude 接下来做什么…"
                : "输入命令，或输入 codex / claude"
            : "项目尚未接入"}
          rows={1}
          ref={draftRef}
          spellCheck={chatMode !== "shell"}
          value={draft}
        />
        <div className="composer-toolbar">
          <div className="composer-tools">
            <button
              className="attach-button"
              onClick={() => setViewMode("terminal")}
              type="button"
              aria-label="切换到原生终端"
            >
              <span>⌘</span>
            </button>
            {chatMode === "claude" ? (
              <button
                aria-label={`Claude 权限模式：${claudePermissionLabel}，点击或按 Shift Tab 切换`}
                className="composer-mode-chip claude permission-mode-chip"
                disabled={isStreaming || isResettingSession || isHydratingClaude}
                onClick={cycleClaudePermissionMode}
                title="点击或按 Shift+Tab 切换 Claude 权限模式"
                type="button"
              >
                <i /> Claude · {claudePermissionLabel}<kbd>⇧Tab</kbd>
              </button>
            ) : (
              <span className={`composer-mode-chip ${chatMode}`}><i /> {chatModeName}</span>
            )}
          </div>
          {isStreaming ? (
            <button
              className="send-button stop"
              disabled={isStopping}
              onClick={() => void stopRun()}
              type="button"
              aria-label="停止任务"
            >
              <i />
            </button>
          ) : (
            <button
              className="send-button"
              disabled={!draft.trim() || !projectConnected || isResettingSession || isHydratingClaude}
              type="submit"
              aria-label="执行"
            >
              ↑
            </button>
          )}
        </div>
      </form>
    </>
  );

  const renderTerminal = () => {
    if (!terminalUrl) {
      return (
        <section className="terminal-unavailable">
          <span className="placeholder-icon">⌘</span>
          <h2>这个项目还没有接入</h2>
          <p>请返回项目列表，从允许访问的 Mac 项目目录中重新选择。</p>
        </section>
      );
    }

    return (
      <section className="terminal-embed" aria-label={`${selectedProject.name} 实时终端`}>
        <div className="terminal-status-row">
          <span className={`terminal-live-status ${terminalReady && terminalFrameLoaded ? "connected" : "connecting"}`}>
            <i /> {terminalReady && terminalFrameLoaded ? "实时终端" : "正在切换项目"}
          </span>
          <span>{selectedProject.name} · tmux</span>
        </div>
        <div className="terminal-frame-shell">
          {(!terminalReady || !terminalFrameLoaded) && (
            <div className="terminal-loading"><span className="mini-spinner" />正在进入 {selectedProject.name}…</div>
          )}
          {terminalReady && (
            <iframe
              allow="clipboard-read; clipboard-write"
              className="terminal-frame"
              key={`${terminalUrl}-${selectedProject.id}`}
              onLoad={() => setTerminalFrameLoaded(true)}
              src={terminalUrl}
              title={`${selectedProject.name} Mac 实时终端`}
            />
          )}
        </div>
        <div className="terminal-keybar" role="toolbar" aria-label="终端快捷键">
          {TERMINAL_KEYS.map((item) => (
            <button
              aria-label={item.ariaLabel}
              key={item.key}
              onPointerDown={(event) => {
                event.preventDefault();
                void sendTerminalKey(item.key);
              }}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
        <p className={`terminal-note ${terminalKeyError ? "error" : ""}`}>
          {terminalKeyError || "点击终端即可输入 · ⇧Tab 会作为组合键发送到当前项目"}
        </p>
      </section>
    );
  };

  const renderChatPanel = () => (
    <main className={`chat-panel ${mobileScreen === "chat" ? "mobile-visible" : ""}`}>
      <header className="chat-header">
        <button className="back-button" onClick={() => setMobileScreen("projects")} type="button" aria-label="返回项目列表">←</button>
        <div className={`project-avatar compact ${selectedProject.color}`}>{selectedProject.shortName}</div>
        <div className="chat-title">
          <strong>{selectedProject.name}</strong>
          <span><i className={selectedProject.status} /> {selectedProject.machine} · tmux</span>
        </div>
        <div className="view-switch" role="group" aria-label="视图切换">
          <button className={viewMode === "chat" ? "active" : ""} onClick={() => setViewMode("chat")} type="button">对话</button>
          <button className={viewMode === "terminal" ? "active" : ""} onClick={() => setViewMode("terminal")} type="button">终端</button>
        </div>
      </header>
      <div className="session-bar">
        <span>{selectedProject.path}</span>
        <span className="branch-pill">⑂ {selectedProject.branch}</span>
      </div>
      {viewMode === "chat" ? renderChat() : renderTerminal()}
    </main>
  );

  return (
    <div className="app-shell">
      <div className={`sidebar ${mobileScreen === "projects" ? "mobile-visible" : ""}`}>
        {activeTab === "projects" ? renderProjectList() : (
          <section className="placeholder-panel">
            <button className="back-to-projects" type="button" onClick={() => setActiveTab("projects")}>‹ 返回</button>
            <span className="placeholder-icon">{activeTab === "activity" ? "◷" : "⚙"}</span>
            <h2>{activeTab === "activity" ? "最近活动" : "连接设置"}</h2>
            <p>{activeTab === "activity" ? "后续会在这里汇总所有电脑上的任务进度。" : "后续会在这里管理设备配对、安全策略和显示偏好。"}</p>
          </section>
        )}
        <nav className="bottom-nav" aria-label="主导航">
          <button className={activeTab === "projects" ? "active" : ""} onClick={() => setActiveTab("projects")} type="button"><span>▦</span>项目</button>
          <button className={activeTab === "activity" ? "active" : ""} onClick={() => setActiveTab("activity")} type="button"><span>◷</span>活动</button>
          <button className={activeTab === "settings" ? "active" : ""} onClick={() => setActiveTab("settings")} type="button"><span>⚙</span>设置</button>
        </nav>
      </div>
      {renderChatPanel()}
      {showProjectPicker && renderProjectPicker()}
    </div>
  );
}
