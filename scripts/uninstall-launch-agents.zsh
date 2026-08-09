#!/bin/zsh

set -euo pipefail

launch_agents_dir="${HOME}/Library/LaunchAgents"
user_domain="gui/$(/usr/bin/id -u)"
labels=(dev.remote-shell-mobile.server dev.remote-shell-mobile.ttyd)

for label in "${labels[@]}"; do
  /bin/launchctl bootout "${user_domain}/${label}" >/dev/null 2>&1 || true
  /bin/rm -f "${launch_agents_dir}/${label}.plist"
done

print "Remote Shell Mobile LaunchAgents were removed. Runtime data was kept."
