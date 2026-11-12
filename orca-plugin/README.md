# Gestalt Conductor (Orca 플러그인)

Gestalt 컨덕터가 굴리는 주문과 사람 확인을 기다리는 게이트를 오르카 사이드바와 상태 표시줄에 보여 준다. 게이트 승인과 거절도 여기서 한다.

## 하는 일

- 워커가 `gestalt conductor status --all --json`을 불러 읽는다. 이벤트 로그를 직접 재생하지 않으니 저장소 꼴이 바뀌어도 CLI만 맞으면 된다.
- 저장소의 `events.jsonl`을 지켜보다 바뀌면 다시 읽는다. 파일이 없으면 5초마다 생겼는지 보고 그동안 "컨덕터 저장소 없음"을 띄운다.
- 상태 표시줄에 `주문 N · 확인 대기 M`을 띄운다. 확인 대기가 있으면 warning, 저장소가 없거나 CLI가 실패하면 danger이고 이유는 툴팁에 있다. 누르면 다시 읽는다.
- 새 게이트가 열리면 데스크톱 알림을 한 번 띄운다. 알린 게이트 id는 플러그인 저장소에 남겨서 워커가 다시 떠도 또 알리지 않는다.
- 패널은 레포마다 타일 하나를 그린 지도로 시작한다. 타일에는 확인 대기 게이트 수와 상태별 주문 수가 붙고, 사람 손이 필요한 레포가 앞에 온다. 타일을 누르면 그 레포의 게이트와 상태별 주문, bypass 사후 보고가 나온다. 주문을 맡은 워커의 오르카 워크트리를 찾으면 "워크트리 열기" 버튼이 붙는다.
- 게이트 승인과 거절은 버튼을 한 번 더 눌러 확정해야 보낸다. 워커가 `gestalt conductor gate resolve <id> --approve|--reject [--answer] --json`을 부르고 돌아온 `hostActions`와 `errors`를 "컨덕터 세션에서 처리할 일"로 그대로 보여 준다. 플러그인은 hostActions를 실행하지 않는다. 컨덕터 세션이 다음 tick에 처리한다.

## 설정

| 키 | 비워 두면 | 언제 적나 |
|---|---|---|
| `gestaltPath` | PATH의 `gestalt` | 오르카가 셸 PATH를 못 물려받아 "gestalt 실행 파일을 못 찾았어요"가 뜰 때 절대 경로를 적는다 |
| `stateDir` | CLI 기본 위치 | `~/.gestalt/conductor.json`에 `stateDir`을 따로 정했거나 0.129.0 이하 CLI를 쓸 때 같은 경로를 적는다 |

0.129.0 이하 CLI는 status JSON에 저장소 경로와 워커 워크트리 이름을 싣지 않는다. 그때는 `stateDir` 설정으로 저장소를 알려 줘야 하고 "워크트리 열기" 버튼도 안 붙는다.

## 권한

`notifications:show`, `workspace:read`, `workspace:write`, `settings:own`, `storage:own`만 쓴다. 워크스페이스 권한은 워커 워크트리를 찾아 여는 데만 쓴다. 터미널에 글을 보내거나 에이전트를 띄우는 권한은 받지 않는다.

## 개발

```bash
orca plugin validate ./orca-plugin --json
orca plugin test ./orca-plugin --json     # src/*.test.ts(x)
orca plugin check ./orca-plugin --json    # src/panel.check.ts 시나리오
cd orca-plugin && npx tsc -p .
```

테스트와 check 시나리오는 진짜 gestalt 대신 `test/fake-gestalt.mjs`를 부른다. `--state-dir`로 받은 폴더의 `fake-status.json`과 `fake-resolve.json`을 그대로 내보내니 실제 컨덕터 저장소는 건드리지 않는다.
