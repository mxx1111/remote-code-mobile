# Contributing

Thanks for helping improve Remote Shell Mobile.

## Before opening a pull request

1. Keep the remote execution boundary explicit and secure by default.
2. Do not commit `.env.local`, `.runtime`, logs, credentials, conversation data, private project names, or absolute user paths.
3. Keep Claude Code, Codex and other provider integrations optional.
4. Preserve mobile keyboard, touch, reconnect and per-project session behavior.
5. Run:

```bash
npm ci
npm run check
npm audit --omit=dev
```

Explain the user-visible outcome, security impact, and manual mobile validation in the pull request. Screenshots are useful for visual changes, but never include private project or account data.
