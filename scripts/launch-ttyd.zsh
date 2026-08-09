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
projects_root="${REMOTE_SHELL_PROJECTS_ROOT:-${project_root:h}}"
workspace_session="${REMOTE_SHELL_WORKSPACE_SESSION:-remote-shell-mobile}"
ttyd_host="${REMOTE_SHELL_TTYD_HOST:-127.0.0.1}"
ttyd_port="${REMOTE_SHELL_TTYD_PORT:-7681}"

mkdir -p "${log_root}"

export LANG="${LANG:-en_US.UTF-8}"
export LC_CTYPE="${LC_CTYPE:-UTF-8}"
export PATH="/opt/homebrew/bin:${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
tmux_bin="${REMOTE_SHELL_TMUX:-$(command -v tmux || true)}"
ttyd_bin="${REMOTE_SHELL_TTYD:-$(command -v ttyd || true)}"

if [[ -z "${tmux_bin}" || -z "${ttyd_bin}" ]]; then
  print -u2 "Remote Shell Mobile requires both tmux and ttyd."
  exit 127
fi

if [[ ! -d "${projects_root}" ]]; then
  print -u2 "Project root does not exist: ${projects_root}"
  exit 78
fi

if ! "${tmux_bin}" has-session -t "${workspace_session}" 2>/dev/null; then
  "${tmux_bin}" new-session \
    -d \
    -s "${workspace_session}" \
    -n workspace \
    -c "${projects_root}"
fi

ttyd_args=(
  -i "${ttyd_host}" \
  -p "${ttyd_port}" \
  -W \
  -O \
  -m 1 \
  -t fontSize=15 \
  -t cursorBlink=true
)
if [[ -n "${REMOTE_SHELL_TTYD_CREDENTIAL:-}" ]]; then
  ttyd_args+=(-c "${REMOTE_SHELL_TTYD_CREDENTIAL}")
fi

exec "${ttyd_bin}" "${ttyd_args[@]}" \
  /usr/bin/env -u TMUX "${tmux_bin}" attach-session -t "${workspace_session}" \
  >>"${log_root}/ttyd.log" 2>>"${log_root}/ttyd.error.log"
