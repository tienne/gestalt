# PR base 고르기

이 문서는 GitHub PR을 만드는 스킬(`pr`, `ship`)이 함께 쓴다. 사용자가 base를 직접 주지 않았을 때 적용한다. 사용자가 준 base는 그대로 쓰고 이 절차를 건너뛴다.

## 왜 필요한가

기능 브랜치 위에 쌓은 브랜치(스택 브랜치)를 올릴 때 base를 기본 브랜치로 잡으면 PR diff에 상위 브랜치의 커밋이 전부 섞인다. 리뷰어는 남의 변경까지 읽게 되고 머지하면 상위 브랜치보다 먼저 기본 브랜치에 들어간다. 오르카에서 상위 워크트리의 브랜치를 기준으로 하위 워크트리를 만들면 이 상황이 흔하게 생긴다.

## 1. 후보 뽑기

원격 브랜치마다 현재 브랜치와의 merge-base를 구하고 그 merge-base 이후에 쌓인 내 커밋 수를 센다. 이 수가 가장 작은 브랜치가 내가 실제로 갈라져 나온 브랜치다.

```bash
default=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)
me=$(git rev-parse --abbrev-ref HEAD)
head=$(git rev-parse HEAD)
git fetch --quiet origin

{ echo "refs/remotes/origin/$default"
  git for-each-ref --sort=-committerdate --count=200 --format='%(refname)' refs/remotes/origin
} | awk '!seen[$0]++' | while read -r ref; do
  name=${ref#refs/remotes/origin/}
  [ "$name" = HEAD ] || [ "$name" = "$me" ] && continue
  mb=$(git merge-base HEAD "$ref") || continue
  [ "$mb" = "$head" ] && continue
  echo "$(git rev-list --count "$mb"..HEAD) $name"
done | sort -n -k1,1 -s | head -5
```

출력은 `<내 커밋 수> <브랜치>` 줄이고 가까운 순이다.

- **기본 브랜치를 맨 앞에 넣고 안정 정렬(`-s`)한다.** 수가 같으면 기본 브랜치가 앞에 남는다. 상위 브랜치가 merge commit으로 기본 브랜치에 이미 들어갔으면 두 브랜치의 수가 같아지는데, 그때는 기본 브랜치가 맞다
- **merge-base가 HEAD인 브랜치는 뺀다.** 내 커밋을 전부 담은 브랜치라 base가 아니다. 내 위에 쌓인 하위 브랜치나 같은 커밋을 다른 이름으로 올린 브랜치가 여기 걸린다
- **최근 커밋 순 200개만 본다.** 원격 브랜치가 수천 개인 레포에서 merge-base를 전부 구하면 오래 걸린다. 갈라져 나온 상위 브랜치는 대개 최근에 움직인 브랜치다
- **`git fetch`를 먼저 한다.** 원격 추적 브랜치가 낡으면 이미 머지된 상위 브랜치를 후보로 고른다

## 2. 보조 신호

후보를 정하는 건 1의 수다. 아래 신호는 동률을 가르거나 근거를 덧붙이는 데만 쓴다.

**열린 PR.** 1등 후보가 기본 브랜치가 아니면 그 브랜치에 걸린 PR을 본다.

```bash
gh pr list --head "<후보>" --state all --json number,state --jq '.[] | "\(.state) #\(.number)"'
```

| 결과 | 처리 |
| --- | --- |
| `OPEN`이 있다 | 후보로 확정한다. 근거에 PR 번호를 적는다 |
| `MERGED`만 있다 | 상위 브랜치가 squash 머지로 이미 들어간 경우다. 기본 브랜치를 base로 잡고, 내 브랜치에 상위 브랜치의 커밋이 그대로 남아 있어 diff에 섞인다고 알린다. rebase는 사용자가 정한다 |
| `CLOSED`만 있다 | 상위 브랜치를 버린 경우일 수 있다. 사용자에게 묻는다 |
| 없다 | 후보로 확정한다. 근거에 "PR 없음"을 적는다 |

**오르카 워크트리 정보.** `orca` 명령이 있을 때만 본다. 없으면 이 신호 없이 진행한다.

```bash
orca worktree current --json | jq -r '.result.worktree.baseRef // empty'
parent=$(orca worktree current --json | jq -r '.result.worktree.parentWorktreeId // empty')
[ -n "$parent" ] && orca worktree show --worktree "id:$parent" --json | jq -r '.result.worktree.branch'
```

- `baseRef`는 이 워크트리를 만들 때 기준으로 삼은 ref다. `refs/remotes/origin/feat/x`나 `refs/heads/feat/x`면 `feat/x`가 상위 브랜치다
- 두 번째 값은 상위 워크트리가 지금 체크아웃한 브랜치다. 상위 워크트리가 기본 브랜치 체크아웃이면 기본 브랜치가 나온다
- `orca`는 `--jq`를 안 받는다. `jq`로 거른다
- 두 값이 가리키는 브랜치가 1의 동률 후보 안에 있으면 그 브랜치로 정한다. 후보 밖이면 정하는 데 쓰지 않고 보고에만 적는다. 상위 브랜치가 원격에 아직 안 올라갔거나 이미 머지된 경우다

## 3. 정하기

| 상황 | 처리 |
| --- | --- |
| 1등이 기본 브랜치다 (동률 포함) | 기본 브랜치로 진행한다. 따로 알리지 않는다 |
| 1등이 기본 브랜치가 아닌 브랜치 하나다 | 2의 PR 표대로 처리하고, 확정되면 그 브랜치로 진행한다 |
| 기본 브랜치가 아닌 브랜치가 여럿 동률이다 | 열린 PR이 있는 브랜치가 하나뿐이거나 오르카 정보가 하나를 가리키면 그 브랜치로 정한다. 그래도 못 가르면 후보를 보여주고 묻는다 |

기본 브랜치가 아닌 브랜치로 정했으면 사전 점검 보고에 한 줄로 밝힌다.

```
base를 feat/parent로 잡았어요 (근거: 내 커밋 2개만 앞섬, 기본 브랜치 main은 4개, 열린 PR #123)
```

사용자가 이 줄을 보고 다른 base를 말하면 그 값으로 바꾼다.

## 확인한 상황

임시 레포에서 아래 상황을 만들어 1의 절차를 돌려봤다.

| 상황 | 1등 | 결과 |
| --- | --- | --- |
| 상위 브랜치 위에 쌓았고 상위와 기본 브랜치가 둘 다 그 뒤로 더 나감 | 상위 (2) | 기본 브랜치는 4 |
| 기본 브랜치에서 바로 땄다 | 기본 (1) | 나머지는 2 |
| 상위가 merge commit으로 기본 브랜치에 들어감 | 기본 (2) | 상위와 동률이라 기본이 앞에 남음 |
| 같은 커밋을 가리키는 상위 브랜치가 둘 | 상위 둘 (2) | 3의 동률 규칙으로 감 |
| 내 위에 하위 브랜치가 쌓여 있음 | 영향 없음 | merge-base가 HEAD라 빠짐 |
