#!/usr/bin/env bash
# Claude Code plugin hook: peer 공유를 누가 보고 있는지 주인 세션에 알린다 (hooks/hooks.json).
#
#   peer-watching-hook.sh    UserPromptSubmit: 이 세션을 원격으로 보거나 보려고 승인을 기다리는
#                            사람이 있으면 그 사실을 붙인다
#
# 플러그인이 깔린 모든 레포의 모든 프롬프트에 걸린다. 그래서 켜고 끄는 설정 없이 늘 돌지만
# Node를 띄우지 않는다. 보는 사람이나 승인 대기가 있는 세션에만 peer 데몬이 상태 파일을 써 둔다.
# 훅은 그 파일을 읽어 그대로 내보낸다. 상태 파일 디렉토리가 없거나 비었으면 stdin도 안 읽고
# 끝난다. 아래 분기는 전부 exit 0으로 끝낸다. 이 훅 때문에 프롬프트가 막히는 일은 없어야 한다.
#
# 상태 파일: <peer 루트>/watching/<세션 id>
#   1줄: 파일을 쓴 데몬 pid. 그 프로세스가 없으면 남은 파일로 보고 아무것도 안 낸다
#   2줄: 그 데몬의 시작 시각(`LC_ALL=C ps -o lstart=`에서 공백을 뺀 글자). 데몬이 죽고 같은 pid를
#        다른 프로세스가 받았으면 시각이 달라서 안 낸다. 비어 있으면 데몬이 ps를 못 부른 것이라 안 본다
#   3줄: 훅 출력 JSON 한 줄. 데몬이 JSON.stringify로 만든 것이라 셸에서 다시 손대지 않는다
#
# peer 루트는 src/peer/paths.ts의 peerRoot와 같게 정한다. GESTALT_PEER_HOME(절대경로만),
# 없으면 GESTALT_HOME(절대경로만)/.gestalt/peer, 그것도 없으면 ~/.gestalt/peer다.
#
# 의존성: bash 3.2+. jq는 안 쓴다.
set -u

if [[ -n "${GESTALT_PEER_HOME:-}" ]]; then
  # 데몬은 상대경로면 뜨지 않는다. 그러면 읽을 상태 파일도 없다
  [[ "$GESTALT_PEER_HOME" == /* ]] || exit 0
  PEER_ROOT="$GESTALT_PEER_HOME"
elif [[ "${GESTALT_HOME:-}" == /* ]]; then
  PEER_ROOT="$GESTALT_HOME/.gestalt/peer"
else
  [[ "${HOME:-}" == /* ]] || exit 0
  PEER_ROOT="$HOME/.gestalt/peer"
fi

DIR="$PEER_ROOT/watching"
[[ -d "$DIR" && ! -L "$DIR" ]] || exit 0

# 공유가 없거나 보는 사람과 승인 대기가 없으면 데몬이 파일을 지운다. 그 경우 stdin을 읽기 전에 끝낸다
shopt -s nullglob
FILES=("$DIR"/*)
((${#FILES[@]} > 0)) || exit 0

if [[ -t 0 ]]; then
  exit 0
fi
# fork는 상태 파일이 있을 때만 한 번 생긴다. read 내장은 파이프에서 한 바이트씩 읽어서 큰 프롬프트를
# 붙여 넣으면 cat보다 몇 배 느리다(bash 3.2에서 200KB 입력이 7배)
INPUT="$(cat)"

# session_id만 꺼낸다. 파일 이름으로 쓰므로 세션 id 꼴(src/peer/locate.ts의 isSessionId)만 받는다
SID_RE='"session_id"[[:space:]]*:[[:space:]]*"([A-Za-z0-9][A-Za-z0-9_-]{0,127})"'
[[ "$INPUT" =~ $SID_RE ]] || exit 0
SID="${BASH_REMATCH[1]}"

FILE="$DIR/$SID"
[[ -f "$FILE" && ! -L "$FILE" ]] || exit 0

PID="" STAMP="" LINE=""
{ IFS= read -r PID; IFS= read -r STAMP; IFS= read -r LINE; } <"$FILE" || true
[[ "$PID" =~ ^[0-9]+$ ]] || exit 0
# 데몬이 죽었으면 보는 사람도 이미 끊겼다
kill -0 "$PID" 2>/dev/null || exit 0
if [[ -n "$STAMP" ]]; then
  NOW="$(LC_ALL=C ps -o lstart= -p "$PID" 2>/dev/null)" || exit 0
  [[ "${NOW//[[:space:]]/}" == "$STAMP" ]] || exit 0
fi
[[ "$LINE" == '{"hookSpecificOutput":'* ]] || exit 0

printf '%s\n' "$LINE"
exit 0
