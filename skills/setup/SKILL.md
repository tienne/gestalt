---
name: setup
version: "1.0.0"
description: "Gestalt 프로젝트 초기 설정 — gestalt.json 생성, 코드 그래프 빌드, post-commit 훅 설치"
triggers:
  - "gestalt 초기화"
  - "gestalt init"
  - "gestalt setup"
  - "setup gestalt"
  - "프로젝트 설정"
inputs:
  cwd:
    type: string
    required: false
    description: "초기화할 프로젝트 디렉토리 (기본값: 현재 디렉토리)"
outputs:
  - gestalt.json
  - code-graph.db
  - post-commit hook
---

# Setup Skill

`gestalt init` 명령어와 동일한 초기화 작업을 Claude Code 스킬로 실행한다.

## 실행 단계

1. **선택 화면**: `AskUserQuestion`으로 실행할 단계를 다중 선택
2. **gestalt.json 생성**: 프로젝트 루트에 기본 설정 파일 생성
3. **코드 그래프 빌드**: `ges_code_graph { action: "build" }`로 의존성 그래프 구축
4. **post-commit 훅 설치**: `gestalt init --skip-graph --skip-hook`을 활용해 훅만 설치

---

## 실행 방법

### Step 1 — 실행할 단계 선택

`AskUserQuestion`으로 다음 질문을 표시한다. **3개 모두 기본 선택**으로 제시한다.

```
질문: "실행할 초기화 단계를 선택하세요 (기본: 전체)"
multiSelect: true
옵션:
  - label: "gestalt.json 생성 (Recommended)"
    description: "프로젝트 루트에 gestalt.json 설정 파일을 생성합니다"
  - label: "코드 그래프 빌드 (Recommended)"
    description: "코드베이스를 분석해 의존성 그래프를 구축합니다 (시간이 걸릴 수 있음)"
  - label: "post-commit 훅 설치 (Recommended)"
    description: "커밋 시 코드 그래프를 자동으로 갱신하는 git 훅을 설치합니다"
```

선택된 항목에 따라 아래 단계를 순서대로 실행한다. 아무것도 선택하지 않으면 중단한다.

---

### Step 2 — gestalt.json 생성 (선택된 경우)

프로젝트 루트에 `gestalt.json`이 이미 존재하는지 확인한다.

**파일이 없으면**: Bash로 생성한다.

```bash
! pnpm tsx bin/gestalt.ts setup
```

또는 npx로 설치된 환경이면:

```bash
! npx @tienne/gestalt setup
```

**파일이 이미 존재하면**: 사용자에게 덮어쓸지 확인 후 진행한다.

성공 시 출력:
```
✓ gestalt.json 생성 완료
```

---

### Step 3 — 코드 그래프 빌드 (선택된 경우)

`ges_code_graph` MCP 툴을 사용한다.

```
ges_code_graph({ action: "build", repoRoot: "<현재 디렉토리 절대경로>" })
```

응답 예시:
```json
{ "nodesBuilt": 1192, "edgesBuilt": 1321, "timeTakenMs": 4200 }
```

성공 시 출력:
```
✓ 코드 그래프 빌드 완료: 노드 {nodesBuilt}개, 엣지 {edgesBuilt}개 ({timeTakenMs}ms)
```

실패해도 다음 단계를 계속 진행한다 (non-fatal).

---

### Step 4 — post-commit 훅 설치 (선택된 경우)

```bash
! pnpm tsx bin/gestalt.ts init --skip-graph
```

또는:

```bash
! npx @tienne/gestalt init --skip-graph
```

성공 시 출력:
```
✓ post-commit 훅 설치 완료
```

---

### Step 5 — 완료 메시지

선택된 모든 단계 완료 후:

```
Gestalt 초기화 완료!

완료된 단계:
  ✓ gestalt.json 생성
  ✓ 코드 그래프 빌드 (노드 1192개, 엣지 1321개)
  ✓ post-commit 훅 설치

이제 다음 스킬을 바로 사용할 수 있습니다:
  /gestalt:interview  — 요구사항 인터뷰
  /build-graph        — 코드 그래프 갱신
  /blast-radius       — 영향 범위 분석
```

---

## 에러 처리

| 상황 | 대응 |
|------|------|
| `gestalt.json` 이미 존재 | 덮어쓸지 확인 후 진행 |
| 코드 그래프 빌드 실패 | 경고 출력 후 다음 단계 계속 |
| git 저장소 아님 | post-commit 훅 설치 건너뜀 + 안내 |
| CLI 명령어 없음 | `pnpm add @tienne/gestalt` 안내 |
