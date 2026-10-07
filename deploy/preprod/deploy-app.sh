#!/usr/bin/env bash
# Deploys one git ref of this repo to the preprod server, then restarts the
# control API and the operator UI. Run it from the repo root on a machine
# with SSH access. Each deploy is a new folder under ~/tally-app/releases;
# ~/tally-app/current points at the live one. Data stays in ~/tally-app/data.
#
# Usage: deploy/preprod/deploy-app.sh [git ref]   (default: HEAD)
# Settings: TALLY_HOST (default ubuntu@13.210.42.0), TALLY_SSH_KEY (default ~/.ssh/tally-aws.pem),
#           TALLY_PUBLIC_URL (default https://13-210-42-0.sslip.io)
set -euo pipefail
ref="${1:-HEAD}"
host="${TALLY_HOST:-ubuntu@13.210.42.0}"
key="${TALLY_SSH_KEY:-$HOME/.ssh/tally-aws.pem}"
url="${TALLY_PUBLIC_URL:-https://13-210-42-0.sslip.io}"
sha="$(git rev-parse --short "$ref")"
remote=(ssh -i "$key" -o BatchMode=yes -o ServerAliveInterval=15 "$host")

echo "deploying $ref ($sha) to $host"
git archive --format=tar --prefix="$sha/" "$ref" |
  "${remote[@]}" "mkdir -p ~/tally-app/releases ~/tally-app/data && rm -rf ~/tally-app/releases/$sha && tar -x -C ~/tally-app/releases"
"${remote[@]}" "set -e
  cd ~/tally-app/releases/$sha
  rm -rf services/.data && ln -s \$HOME/tally-app/data services/.data
  ~/.bun/bin/bun install --frozen-lockfile > ~/tally-app/install-$sha.log 2>&1
  ln -sfn \$HOME/tally-app/releases/$sha \$HOME/tally-app/current
  sudo systemctl restart tally-services tally-ui
  for i in \$(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:8791/ && break; sleep 2; done
  systemctl is-active tally-services tally-ui"
curl -fsS -o /dev/null -w "public UI: HTTP %{http_code}\n" "$url/"
echo "live: $sha. Roll back: ssh in, ln -sfn ~/tally-app/releases/<old sha> ~/tally-app/current, sudo systemctl restart tally-services tally-ui"
