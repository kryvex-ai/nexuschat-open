#!/usr/bin/env bash
#
# Run the Electron app on a headless Linux box — a container, CI, or a remote
# shell with no desktop. Two things normally stop it, and neither needs root:
#
#   * GTK 3, which slim images do not ship. It is unpacked from the Ubuntu
#     archive into .electron-deps/ once and found through LD_LIBRARY_PATH on
#     every later run (apt-get download works as a normal user).
#   * the Chromium setuid sandbox, which needs a root-owned binary. A test
#     window skips it (--no-sandbox); the app's own security work (encryption
#     at rest) is unaffected.
#
# A window still needs a display, so xvfb-run supplies one when DISPLAY is
# empty. Everything after the mode is passed straight to Electron.
#
# Usage:
#   bash scripts/run-linux.sh run   [electron args…]  # normal start, real profile
#   bash scripts/run-linux.sh smoke [electron args…]  # boots once, prints SMOKE_OK, exits
#   bash scripts/run-linux.sh ui    [electron args…]  # boots, runs scripts/ui-check.js
#                                                     # against the live window, exits
#
# Smoke and ui use a throwaway profile, so they can never fight the running app
# over Electron's single-instance lock, and they always leave your own settings
# and chats alone. To poke at the real UI by hand, keep it open:
#   bash scripts/run-linux.sh run --remote-debugging-port=9222
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPS="$ROOT/.electron-deps"

ARCH="$(dpkg --print-architecture 2>/dev/null || echo amd64)"
case "$ARCH" in
  amd64) LIBSUB="x86_64-linux-gnu" ;;
  arm64) LIBSUB="aarch64-linux-gnu" ;;
  *)     LIBSUB="${ARCH}-linux-gnu" ;;
esac
LIBDIR="$DEPS/usr/lib/$LIBSUB"

# Electron's GTK 3 runtime: gtk itself, its lazily-loaded libraries, and the
# schemas that keep GtkSettings quiet (libgtk-3-common is arch-independent).
GTK_PACKAGES=(libgtk-3-0t64 libgtk-3-common libepoxy0 libwayland-cursor0)

log() { echo "run-linux: $*" >&2; }

have_gtk() {
  [ -e "$LIBDIR/libgtk-3.so.0" ] && return 0
  # libgtk-3-0 is the pre-t64 name; either one satisfies the loader.
  ldconfig -p 2>/dev/null | grep -q 'libgtk-3\.so\.0'
}

provision_gtk() {
  command -v apt-get >/dev/null || { log 'GTK 3 is missing and apt-get is not here — install it yourself'; return 1; }
  command -v dpkg-deb >/dev/null || { log 'GTK 3 is missing and dpkg-deb is not here — install it yourself'; return 1; }
  log 'GTK 3 is missing — unpacking it into .electron-deps (no root needed)'
  local work="$DEPS/.download"
  rm -rf "$work"; mkdir -p "$work" "$DEPS"
  local pkg
  for pkg in "${GTK_PACKAGES[@]}"; do
    ( cd "$work" && apt-get download "$pkg" >/dev/null 2>&1 ) \
      || log "could not fetch $pkg — if the system already has it, this is harmless"
  done
  local deb
  for deb in "$work"/*.deb; do
    [ -e "$deb" ] && dpkg-deb -x "$deb" "$DEPS"
  done
  rm -rf "$work"
}

if ! have_gtk; then
  provision_gtk || exit 1
fi
if [ -d "$LIBDIR" ]; then
  export LD_LIBRARY_PATH="$LIBDIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
else
  log 'no local GTK copy — relying on the system one'
fi

# GTK asks GSettings for a few defaults at startup: without its schemas it
# logs a critical and falls back. Point it at the ones we unpacked.
SCHEMAS="$DEPS/usr/share/glib-2.0/schemas"
if [ -d "$SCHEMAS" ]; then
  export GSETTINGS_SCHEMA_DIR="$SCHEMAS${GSETTINGS_SCHEMA_DIR:+:$GSETTINGS_SCHEMA_DIR}"
  if [ ! -e "$SCHEMAS/gschemas.compiled" ] && command -v glib-compile-schemas >/dev/null; then
    glib-compile-schemas "$SCHEMAS" >/dev/null 2>&1 || log 'could not compile the GTK schemas — only a warning, GTK uses defaults'
  fi
fi

MODE="${1:-run}"
shift || true

# No setuid sandbox in a container, and /dev/shm is usually far too small.
FLAGS=(--no-sandbox --disable-dev-shm-usage)
# Software rendering: Xvfb has no GPU, and a failed GPU init only adds noise.
FLAGS+=(--disable-gpu)

BIN="$ROOT/node_modules/electron/dist/electron"
[ -x "$BIN" ] || BIN="$ROOT/node_modules/.bin/electron"
if [ ! -e "$BIN" ]; then
  log 'Electron is not installed — run npm install first'
  exit 1
fi

CMD=()
if [ -z "${DISPLAY:-}" ]; then
  if command -v xvfb-run >/dev/null; then
    CMD=(xvfb-run -a)
  else
    log 'no DISPLAY and no xvfb-run — the window cannot open (apt-get install xvfb)'
  fi
fi
# The app is always this checkout; everything after the mode is an Electron flag
# (--remote-debugging-port=9222, say), never another app path.
CMD+=("$BIN" "$ROOT" "${FLAGS[@]}" "$@")

case "$MODE" in
  run)
    exec "${CMD[@]}"
    ;;
  smoke)
    # A throwaway profile keeps the single-instance lock out of the way and the
    # user's real data untouched. main.js prints SMOKE_OK once the window has
    # loaded, then exits by itself; the timeout is only a backstop.
    PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/nexus-smoke-XXXXXX")"
    LOGFILE="$PROFILE/boot.log"
    status=0
    NEXUS_SMOKE=1 timeout 90 "${CMD[@]}" --user-data-dir="$PROFILE" >"$LOGFILE" 2>&1 || status=$?
    cat "$LOGFILE"
    if grep -q 'SMOKE_OK' "$LOGFILE"; then
      log 'SMOKE_OK — the window loaded'
      rm -rf "$PROFILE"
      exit 0
    fi
    log "the window never loaded (exit $status) — log above"
    rm -rf "$PROFILE"
    exit 1
    ;;
  ui)
    # Boot the real window on a throwaway profile, let scripts/ui-check.js drive
    # it over CDP, then take it down again — pass or fail.
    PORT="${NEXUS_CDP_PORT:-9222}"
    PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/nexus-ui-XXXXXX")"
    LOGFILE="$PROFILE/boot.log"
    setsid "${CMD[@]}" --user-data-dir="$PROFILE" --remote-debugging-port="$PORT" >"$LOGFILE" 2>&1 &
    APP_PID=$!
    status=0
    NEXUS_CDP_PORT="$PORT" node "$ROOT/scripts/ui-check.js" || status=$?
    kill -- -"$APP_PID" 2>/dev/null || kill "$APP_PID" 2>/dev/null
    sleep 1
    if [ "$status" -ne 0 ]; then
      log "the live UI checks did not pass — app log:"
      tail -20 "$LOGFILE" >&2 || true
    fi
    rm -rf "$PROFILE"
    exit "$status"
    ;;
  *)
    log "unknown mode '$MODE' — use 'run' or 'smoke'"
    exit 2
    ;;
esac
