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
gestalt peer unshare <공유 id>                        # 공유를 닫는다. 붙어 있던 뷰어도 끊긴다
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

보이는 것에도 가리기를 한 번 더 건다. AWS 액세스 키, GitHub 토큰, JWT, PEM 개인키 블록, `Bearer` 값, 이름에 KEY/TOKEN/SECRET/PASSWORD가 든 `NAME=값`과 따옴표 친 JSON 키의 값이 `[가림]`이 되고 홈 디렉토리 경로는 `~`가 된다.

## 뷰어

주소는 `http://127.0.0.1:<포트>/s/<공유 id>?t=<토큰>`이다. 토큰이 없거나 틀리면 401이다. 페이지는 바깥 자원을 안 끌어오고 대화 내용은 마크다운으로 그리지 않고 글자 그대로 넣는다. 응답에 `Cache-Control: no-store`를 붙이고 브라우저 저장소도 쓰지 않는다.

## 한계

- 패턴 가리기는 다 잡지 못한다. 형식이 정해지지 않은 비밀번호나 고객 데이터는 그대로 보일 수 있다. 공유를 열 때와 뷰어 상단에 같은 경고가 뜬다.
- 대화 기록 jsonl은 문서화되지 않은 형식이다. Claude Code가 형식을 바꾸면 보이는 내용이 줄 수 있다(새는 쪽이 아니라 덜 보이는 쪽으로 깨진다).
- 대화 기록 파일이 줄거나 다른 파일로 바뀌면 처음부터 다시 읽지 않고 멈춘다. 뷰어에 상태가 뜬다.
- 데몬이 다시 뜨면 이전 공유는 닫힌다. 토큰은 메모리에만 있다.
- 뷰어가 이미 받은 내용은 공유를 닫아도 브라우저 화면에 남는다.
