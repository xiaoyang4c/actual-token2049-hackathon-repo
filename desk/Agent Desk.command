#!/bin/zsh
# Double-click to start Agent Desk. v2 opens at http://localhost:8800/v2, v1 stays at /
cd "$(dirname "$0")"
BUN="$HOME/.bun/bin/bun"
[ -x "$BUN" ] || { echo "Bun is missing. Install it: curl -fsSL https://bun.sh/install | bash"; read; exit 1; }
[ -d ../node_modules ] || (cd .. && "$BUN" install && cd cre/agent-loop && "$BUN" install)
[ -f web/dist/index.html ] || (cd web && npm install && npm run build)
[ -f web-v2/dist/index.html ] || (cd web-v2 && npm install && npm run build)
(sleep 3 && open http://localhost:8800/v2) &
exec "$BUN" run server.ts
