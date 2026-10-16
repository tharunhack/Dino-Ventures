#!/usr/bin/env bash
#
# One-shot setup: start Postgres, apply migrations, load seed data.
#
#   ./setup.sh              start Postgres in Docker, then migrate + seed
#   ./setup.sh --local      skip Docker, use an existing DATABASE_URL
#   ./setup.sh --reset      drop the schema first (destroys all data)
#
# After this, `npm start` serves the API on http://localhost:3000.

set -euo pipefail

USE_DOCKER=1
RESET=0

for arg in "$@"; do
  case "$arg" in
    --local) USE_DOCKER=0 ;;
    --reset) RESET=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

POSTGRES_PORT="${POSTGRES_PORT:-5432}"
export DATABASE_URL="${DATABASE_URL:-postgres://wallet:wallet@localhost:${POSTGRES_PORT}/wallet}"

echo "==> DATABASE_URL=${DATABASE_URL}"

if [ "$USE_DOCKER" -eq 1 ]; then
  echo "==> starting Postgres (host port ${POSTGRES_PORT})"
  POSTGRES_PORT="$POSTGRES_PORT" docker compose up -d postgres

  echo "==> waiting for Postgres to accept connections"
  for _ in $(seq 1 60); do
    if docker compose exec -T postgres pg_isready -U wallet -d wallet >/dev/null 2>&1; then
      echo "    ready"
      break
    fi
    sleep 1
  done
fi

if [ ! -d node_modules ]; then
  echo "==> installing dependencies"
  npm install --no-audit --no-fund
fi

echo "==> applying migrations"
if [ "$RESET" -eq 1 ]; then
  node scripts/migrate.js --reset
else
  node scripts/migrate.js
fi

echo "==> loading seed data"
node scripts/seed.js

cat <<'DONE'

Setup complete.

  npm start                 serve the API on http://localhost:3000
  npm test                  run the integration suite
  npm run loadtest          prove the concurrency guarantees

DONE
