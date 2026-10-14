#!/usr/bin/env bash
# dsh-computer: macOS (Apple silicon) feasibility check for the microsandbox backend.
#   bash check-mac.sh            # smoke test (tiny image) + full AIO test
#   bash check-mac.sh --smoke    # only the quick microVM smoke test
# Writes a full log next to this script: dsh-computer-check.log
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
LOG="$HERE/dsh-computer-check.log"
exec > >(tee "$LOG") 2>&1

IMAGE="${IMAGE:-ghcr.io/agent-infra/sandbox:latest}"
SMOKE_IMAGE="${SMOKE_IMAGE:-alpine:3.20}"
PORT="${PORT:-18080}"
SMOKE_ONLY=0; [ "${1:-}" = "--smoke" ] && SMOKE_ONLY=1

declare -a RES
step() { # name ok detail
  local tag; if [ "$2" = 1 ]; then tag=PASS; printf '\033[32m'; else tag=FAIL; printf '\033[31m'; fi
  printf '[%s] %s %s\033[0m\n' "$tag" "$1" "${3:-}"; RES+=("$(printf '%-34s %s' "$1" "$tag")")
}
summary() { echo "== Summary"; printf '%s\n' "${RES[@]}"; echo "Log saved to: $LOG"; }
code() { curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 5 "$1" 2>/dev/null || echo 000; }
waitfor() { local i=0; while [ $i -lt "$2" ]; do [ "$(code "$1")" = 200 ] && return 0; sleep 2; i=$((i+2)); done; return 1; }
secs() { echo $(( $(date +%s) - $1 )); }

echo "== Environment"
sw_vers 2>/dev/null | tr '\n' ' '; echo; echo "arch: $(uname -m), RAM: $(( $(sysctl -n hw.memsize) / 1073741824 )) GB"
df -h "$HOME" | tail -1
NODE_V="$(node -v 2>/dev/null || true)"; NODE_MAJOR="${NODE_V#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
[ -n "$NODE_V" ] && [ "${NODE_MAJOR:-0}" -ge 22 ] && step 'node>=22' 1 "($NODE_V)" || { step 'node>=22' 0 "($NODE_V) — install with: brew install node"; summary; exit 1; }
[ "$(uname -m)" = arm64 ] && step 'apple silicon' 1 || { step 'apple silicon' 0 '(microsandbox needs Apple silicon on macOS)'; summary; exit 1; }

echo "== Install microsandbox (temp folder)"
WORK="${TMPDIR:-/tmp}/dsh-computer-check"; mkdir -p "$WORK"
( cd "$WORK" && [ -f package.json ] || npm init -y >/dev/null; cd "$WORK" && npm i microsandbox@0.7.8 --no-fund --no-audit 2>&1 | tail -2 )
MSB="$(find "$WORK/node_modules" -type f -name msb -perm -u+x 2>/dev/null | head -1)"
[ -n "$MSB" ] && step 'msb bundled binary' 1 "($MSB)" || { step 'msb bundled binary' 0; summary; exit 1; }

echo "== Host virtualization (msb doctor)"
"$MSB" doctor && step 'hypervisor available' 1 || { step 'hypervisor available' 0; summary; exit 1; }

echo "== Proxy"
# msb (reqwest) reads HTTPS_PROXY, not the macOS system proxy that Clash/Surge set.
if [ -z "${HTTPS_PROXY:-}" ]; then
  P="$(scutil --proxy 2>/dev/null)"
  if echo "$P" | grep -q 'HTTPSEnable : 1'; then
    H="$(echo "$P" | awk '/HTTPSProxy :/{print $3}')"; PT="$(echo "$P" | awk '/HTTPSPort :/{print $3}')"
    export HTTPS_PROXY="http://$H:$PT" HTTP_PROXY="http://$H:$PT"
  elif echo "$P" | grep -q 'HTTPEnable : 1'; then
    H="$(echo "$P" | awk '/HTTPProxy :/{print $3}')"; PT="$(echo "$P" | awk '/HTTPPort :/{print $3}')"
    export HTTPS_PROXY="http://$H:$PT" HTTP_PROXY="http://$H:$PT"
  fi
fi
export NO_PROXY="localhost,127.0.0.1"
echo "HTTPS_PROXY=${HTTPS_PROXY:-<none, direct download>}"

SHARED="$HOME/dsh-computer-check-share"; mkdir -p "$SHARED"; echo hello-from-mac > "$SHARED/from-host.txt"; rm -f "$SHARED/from-vm.txt"

echo "== Smoke test: tiny microVM ($SMOKE_IMAGE)"
S=dsh-computer-smoke; SP=$((PORT+1))
t=$(date +%s); "$MSB" pull "$SMOKE_IMAGE" && step 'smoke image pull' 1 "($(secs $t)s)" || step 'smoke image pull' 0
"$MSB" rm -f -q "$S" >/dev/null 2>&1
t=$(date +%s)
if "$MSB" create --name "$S" -m 512M -c 1 -p "127.0.0.1:$SP:8080" --mount-dir "$SHARED:$SHARED" "$SMOKE_IMAGE"; then
  step 'microVM boot' 1 "($(secs $t)s)"
  U="$("$MSB" exec "$S" --no-tty -- uname -sr 2>&1)"; echo "$U" | grep -q Linux && step 'microVM exec' 1 "($U)" || step 'microVM exec' 0 "($U)"
  R="$("$MSB" exec "$S" --no-tty -- cat "$SHARED/from-host.txt" 2>&1)"; echo "$R" | grep -q hello-from-mac && step 'shared folder host->VM' 1 || step 'shared folder host->VM' 0 "($R)"
  "$MSB" exec "$S" --no-tty -- sh -c "echo hello-from-vm > $SHARED/from-vm.txt" >/dev/null 2>&1
  grep -q hello-from-vm "$SHARED/from-vm.txt" 2>/dev/null && step 'shared folder VM->host' 1 || step 'shared folder VM->host' 0
  "$MSB" exec "$S" --no-tty -- sh -c 'mkdir -p /www && echo smoke-ok > /www/index.html && (busybox httpd -p 8080 -h /www &) ; sleep 1' >/dev/null 2>&1
  curl -s --noproxy '*' --max-time 5 "http://127.0.0.1:$SP/" | grep -q smoke-ok && step 'port forward host->VM' 1 || step 'port forward host->VM' 0
  "$MSB" exec "$S" --no-tty -- sh -c 'wget -q -O /dev/null -T 10 https://www.bing.com && echo net-ok' 2>&1 | grep -q net-ok && step 'VM internet access' 1 || step 'VM internet access' 0
  "$MSB" metrics "$S" 2>&1 | head -4
  t=$(date +%s); "$MSB" stop "$S" >/dev/null 2>&1; "$MSB" start "$S" >/dev/null 2>&1
  "$MSB" exec "$S" --no-tty -- cat "$SHARED/from-host.txt" >/dev/null 2>&1 && step 'stop/start (persistence)' 1 "($(secs $t)s)" || step 'stop/start (persistence)' 0
  "$MSB" rm -f -q "$S" >/dev/null 2>&1
else
  step 'microVM boot' 0
fi
[ $SMOKE_ONLY = 1 ] && { summary; exit 0; }

echo "== Pull AIO image (~3.6 GB download the first time)"
t=$(date +%s); ok=0
for try in 1 2 3; do
  [ $try -gt 1 ] && echo "retry $try/3 (finished layers are kept)…"
  "$MSB" pull "$IMAGE" && { ok=1; break; }
done
step 'AIO image pull' $ok "($(secs $t)s)"
[ $ok = 1 ] || { summary; exit 1; }

N=dsh-computer-check; B="http://127.0.0.1:$PORT"; booted=0
for init in "" "--init auto"; do
  echo "== Boot AIO VM (${init:-image entrypoint})"
  "$MSB" rm -f -q "$N" >/dev/null 2>&1
  t=$(date +%s)
  # shellcheck disable=SC2086
  "$MSB" create --name "$N" --hostname dsh-computer -m 4G -c 2 -p "127.0.0.1:$PORT:8080" \
    --mount-dir "$SHARED:$SHARED:uid=1000,gid=1000" \
    -e DISABLE_JUPYTER=true -e DISABLE_CODE_SERVER=true -e DISABLE_NODEJS_REPL=true $init "$IMAGE" || continue
  if waitfor "$B/v1/sandbox" 240; then step "AIO boot (${init:-entrypoint})" 1 "($(secs $t)s)"; booted=1; break; fi
  step "AIO boot (${init:-entrypoint})" 0 "($(secs $t)s)"; "$MSB" logs --tail 40 "$N" 2>&1
done
if [ $booted = 1 ]; then
  W="$("$MSB" exec "$N" -u gem --no-tty -- sh -c 'whoami; hostname' 2>&1 | tr '\n' ' ')"
  echo "$W" | grep -q gem && step 'shell exec as gem' 1 "($W)" || step 'shell exec as gem' 0 "($W)"
  "$MSB" exec "$N" -u gem --no-tty -- cat "$SHARED/from-host.txt" 2>&1 | grep -q hello-from-mac && step 'AIO shared folder' 1 || step 'AIO shared folder' 0
  waitfor "$B/cdp/json/version" 60 && step 'browser CDP' 1 || step 'browser CDP' 0
  curl -s --noproxy '*' --max-time 10 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}' "$B/mcp" \
    | grep -q protocolVersion && step 'browser MCP' 1 || step 'browser MCP' 0
  [ "$(code "$B/vnc/index.html")" = 200 ] && step 'live view (noVNC page)' 1 || step 'live view (noVNC page)' 0
  "$MSB" metrics "$N" 2>&1 | head -4
  echo; echo "Live view: $B/vnc/index.html?autoconnect=true&resize=scale"
  echo "VM left running. Remove later with: \"$MSB\" rm -f $N"
fi
summary
