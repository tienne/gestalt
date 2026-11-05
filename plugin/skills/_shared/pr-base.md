# PR base 고르기

이 문서는 GitHub PR을 만드는 스킬(`pr`, `ship`)이 함께 쓴다. 1~3절은 사용자가 base를 직접 주지 않았을 때 적용한다. 사용자가 준 base는 후보 고르기를 건너뛰지만 0절의 이름 검사와 4절의 비교 기준은 똑같이 거친다.

## 왜 필요한가

기능 브랜치 위에 쌓은 브랜치(스택 브랜치)를 올릴 때 base를 기본 브랜치로 잡으면 PR diff에 상위 브랜치의 커밋이 전부 섞인다. 리뷰어는 남의 변경까지 읽게 되고 머지하면 상위 브랜치보다 먼저 기본 브랜치에 들어간다. 오르카에서 상위 워크트리의 브랜치를 기준으로 하위 워크트리를 만들면 이 상황이 흔하게 생긴다.

## 0. 브랜치 이름 검사

base 이름은 뒤에서 PR 생성 명령의 `--base "<base>"`, `gh pr list --head "<후보>"`, `git rev-list "origin/<base>"..HEAD`처럼 큰따옴표 안 셸 명령에 그대로 들어간다. `$(...)`나 백틱이 든 이름이면 명령 치환이 일어나고 `-`로 시작하면 옵션으로 읽힌다. 그래서 **출처와 상관없이** 아래 세 자리의 이름을 명령에 넣기 전에 검사한다.

| 이름이 온 자리 | 걸리면 |
| --- | --- |
| 사용자가 준 base나 `target` | 멈추고 사용자에게 묻는다 |
| 1절 후보 뽑기의 원격 브랜치 | 후보에서 빼고 `skip <이름>`을 표준 에러에 남긴다 (1절 스니펫이 한다) |
| 2절 오르카 값 | 쓰지 않는다 (2절 스니펫이 한다) |

사용자가 준 이름은 따옴표로 감싸 변수에 넣지 않는다. 이름에 `'`가 있으면 그 자리에서 따옴표가 닫힌다. 따옴표 붙은 heredoc으로 받아 글자 그대로 넣는다.

```bash
name=$(cat <<'BRANCH_NAME_END'
<사용자가 준 이름>
BRANCH_NAME_END
)
[[ $name =~ ^[A-Za-z0-9._][A-Za-z0-9._/-]*$ ]] && echo ok || echo "bad-name"
```

- 영문, 숫자, `.`, `_`, `/`, `-`만 받고 첫 글자에는 `/`와 `-`를 받지 않는다
- `git check-ref-format`은 `feat/$(id)` 같은 이름을 통과시키므로 쓰지 않는다
- `[[ =~ ]]`는 bash와 zsh에서 같게 돈다. 줄바꿈이 든 값도 걸린다

## 1. 후보 뽑기

원격 브랜치마다 현재 브랜치와의 merge-base를 구하고 그 merge-base 이후에 쌓인 내 커밋 수를 센다. 이 수가 가장 작은 브랜치가 내가 실제로 갈라져 나온 브랜치다.

```bash
default=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)
me=$(git rev-parse --abbrev-ref HEAD)
head=$(git rev-parse HEAD)
GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=20 git fetch --quiet origin \
  || echo "fetch-failed" >&2
refs=$(git for-each-ref --format='%(refname)' refs/remotes/origin | grep -vc '/HEAD$')
[ "$refs" -le 1 ] && echo "only-default" >&2
[ "$refs" -gt 200 ] && echo "capped $refs" >&2

{ echo "refs/remotes/origin/$default"
  git for-each-ref --sort=-committerdate --count=200 --format='%(refname)' refs/remotes/origin
} | awk '!seen[$0]++' | while read -r ref; do
  name=${ref#refs/remotes/origin/}
  [ "$name" = HEAD ] || [ "$name" = "$me" ] && continue
  [[ $name =~ ^[A-Za-z0-9._][A-Za-z0-9._/-]*$ ]] || { echo "skip $name" >&2; continue; }
  mb=$(git merge-base HEAD "$ref") || continue
  [ "$mb" = "$head" ] && [ "$name" != "$default" ] && continue
  echo "$(git rev-list --count "$mb"..HEAD) $name"
done | sort -n -k1,1 -s | head -5
```

표준 출력은 `<내 커밋 수> <브랜치>` 줄이고 가까운 순이다. 표준 에러에는 아래 "보고 줄" 절이 쓰는 표시가 나온다.

- **기본 브랜치를 맨 앞에 넣고 안정 정렬(`-s`)한다.** 수가 같으면 기본 브랜치가 앞에 남는다. 상위 브랜치가 merge commit으로 기본 브랜치에 이미 들어갔으면 두 브랜치의 수가 같아지는데 그때는 기본 브랜치가 맞다
- **merge-base가 HEAD인 브랜치는 뺀다.** 내 커밋을 전부 담은 브랜치라 base가 아니다. 내 위에 쌓인 하위 브랜치나 같은 커밋을 다른 이름으로 올린 브랜치가 여기 걸린다. 기본 브랜치만은 빼지 않는다. 내 커밋이 이미 기본 브랜치에 들어갔으면 기본 브랜치가 수 0으로 남는다. 부르는 스킬은 그 수를 보고 올릴 커밋이 없다고 멈춘다
- **0절 이름 검사에 걸린 브랜치는 후보에서 뺀다.** 뺀 이름은 `skip <이름>`으로 표준 에러에 남긴다. 여기 이름은 `read`로 받은 변수라 검사하는 중에 치환이 일어나지는 않는다
- **최근 커밋 순 200개만 본다.** 원격 브랜치가 수천 개인 레포에서 merge-base를 전부 구하면 오래 걸린다. 갈라져 나온 상위 브랜치는 대개 최근에 움직인 브랜치다. 원격 브랜치가 200개를 넘으면 `capped <개수>`를 남긴다. 상위 브랜치가 200개 밖에 있으면 기본 브랜치로 정해지기 때문이다
- **`git fetch`를 먼저 한다.** 원격 추적 브랜치가 낡으면 이미 머지된 상위 브랜치를 후보로 고른다. HTTP 원격은 20초 동안 초당 1KB도 못 받으면 끊는다. SSH 원격은 사용자의 ssh 설정을 따르므로 여기서 상한을 걸지 않는다. 실패하면 `fetch-failed`를 남기고 낡은 ref로 그대로 진행한다. 원격 추적 브랜치가 기본 브랜치 하나뿐이면(단일 브랜치 클론) `only-default`를 남긴다. 둘 다 상위 브랜치를 못 보고 기본 브랜치로 정해지는 경우다

## 2. 보조 신호

후보를 정하는 건 후보 뽑기에서 센 커밋 수다. 아래 신호는 동률을 가르거나 근거를 덧붙이는 데만 쓴다.

**열린 PR.** 1등 후보가 기본 브랜치가 아니면 그 브랜치에 걸린 PR을 본다.

```bash
gh pr list --head "<후보>" --state all --json number,state --jq '.[] | "\(.state) #\(.number)"'
```

| 결과 | 처리 |
| --- | --- |
| `OPEN`이 있다 | 후보로 확정한다. 근거에 PR 번호를 적는다 |
| `MERGED`만 있다 | 상위 브랜치가 squash 머지로 이미 들어간 경우다. 기본 브랜치를 base로 잡고 내 브랜치에 상위 브랜치의 커밋이 그대로 남아 있어 diff에 섞인다고 알린다. rebase는 사용자가 정한다 |
| `CLOSED`만 있다 | 상위 브랜치를 버린 경우일 수 있다. 사용자에게 묻는다 |
| 없다 | 후보로 확정한다. 근거에 "PR 없음"을 적는다 |

**오르카 워크트리 정보.** `orca` 명령이 있을 때만 본다. 없으면 이 신호 없이 진행한다.

```bash
cur=$(orca worktree current --json)
orcaBase=$(printf '%s' "$cur" | jq -r '.result.worktree.baseRef // empty')
orcaBase=${orcaBase#refs/remotes/origin/}; orcaBase=${orcaBase#refs/heads/}
parent=$(printf '%s' "$cur" | jq -r '.result.worktree.parentWorktreeId // empty')
orcaParent=
[ -n "$parent" ] && orcaParent=$(orca worktree show --worktree "id:$parent" --json \
  | jq -r '.result.worktree.branch // empty')
for v in "$orcaBase" "$orcaParent"; do
  [ -n "$v" ] || continue
  [[ $v =~ ^[A-Za-z0-9._][A-Za-z0-9._/-]*$ ]] && echo "$v" || echo "skip $v" >&2
done
```

- 첫 값은 이 워크트리를 만들 때 기준으로 삼은 ref에서 `refs/remotes/origin/`이나 `refs/heads/`를 뗀 이름이다
- 두 번째 값은 상위 워크트리가 지금 체크아웃한 브랜치다. 상위 워크트리가 기본 브랜치 체크아웃이면 기본 브랜치가 나온다
- `orca`는 `--jq`를 안 받는다. `jq`로 거른다
- 0절 이름 검사에 걸린 값은 찍지 않고 `skip <값>`을 표준 에러에 남긴다
- 두 값이 가리키는 브랜치가 동률 후보 안에 있으면 그 브랜치로 정한다. 후보 밖이면 정하는 데 쓰지 않고 보고에만 적는다. 상위 브랜치가 원격에 아직 안 올라갔거나 이미 머지된 경우다

## 3. 정하기

| 상황 | 처리 |
| --- | --- |
| 1등이 기본 브랜치다 (동률 포함) | 기본 브랜치로 진행한다 |
| 1등이 기본 브랜치가 아닌 브랜치 하나다 | 열린 PR 표대로 처리한다. 확정되면 그 브랜치로 진행한다 |
| 기본 브랜치가 아닌 브랜치가 여럿 동률이다 | 열린 PR이 있는 브랜치가 하나뿐이거나 오르카 정보가 하나를 가리키면 그 브랜치로 정한다. 그래도 못 가르면 후보를 보여주고 묻는다 |
| 후보가 하나도 없다 | merge-base를 못 구한 경우다(기본 브랜치와 이력이 안 이어짐). 사용자에게 묻는다 |

### 보고 줄

아래 가운데 하나라도 해당하면 부르는 스킬이 사전 점검 보고에 한 줄씩 싣는다. 하나도 없으면 따로 알리지 않는다.

| 언제 | 줄 |
| --- | --- |
| 기본 브랜치가 아닌 브랜치로 정했다 | `base를 feat/parent로 잡았어요 (근거: 내 커밋 2개만 앞섬, 기본 브랜치 main은 4개, 열린 PR #123)` |
| 상위 PR이 `MERGED`라 기본 브랜치로 돌아갔다 | `상위 브랜치 feat/parent는 #123으로 이미 머지돼서 base를 main으로 잡았어요. 상위 커밋이 diff에 섞여요` |
| 표준 에러에 `skip <이름>`이 있다 | `base 후보에서 뺀 브랜치: <이름> (쓸 수 없는 글자가 있음). 이 브랜치가 base면 직접 알려주세요` |
| 표준 에러에 `fetch-failed`나 `only-default`, `capped`가 있다 | `base 자동 선택 근거가 약해요: <fetch 실패 \| 원격 브랜치가 기본 브랜치뿐 \| 원격 브랜치 N개 중 최근 200개만 봄>` |

사용자가 이 줄을 보고 다른 base를 말하면 그 값으로 바꾼다.

## 4. 비교 기준 ref

base가 정해지면(사용자가 줬든 1~3절로 골랐든) 커밋 수와 diff를 볼 ref를 여기서 정한다. `ship` Phase 0의 커밋 0 판정과 `pr` 2단계의 diff 수집이 같은 ref를 써야 두 스킬이 같은 판정을 한다. 0절 이름 검사를 통과한 이름만 넣는다.

```bash
GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=20 git fetch --quiet origin "<base>" \
  || echo "fetch-failed" >&2
baseRef=$(git rev-parse --verify --quiet "refs/remotes/origin/<base>" >/dev/null \
  && echo "origin/<base>" || echo "<base>")
echo "baseRef=$baseRef commits=$(git rev-list --count "$baseRef"..HEAD)"
```

- `origin/<base>`가 있으면 그것을 쓴다. 로컬 브랜치는 원격보다 뒤처질 수 있고 PR은 원격 브랜치와 비교된다
- `commits`가 0이면 올릴 커밋이 없다. 부르는 스킬이 멈춘다
- 셸 상태가 호출 사이에 안 남는 런타임이 있어서 `baseRef`를 쓰는 명령은 이 블록과 같은 호출 안에 붙여 돌린다
- `--base`에는 `origin/` 없이 `<base>` 이름만 넘긴다

## 확인한 상황

임시 레포에서 아래 상황을 만들어 후보 뽑기 절차를 돌려봤다.

| 상황 | 1등 | 결과 |
| --- | --- | --- |
| 상위 브랜치 위에 쌓았고 상위와 기본 브랜치가 둘 다 그 뒤로 더 나감 | 상위 (2) | 기본 브랜치는 4 |
| 기본 브랜치에서 바로 땄다 | 기본 (1) | 나머지는 2 |
| 상위가 merge commit으로 기본 브랜치에 들어감 | 기본 (2) | 상위와 동률이라 기본이 앞에 남음 |
| 같은 커밋을 가리키는 상위 브랜치가 둘 | 상위 둘 (2) | 정하기 표의 동률 규칙으로 감 |
| 내 위에 하위 브랜치가 쌓여 있음 | 영향 없음 | merge-base가 HEAD라 빠짐 |
| 내 커밋이 이미 기본 브랜치에 fast-forward로 들어감 | 기본 (0) | 기본 브랜치는 merge-base가 HEAD여도 남아서 부르는 스킬이 커밋 없음으로 멈춤 |
| 원격에 `feat/$(id)` 브랜치가 있음 | 영향 없음 | `skip feat/$(id)`가 표준 에러에 남고 후보에서 빠짐. `git check-ref-format --branch`는 이 이름을 통과시킴 |
| 기본 브랜치만 받은 단일 브랜치 클론 | 기본 (1) | `only-default`가 표준 에러에 남음 |
