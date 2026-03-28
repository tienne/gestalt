# 3단계: Execute — Spec을 실행 가능한 태스크로

> Spec이 완성됐다고 바로 실행할 수 있는 건 아니에요. Execute 단계에서 하나의 목표를 게슈탈트 4원리로 분해하고, DAG로 실행 순서를 정한 뒤, 태스크마다 드리프트를 감지해요.

---

## Execute가 하는 일

Spec을 입력으로 받아 **ExecutionPlan**을 수립하고, 태스크를 위상 정렬 순서로 실행해요. 실행 중에는 Drift Detection이 Spec과의 이탈을 실시간으로 측정해요.

---

## 게슈탈트 원리 적용

Planning Phase는 4개 원리를 순서대로 적용해요.

```
PLANNING_PRINCIPLE_SEQUENCE = [
  'figure_ground',  // 1단계: MVP vs 부가기능 분리
  'closure',        // 2단계: 불완전한 요구사항 채우기
  'proximity',      // 3단계: 관련 태스크 그룹핑
  'continuity',     // 4단계: 모순 제거 + 의존성 정리
]
```

소스: `src/core/constants.ts`

### 원리별 역할

| 단계 | 원리 | 역할 |
|:---:|:---:|:---|
| 1 | **전경과 배경** | AC를 core(MVP)와 enhancement로 분류해요. 무엇을 먼저 할지 결정해요. |
| 2 | **폐쇄성** | 각 AC에서 암묵적 요구사항을 발굴해 원자 태스크로 변환해요. |
| 3 | **근접성** | 연관 태스크를 그룹(병렬 실행 단위)으로 묶어 TaskGroup을 생성해요. |
| 4 | **연속성** | 의존성 순환 여부를 검증하고 임계 경로(critical path)를 확정해요. |

---

## DAG 검증

태스크 간 의존성은 DAG(Directed Acyclic Graph)로 표현하고, Kahn's Algorithm으로 검증해요.

```
1. in-degree 계산 (각 노드로 들어오는 간선 수)
2. in-degree === 0인 노드를 큐에 삽입
3. 큐에서 꺼내 topological order에 추가 → 인접 노드 in-degree 감소
4. 반복 → 처리된 노드 수 < 전체 노드 수 → 순환 감지
```

Critical Path는 위상 정렬 순서대로 `longest-path` DP로 계산해요.

소스: `src/execute/dag-validator.ts`

### DAG 검증 결과

```typescript
interface DAGValidation {
  isValid: boolean;
  hasCycles: boolean;
  hasConflicts: boolean;
  topologicalOrder: string[];
  criticalPath: string[];
  cycleDetails: string[];
  conflictDetails: string[];
}
```

---

## 처리 흐름 (Passthrough Mode)

### Planning Phase (4-Call)

```
// Call 1: 세션 시작
ges_execute({ action: "start", spec: { ...specObject } })
→ executeContext 반환 (systemPrompt, planningPrompt, currentPrinciple: "figure_ground")

// Call 2~4: 각 원리 단계 결과 제출
ges_execute({
  action: "plan_step",
  sessionId: "<id>",
  stepResult: {
    principle: "figure_ground",
    classifiedACs: [{ acIndex: 0, classification: "core" }, ...]
  }
})
→ 다음 executeContext 반환. isLastStep === true까지 반복.

// Call 5: 실행 계획 조립
ges_execute({ action: "plan_complete", sessionId: "<id>" })
→ ExecutionPlan 반환
  - planSummary: { totalTasks, groupCount, criticalPathLength, parallelGroupCount }
  - nextStep: 실행 시작 안내 메시지
```

### Execution Phase

```
// 실행 시작
ges_execute({ action: "execute_start", sessionId: "<id>", cwd: "/path/to/project" })
→ 첫 번째 태스크 컨텍스트 반환
  cwd를 전달하면 .claude/rules/gestalt-active.md와 .gestalt/active-session.json을 자동 생성해요.

// 태스크 결과 제출
ges_execute({
  action: "execute_task",
  sessionId: "<id>",
  taskResult: {
    taskId: "task-001",
    status: "completed",
    output: "...",
    artifacts: ["src/auth.ts"]
  }
})
→ 다음 태스크 컨텍스트 + driftScore 반환
  완료된 태스크가 5개를 초과하면 compressionAvailable: true 포함.
```

---

## Active Session Rule File

`execute_start`에 `cwd`를 전달하면 두 파일을 자동으로 생성하고 관리해요.

| 파일 | 위치 | 내용 |
|:---|:---|:---|
| `.claude/rules/gestalt-active.md` | `{cwd}/.claude/rules/` | goal / constraints / 현재 태스크 |
| `.gestalt/active-session.json` | `{cwd}/.gestalt/` | sessionId + specId |

`.claude/rules/` 디렉토리의 파일은 Claude Code 세션 시작 시 자동으로 로드돼요. 새 세션을 열어도 현재 실행 중인 Spec의 목표와 제약조건이 컨텍스트에 주입돼요.

### 라이프사이클

| 액션 | 동작 |
|:---|:---|
| `execute_start` | 두 파일 생성 |
| `execute_task` | `gestalt-active.md`의 currentTask 업데이트 |
| `evolve_patch` | `gestalt-active.md`의 Spec 정보 업데이트 |
| 세션 종료 (`completed` / `terminated` / `human_escalation`) | 두 파일 삭제 |

소스: `src/execute/rule-writer.ts`

---

## Drift Detection

태스크 결과가 제출될 때마다 Spec과의 이탈 정도를 자동으로 측정해요.

### 측정 방식

Jaccard 유사도 기반 3차원 드리프트로 계산해요.

```
driftScore = Goal × 0.5 + Constraint × 0.3 + Ontology × 0.2

Goal:       1 - Jaccard(task.keywords, spec.goal.keywords)
Constraint: violated_constraints / total_constraints
Ontology:   1 - Jaccard(task.entities, spec.ontologySchema.entities)
```

소스: `src/execute/drift-detector.ts`, `src/core/constants.ts`

### 임계값 초과 시

`driftScore > driftThreshold(기본 0.3)`이면 `retrospectiveContext`를 반환해요. Caller는 이를 보고 태스크를 수정하거나, 이후 Evolve 단계에서 Spec을 패치할 수 있어요.

---

## Role Agent 매칭

태스크 실행 전 관련 Role Agent를 자동으로 매칭해서 다중 관점 합의를 수행할 수 있어요.

### 흐름 (4-Call)

```
// Role Match — Call 1: 매칭 컨텍스트 요청
ges_execute({ action: "role_match", sessionId: "<id>" })
→ matchContext 반환 (후보 에이전트 목록 + 태스크 컨텍스트)

// Role Match — Call 2: 매칭 결과 제출
ges_execute({
  action: "role_match",
  sessionId: "<id>",
  matchResult: [
    { agentName: "frontend-developer", domain: ["ui", "react"], relevanceScore: 0.9, reasoning: "..." },
    { agentName: "architect", domain: ["design", "api"], relevanceScore: 0.7, reasoning: "..." }
  ]
})
→ perspectivePrompts 반환

// Role Consensus — Call 3: 각 에이전트 관점 제출
ges_execute({
  action: "role_consensus",
  sessionId: "<id>",
  perspectives: [
    { agentName: "frontend-developer", perspective: "...", confidence: 0.85 }
  ]
})
→ synthesisContext 반환

// Role Consensus — Call 4: 합성 합의 제출
ges_execute({
  action: "role_consensus",
  sessionId: "<id>",
  consensus: { consensus: "...", conflictResolutions: [...], perspectives: [...] }
})
→ roleGuidance 반환 → execute_task 시 참조
```

### 내장 Role Agent (8개)

`role-agents/` 디렉토리에 있어요. 사용자 `agents/`의 `role: true` 에이전트와 병합해서 로드하고, 이름이 같으면 커스텀 에이전트가 우선해요.

| 에이전트 | 도메인 |
|:---|:---|
| `architect` | 시스템 설계, API |
| `backend-developer` | 서버, DB |
| `frontend-developer` | UI, React |
| `designer` | UX, 접근성 |
| `devops-engineer` | CI/CD, 인프라 |
| `product-planner` | 요구사항, 비즈니스 |
| `qa-engineer` | 테스트, 품질 |
| `researcher` | 기술 조사 |

---

## 설계 결정

### 왜 Planning을 4단계 순서로 고정했나요?

각 원리가 다음 단계의 입력을 만들어요. 전경과 배경(무엇)이 없으면 폐쇄성(어떻게)이 방향을 잃어요. 근접성(어디서 같이)이 없으면 연속성(어떤 순서로)이 기준점이 없어요. 병렬 처리보다 순차 의존이 더 정확한 계획을 만들어요.

### 왜 Drift Detection을 태스크 제출 시마다 하나요?

태스크 완료 후 drift를 발견하면 이미 다음 태스크에 오염이 전파됐을 수 있어요. 실시간으로 측정해서 이탈을 조기에 포착하고, Evolve 단계에서 패치 범위를 최소화해요.

### 왜 Jaccard 유사도를 쓰나요?

키워드 집합 간 겹침 비율은 LLM 임베딩 없이도 계산할 수 있어요. 동일 Spec에서 반복 측정할 때 일관성도 보장돼요. 임베딩 기반 의미 유사도는 같은 문장도 호출마다 미세하게 달라질 수 있어요.

---

## MCP 액션 요약

| 액션 | 설명 |
|:---|:---|
| `start` | Spec 제출 → Planning 세션 시작 |
| `plan_step` | 각 원리 단계 결과 제출 |
| `plan_complete` | 실행 계획 조립 → ExecutionPlan 반환 |
| `execute_start` | 실행 Phase 시작 → 첫 태스크 컨텍스트. `cwd` 전달 시 `.claude/rules/gestalt-active.md` 자동 생성 |
| `execute_task` | 태스크 결과 제출 → driftScore + 다음 태스크. 완료 5개 초과 시 `compressionAvailable: true` |
| `role_match` | Role Agent 매칭 (2-Call) |
| `role_consensus` | 다중 관점 합의 (2-Call) |
| `status` | 세션 상태 조회 |

---

## 소스 코드 참조

| 파일 | 역할 |
|:---|:---|
| `src/execute/passthrough-engine.ts` | Passthrough 모드 Execute 핸들러 |
| `src/execute/dag-validator.ts` | Kahn's algorithm DAG 검증 |
| `src/execute/drift-detector.ts` | Jaccard 기반 드리프트 측정 |
| `src/execute/session-manager.ts` | ExecuteSession 상태 관리 |
| `src/agent/role-agent-registry.ts` | RoleAgentRegistry |
| `src/agent/role-match-engine.ts` | 에이전트 매칭 컨텍스트 생성 |
| `src/agent/role-consensus-engine.ts` | 다중 관점 합성 |
| `src/core/constants.ts` | PLANNING_PRINCIPLE_SEQUENCE, DRIFT_WEIGHTS |
| `src/execute/rule-writer.ts` | `gestalt-active.md` 및 `active-session.json` 라이프사이클 관리 |
| `src/mcp/tools/execute-passthrough.ts` | MCP 핸들러 |
