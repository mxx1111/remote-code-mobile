#!/bin/zsh

set -euo pipefail
umask 077

script_dir="${0:A:h}"
project_root="${script_dir:h}"

if [[ -f "${project_root}/.env.local" ]]; then
  set -a
  source "${project_root}/.env.local"
  set +a
fi

if [[ -z "${HOME:-}" ]]; then
  user_name="$(/usr/bin/id -un)"
  export HOME="$(/usr/bin/dscl . -read "/Users/${user_name}" NFSHomeDirectory | /usr/bin/awk '{print $2}')"
fi

state_root="${REMOTE_SHELL_STATE_ROOT:-${project_root}/.runtime}"
log_root="${state_root}/logs"

mkdir -p "${log_root}"

export LANG="${LANG:-en_US.UTF-8}"
export LC_CTYPE="${LC_CTYPE:-UTF-8}"
export NODE_ENV="production"
export NO_COLOR="1"
export PATH="/opt/homebrew/bin:${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
node_bin="${REMOTE_SHELL_NODE:-$(command -v node || true)}"
tmux_bin="${REMOTE_SHELL_TMUX:-$(command -v tmux || true)}"
if [[ -z "${node_bin}" || -z "${tmux_bin}" ]]; then
  print -u2 "Remote Shell Mobile requires Node.js 22 or newer and tmux."
  exit 127
fi

claude_bin="${REMOTE_SHELL_CLAUDE:-$(command -v claude || true)}"
codex_bin="${REMOTE_SHELL_CODEX:-$(command -v codex || true)}"
if [[ -n "${claude_bin}" ]]; then
  export REMOTE_SHELL_CLAUDE="${claude_bin}"
fi
if [[ -n "${codex_bin}" ]]; then
  export REMOTE_SHELL_CODEX="${codex_bin}"
fi
export REMOTE_SHELL_HOST="${REMOTE_SHELL_HOST:-127.0.0.1}"
export REMOTE_SHELL_MACHINE_NAME="${REMOTE_SHELL_MACHINE_NAME:-$(/usr/sbin/scutil --get ComputerName 2>/dev/null || /bin/hostname -s)}"
export REMOTE_SHELL_PORT="${REMOTE_SHELL_PORT:-3001}"
export REMOTE_SHELL_PROJECTS_ROOT="${REMOTE_SHELL_PROJECTS_ROOT:-${project_root:h}}"
export REMOTE_SHELL_STATE_ROOT="${state_root}"
export REMOTE_SHELL_TMUX="${tmux_bin}"
export REMOTE_SHELL_WORKSPACE_SESSION="${REMOTE_SHELL_WORKSPACE_SESSION:-remote-shell-mobile}"

if [[ ! -d "${REMOTE_SHELL_PROJECTS_ROOT}" ]]; then
  print -u2 "Project root does not exist: ${REMOTE_SHELL_PROJECTS_ROOT}"
  exit 78
fi

cd "${project_root}"
exec "${node_bin}" "${project_root}/server/local-terminal-server.mjs" \
  >>"${log_root}/server.log" 2>>"${log_root}/server.error.log"
