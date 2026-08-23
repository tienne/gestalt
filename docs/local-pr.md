# 로컬 PR

에이전트가 쪼갠 작업을 다른 에이전트에게 리뷰받는 자리다. 원격에 나가지 않는다.

원격 GitHub PR은 사람에게 넘기려고 만든다. 그건 그대로 둔다. 로컬 PR은 다른 쓸모다 —
에이전트 여럿이 워크트리를 나눠 각자 작업한다. 서로의 결과를 리뷰하고 고쳐서 다시 받는
왕복이 레포 안에서 끝난다. `gh`도 인증도 네트워크도 필요 없다.

**한 작업 단위가 PR 하나다.** 사람이 만들 때도 있고 에이전트가 만들 때도 있다.

## 왜 이걸 만들었나

에이전트가 만든 것을 그 에이전트가 검토하면 놓친 자리를 그대로 놓친다. 다른 에이전트에게
넘기면 잡힌다. 그런데 넘길 자리가 없었다. GitHub에 올리면 사람 리뷰 큐에 섞이고 원격
왕복이 붙는다. 에이전트끼리 주고받는 데는 그게 다 군더더기다.

이 시스템을 만들면서 스스로 리뷰해 본 결과가 있다. 다섯 PR을 워크트리로 나눠 만들고
서로 리뷰하게 했더니, 게이트가 깨진 채 올라온 PR, 코드를 일부러 깨도 안 죽는 빈 테스트,
1라운드에 고친 자리가 2라운드에 옮겨 간 구멍이 각각 잡혔다. 셋 다 통과 결과만 봐서는
안 보이는 것들이다.

## 상태

```
open ──review(request_changes)──> changes_requested ──update──> open
  │                                                              │
  ├── review(approve) ────────────────────────────────────────> open (판정만 기록)
  ├── merge ──> merged
  └── close ──> closed
```

`request_changes`가 나면 **새 PR을 만들지 않고 같은 PR에 라운드를 늘린다.** 3라운드에서
다시 열린 지적이 어느 라운드에서 났고 어디서 닫혔는지가 한 자리에 남는다.

**승인 게이트는 없다.** 미해결 스레드가 남아 있어도 머지를 막지 않는다. 대신 머지 시점의
미해결 수가 이벤트에 남는다. 나중에 그 판단을 되짚을 수 있다.

## 저장

이벤트 소싱이다. 상태를 따로 저장하지 않고 이벤트를 처음부터 다시 훑어 만든다(`src/local-pr/repository.ts`).
저장소는 `.gestalt/reviews.db`다. 경로를 `--git-common-dir` 기준으로 잡아서 **워크트리
어디서 불러도 같은 파일을 본다.** 이게 아니면 워크트리마다 PR 목록이 갈린다.

PR의 커밋은 `refs/gestalt/pr/<id>/head`와 `.../base`가 붙잡는다. GitHub이 `refs/pull/N/head`를
두는 것과 같은 이유다 — 워커가 브랜치를 지우거나 리베이스해도 diff가 산다. 붙잡지 않으면
gc가 수거해 간 뒤 PR이 빈 껍데기가 된다.

## CLI

```bash
gestalt pr create --title "..." --base main --body-file body.md
gestalt pr list [--status open|changes_requested|merged|closed]
gestalt pr show <id>
gestalt pr diff <id>
gestalt pr comment <id> --path <파일> [--line N] --body-file c.md [--reply-to <commentId>]
gestalt pr comments <id> [--unresolved]
gestalt pr resolve <id> <commentId>
gestalt pr review <id> --verdict approve|request-changes|comment --body-file v.md
gestalt pr update <id> [--head <커밋>]
gestalt pr merge <id> [--delete-branch]
gestalt pr close <id> [--reason "..."]
gestalt pr checkout <id> [--remove] [--force]
gestalt pr prune [--checkouts] [--dry-run]
gestalt pr serve [--port N] [--no-browser]
```

모든 명령이 `--json`과 `--repo-root <경로>`를 받는다.

**본문은 인자가 아니라 `--body-file`로 넘긴다.** 셸을 타면 한글과 백틱, 줄바꿈이 깨진다.
`-`를 주면 stdin에서 읽는다 — `gh`가 `--body-file`에 쓰는 방식과 같다.

**누가 했는지는 `GESTALT_ACTOR` 환경변수나 `--author`로 준다.** `codex:worker-1`,
`claude-code:main`, `human:tienne` 같은 형태다. 안 주면 `human:local`이다. 작성자와
리뷰어가 갈려야 "누가 지적했고 누가 답했나"가 남는다.

### 종료 코드

에이전트가 stdout을 파싱하지 않고도 갈래를 타게 만든 값이다.

| 코드 | 뜻 |
| --- | --- |
| 0 | 정상 |
| 1 | 입력이 잘못됐다 |
| 3 | PR이나 코멘트를 못 찾았다 |
| 4 | 상태가 안 맞는다 (이미 머지됨, 지킬 변경이 있음 등) |

## 리뷰용 체크아웃

`pr diff`는 텍스트만 준다. 그런데 테스트가 무언가를 실제로 잡는지 보려면 코드를 돌려봐야
한다 — 핵심 줄을 일부러 깨고 테스트가 실패하는지 확인하는 식이다. 통과 결과만 보면
아무것도 안 잡는 테스트도 초록으로 보인다.

리뷰어의 워크트리는 자기 브랜치를 체크아웃하고 있어서 PR 코드가 거기 없다. 떼어낸다.

```bash
gestalt pr checkout <id> --json          # { path, created, headSha }
gestalt pr checkout <id> --remove --json # 정리
```

`--detach`로 뗀다. 브랜치를 잡으면 그 브랜치를 이미 체크아웃한 워크트리와 부딪힌다. 같은
PR을 두 번 불러도 워크트리는 하나이고 그 안의 변경은 살아남는다.

떼어낸 자리는 공용 git 디렉토리 아래다. `.git/`은 워킹 트리가 아니라서 추적 안 되는
디렉토리가 리뷰 중인 diff에 안 섞인다. 공유 `/tmp`를 안 쓰는 이유는 그 경로가 예측
가능해서 남이 먼저 만들어 두면 리뷰 중인 소스가 남의 자리에 풀리기 때문이다.

정리 결과는 `status`로 갈래를 탄다. 산문 `reason`을 부분 문자열로 긁지 않는다.

| status | 뜻 | 종료 코드 |
| --- | --- | --- |
| `removed` | 지웠다 | 0 |
| `absent` | 지울 자리가 없었다 | 0 |
| `dirty` | 커밋 안 된 변경이 있어 안 지웠다 | 4 |
| `diverged` | 거기서 커밋한 변경이 있어 안 지웠다 | 4 |
| `stale` | 등록이 끊기고 디렉토리만 남아, 안을 못 읽어 안 지웠다 | 4 |

`absent`가 0인 이유는 지울 게 없으면 정리는 이미 끝난 셈이어서다. 4로 주면
`--remove`를 두 번 부르는 `set -e` 스크립트가 두 번째에 죽는다.

`stale`을 `dirty`에 얹지 않는 이유는 둘이 다른 상태여서다. `dirty`는 안을 읽어 커밋 안 된
변경을 확인한 것이고 `stale`은 읽을 방법이 없어 판단을 미룬 것이다.

`dirty`와 `diverged`와 `stale`은 확인한 뒤 `--force`로 다시 부른다. `diverged`를 force로 지우면 그
커밋을 `refs/gestalt/pr-checkout/<id>/<sha 8자>`가 붙잡아 둔다. 떼어낸 자리는 detached
HEAD라 브랜치 ref도 워크트리 reflog도 함께 죽는다. 붙잡지 않으면 되짚을 실마리가 없다.

## ref 반납

`refs/gestalt/` 아래는 붙이기만 하고 놓는 자리가 없었다. 머지된 PR도 base와 head를 영구
보유한다. 체크아웃을 `--force`로 지울 때마다 자국도 한 칸씩 더 쌓인다. 오래 쓴 레포일수록
`for-each-ref`가 느려지고 `git gc`가 놓지 못하는 객체가 늘어난다.

```bash
gestalt pr prune             # 머지된 PR의 base와 head를 놓는다
gestalt pr prune --dry-run   # 무엇을 놓을지만 본다
gestalt pr prune --checkouts # 체크아웃 자국도 놓는다
```

무엇을 놓는지는 **놓아도 커밋이 안 사라지는가**로 가른다.

| 대상 | 기본 | 왜 |
| --- | --- | --- |
| 머지된 PR의 base·head | 놓는다 | 머지 커밋이 둘 다 base 브랜치 이력에 넣었다 |
| 닫힌 PR의 head | 남긴다 | 닫힌 PR도 `checkout`으로 떼어낸다고 약속했다 |
| 열린 PR | 남긴다 | 리뷰 중이다 |
| 체크아웃 자국 | 남긴다 | 어느 이력에도 없는 워크트리 전용 커밋이라 놓으면 영영 사라진다 |

머지된 PR이라도 head가 정말 base 이력에 있는지 확인한 뒤에 놓는다. 머지 뒤 누가 base를
되돌렸으면 그 근거가 깨지므로 안 놓고 이유를 돌려준다.

체크아웃 자국은 `--checkouts`로 뜻을 밝혔을 때, 그리고 그 PR이 이미 머지되거나 닫혀
리뷰가 끝났을 때만 놓는다.

## 웹 UI

```bash
gestalt pr serve
```

127.0.0.1에만 붙는 읽기 전용 뷰다. 코멘트 작성과 판정은 CLI 몫으로 남겼다 — 에이전트가
쓰는 표면이 하나여야 기록이 갈리지 않는다.

**서버 하나가 여러 레포를 보여준다.** `pr create`를 한 번이라도 돌린 레포는 `~/.gestalt/repos.json`에
등록된다. 어느 레포에서 `pr serve`를 치든 등록된 레포가 전부 뜬다. `/`는 지금 자리의 레포로
보내고 위쪽 줄에서 다른 레포로 옮겨 간다.

| 경로 | 내용 |
| --- | --- |
| `/` | 지금 레포로 보냄 |
| `/r/<키>` | 그 레포의 PR 목록 |
| `/r/<키>/prs/<id>` | PR 상세 |
| `/api/repos` | 등록된 레포 목록 |
| `/api/r/<키>/prs` | PR 목록 JSON |

URL에 실리는 건 경로가 아니라 **레포 키**(공용 git 디렉토리의 해시)다. 요청이 레포 경로를
지정할 수 있으면 인증 없는 이 서버가 이 머신의 아무 git 레포나 읽어주는 도구가 된다.
모르는 키는 404다. 워크트리 여럿은 저장소를 공유하므로 목록에서 한 줄이다.

## MCP

`ges_pr` 도구로 같은 일을 한다. 액션은 `create`, `list`, `get`, `diff`, `comment`,
`resolve`, `review`, `update`, `merge`, `close`, `checkout`, `checkout_remove`다.
오류는 `{ error, kind }`로 오고 `kind`는 `not_found`(종료 코드 3)나 `conflict`(4)다.

CLI를 먼저 만든 이유는 MCP가 없거나 끊긴 런타임에서도 돌아야 해서다. 셸만 있으면 되는
경로가 정본이고 MCP는 그 위의 껍데기다.

## 리뷰 파이프라인과 잇기

기존 Review 파이프라인(리뷰 에이전트 6종 + consensus)을 로컬 PR에 붙일 수 있다.
자세한 건 [`06-code-review.md`](./06-code-review.md)에 있다.

```
ges_execute { action: "review_start", prId: "<id>" }
  → PR의 변경 파일로 리뷰를 연다. sessionId나 changedFiles를 손으로 나열할 필요가 없다

ges_execute { action: "review_publish", reviewSessionId: "<id>" }
  → 합의된 지적을 인라인 코멘트로 쓰고 판정을 기록한다
```

`review_publish`는 멱등하다. 같은 합의를 두 번 옮겨도 코멘트가 늘지 않는다. 어디까지 썼는지는
코멘트의 `marker` 필드에 남긴다 — 본문에 실으면 CLI가 평문으로 찍고 웹이 이스케이프해서
화면에 내보내, 사람이 읽을 이유가 없는 해시 줄이 코멘트마다 붙는다. PR은 이벤트
소싱이라 한 번 붙은 코멘트를 지울 수 없다. 중복이 생기면 사람이 손으로 resolve하는
수밖에 없다.

## 스킬

`pr`, `review`, `review-reply` 세 스킬이 로컬 갈래를 탄다. `--local`을 붙이거나 로컬 PR
id를 주면 GitHub 대신 로컬 PR로 간다. 판별 규칙은 각 SKILL.md에 표로 있다.

## 워크트리로 나눠 쓰기

```bash
git worktree add -b feat/a /tmp/wt-a main
git worktree add -b feat/b /tmp/wt-b main

cd /tmp/wt-a && GESTALT_ACTOR=codex:worker-1 gestalt pr create --title "A" --base main
cd /tmp/wt-b && GESTALT_ACTOR=codex:worker-2 gestalt pr create --title "B" --base main
```

두 워크트리가 같은 `.gestalt/reviews.db`를 본다. 서로의 PR이 목록에 뜨고 리뷰할 수 있다.

머지는 base 브랜치가 어디에 체크아웃돼 있느냐에 따라 갈린다.

- **지금 워크트리가 base를 체크아웃하고 있으면** 그 자리에서 곧장 합친다.
- **어느 워크트리도 base를 체크아웃하고 있지 않으면** 임시 워크트리에서 합치고 브랜치 ref만 옮긴다.
  워커가 자기 워크트리에 그대로 있는 채로 머지할 수 있다.
- **다른 워크트리가 base를 체크아웃하고 있으면** 거부한다. 그쪽은 파일이 옛 상태인데 HEAD만
  움직인다. 그래서 git이 머지를 되돌리는 수정이 널려 있는 것처럼 보고한다.
