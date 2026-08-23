#!/usr/bin/env bash
# Launch the Munder Difflin dev app under WSLg, DETACHED from the terminal.
#
# Two WSLg quirks bite a normal `pnpm dev`:
#  1) Attached to an interactive terminal, the Electron process group gets
#     SIGTSTP'd (job control shows "Stopped") — a stopped process paints its
#     window but responds to nothing: no clicks, no close. `setsid` + no tty
#     (stdin from /dev/null) keeps it out of job control so it runs normally.
#  2) WSLg's virtual GPU makes Electron's GPU process log an init error and fall
#     back to software compositing; forcing Mesa's llvmpipe makes that fallback
#     clean. (Non-fatal either way, but keep it — belt and suspenders.)
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe
cd "$(dirname "${BASH_SOURCE[0]}")"

LOG="${TMPDIR:-/tmp}/munder-difflin-dev.log"
setsid pnpm dev </dev/null >"$LOG" 2>&1 &
PID=$!
disown 2>/dev/null || true
sleep 2
echo "Munder Difflin launching detached — session leader pid $PID"
echo "  window : should appear on your desktop in a few seconds"
echo "  logs   : tail -f \"$LOG\""
echo "  stop   : kill -- -$PID   (or just close the app window)"
