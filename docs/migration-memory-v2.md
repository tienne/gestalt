# Memory v2 Migration Guide

## 변경 내용: architectureDecisions 스키마 구조화

### v1 (이전 스키마)

`architectureDecisions` 필드는 단순 문자열 배열이었습니다.

```json
{
  "version": "1.0.0",
  "architectureDecisions": [
    "PassthroughMode: Execute engine은 항상 Passthrough 전용",
    "[Review] code-review summary here"
  ]
}
```

### v2 (현재 스키마)

`architectureDecisions` 필드가 `ArchitectureDecision` 객체 배열로 변경되었습니다.

```typescript
export interface ArchitectureDecision {
  decision: string;   // 결정 내용
  rationale: string;  // 결정 이유
  outcome?: string;   // 결과 (선택)
  specId: string;     // 관련 Spec ID (없으면 '')
  timestamp: string;  // ISO 8601 형식
}
```

```json
{
  "version": "1.0.0",
  "architectureDecisions": [
    {
      "decision": "PassthroughMode: Execute engine은 항상 Passthrough 전용",
      "rationale": "Claude Code가 도구로 파일 수정·코드 실행을 수행하므로 LLM 주체",
      "outcome": "자체 LLM 호출 모드 제거",
      "specId": "spec-abc123",
      "timestamp": "2026-06-14T00:00:00.000Z"
    }
  ]
}
```

## 자동 마이그레이션

`project-memory-store.ts`의 `read()` 메서드가 파일을 읽을 때 자동으로 v1 → v2 변환합니다.

- `string` 타입 항목 발견 시 아래 형태로 변환됩니다:

```typescript
{
  decision: item,        // 기존 문자열 그대로
  rationale: '',         // 빈 문자열 (추후 수동 보강 권장)
  specId: '',            // 빈 문자열
  timestamp: new Date().toISOString(),
}
```

별도 마이그레이션 스크립트 없이 다음 `read()` 호출 시 자동 변환되며, 변환 결과는 다음 `write()` 시점에 파일에 반영됩니다.

## 수동 마이그레이션 스크립트 (선택)

자동 마이그레이션 후 `rationale`을 보강하고 싶다면 아래 스크립트를 사용하세요.

```typescript
// scripts/migrate-memory-v2.ts
import { readFileSync, writeFileSync } from 'node:fs';

const memoryPath = '.gestalt/memory.json';
const raw = readFileSync(memoryPath, 'utf-8');
const memory = JSON.parse(raw);

memory.architectureDecisions = memory.architectureDecisions.map(
  (item: string | object) => {
    if (typeof item === 'string') {
      return {
        decision: item,
        rationale: '',   // TODO: 내용 보강 필요
        specId: '',
        timestamp: new Date().toISOString(),
      };
    }
    return item;
  }
);

writeFileSync(memoryPath, JSON.stringify(memory, null, 2), 'utf-8');
console.log('Migration complete:', memory.architectureDecisions.length, 'entries');
```

## 변경된 필드 목록

| 위치 | 필드 | v1 타입 | v2 타입 |
|------|------|---------|---------|
| `ProjectMemory` | `architectureDecisions` | `string[]` | `ArchitectureDecision[]` |
| `MemoryContext` | `architectureDecisions` | `string[]` | `ArchitectureDecision[]` |
| `ProjectMemoryStore.addArchitectureDecision()` | 인자 | `string` | `ArchitectureDecision` |

## 관련 파일

- `src/core/types.ts` — `ArchitectureDecision` 인터페이스 정의
- `src/memory/project-memory-store.ts` — 자동 마이그레이션 로직 (`read()`)
- `src/memory/memory-context-injector.ts` — `MemoryContext` 타입 및 포맷 업데이트
- `src/mcp/tools/review-passthrough.ts` — `addArchitectureDecision()` 호출부 업데이트
