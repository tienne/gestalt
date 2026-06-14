# Memory 팀 공유 가이드

Gestalt의 `memory.json`은 프로젝트별 누적 컨텍스트(Spec 히스토리, 실행 기록, 아키텍처 결정)를 저장합니다.
팀이 이 파일을 공유하면 모든 구성원이 동일한 프로젝트 컨텍스트를 기반으로 작업할 수 있습니다.

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

두 명이 동시에 memory.json을 수정하면 git 머지 충돌이 발생할 수 있습니다.
이 경우 아래 두 가지 방법 중 하나를 사용하세요.

---

## .gitattributes union 머지 드라이버 설정

`.gitattributes`에 `union` 머지 드라이버를 설정하면 git이 자동으로 줄 단위 병합을 시도합니다.
JSON처럼 구조화된 파일에서는 완벽하지 않지만, 단순 추가 작업에는 효과적입니다.

```
# .gitattributes
.gestalt/memory.json merge=union
```

> **주의**: `union` 드라이버는 동일 키를 수정했을 때 양쪽 내용이 모두 남아 JSON이 깨질 수 있습니다.
> 이 경우 아래 `mergeMemory()` 함수를 사용한 수동 머지를 권장합니다.

---

## mergeMemory() 함수 사용법

`ProjectMemoryStore.mergeMemory(local, remote)`는 두 `ProjectMemory` 인스턴스를 안전하게 머지합니다.

### 머지 전략

| 필드 | 기준 키 | 전략 |
|------|--------|------|
| `specHistory` | `specId` | remote 기준, local에만 있는 항목 추가 |
| `executionHistory` | `executeSessionId` | remote 기준, local에만 있는 항목 추가 |
| `architectureDecisions` | `timestamp + decision` | remote 기준, local에만 있는 항목 추가 |
| `compressedContexts` | `sessionId` | remote 기준, local에만 있는 항목 추가 |
| `lastUpdated` | — | 더 최신 값 사용 |

### 코드 예시

```typescript
import { ProjectMemoryStore } from './src/memory/project-memory-store.js';
import { readFileSync } from 'node:fs';

const store = new ProjectMemoryStore();

// 현재 로컬 memory 읽기
const localMemory = store.read();

// remote (예: git pull 이전 버전) memory 읽기
const remoteRaw = readFileSync('.gestalt/memory.remote.json', 'utf-8');
const remoteMemory = JSON.parse(remoteRaw);

// 머지 실행
const merged = store.mergeMemory(localMemory, remoteMemory);

// 결과 저장 (store.write는 private이므로 addSpec 등 공개 메서드를 활용하거나
// 직접 writeFileSync로 저장)
import { writeFileSync } from 'node:fs';
writeFileSync('.gestalt/memory.json', JSON.stringify(merged, null, 2), 'utf-8');

console.log('Merged:', {
  specs: merged.specHistory.length,
  executions: merged.executionHistory.length,
  decisions: merged.architectureDecisions.length,
});
```

### git 충돌 해결 스크립트 예시

```bash
#!/bin/bash
# scripts/merge-memory.sh
# 사용법: git mergetool 또는 수동으로 실행

LOCAL=$1    # 로컬 버전 파일 경로
REMOTE=$2   # 리모트 버전 파일 경로
OUTPUT=$3   # 출력 파일 경로

pnpm tsx -e "
  import { readFileSync, writeFileSync } from 'node:fs';
  import { ProjectMemoryStore } from './src/memory/project-memory-store.js';

  const store = new ProjectMemoryStore();
  const local = JSON.parse(readFileSync('$LOCAL', 'utf-8'));
  const remote = JSON.parse(readFileSync('$REMOTE', 'utf-8'));
  const merged = store.mergeMemory(local, remote);
  writeFileSync('$OUTPUT', JSON.stringify(merged, null, 2), 'utf-8');
  console.log('Memory merged successfully');
"
```

## 권장 워크플로

1. 작업 시작 전 `git pull`로 최신 memory.json 수신
2. 작업 완료 후 `git add .gestalt/memory.json && git commit`
3. 충돌 발생 시 `mergeMemory()`로 수동 머지 후 커밋

## 관련 파일

- `src/memory/project-memory-store.ts` — `mergeMemory()` 구현
- `src/core/types.ts` — `ProjectMemory`, `ArchitectureDecision` 타입 정의
- `docs/migration-memory-v2.md` — v1 → v2 스키마 마이그레이션 가이드
