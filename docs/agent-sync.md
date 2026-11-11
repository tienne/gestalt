# 규칙과 스킬 동기화 (`gestalt sync`, `gestalt doctor`)

Claude 계정 여럿과 터미널 Codex, 오르카가 띄운 Codex가 같은 규칙과 스킬을 보게 연결한다. 규칙과 스킬은 `~/.agents` 한 곳에만 두고 각 호스트는 그곳을 읽기만 한다. 각 홈에는 `~/.agents`로 가는 링크나 가져오기 줄만 둔다.

`gestalt sync`가 연결을 처음 걸고 `gestalt doctor`가 어긋난 연결을 찾고 `--fix`를 주면 고친다. 둘 다 사용자가 부를 때만 돈다. 상주 프로세스나 launchd 등록은 없다.

다루는 건 규칙 파일과 스킬 폴더뿐이다. MCP 설정(`.mcp.json`, `~/.claude.json`)과 `settings.json`은 읽지도 고치지도 않는다. `settings.json`은 오르카 settings-sync가 맞춘다.

## 연결 모양

| 홈                          | 자리        | 연결                                                                                       |
| --------------------------- | ----------- | ------------------------------------------------------------------------------------------ |
| Claude 시스템 (`~/.claude`) | `skills`    | `~/.agents/skills`로 가는 링크                                                             |
|                             | `CLAUDE.md` | 실제 파일. 맨 위에 `@~/.agents/AGENTS.md` 줄이 있고 그 아래에 Claude에만 쓰는 줄을 둔다    |
| Claude 계정 홈 (오르카)     | `skills`    | `~/.agents/skills`로 가는 링크                                                             |
|                             | `CLAUDE.md` | 실제 파일. `@~/.claude/CLAUDE.md` 줄을 넣어 시스템 CLAUDE.md를 거쳐 `~/.agents`를 가져온다 |
| Codex 시스템 (`~/.codex`)   | `AGENTS.md` | `~/.agents/AGENTS.md`로 가는 링크                                                          |
| Codex 계정 홈 (오르카)      | `AGENTS.md` | `~/.agents/AGENTS.md`로 가는 링크                                                          |

스킬은 `skills` 폴더 자체를 링크 하나로 건다. 스킬마다 링크를 만들지 않으니 새 스킬을 만들어도 다시 sync할 필요가 없다. Codex는 사용자 스킬을 `~/.agents/skills`에서 바로 읽으므로 Codex 홈에는 스킬 링크를 두지 않는다.

이미 다른 길로 `~/.agents`에 닿아 있으면 그대로 둔다. 계정 홈의 `skills`가 `~/.claude/skills`를 가리키거나 계정 CLAUDE.md가 `@~/.agents/AGENTS.md`를 바로 가져와도 문제로 보지 않는다.

## 명령

```bash
gestalt sync --dry-run       # 바꿀 목록만 보여 준다. 파일은 그대로다
gestalt sync                 # 연결을 건다
gestalt sync --revert        # 아직 안 되돌린 가장 최근 sync를 되돌린다
gestalt sync --revert <id>   # 그 실행을 되돌린다. --dry-run과 같이 쓰면 할 일만 보여 준다
gestalt doctor               # 어긋난 연결과 도구 경고를 보고한다. 아무것도 안 바꾼다
gestalt doctor --fix         # 백업하고 그 자리에서 고친다
```

모든 명령은 `--json`을 받는다. 스킬이나 스크립트가 결과를 읽을 때 쓴다.

| 명령             | 종료 코드 1                                                                 |
| ---------------- | --------------------------------------------------------------------------- |
| `gestalt sync`   | 설정 파일이 깨졌거나 실행 중에 멈췄을 때                                    |
| `gestalt doctor` | 남은 문제(--fix를 안 줬으면 찾은 문제)가 있으면 1. 도구 경고만 있으면 0이다 |

## 대상 홈

`~/.claude`와 `~/.codex`에 더해 `orca account list --json`이 돌려준 계정 홈을 전부 넣는다. Claude 계정 홈은 오르카가 알려 준 경로를 쓰고 Codex 계정 홈은 오르카 데이터 폴더의 `codex-accounts/<id>/home`으로 만든다. WSL 계정처럼 이 머신에서 바로 못 건드리는 홈은 뺀다.

폴더가 없는 홈이나 사용자 설정에서 `skip`한 계정은 건너뛰고 이유를 출력에 적는다. 계정 홈이 사용자 홈 밖이면(`orcaDataDir`를 설정했으면 그 폴더 밖이면) 손대지 않고 건너뛴다. `orca`를 못 부르면 경고를 내고 시스템 홈만 대상으로 삼는다. 오르카 명령은 사용자 설정 `orcaCommand`, 환경변수 `ORCA_CLI_COMMAND`, `orca` 순서로 고른다. 절대 경로나 PATH에서 찾을 이름만 받고 상대 경로면 설정 에러로 멈춘다.

## 처음 sync가 하는 일

1. `~/.agents/AGENTS.md`가 없으면 `~/.claude/CLAUDE.md`를 나눠 만든다. 공용 줄은 `~/.agents/AGENTS.md`로 가고 Claude 쪽에는 `@~/.agents/AGENTS.md` 줄과 Claude에만 쓰는 줄이 남는다. Claude에만 쓰는 줄은 사용자 설정 `rules.claudeOnly`에 적은 문자열이 든 줄과 `@`로 시작하는 가져오기 줄이다. 코드 블록 안의 줄은 나누지 않는다.
2. `~/.claude/skills`가 실제 폴더면 안의 항목을 전부 `~/.agents/skills`로 옮긴다. `SKILL.md`가 없는 폴더(`.trash/`처럼)도 같이 옮긴다. `~/.agents/skills`에 같은 이름이 이미 있으면 그쪽을 남기고 Claude 쪽 것은 백업 폴더에만 둔다. 계정 홈의 실제 `skills` 폴더도 같은 식으로 합친다.
3. 비운 `skills` 폴더 자리에 `~/.agents/skills`로 가는 링크를 건다.
4. 계정 홈마다 위 표대로 링크를 걸거나 가져오기 줄을 넣는다. 원래 있던 Codex `AGENTS.md` 내용은 `~/.agents`로 옮기지 않고 백업에만 둔다. 공용으로 쓸 줄이 있으면 직접 `~/.agents/AGENTS.md`에 옮긴다.

두 번째 실행부터는 어긋난 자리만 고친다. 바꿀 게 없으면 실행 폴더도 만들지 않는다.

## 백업과 기록

파일이나 폴더를 덮기 전에 `~/.gestalt/backups/<날짜>-<실행id>/` 아래로 옮긴다. 홈 아래 경로는 `home/` 아래에 원래 구조 그대로 둔다. 예를 들어 `~/.codex/AGENTS.md`의 백업은 `home/.codex/AGENTS.md`다.

같은 폴더의 `run.json`이 기록 파일이다. 파일을 옮기기 전에 할 일을 먼저 적고 옮긴 뒤 끝났다고 고쳐 적는다. 저장은 임시 파일에 쓰고 이름을 바꾸는 식이라 쓰다 멈춰도 이전 내용이 남는다. 그래서 실행이 중간에 에러로 멈춰도 거기까지 한 일은 기록에 있고 되돌리기가 읽는다. 실행 폴더는 0700, `run.json`은 0600으로 만든다. 출력에 보여 준 바뀐 목록과 같은 내용이 `changes`에 들어 있다.

보관 기간은 6개월이다. 쓰는 실행(sync, `doctor --fix`, 되돌리기)이 오래된 실행 폴더를 지우고 지운 폴더 이름을 출력에 적는다. 미리보기와 바꿀 게 없는 실행은 아무것도 지우지 않는다. 아직 되돌리지 않은 가장 최근 sync는 기간이 지나도 남긴다. 읽지 못한 `run.json`이 든 폴더도 지우지 않고 doctor가 경고로 알린다.

## 되돌리기

`gestalt sync --revert`는 sync 실행의 기록을 거꾸로 읽어 sync 전 상태로 돌린다. 만든 링크를 지우고 백업해 둔 파일과 옮긴 스킬을 제자리로 돌린다. 내용을 바꾼 CLAUDE.md는 sync 전 내용으로 돌린다.

- sync가 만든 파일은 지우지 않고 되돌리기 실행의 백업 폴더로 옮긴다.
- sync 뒤에 링크 자리에 생긴 것도 되돌리기 실행의 백업 폴더로 옮기고 출력에 알린다. 옮긴 스킬 폴더 안에 새로 쓴 파일은 그 폴더와 함께 돌아간다.
- sync 뒤에 `~/.agents/skills`에 새로 만든 스킬은 그대로 남는다. sync가 만든 폴더라도 비어 있지 않으면 지우지 않고 남은 항목을 출력에 적는다.
- doctor 실행은 대상이 아니다. doctor가 고친 것을 되돌리려면 그 실행의 백업 폴더에서 직접 꺼낸다.
- 아직 되돌리지 않은 더 새 sync가 있으면 예전 실행은 거부한다. 새것부터 되돌린다.
- 되돌리기 전에 기록 전체를 검사한다. 경로가 다루는 자리(`~/.agents`, 각 홈의 `skills`와 규칙 파일, 실행 폴더) 밖을 가리키거나 모르는 동작이 있으면 아무것도 바꾸지 않고 멈춘다. 대상보다 새 실행 중에 읽지 못한 기록이 있어도 멈춘다.
- 되돌리기가 중간에 멈추면 어디까지 돌렸는지 기록에 남는다. 다시 돌리면 멈춘 단계부터 이어간다.

## doctor가 보는 것

| 문제               | 뜻                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `missing_link`     | 링크가 있어야 할 자리가 비었다                                                            |
| `broken_link`      | 링크가 없는 곳을 가리킨다                                                                 |
| `wrong_target`     | 링크가 `~/.agents` 말고 다른 곳을 가리킨다                                                |
| `replaced_by_file` | 링크 자리에 실제 파일이나 폴더가 있다                                                     |
| `missing_import`   | CLAUDE.md에 가져오기 줄이 없다                                                            |
| `source_missing`   | `~/.agents/AGENTS.md`나 `~/.agents/skills`가 없다. doctor가 못 고친다. sync를 먼저 돌린다 |

`--fix`는 백업한 뒤 sync와 같은 방식으로 고친다. 실제 `skills` 폴더를 링크로 바꿀 때 sync와 달리 안의 항목을 `~/.agents/skills`로 합치지 않는다. 거기 없는 항목은 백업에만 있으니 필요하면 직접 옮기라고 출력에 적는다.

도구 경고는 사용자 설정 `tools`에 적은 도구만 확인한다. 목록이 비어 있으면 아무것도 확인하지 않는다. 경고에는 호스트 이름과 도구 이름이 같이 나온다.

## 사용자 설정

`~/.gestalt/agent-sync.json`에 둔다. 칸은 [설정 레퍼런스](./configuration.md#설정-동기화-gestaltagent-syncjson)에 있다. 계정 이름과 도구 목록은 이 파일에서만 읽고 코드에는 넣지 않는다.

## Claude에만 쓸 스킬

`~/.claude/skills`가 `~/.agents/skills`로 가는 링크라 거기 만든 스킬은 Codex에도 보인다. Claude에서만 쓸 스킬은 아래 자리에 둔다.

- 플러그인 스킬. 플러그인은 Claude 쪽에만 설치된다.
- 레포 안 `.claude/skills/`. 그 레포의 Claude 세션에서만 보인다.

## 정한 기본값

스펙이 정하지 않아서 이 구현이 고른 값이다. 바꾸기 쉬운 쪽으로 골랐다.

| 항목                         | 고른 값                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 되돌리기 명령                | 따로 명령을 두지 않고 `gestalt sync --revert [id]`                                                                 |
| doctor 기본 동작             | 보고만 한다. 고치는 건 `--fix`                                                                                     |
| 기록 파일                    | 실행 폴더 안 `run.json`                                                                                            |
| 백업 정리 시점               | 쓰는 실행이 시작할 때와 되돌리기가 끝났을 때                                                                       |
| 사용자 설정 파일             | `~/.gestalt/agent-sync.json`                                                                                       |
| 계정 홈의 실제 `skills` 폴더 | 시스템 홈과 같이 `~/.agents/skills`로 합친다                                                                       |
| 링크인 시스템 CLAUDE.md      | 가리키는 파일은 그대로 두고 링크를 백업한 뒤 그 자리에 새 파일을 둔다. 그 파일을 다른 호스트가 같이 볼 수 있어서다 |
| 상대 경로 링크인 스킬        | 옮긴 뒤 절대 경로 링크로 다시 건다                                                                                 |
| sync가 만든 파일의 되돌리기  | 지우지 않고 백업으로 옮긴다                                                                                        |
| 세션용 스킬                  | 만들지 않았다. 세션에서는 `gestalt sync`나 `gestalt doctor`를 셸로 부른다                                          |

## 수동 확인

실제 세션에서 규칙과 스킬이 보이는지는 테스트로 못 본다. 아래 순서로 직접 확인한다. sync는 실제 홈을 바꾸니 미리보기부터 본다. 문제가 생기면 `gestalt sync --revert`로 돌린다.

### 준비

```bash
gestalt sync --dry-run   # 대상 홈에 Claude 계정 전부와 Codex 홈이 나오는지 본다
gestalt sync
gestalt doctor           # "어긋난 연결이 없어요"가 나와야 한다
```

### 같은 규칙 (AC0)

1. `~/.agents/AGENTS.md` 맨 아래에 확인용 줄을 넣는다.

   ```
   [sync-check] 답변 첫 줄에 SYNC-OK라고 적는다
   ```

2. 아래 세션을 새로 열고 "안녕"이라고 보낸다. 이미 열려 있던 세션은 규칙을 다시 안 읽으니 새로 연다.
   - Claude 첫 번째 계정
   - Claude 두 번째 계정
   - 터미널 Codex
   - 오르카가 띄운 Codex
3. 네 세션 모두 답변 첫 줄에 `SYNC-OK`가 나오면 통과다. 안 나오는 세션이 있으면 그 홈의 연결을 확인한다.

   ```bash
   ls -l ~/.codex/AGENTS.md        # ~/.agents/AGENTS.md를 가리켜야 한다
   head -1 ~/.claude/CLAUDE.md     # @~/.agents/AGENTS.md
   gestalt doctor
   ```

4. 확인용 줄을 지운다.

### 같은 스킬 (AC1)

1. Claude 첫 번째 계정 세션에서 스킬 하나를 만들어 달라고 한다. 예를 들어 "`sync-check` 스킬을 만들어 줘. 부르면 SKILL-OK라고만 답하는 스킬이야."
2. 스킬 폴더가 `~/.agents/skills`에 생겼는지 본다.

   ```bash
   ls ~/.agents/skills/sync-check/SKILL.md
   ```

3. Claude 두 번째 계정과 터미널 Codex, 오르카가 띄운 Codex에서 새 세션을 열고 스킬 목록에 `sync-check`가 뜨는지 본다. Claude는 `/skills`, Codex는 `/skills`나 `$` 입력 목록에서 본다. 불렀을 때 `SKILL-OK`가 나오면 통과다.
4. `~/.agents/skills/sync-check` 폴더를 지운다.
