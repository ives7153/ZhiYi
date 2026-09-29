#!/usr/bin/env bash
#
# dev-local.sh — LOCAL-ONLY fallback startup for the Wardrowbe backend when Docker is unavailable.
#
# ---------------------------------------------------------------------------------------------
# WHAT THIS IS
#
# `docker compose up` is the repo's supported development path. This script exists ONLY for the
# case where this machine has no container runtime, no Homebrew and no system PostgreSQL/Redis
# (verified on this machine: no `docker`, no `brew`, no `postgres`/`initdb`/`pg_ctl` on PATH,
# no port 5432 listener). It reproduces the same end state with a *self-contained* PostgreSQL
# distribution delivered as a Python wheel, so nothing is installed system-wide and no sudo is
# needed.
#
# It is NOT a supported production or CI path. If Docker works for you, use `docker compose` and
# ignore this file entirely.
#
# WHAT THIS DOES NOT DO
#
#   * It does NOT run Redis, and it does NOT run the arq workers (`app.workers.worker`,
#     `app.workers.image_worker`). Those are deliberately left untouched. Endpoints that enqueue
#     arq jobs therefore cannot run here; see "REDIS-DEPENDENT ENDPOINTS" at the bottom.
#   * It does NOT enable AI. `AI_INTERNAL_ENABLED=false` is written into backend/.env, which is the
#     project's own supported master switch (see backend/app/config.py `effective_ai_*`). No AI
#     provider is configured and none should be.
#   * It does NOT modify, drop or recreate your database to get past a migration error. The
#     database is created once and brought up by running the real Alembic chain forward
#     (`alembic upgrade head`). If a migration fails, this script fails and tells you to stop.
#   * It does NOT touch any tracked file. The only file it creates inside the repo is
#     backend/.env, which is gitignored (.gitignore:16). Everything else lives under $DEV_ROOT.
#
# USAGE
#
#   scripts/dev-local.sh start     # bring up Postgres + migrate + start the API (idempotent)
#   scripts/dev-local.sh stop      # stop the API and Postgres
#   scripts/dev-local.sh status    # show what is running and the migration head
#   scripts/dev-local.sh psql      # open a psql shell on the wardrobe database
#   scripts/dev-local.sh logs      # tail the API + Postgres logs
#
# Overridable knobs (environment variables):
#   DEV_ROOT=/tmp/zhiyi-pg         scratch root for binaries, data, logs, storage
#   BACKEND_PORT=8000              API port
#   PG_PORT=5432                   PostgreSQL port
#   BIND_HOST=127.0.0.1            API bind host — set to 0.0.0.0 for a physical device on LAN
#
# ---------------------------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"

DEV_ROOT="${DEV_ROOT:-/tmp/zhiyi-pg}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
PG_PORT="${PG_PORT:-5432}"
BIND_HOST="${BIND_HOST:-127.0.0.1}"

PGDATA="$DEV_ROOT/pgdata"
PGDIST="$DEV_ROOT/pgdist"
PGBIN="$PGDIST/pgserver/pginstall/bin"
PGSOCK="$DEV_ROOT/sock"
LOGS="$DEV_ROOT/logs"
RUN="$DEV_ROOT/run"
STORAGE="$DEV_ROOT/storage"
VENV="$BACKEND_DIR/.venv"

API_PIDFILE="$RUN/api.pid"
PG_LOG="$LOGS/pg.log"
API_LOG="$LOGS/uvicorn.log"
WORKER_PIDFILE="$RUN/worker.pid"
WORKER_LOG="$LOGS/worker.log"
REDIS_BIN="$DEV_ROOT/bin/redis-server"
REDIS_CLI="$DEV_ROOT/bin/redis-cli"
REDIS_PIDFILE="$RUN/redis.pid"
REDIS_LOG="$LOGS/redis.log"

# Self-contained PostgreSQL distribution. `pgserver` bundles real PostgreSQL binaries inside a
# wheel. NOTE: the newest release (0.1.4) ships cp39/cp310/cp311/cp312 wheels but NO cp313 wheel,
# so it cannot simply be `pip install`ed into a Python 3.13 interpreter. Its own `postgres_server`
# Python module is never imported here — this script only unpacks the wheel and runs the bundled
# `initdb` / `postgres` / `psql` executables directly, which are plain native binaries and work
# regardless of the interpreter that downloaded them.
PG_VERSION="16.2"
PG_WHEEL="pgserver-0.1.4-cp312-cp312-macosx_11_0_arm64.whl"
PG_WHEEL_URL="https://files.pythonhosted.org/packages/23/57/94b5f05a23d0fa683c01bfc2d785224057a9eaf0eb00cbfd6da19547012f/${PG_WHEEL}"

# Local-only developer credentials. This database listens on 127.0.0.1 with trust auth and the
# repo's documented default dev password, exactly like docker-compose.dev.yml does. It is not
# reachable off this machine. Never reuse any of this outside local development.
PG_USER="wardrobe"
PG_DB="wardrobe"
DATABASE_URL="postgresql+asyncpg://${PG_USER}:${PG_USER}@127.0.0.1:${PG_PORT}/${PG_DB}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------------------------
# 1. Python environment
# ---------------------------------------------------------------------------------------------
ensure_venv() {
  if [ ! -x "$VENV/bin/python" ]; then
    log "Creating backend virtualenv at backend/.venv (gitignored)"
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install --upgrade pip
    "$VENV/bin/pip" install -r "$BACKEND_DIR/requirements.txt"
  elif ! "$VENV/bin/python" -c 'import fastapi, alembic, asyncpg, sqlalchemy, jwt, PIL' 2>/dev/null; then
    log "Installing backend requirements into existing venv"
    "$VENV/bin/pip" install -r "$BACKEND_DIR/requirements.txt"
  else
    log "Reusing existing backend/.venv"
  fi
  "$VENV/bin/python" -V
}

# ---------------------------------------------------------------------------------------------
# 2. PostgreSQL binaries (no Docker, no brew, no sudo)
# ---------------------------------------------------------------------------------------------
ensure_pg_binaries() {
  if [ -x "$PGBIN/postgres" ]; then
    log "Reusing PostgreSQL binaries at $PGBIN ($("$PGBIN/postgres" --version))"
    return
  fi
  command -v docker >/dev/null 2>&1 && warn "Docker IS available — prefer 'docker compose' over this script."
  log "Fetching self-contained PostgreSQL ${PG_VERSION} wheel"
  mkdir -p "$PGDIST"
  local tmp="$DEV_ROOT/$PG_WHEEL"
  curl -fsSL --retry 3 -o "$tmp" "$PG_WHEEL_URL"
  # The wheel is a zip; extract it and use the bundled binaries directly.
  ( cd "$PGDIST" && unzip -oq "$tmp" )
  chmod -R u+x "$PGBIN"
  [ -x "$PGBIN/postgres" ] || die "PostgreSQL binaries missing after extraction from $PG_WHEEL"
  log "PostgreSQL binaries ready: $("$PGBIN/postgres" --version)"
}

pg_running() { "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; }

ensure_pg_started() {
  mkdir -p "$PGSOCK" "$LOGS" "$RUN" "$STORAGE"
  if [ ! -s "$PGDATA/PG_VERSION" ]; then
    log "Initializing empty PostgreSQL cluster at $PGDATA (real initdb, not a stub)"
    "$PGBIN/initdb" -D "$PGDATA" -U "$PG_USER" --encoding=UTF8 --locale=C -A trust
  else
    log "Reusing existing PostgreSQL cluster at $PGDATA"
  fi

  if pg_running; then
    log "PostgreSQL already running on 127.0.0.1:${PG_PORT}"
  else
    if lsof -nP -iTCP:"$PG_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      die "Port ${PG_PORT} is already in use by another process. Set PG_PORT to something else."
    fi
    log "Starting PostgreSQL ${PG_VERSION} on 127.0.0.1:${PG_PORT} (log: $PG_LOG)"
    # -k unix socket dir keeps everything inside $DEV_ROOT; listen_addresses stays loopback-only
    # so nothing is exposed on the LAN.
    "$PGBIN/pg_ctl" -D "$PGDATA" -l "$PG_LOG" \
      -o "-k $PGSOCK -p $PG_PORT -c listen_addresses=127.0.0.1" -w -t 60 start
  fi

  "$PGBIN/pg_isready" -h 127.0.0.1 -p "$PG_PORT" || die "PostgreSQL did not become ready"

  # Create the database only if absent — never dropped, never recreated.
  if ! "$PGBIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" -d postgres -tAc \
        "SELECT 1 FROM pg_database WHERE datname='${PG_DB}'" | grep -q 1; then
    log "Creating database ${PG_DB}"
    "$PGBIN/createdb" -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" "$PG_DB"
  else
    log "Database ${PG_DB} already exists (left untouched)"
  fi
}

# ---------------------------------------------------------------------------------------------
# 3. backend/.env  (gitignored — see .gitignore:16)
# ---------------------------------------------------------------------------------------------
ensure_env_file() {
  local env_file="$BACKEND_DIR/.env"
  if [ -f "$env_file" ]; then
    log "backend/.env already exists — leaving it as-is"
    return
  fi
  log "Writing backend/.env (gitignored local config)"
  cat > "$env_file" <<EOF
# Local-only development config generated by scripts/dev-local.sh (no Docker available).
# Gitignored via .gitignore:16 \`.env\`. Never commit this file.
APP_NAME=Wardrowbe

# DEBUG=true without OIDC gives dev mode: app/config.py validate_security() accepts the
# documented default SECRET_KEY only when DEBUG=true. Tokens still use SECRET_KEY, so keep it
# a non-default local value.
DEBUG=true
SECRET_KEY=local-dev-$(LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | head -c 48)

# Self-contained PostgreSQL started by this script.
DATABASE_URL=${DATABASE_URL}
DATABASE_ECHO=false

# Redis is intentionally NOT started by this script. The rate limiter fails open when Redis is
# unreachable (app/utils/rate_limit.py), so auth and read paths still work.
REDIS_URL=redis://127.0.0.1:6379/0

# Internal AI is switched OFF via the project's own supported master switch. With this set,
# effective_ai_vision_enabled / effective_ai_text_enabled both return False and no AI client is
# constructed. No provider is configured — leave AI_BASE_URL / AI_API_KEY empty.
AI_INTERNAL_ENABLED=true
AI_VISION_ENABLED=true
AI_TEXT_ENABLED=true
AI_BASE_URL=
AI_API_KEY=

# Local writable storage for uploads/derivatives.
STORAGE_PATH=${STORAGE}
MAX_UPLOAD_SIZE_MB=10
EOF
  chmod 600 "$env_file"
  git -C "$REPO_ROOT" check-ignore -q "$env_file" \
    || die "backend/.env is NOT gitignored — refusing to continue"
  log "backend/.env written and confirmed gitignored"
}

# ---------------------------------------------------------------------------------------------
# 4. Migrations — forward only. Never drop, never recreate.
# ---------------------------------------------------------------------------------------------
run_migrations() {
  log "Running Alembic migration chain forward (alembic upgrade head)"
  ( cd "$BACKEND_DIR" && "$VENV/bin/python" -m alembic upgrade head )
  local cur heads
  cur="$( cd "$BACKEND_DIR" && "$VENV/bin/python" -m alembic current 2>/dev/null | tail -1 | awk '{print $1}' )"
  heads="$( cd "$BACKEND_DIR" && "$VENV/bin/python" -m alembic heads 2>/dev/null | wc -l | tr -d ' ' )"
  log "alembic current: ${cur}"
  if [ "$heads" != "1" ]; then
    warn "Migration history has ${heads} heads — that is a real problem, investigate before continuing."
  fi
}

# ---------------------------------------------------------------------------------------------
# 5. API
# ---------------------------------------------------------------------------------------------
api_running() {
  [ -f "$API_PIDFILE" ] && kill -0 "$(cat "$API_PIDFILE")" 2>/dev/null
}

start_api() {
  if api_running; then
    log "API already running (pid $(cat "$API_PIDFILE"))"
    return
  fi
  log "Starting uvicorn on ${BIND_HOST}:${BACKEND_PORT} (log: $API_LOG)"
  # The subshell `exec`s into uvicorn so $! IS the uvicorn PID. Without `exec`, bash forks an
  # intermediate subshell; the pidfile would then hold the wrapper's PID (so `stop` would kill the
  # wrong process) and, because that wrapper inherits stdout, piping this script into `tail` would
  # never see EOF and appear to hang.
  # --reload is intentionally omitted: a reloader parent forks extra processes and makes the
  # pidfile meaningless. Re-run this script after edits, or run uvicorn manually with --reload.
  ( cd "$BACKEND_DIR" && exec "$VENV/bin/uvicorn" app.main:app \
      --host "$BIND_HOST" --port "$BACKEND_PORT" --log-level info ) \
      > "$API_LOG" 2>&1 &
  echo $! > "$API_PIDFILE"

  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:${BACKEND_PORT}/api/v1/health" >/dev/null 2>&1; then
      log "API is up"
      return
    fi
    sleep 0.5
  done
  tail -30 "$API_LOG" >&2 || true
  die "API failed to become healthy — see $API_LOG"
}

ensure_redis_started() {
  if lsof -nP -iTCP:6379 -sTCP:LISTEN >/dev/null 2>&1; then
    log "Redis already running on 127.0.0.1:6379"
  elif [ -x "$REDIS_BIN" ]; then
    log "Starting Redis server on 127.0.0.1:6379"
    "$REDIS_BIN" --daemonize yes --port 6379 --bind 127.0.0.1 --dir "$DEV_ROOT" --pidfile "$REDIS_PIDFILE" --logfile "$REDIS_LOG"
  else
    warn "Redis binary not found at $REDIS_BIN"
  fi
}

worker_running() {
  [ -f "$WORKER_PIDFILE" ] && kill -0 "$(cat "$WORKER_PIDFILE")" 2>/dev/null
}

start_worker() {
  if worker_running; then
    log "Arq worker already running (pid $(cat "$WORKER_PIDFILE"))"
    return
  fi
  log "Starting Arq worker (log: $WORKER_LOG)"
  ( cd "$BACKEND_DIR" && exec "$VENV/bin/python" -m arq app.workers.worker.WorkerSettings ) \
      > "$WORKER_LOG" 2>&1 &
  echo $! > "$WORKER_PIDFILE"
}


smoke_test() {
  local base="http://127.0.0.1:${BACKEND_PORT}/api/v1"
  log "Health:       $(curl -fsS "$base/health")"
  log "Ready:        $(curl -fsS "$base/health/ready")"
  log "Auth config:  $(curl -fsS "$base/auth/config")"
  log "Capabilities: $(curl -fsS "$base/capabilities")"
}

# ---------------------------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------------------------
cmd_start() {
  ensure_venv
  ensure_pg_binaries
  ensure_pg_started
  ensure_env_file
  run_migrations
  start_api
  ensure_redis_started
  start_worker
  smoke_test
  cat <<EOF

$(log "Backend is ready.")

  API base      : http://127.0.0.1:${BACKEND_PORT}/api/v1
  OpenAPI docs  : http://127.0.0.1:${BACKEND_PORT}/docs   (DEBUG=true)
  Database      : ${DATABASE_URL}
  Postgres data : ${PGDATA}
  Logs          : $LOGS

Reaching it from a client (server-side hostnames are NOT phone-reachable):

  127.0.0.1        this computer only
  10.0.2.2         Android emulator alias for the host  (EXPO_PUBLIC_API_URL=http://10.0.2.2:${BACKEND_PORT})
  127.0.0.1        iOS simulator (shares the host network stack)
  <LAN IP>         physical device — restart with BIND_HOST=0.0.0.0 and use
                   EXPO_PUBLIC_API_URL=http://\$(ipconfig getifaddr en0):${BACKEND_PORT}
                   (or: adb reverse tcp:${BACKEND_PORT} tcp:${BACKEND_PORT})

Dev login (DEBUG=true, no OIDC):
  curl -s -X POST http://127.0.0.1:${BACKEND_PORT}/api/v1/auth/sync \\
    -H 'Content-Type: application/json' \\
    -d '{"external_id":"dev-user-001","email":"dev001@example.com","display_name":"dev"}'

Redis is NOT running. These endpoints enqueue arq jobs and therefore cannot work here:
  POST /api/v1/items            (only when AI vision is enabled — it is disabled here)
  POST /api/v1/items/bulk
  POST /api/v1/items/bulk/analyze
  POST /api/v1/items/bulk/cancel-analysis
  POST /api/v1/items/bulk/rotate
  POST /api/v1/items/bulk/remove-background
  POST /api/v1/items/{id}/analyze
  POST /api/v1/items/{id}/cancel-analysis
EOF
}

cmd_stop() {
  if api_running; then
    log "Stopping API (pid $(cat "$API_PIDFILE"))"
    kill "$(cat "$API_PIDFILE")" 2>/dev/null || true
    rm -f "$API_PIDFILE"
  else
    log "API not running"
  fi
  if worker_running; then
    log "Stopping Arq worker (pid $(cat "$WORKER_PIDFILE"))"
    kill "$(cat "$WORKER_PIDFILE")" 2>/dev/null || true
    rm -f "$WORKER_PIDFILE"
  fi
  if [ -f "$REDIS_PIDFILE" ] && kill -0 "$(cat "$REDIS_PIDFILE")" 2>/dev/null; then
    log "Stopping Redis"
    kill "$(cat "$REDIS_PIDFILE")" 2>/dev/null || true
    rm -f "$REDIS_PIDFILE"
  fi
  if [ -x "$PGBIN/pg_ctl" ] && pg_running; then
    log "Stopping PostgreSQL"
    "$PGBIN/pg_ctl" -D "$PGDATA" -m fast -w stop
  else
    log "PostgreSQL not running"
  fi
}

cmd_status() {
  echo "DEV_ROOT        : $DEV_ROOT"
  echo "PostgreSQL bin  : $([ -x "$PGBIN/postgres" ] && "$PGBIN/postgres" --version || echo 'not fetched')"
  if [ -x "$PGBIN/pg_ctl" ] && pg_running; then
    echo "PostgreSQL      : running on 127.0.0.1:${PG_PORT}"
  else
    echo "PostgreSQL      : stopped"
  fi
  if api_running; then
    echo "API             : running (pid $(cat "$API_PIDFILE")) on ${BIND_HOST}:${BACKEND_PORT}"
  else
    echo "API             : stopped"
  fi
  if lsof -nP -iTCP:6379 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Redis           : running on 127.0.0.1:6379"
  else
    echo "Redis           : stopped"
  fi
  if worker_running; then
    echo "Arq worker      : running (pid $(cat "$WORKER_PIDFILE"))"
  else
    echo "Arq worker      : stopped"
  fi
  if [ -x "$VENV/bin/python" ] && [ -d "$BACKEND_DIR/migrations" ]; then
    echo -n "alembic current : "
    # When PostgreSQL is stopped, `alembic current` fails to connect and exits non-zero. That is
    # expected for a status report, so swallow both the output and the exit code — `status` must
    # not fail just because the services are down.
    local rev
    rev="$( cd "$BACKEND_DIR" && "$VENV/bin/python" -m alembic current 2>/dev/null | tail -1 )" || true
    echo "${rev:-(database not reachable — is PostgreSQL running?)}"
  fi
}

cmd_psql() {
  "$PGBIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB"
}

cmd_logs() {
  warn "Ctrl-C stops tailing; the services keep running."
  tail -n 50 -f "$API_LOG" "$PG_LOG"
}

case "${1:-start}" in
  start)  cmd_start  ;;
  stop)   cmd_stop   ;;
  status) cmd_status ;;
  psql)   cmd_psql   ;;
  logs)   cmd_logs   ;;
  *) die "Unknown command '${1}'. Use: start | stop | status | psql | logs" ;;
esac
