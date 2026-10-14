#!/usr/bin/env bash
# dsh-computer: second-stage macOS check. msb `create` boots its own agent as PID 1 and does not run
# the image ENTRYPOINT, so the AIO services (supervisord, Chrome, nginx, VNC, MCP) are started here
# as a runtime-owned job with `msb exec -d`. Also re-tests port forwarding with a detached server.
#   bash check-mac-aio.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
LOG="$HERE/dsh-computer-aio.log"
exec > >(tee "$LOG") 2>&1

IMAGE="${IMAGE:-ghcr.io/agent-infra/sandbox:latest}"
PORT="${PORT:-18080}"
WORK="${TMPDIR:-/tmp}/dsh-computer-check"
MSB="$(find "$WORK/node_modules" -type f -name msb -perm -u+x 2>/dev/null | head -1)"
[ -n "$MSB" ] || { echo "msb not found; run check-mac.sh first"; exit 1; }
SHARED="$HOME/dsh-computer-check-share"; mkdir -p "$SHARED"; echo hello-from-mac > "$SHARED/from-host.txt"

declare -a RES
step() { local tag; if [ "$2" = 1 ]; then tag=PASS; printf '\033[32m'; else tag=FAIL; printf '\033[31m'; fi
  printf '[%s] %s %s\033[0m\n' "$tag" "$1" "${3:-}"; RES+=("$(printf '%-34s %s' "$1" "$tag")"); }
code() { curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 5 "$1" 2>/dev/null || echo 000; }
waitfor() { local i=0; while [ $i -lt "$2" ]; do [ "$(code "$1")" = 200 ] && return 0; sleep 2; i=$((i+2)); done; return 1; }
secs() { echo $(( $(date +%s) - $1 )); }
X() { "$MSB" exec "$N" --no-tty "$@" 2>&1; }

echo "== Port forward with a detached server (alpine)"
S=dsh-computer-smoke; SP=$((PORT+1))
"$MSB" rm -f -q "$S" >/dev/null 2>&1
"$MSB" create --name "$S" -m 512M -c 1 -p "127.0.0.1:$SP:8080" alpine:3.20 >/dev/null 2>&1
"$MSB" exec "$S" --no-tty -- sh -c 'mkdir -p /www && echo smoke-ok > /www/index.html' >/dev/null 2>&1
"$MSB" exec -d "$S" -- busybox httpd -f -p 8080 -h /www
sleep 2
curl -s --noproxy '*' --max-time 5 "http://127.0.0.1:$SP/" | grep -q smoke-ok && step 'port forward (detached server)' 1 || {
  step 'port forward (detached server)' 0
  echo "-- inside VM:"; "$MSB" exec "$S" --no-tty -- sh -c 'wget -q -O - http://127.0.0.1:8080/ ; netstat -ltn 2>/dev/null | head' 2>&1
  "$MSB" inspect "$S" --format json 2>&1 | grep -iE -A3 '"port' | head -20
}
"$MSB" rm -f -q "$S" >/dev/null 2>&1

N=dsh-computer-check; B="http://127.0.0.1:$PORT"
echo "== Create AIO VM (agent only)"
"$MSB" rm -f -q "$N" >/dev/null 2>&1
t=$(date +%s)
"$MSB" create --name "$N" --hostname dsh-computer -m 4G -c 2 -p "127.0.0.1:$PORT:8080" \
  --mount-dir "$SHARED:$SHARED:uid=1000,gid=1000" \
  -e DISABLE_JUPYTER=true -e DISABLE_CODE_SERVER=true -e DISABLE_NODEJS_REPL=true "$IMAGE" \
  && step 'AIO create' 1 "($(secs $t)s)" || { step 'AIO create' 0; printf '%s\n' "${RES[@]}"; exit 1; }

echo "== Start image entrypoint as a detached job"
t=$(date +%s)
"$MSB" exec -d "$N" -u root -e DISABLE_JUPYTER=true -e DISABLE_CODE_SERVER=true -e DISABLE_NODEJS_REPL=true -- /opt/gem/run.sh
if waitfor "$B/v1/sandbox" 240; then
  step 'AIO services healthy' 1 "($(secs $t)s)"
else
  step 'AIO services healthy' 0 "($(secs $t)s)"
  echo "-- diagnostics"
  X -u root -- sh -c 'supervisorctl -c /opt/gem/supervisord.conf status 2>&1 | head -25; echo ---; tail -5 /var/log/nginx/error.log 2>/dev/null; echo ---; ls /proc/sys/net/ipv6 >/dev/null 2>&1 && echo ipv6:yes || echo ipv6:no'
  # Same fix as on hosts without IPv6: drop nginx "listen [::]" lines and restart it.
  echo "-- retry with IPv6 listeners removed"
  X -u root -- sh -c 'for f in $(grep -rln "listen \[::\]" /opt/gem /etc/nginx 2>/dev/null); do sed -i "/listen \[::\]/d" $f; done; supervisorctl -c /opt/gem/supervisord.conf restart nginx'
  waitfor "$B/v1/sandbox" 60 && step 'AIO services healthy (ipv6 patch)' 1 || step 'AIO services healthy (ipv6 patch)' 0
fi
W="$(X -u gem -- sh -c 'whoami; hostname' | tr '\n' ' ')"; echo "$W" | grep -q gem && step 'shell exec as gem' 1 "($W)" || step 'shell exec as gem' 0 "($W)"
X -u gem -- cat "$SHARED/from-host.txt" | grep -q hello-from-mac && step 'AIO shared folder' 1 || step 'AIO shared folder' 0
waitfor "$B/cdp/json/version" 60 && step 'browser CDP' 1 || step 'browser CDP' 0
curl -s --noproxy '*' --max-time 10 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}' "$B/mcp" \
  | grep -q protocolVersion && step 'browser MCP' 1 || step 'browser MCP' 0
[ "$(code "$B/vnc/index.html")" = 200 ] && step 'live view (noVNC page)' 1 || step 'live view (noVNC page)' 0
"$MSB" metrics "$N" 2>&1 | head -3
echo; echo "Live view: $B/vnc/index.html?autoconnect=true&resize=scale"
echo "VM left running. Remove later with: \"$MSB\" rm -f $N"
echo "== Summary"; printf '%s\n' "${RES[@]}"; echo "Log saved to: $LOG"
