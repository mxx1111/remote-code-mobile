#!/bin/zsh

set -euo pipefail
umask 077

script_dir="${0:A:h}"
repo_root="${script_dir:h}"
launch_agents_dir="${HOME}/Library/LaunchAgents"
user_domain="gui/$(/usr/bin/id -u)"
labels=(dev.remote-shell-mobile.server dev.remote-shell-mobile.ttyd)

if [[ ! -f "${repo_root}/.env.local" ]]; then
  print -u2 "Create .env.local from .env.example before installing."
  exit 78
fi
if [[ ! -f "${repo_root}/dist-spa/index.html" ]]; then
  print -u2 "Build the H5 first with: npm run build"
  exit 78
fi

set -a
source "${repo_root}/.env.local"
set +a
configured_projects_root="${REMOTE_SHELL_PROJECTS_ROOT:-${repo_root:h}}"
if [[ ! -d "${configured_projects_root}" ]]; then
  print -u2 "Project root does not exist: ${configured_projects_root}"
  exit 78
fi

mkdir -p "${launch_agents_dir}" "${repo_root}/.runtime/logs"

escaped_repo="${repo_root//\\/\\\\}"
escaped_repo="${escaped_repo//&/\\&}"
escaped_repo="${escaped_repo//|/\\|}"

for label in "${labels[@]}"; do
  template="${repo_root}/deploy/launchd/${label}.plist.template"
  target="${launch_agents_dir}/${label}.plist"
  temporary="$(/usr/bin/mktemp "${TMPDIR:-/tmp}/remote-shell-mobile.XXXXXX")"

  /usr/bin/sed "s|__REMOTE_SHELL_REPO_ROOT__|${escaped_repo}|g" "${template}" >"${temporary}"
  /usr/bin/plutil -lint "${temporary}" >/dev/null
  /bin/mv "${temporary}" "${target}"

  /bin/launchctl bootout "${user_domain}/${label}" >/dev/null 2>&1 || true
  /bin/launchctl bootstrap "${user_domain}" "${target}"
  /bin/launchctl enable "${user_domain}/${label}"
  /bin/launchctl kickstart -k "${user_domain}/${label}"
done

print "Remote Shell Mobile is running."
print "H5/API: http://127.0.0.1:${REMOTE_SHELL_PORT:-3001}"
print "Terminal: http://127.0.0.1:${REMOTE_SHELL_TTYD_PORT:-7681}"
