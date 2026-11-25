#!/bin/sh
SELF=$(readlink "$0" 2>/dev/null || echo "$0")
HERE=$(dirname "$SELF")
CONF="$HERE/board.conf"
WORKER=$(dirname "${AGENT_BOARD_STATE_DIR:-/nonexistent/state}")
LOG="$WORKER/stub.log"
ACCEPT_TOKEN=abm_good
ACCEPT_KEY=abk1_good
MACHINE=studio
TICK_STATUS=ok
TICK_MESSAGE="the tick ran"
TICK_EXIT=0
SHUTDOWN_FAIL=0
IGNORE_TERM_WATCH=0
INIT_CHECKS_FAIL=0
[ -f "$CONF" ] && . "$CONF"

note() { echo "$*" >> "$LOG"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
command="$1"
shift

unit_json() {
  printf '{"name":"%s","kind":"%s","program":"%s","args":["--profile","server-app","internal","%s"]%s}' "$1" "$2" "$SELF" "$1" "$3"
}

case "$command" in
  internal)
    sub="$1"
    shift
    case "$sub" in
      units)
        printf '{"schema":1,"platform":"darwin","path":"/usr/bin:/bin","passedVariables":[],"units":[%s,%s,%s]}\n' \
          "$(unit_json dispatch tick ',"everySeconds":1,"limitSeconds":5,"graceSeconds":1,"lockHeldExitCode":75')" \
          "$(unit_json listen service ',"restartDelaySeconds":10')" \
          "$(unit_json watch service ',"restartDelaySeconds":5')"
        ;;
      listen|watch)
        if [ "$sub" = watch ] && [ "$IGNORE_TERM_WATCH" = 1 ]; then
          trap 'note "watch ignored term"' TERM
        else
          trap 'note "$sub term"; exit 0' TERM
        fi
        env | sort > "$WORKER/$sub.env"
        note "$sub start $$"
        while :; do sleep 1 & wait $!; done
        ;;
      dispatch)
        note "dispatch"
        if [ "$TICK_EXIT" != 75 ]; then
          printf '{"at":"2026-01-01T00:00:00.000Z","status":"%s","message":"%s"}\n' "$TICK_STATUS" "$TICK_MESSAGE" > "$AGENT_BOARD_STATE_DIR/dispatch-result.json"
        fi
        exit "$TICK_EXIT"
        ;;
      shutdown)
        note "shutdown $*"
        [ "$SHUTDOWN_FAIL" = 1 ] && { echo "shutdown failed" >&2; exit 1; }
        ;;
    esac
    ;;
  init)
    url=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --url) url="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    creds=$("$AGENT_BOARD_CREDENTIALS_COMMAND") || { echo "the credentials command failed" >&2; exit 1; }
    token=$(printf '%s\n' "$creds" | sed -n 's/^AGENT_BOARD_TOKEN=//p')
    key=$(printf '%s\n' "$creds" | sed -n 's/^AGENT_BOARD_DATA_KEY=//p')
    if [ "$token" != "$ACCEPT_TOKEN" ]; then echo "the board answered 401: the token is not valid" >&2; exit 1; fi
    if [ "$key" != "$ACCEPT_KEY" ]; then echo "the data key is not the board's" >&2; exit 1; fi
    mkdir -p "$AGENT_BOARD_CONFIG_DIR"
    printf '{\n  "url": "%s"\n}\n' "$url" > "$AGENT_BOARD_CONFIG_DIR/server.json"
    [ -f "$AGENT_BOARD_CONFIG_DIR/config.yaml" ] || echo "machine: $MACHINE" > "$AGENT_BOARD_CONFIG_DIR/config.yaml"
    note "init $url"
    echo "board: profile \"server-app\" is set up for $url as machine $MACHINE"
    if [ "$INIT_CHECKS_FAIL" = 1 ]; then
      echo "FAIL worker: refused: the token was revoked"
      echo "20 checks: 19 ok, 0 warnings, 1 failures"
      exit 1
    fi
    ;;
  doctor)
    if [ -f "$HERE/doctor.json" ]; then cat "$HERE/doctor.json"; else
      echo '[{"name":"node","level":"ok","message":"node 24"},{"name":"launchd agents","level":"fail","message":"missing"},{"name":"git","level":"warn","message":"git did not run","hint":"install git"}]'
    fi
    exit 1
    ;;
  echo-env)
    echo "profile=$AGENT_BOARD_PROFILE config=$AGENT_BOARD_CONFIG_DIR path=$PATH"
    ;;
esac
