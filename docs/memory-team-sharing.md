# Memory 팀 공유 가이드

Gestalt의 `memory.json`은 프로젝트별 누적 컨텍스트(Spec 히스토리, 실행 기록, 아키텍처 결정)를 저장합니다.
팀이 이 파일을 공유하면 모든 구성원이 같은 프로젝트 컨텍스트를 바탕으로 작업할 수 있습니다.

## 팀 공유 방법 (git commit + pull)

### 1. memory.json을 git에 커밋

`.gestalt/memory.json`은 기본적으로 `.gitignore`에 포함되어 있지 않습니다.
아래와 같이 git에 커밋하고 공유하세요.

```bash
git add .gestalt/memory.json
git commit -m "chore(memory): update project memory"
git push
```

팀원은 최신 memory.json을 받습니다.

```bash
git pull
```

### 2. 충돌 발생 시

두 명이 동시에 memory.json을 수정하면 git 머지 충돌이 나기 쉽습니다. 양쪽 다 배열 끝에 항목을 붙이기 때문에 git 눈에는 같은 자리를 서로 다르게 고친 것으로 보입니다.
Gestalt가 제공하는 merge driver를 등록해 두면 git이 이 충돌을 알아서 풉니다.

---

## memory merge driver 등록

`gestalt memory-merge`는 git이 memory.json을 머지할 때 대신 불러 쓰는 **merge driver**입니다.
양쪽 기록을 JSON 구조 그대로 합쳐서 충돌 없이 커밋할 수 있게 만듭니다.

### 등록하는 방법

`.gitattributes`는 레포에 커밋해서 팀 전체가 공유합니다.

```gitattributes
# .gitattributes
.gestalt/memory.json merge=gestalt-memory
```

driver 정의는 `git config`에 들어가는데, `git config`는 커밋되지 않습니다. 팀원마다 레포에서 한 번씩 실행해야 합니다.

```bash
git config merge.gestalt-memory.name "Gestalt memory merge"
```

driver 명령은 gestalt를 어떻게 설치했느냐에 따라 고릅니다. 위에 있는 것부터 씁니다.

`gestalt`를 전역 설치했다면 그대로 부릅니다.

```bash
git config merge.gestalt-memory.driver "gestalt memory-merge %O %A %B"
```

레포 devDependency로 설치했다면 `pnpm exec`로 부릅니다.

```bash
git config merge.gestalt-memory.driver "pnpm exec gestalt memory-merge %O %A %B"
```

둘 다 아니라서 npx를 써야 한다면 버전을 꼭 박습니다. 버전을 빼면 머지할 때마다 레지스트리의 최신 패키지를 확인 없이 받아 실행합니다.

```bash
git config merge.gestalt-memory.driver "npx -y @tienne/gestalt@<버전> memory-merge %O %A %B"
```

`<버전>`에는 `memory-merge` 명령이 처음 들어간 버전 이상을 넣습니다. 그보다 옛 버전이면 명령이 없어서 머지할 때마다 driver가 실패합니다. npx는 버전을 박아도 실행할 때마다 레지스트리를 조회하므로, 캐시가 비어 있으면 머지 한 번에 수십 초가 걸릴 수 있습니다.

> ⚠️ **주의**: `.gitattributes`만 커밋하고 `git config`를 빠뜨린 팀원은 driver가 정의되지 않은 상태라 git 기본 머지로 돌아갑니다. 그 팀원에게는 예전처럼 충돌 표시가 남습니다.

> ⚠️ **주의**: `merge=union`은 쓰지 마세요. 줄 단위로 양쪽을 이어 붙이기 때문에 쉼표나 괄호가 어긋나 JSON이 깨질 수 있습니다.

### 동작 방식

git은 `%O`(공통 조상), `%A`(현재 브랜치, ours), `%B`(머지해 들어오는 쪽, theirs) 세 파일 경로를 넘깁니다.

- 합친 결과를 `%A` 파일에 쓰고 종료 코드 0으로 끝납니다. git은 이 결과를 머지 결과로 받습니다.
- 어느 한쪽이라도 JSON으로 못 읽거나 구조가 맞지 않으면 종료 코드 1로 끝납니다. 배열이어야 할 필드가 배열이 아니거나, spec 항목에 `specId`, `goal`, `createdAt` 문자열이 없을 때가 여기에 해당합니다. 이때 git은 파일에 충돌 마커를 넣지 않습니다. memory.json을 충돌 상태(unmerged)로 표시하고 파일에는 현재 브랜치 내용이 손대지 않은 채 남습니다.
- `%O`는 읽지 않습니다. `specHistory`, `executionHistory`, `architectureDecisions`는 쌓기만 하는 기록이라 공통 조상과 비교하지 않고 합집합으로 충분합니다. `compressedContexts`는 같은 세션의 요약을 덮어써서 갱신하는 기록이라, 같은 `sessionId`가 양쪽에 있으면 `compressedAt`이 더 최신인 쪽을 남깁니다. 둘이 같으면 theirs를 남깁니다.
- v1 형식(아키텍처 결정이 문자열 배열인 파일)도 읽어서 v2 구조로 바꾼 뒤 합칩니다.

### 머지 전략

| 필드 | 기준 키 | 전략 |
|------|--------|------|
| `specHistory` | `specId` | 양쪽 합집합 |
| `executionHistory` | `executeSessionId` | 양쪽 합집합 |
| `architectureDecisions` | `decision` 문자열 | 양쪽 합집합. `timestamp`는 비교하지 않습니다. 한쪽에만 `outcome`이 있으면 그쪽을 남깁니다 |
| `compressedContexts` | `sessionId` | 양쪽 합집합. 같은 `sessionId`면 `compressedAt`이 더 최신인 쪽을 남기고, 같으면 theirs를 남깁니다 |
| `lastUpdated` | — | 더 최신 값 사용 |

`compressedContexts`를 뺀 나머지 필드는 같은 키가 양쪽에 다 있으면 theirs(`%B`, 머지해 들어오는 쪽) 항목이 남습니다.

> 📝 **Note**: rebase 중에는 ours와 theirs가 뒤바뀝니다. 내 커밋을 upstream 위에 다시 얹는 동안에는 내 커밋 쪽이 theirs가 되므로, 같은 키가 겹치면 내 항목이 남습니다. `compressedContexts`는 `compressedAt`이 같을 때만 이 규칙을 탑니다.

## 권장 워크플로

1. 작업 시작 전 `git pull`로 최신 memory.json 수신
2. 작업 완료 후 `git add .gestalt/memory.json && git commit`
3. 충돌이 나면 merge driver가 자동으로 합칩니다. driver가 종료 코드 1로 끝나 `git status`에 충돌로 남았다면 양쪽 memory.json 중 깨진 JSON이나 구조가 틀린 파일이 있는지 먼저 확인하세요. 양쪽 내용은 `git show :2:.gestalt/memory.json`(ours)과 `git show :3:.gestalt/memory.json`(theirs)으로 볼 수 있습니다

## 관련 파일

- `src/memory/memory-merge.ts` — `mergeMemory()` 순수 함수와 merge driver 구현
- `src/cli/commands/memory-merge.ts` — `gestalt memory-merge` CLI 진입점
- `src/core/types.ts` — `ProjectMemory`, `ArchitectureDecision` 타입 정의
- `docs/migration-memory-v2.md` — v1 → v2 스키마 마이그레이션 가이드
