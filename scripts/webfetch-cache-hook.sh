#!/usr/bin/env bash
# Claude Code plugin hook for the WebFetch disk cache (hooks/hooks.json).
#
#   webfetch-cache-hook.sh post   PostToolUse: WebFetch 결과를 검증 헤더와 함께 저장
#   webfetch-cache-hook.sh pre    PreToolUse:  원본이 304를 줄 때만 저장본을 돌려줌
#
# 플러그인이 깔린 모든 레포의 모든 WebFetch에 걸리므로 기본은 꺼짐이고, 꺼진 레포는
# 의존성 확인이나 stdin 읽기 전에 exit 0으로 끝난다. 켜진 뒤에도 문제가 생기면
# 전부 exit 0이다. 캐시 때문에 WebFetch가 막히는 일은 없어야 한다. 예외는 304로
# 적중했을 때의 exit 2 하나뿐이고, 이건 오류가 아니라 "이 stderr를 결과로 써라"는
# 신호다.
#
# 의존성: bash 3.2+, jq, curl, sha256sum 또는 shasum. 하나라도 없으면 조용히 통과한다.
set -u

MODE="${1:-}"
[[ "$MODE" == pre || "$MODE" == post ]] || exit 0

PROJECT="${CLAUDE_PROJECT_DIR:-$PWD}"

# 사전 필터. env가 gestalt.json보다 우선하고, 설정이 없으면 꺼진 것이다.
ENV_RAW=""
if [[ -n "${GESTALT_WEBFETCH_CACHE:-}" ]]; then
  ENV_RAW="$(printf '%s' "$GESTALT_WEBFETCH_CACHE" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
fi
case "$ENV_RAW" in
  0 | false) exit 0 ;;
  1 | true) ;;
  *) grep -q '"webFetchCache"' "$PROJECT/gestalt.json" 2>/dev/null || exit 0 ;;
esac

command -v jq >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0
if command -v sha256sum >/dev/null 2>&1; then
  SHA=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  SHA=(shasum -a 256)
else
  exit 0
fi

# grep은 키 이름이 있는지만 봤다. 실제로 켰는지는 jq가 읽는다.
case "$ENV_RAW" in
  1 | true) ;;
  *) jq -e '.webFetchCache.enabled == true' "$PROJECT/gestalt.json" >/dev/null 2>&1 || exit 0 ;;
esac

# 캐시 파일에 응답 본문이 들어가므로 다른 사용자가 못 읽게 한다.
umask 077

if [[ -t 0 ]]; then
  INPUT="{}"
else
  INPUT="$(cat)"
fi

URL="$(printf '%s' "$INPUT" | jq -r '.tool_input.url // empty' 2>/dev/null)" || exit 0
PROMPT="$(printf '%s' "$INPUT" | jq -r '.tool_input.prompt // empty' 2>/dev/null)" || exit 0

# http/https만 다룬다. 공백이나 제어 문자가 든 값은 curl 인자로 넘기지 않는다.
case "$URL" in
  http://* | https://*) ;;
  *) exit 0 ;;
esac
if [[ "$URL" =~ [[:space:][:cntrl:]] ]]; then
  exit 0
fi
# user:pass@host 꼴이면 curl이 Basic 인증을 실어 보낸다. 인증은 싣지 않는다.
AUTHORITY="${URL#*://}"
AUTHORITY="${AUTHORITY%%[/?#]*}"
[[ "$AUTHORITY" != *@* ]] || exit 0

# WebFetch 결과는 prompt가 만든 요약이라 같은 URL도 prompt가 다르면 다른 내용이다.
# 둘을 NUL로 갈라 "a" + "bc"와 "ab" + "c"가 같은 키가 되지 않게 한다.
KEY="$(printf '%s\0%s' "$URL" "$PROMPT" | "${SHA[@]}" | cut -c1-32)"
[[ -n "$KEY" ]] || exit 0

# 테스트용 override. 상대 경로를 거부하는 이유는 code-graph-hook.sh의 GESTALT_HOOK_BIN과 같다.
if [[ "${GESTALT_WEBFETCH_CACHE_DIR:-}" == /* ]]; then
  CACHE_DIR="$GESTALT_WEBFETCH_CACHE_DIR"
else
  CACHE_DIR="$PROJECT/.gestalt/webfetch-cache"
fi
FILE="$CACHE_DIR/$KEY.json"

# 검증 요청은 짧게 끝낸다. 쿠키도 인증도 싣지 않고, -q로 ~/.curlrc가 끼어드는 것을 막는다.
curl_head() {
  curl -q -sS -I -L --globoff --max-time 5 --connect-timeout 3 --max-redirs 5 \
    --proto '=http,https' --proto-redir '=http,https' "$@" 2>/dev/null
}

# 응답 헤더에서 마지막 응답의 "상태\nETag\nLast-Modified"를 뽑는다. 리다이렉트 중간 응답의
# 검증 헤더가 섞이지 않도록 HTTP/ 줄을 만날 때마다 비운다. 개행 구분이라 BSD awk로도 돈다.
final_response() {
  tr -d '\r' | awk '
    /^HTTP\// { status = $2; etag = ""; lm = ""; next }
    tolower($1) == "etag:" || tolower($1) == "last-modified:" {
      name = tolower($1)
      sub(/^[^:]*:[ \t]*/, "")
      sub(/[ \t]+$/, "")
      if (name == "etag:") etag = $0; else lm = $0
    }
    END { print status; print etag; print lm }
  '
}

if [[ "$MODE" == post ]]; then
  # tool_response 형태는 버전에 따라 바뀐다. 알려진 자리를 순서대로 보고 못 찾으면 저장하지 않는다.
  EXTRACT='(.tool_response
    | if type == "string" then .
      elif type == "object" then (.result // .output // .text // .content // .body // empty)
      else empty end)
    | select(type == "string" and length > 0)'

  # 본문은 stdin에서 jq로 곧장 파일에 쓴다. 셸 인자로 넘기면 Linux의 인자 길이 한도(128KB)에 걸린다.
  LEN="$(printf '%s' "$INPUT" | jq -r "$EXTRACT | length" 2>/dev/null)" || exit 0
  [[ "$LEN" =~ ^[0-9]+$ ]] || exit 0
  ((LEN <= 1000000)) || exit 0

  # 네트워크가 실패한 것과 서버가 검증 헤더를 안 준 것은 다르다. 앞쪽에서는 옛 항목을 지우지 않는다.
  HEAD_OUT="$(curl_head --url "$URL")" || exit 0
  OUT="$(printf '%s\n' "$HEAD_OUT" | final_response)"
  { IFS= read -r STATUS; IFS= read -r ETAG; IFS= read -r LAST_MOD; } <<<"$OUT"

  # 검증 헤더가 없거나 성공 응답이 아니면 다시 확인할 방법이 없으니 저장하지 않고 옛 항목도 지운다.
  if [[ ! "$STATUS" =~ ^2[0-9][0-9]$ ]] || [[ -z "$ETAG" && -z "$LAST_MOD" ]]; then
    rm -f "$FILE" 2>/dev/null
    exit 0
  fi
  # 헤더 값이 비정상적으로 길면 조건부 요청 헤더로 쓰지 않는다.
  if ((${#ETAG} > 512 || ${#LAST_MOD} > 512)); then
    exit 0
  fi

  mkdir -p "$CACHE_DIR" 2>/dev/null || exit 0
  TMP="$FILE.$$.tmp"
  trap 'rm -f "$TMP"' EXIT
  if printf '%s' "$INPUT" | jq \
    --arg etag "$ETAG" --arg last_modified "$LAST_MOD" --argjson fetched_at "$(date +%s)" \
    "{url: .tool_input.url, prompt: (.tool_input.prompt // \"\"), etag: \$etag, last_modified: \$last_modified,
      content: ($EXTRACT), fetched_at: \$fetched_at}" >"$TMP" 2>/dev/null; then
    chmod 600 "$TMP" 2>/dev/null
    mv -f "$TMP" "$FILE" 2>/dev/null
  fi
  exit 0
fi

# --- pre ----------------------------------------------------------------------

[[ -f "$FILE" ]] || exit 0

# 손상됐거나 이 요청의 것이 아니면 통과한다. 키가 같아도 url과 prompt를 한 번 더 맞춰 본다.
jq -e --arg u "$URL" --arg p "$PROMPT" \
  '.url == $u and .prompt == $p and (.content | type == "string" and length > 0)' \
  "$FILE" >/dev/null 2>&1 || exit 0

ETAG="$(jq -r '.etag // empty' "$FILE" 2>/dev/null)" || exit 0
LAST_MOD="$(jq -r '.last_modified // empty' "$FILE" 2>/dev/null)" || exit 0
[[ -n "$ETAG" || -n "$LAST_MOD" ]] || exit 0

HEADERS=()
[[ -n "$ETAG" ]] && HEADERS+=(-H "If-None-Match: $ETAG")
[[ -n "$LAST_MOD" ]] && HEADERS+=(-H "If-Modified-Since: $LAST_MOD")

HEAD_OUT="$(curl_head "${HEADERS[@]}" --url "$URL")" || exit 0
OUT="$(printf '%s\n' "$HEAD_OUT" | final_response)"
STATUS="$(printf '%s\n' "$OUT" | sed -n '1p')"
# 304만 적중이다. 200이든 오류든 그 밖은 WebFetch가 직접 가져오게 둔다.
[[ "$STATUS" == 304 ]] || exit 0

FETCHED_AT="$(jq -r '.fetched_at // 0' "$FILE" 2>/dev/null)"
FETCHED_ISO="$(date -u -r "$FETCHED_AT" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$FETCHED_AT" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"

# 본문은 jq가 파일에서 곧장 내보낸다. 셸 변수에 담아 echo하면 백슬래시와 $가 해석된다.
{
  printf '[gestalt webfetch-cache] 캐시 적중: %s\n\n' "$URL"
  printf '원본 서버가 조건부 요청에 304로 답했다. %s 이후 바뀌지 않았으니 아래 내용을\n' "$FETCHED_ISO"
  printf 'WebFetch가 방금 돌려준 결과로 쓰면 된다.\n\n'
  printf '요청한 prompt: %s\n\n' "${PROMPT:0:300}"
  printf -- '----- 캐시 본문 시작 -----\n'
  jq -r '.content' "$FILE"
  printf -- '----- 캐시 본문 끝 -----\n'
} >&2
exit 2
