# 세션 공유 (`gestalt peer`)

내 Claude Code 세션 하나의 대화를 같은 머신의 브라우저에서 실시간으로 본다. 지금은 로컬 전용이고 네트워크로 나가는 코드가 없다. 팀원에게 여는 기능은 [설계 제안서](./proposals/peer-network.md)의 다음 단계에서 붙는다.

## 명령

```bash
gestalt peer daemon                                  # 데몬을 전경에서 띄운다
gestalt peer share --session <sessionId>             # 세션을 공유하고 뷰어 주소를 출력한다
gestalt peer share --transcript <path.jsonl>         # 대화 기록 파일을 직접 지정한다 (로컬 검증용)
                   [--tools full|summary|none]       # 도구 출력 수준. 기본 summary(앞 4KB)
                   [--expires <분>]                  # 기본 480분(8시간), 최대 7일
gestalt peer shares                                  # 열린 공유와 보는 사람 수
gestalt peer unshare <공유 id>                        # 공유를 종료한다. 붙어 있던 뷰어도 끊긴다
gestalt peer status                                  # 데몬 상태
```

`--json`을 `peer` 바로 뒤에 붙이면(`gestalt peer --json shares`) JSON으로 출력한다. 데몬이 안 떠 있으면 모든 명령이 종료 코드 3으로 끝난다.

`--session`은 `CLAUDE_CONFIG_DIR`(없으면 `~/.claude`)의 `sessions/*.json`에서 그 세션의 cwd를 찾아 `projects/<슬러그>/<sessionId>.jsonl`을 연다. 못 찾으면 `projects/*` 아래를 훑는다. 세션을 찾는 건 명령을 친 쪽의 환경이라 데몬과 설정 디렉토리가 달라도 된다.

데몬은 `~/.gestalt/peer/`에 소켓(`peer.sock`, 0600)과 상태 DB(`state.db`)를 둔다. 디렉토리는 0700이다. `GESTALT_PEER_HOME`(절대경로)으로 옮길 수 있다.

## 보이는 것과 안 보이는 것

허용 목록에 있는 것만 뷰어로 나간다. 목록에 없는 줄 종류는 새 종류가 생겨도 나가지 않는다.

| 보인다 | 안 보인다 |
| --- | --- |
| 주인 프롬프트(`<system-reminder>` 블록은 지운다) | `api-request` 계열(시스템 프롬프트 원문) |
| 모델 답 텍스트 | `attachment`(첨부 파일 원문) |
| 도구 이름과 입력 요약(접힘) | `thinking` 블록 |
| 도구 결과 앞 4KB(접힘, `--tools`로 조절) | 하네스가 끼운 줄(`isMeta`), 압축 요약 본문 |
| 세션 제목(`ai-title`) | 서브에이전트 대화(“서브에이전트 실행 중” 한 줄만) |
| | 그 밖의 모든 줄. 모르는 종류는 개수만 띄운다 |

보이는 것에도 가리기를 한 번 더 건다. 아래 값이 `[가림]`이 되고 홈 디렉토리 경로는 `~`가 된다.

- 형식이 정해진 토큰: AWS 액세스 키, GitHub 토큰, GitLab 토큰(`glpat-`), npm 토큰(`npm_`), Anthropic 키(`sk-ant-`)와 그 밖의 `sk-` 키(`sk-proj-` 포함), Stripe 키(`sk_live_`, `rk_test_` 등), Google API 키(`AIza`), Slack 토큰(`xox`), JWT, PEM 개인키 블록, `Bearer`와 `Basic` 뒤 값
- URL에 박힌 비밀번호: `https://user:pass@host`에서 `pass` 자리만 가린다. 이름 없이 비밀번호만 둔 `redis://:pass@host`도 가린다
- 이름에 KEY, TOKEN, SECRET, PASSWORD, PASSWD가 든 `NAME=값`. 따옴표 친 JSON 키는 이름에 key, token, secret, password, passwd, pwd, cookie, credential, authorization, auth(`author`는 빼고)가 들면 값을 가린다. 둘 다 이스케이프된 따옴표나 따옴표 안 줄바꿈도 4096자 안에서 닫는 따옴표를 찾고 못 찾으면 줄 끝까지 가린다
- 헤더 꼴: 줄 첫머리의 `Cookie:`, `Set-Cookie:`, `X-Api-Key:`, `Authorization:`, `Proxy-Authorization:`(`curl -v`의 `>`나 `<` 표시 포함)는 콜론 뒤를 줄 끝까지 가린다. 따옴표 안에 든 헤더(`-H "X-Api-Key: …"`)는 닫는 따옴표 앞까지만 가린다
- 도구 입력에서 키 이름이 민감한 값: 키를 `_`, `-`, `.`, 대소문자 경계로 나눈 낱말이 key, apikey, token, secret, password, passwd, pass, pwd, auth, authorization, credential(s), cookie(s) 중 하나면 값을 통째로 가린다. 낱말이 token, secret, password, passwd, passphrase, apikey, privatekey로 끝나도(`accesstoken`처럼) 가린다. token 말고는 끝에 `s`가 붙어도 된다. 값이 객체면 안으로 들어가 같은 규칙을 건다

## 뷰어

주소는 `http://127.0.0.1:<포트>/s/<공유 id>?t=<토큰>`이다. 토큰이 없거나 틀리면 401이다. 페이지는 바깥 자원을 안 끌어오고 대화 내용은 마크다운으로 그리지 않고 글자 그대로 넣는다. 응답에 `Cache-Control: no-store`를 붙이고 브라우저 저장소도 쓰지 않는다.

공유 하나에 붙을 수 있는 뷰어는 16개다. 넘으면 429로 거절하고 뷰어 화면에 상한에 걸렸다고 뜬다.

## 데몬이 붙잡는 양

| 대상 | 상한 | 넘으면 |
| --- | --- | --- |
| 공유마다 들고 있는 이벤트 | 직렬화 기준 32MB | 앞부분부터 버린다. 새로 붙은 뷰어에는 "메모리 상한에 걸려 앞부분 N개를 생략했어요"가 뜬다 |
| 대화 기록 한 줄 | 64MB | 다음 줄바꿈까지 버리고 따로 센다 |
| 한 번에 읽는 양 | 공유마다 4MB | 나머지는 다음 차례에 읽는다 |
| 뷰어 하나의 소켓에 밀린 양 | 8MB. 앞부분은 소켓이 비는 만큼만 보내서 여기에 안 쌓인다 | 실시간 프레임을 쓰기 전에 넘었으면 그 뷰어 연결을 끊는다 |

변환하다 실패한 줄은 그 줄만 건너뛰고 개수를 센다. 공유 하나를 읽다가 예외가 나면 그 공유만 `error`로 종료되고 다른 공유는 계속 돈다.

## 한계

- 패턴 가리기는 다 잡지 못한다. 형식이 정해지지 않은 비밀번호나 고객 데이터는 그대로 보일 수 있다. 공유를 열 때와 뷰어 상단에 같은 경고가 뜬다.
- 대화 기록 jsonl은 문서화되지 않은 형식이다. Claude Code가 형식을 바꾸면 보이는 내용이 줄 수 있다(새는 쪽이 아니라 덜 보이는 쪽으로 깨진다).
- 대화 기록 파일이 줄거나 다른 파일로 바뀌면 처음부터 다시 읽지 않고 멈춘다. 뷰어에 상태가 뜬다.
- 데몬이 다시 뜨면 이전 공유는 종료된다. 토큰은 메모리에만 있다.
- 뷰어가 이미 받은 내용은 공유를 종료해도 브라우저 화면에 남는다.
