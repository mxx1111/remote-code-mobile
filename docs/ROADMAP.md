# Remote Shell Mobile Roadmap

当前版本定位为仅供可信局域网或 Tailscale tailnet 使用的自托管 alpha。核心终端链路已经可用，后续优先根据真实移动场景反馈迭代。

## 已完成

- 移动端 H5 项目工作台。
- Shell、Claude Code、Codex 三种对话模式。
- 按项目隔离并恢复 Claude 会话与聊天记录。
- SSE 实时输出和短时断线重连。
- ttyd、tmux 与移动端组合快捷键。
- macOS LaunchAgent 常驻运行。
- 默认仅监听 loopback，并提供 Tailscale Serve 部署说明。
- 通用化安装器、环境配置和开源安全文档。
- H5 Claude 权限模式显示，以及点击或 `Shift+Tab` 切换 Manual、Accept Edits、Plan、Auto。

## P0：安全与接入

- 提供可选的应用层设备配对或短期访问令牌。
- 提供 Tailscale Grants/ACL 最小权限示例。
- 将 H5/API 与 ttyd 合并到一个 HTTPS 源，简化 CSP 与终端端口配置。
- 增加操作审计和敏感信息脱敏策略。

## P1：移动体验

- 改进 Markdown、代码块、复制按钮和 Diff 展示。
- 增加 PWA 任务完成通知。
- 支持会话归档、新建会话和历史恢复。
- 完善横屏、外接键盘和 VoiceOver 体验。

## P2：长任务与多任务

- 支持多个项目同时运行后台任务，并显示完成和未读状态。
- 增加持久化任务执行器与输出日志，使 Node 服务重启后可以读取完整结果。
- 增加日志轮转和可配置保留周期。

## 试用观察项

- iPhone 锁屏、切后台、重新打开后，长任务输出是否完整衔接。
- Claude 长时间执行时，停止、恢复和完成状态是否准确。
- 项目切换后的会话隔离是否可靠。
- 手机键盘、终端快捷键和滚动体验是否顺手。
- Wi-Fi、蜂窝网络与 Tailscale 切换后的恢复情况。
