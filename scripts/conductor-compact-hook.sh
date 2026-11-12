#!/usr/bin/env bash
# Claude Code plugin hook: 컨덕터 세션의 컴팩트 횟수를 센다 (hooks/hooks.json, SessionStart matcher compact).
#
#   conductor-compact-hook.sh    SessionStart(source compact): 등록된 컨덕터 세션이면 횟수를 하나 올리고
#                                트랜스크립트 경로를 같이 적는다. 컨덕터라는 사실과 횟수를 맥락에 한 줄 붙인다
#
# 플러그인이 깔린 모든 세션의 컴팩트에 걸리므로 Node를 띄우지 않는다. 컨덕터 세션은 `gestalt conductor tick`이
# 처음 돌 때 `<상태 저장소>/sessions/<세션 id>/` 디렉토리를 만들어 등록한다. 그 디렉토리가 없는 세션은
# 아무것도 안 쓰고 끝난다. 아래 분기는 전부 exit 0으로 끝낸다. 이 훅 때문에 세션이 막히는 일은 없어야 한다.
#
# 상태 파일: <상태 저장소>/sessions/<세션 id>/compactions
#   1줄: 지금까지 센 컴팩트 횟수
#   2줄: 훅 입력의 transcript_path. tick이 여기서 컨텍스트 사용량을 읽는다
#
# 상태 저장소는 src/cli/commands/conductor.ts의 open()과 같게 정한다. GESTALT_CONDUCTOR_STATE_DIR(절대경로만),
# 없으면 ~/.gestalt/conductor.json의 stateDir(절대경로만), 그것도 없으면 GESTALT_HOME(절대경로만)/.gestalt/conductor,
# 마지막으로 ~/.gestalt/conductor다. tick을 --state-dir로 다른 자리에서 돌리면 이 훅은 그 자리를 모른다.
#
# 의존성: bash 3.2+, cat, mv. jq는 안 쓴다.
set -u

if [[ "${HOME:-}" == /* ]]; then
  GHOME="$HOME/.gestalt"
else
  GHOME=""
fi
[[ "${GESTALT_HOME:-}" == /* ]] && GHOME="$GESTALT_HOME/.gestalt"

STATE=""
if [[ "${GESTALT_CONDUCTOR_STATE_DIR:-}" == /* ]]; then
  STATE="$GESTALT_CONDUCTOR_STATE_DIR"
elif [[ -n "$GHOME" && -f "$GHOME/conductor.json" ]]; then
  CONF="$(cat "$GHOME/conductor.json" 2>/dev/null)" || CONF=""
  SD_RE='"stateDir"[[:space:]]*:[[:space:]]*"(/[^"\\]*)"'
  [[ "$CONF" =~ $SD_RE ]] && STATE="${BASH_REMATCH[1]}"
fi
if [[ -z "$STATE" ]]; then
  [[ -n "$GHOME" ]] || exit 0
  STATE="$GHOME/conductor"
fi

SESSIONS="$STATE/sessions"
# 컨덕터를 한 번도 안 돌린 사용자는 stdin도 안 읽고 끝난다
[[ -d "$SESSIONS" && ! -L "$SESSIONS" ]] || exit 0
[[ -t 0 ]] && exit 0
INPUT="$(cat)"

SRC_RE='"source"[[:space:]]*:[[:space:]]*"compact"'
[[ "$INPUT" =~ $SRC_RE ]] || exit 0

# 디렉토리 이름으로 쓰므로 세션 id 꼴만 받는다
SID_RE='"session_id"[[:space:]]*:[[:space:]]*"([A-Za-z0-9][A-Za-z0-9_-]{0,127})"'
[[ "$INPUT" =~ $SID_RE ]] || exit 0
SID="${BASH_REMATCH[1]}"

DIR="$SESSIONS/$SID"
[[ -d "$DIR" && ! -L "$DIR" ]] || exit 0

# 이스케이프가 들어간 경로는 셸에서 풀지 않고 버린다. tick은 경로가 없으면 사용량을 모른다고 보고한다
TP=""
TP_RE='"transcript_path"[[:space:]]*:[[:space:]]*"(/[^"\\]*)"'
[[ "$INPUT" =~ $TP_RE ]] && TP="${BASH_REMATCH[1]}"

FILE="$DIR/compactions"
COUNT=0
if [[ -f "$FILE" && ! -L "$FILE" ]]; then
  IFS= read -r COUNT <"$FILE" || true
  [[ "$COUNT" =~ ^[0-9]+$ ]] || COUNT=0
fi
COUNT=$((COUNT + 1))

TMP="$FILE.$$.tmp"
printf '%s\n%s\n' "$COUNT" "$TP" >"$TMP" 2>/dev/null && mv -f "$TMP" "$FILE" 2>/dev/null || {
  rm -f "$TMP" 2>/dev/null
  exit 0
}

MSG="이 세션은 gestalt 컨덕터 세션이고 컴팩트를 ${COUNT}번 거쳤어요. 컨덕터 세션은 컴팩트를 한 번까지만 허용해요. tick 출력의 handoff.due가 true면 conductor 스킬의 인계 절차(7-1)를 따라 새 세션으로 넘기고 이 세션의 반복을 멈춰 주세요."
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$MSG"
exit 0
