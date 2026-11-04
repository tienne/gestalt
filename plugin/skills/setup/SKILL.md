---
name: setup
version: "1.0.0"
description: "Gestalt 프로젝트 초기 설정 — gestalt.json 생성, 코드 그래프 빌드, post-commit 훅 설치. 레포당 최초 1회용이다. 이미 설정된 레포에서 코드 그래프만 다시 빌드하려면 build-graph를 쓴다."
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

> **호스트별 도구와 모델 호출** → [`../_shared/host-runtime.md`](../_shared/host-runtime.md). 실행 전에 읽고 현재 호스트에 맞게 적용한다.

`gestalt init` 명령어와 동일한 초기화 작업을 현재 호스트에서 실행한다.
Codex에서는 설정 생성 명령에 `--client codex`를 붙인다. 기존 설정은 사용자 동의 없이 덮어쓰지 않는다.

> **도구가 없을 때** → [`../_shared/tool-availability.md`](../_shared/tool-availability.md)
> `ges_*` 도구가 없거나 호출이 실패하면 직접 흉내내 진행하지 않고 무엇이 왜 안 되는지 말하고 멈춥니다.

## 실행 단계

1. **선택 화면**: [질문 capability와 폴백](../_shared/question-capabilities.md)에 따라 실행할 단계를 선택받는다
2. **gestalt.json 생성**: 프로젝트 루트에 기본 설정 파일 생성
3. **코드 그래프 빌드**: `ges_code_graph { action: "build" }`로 의존성 그래프 구축
4. **post-commit 훅 설치**: `gestalt init --skip-graph`로 기존 설정을 보존하며 훅 설치

---

## 실행 방법

### Step 1 — 실행할 단계 선택

[질문 capability와 폴백](../_shared/question-capabilities.md)을 먼저 적용한다. 아래는 질문의 의미를 나타낸 예시이며 호출 인자는 실제 도구 스키마에 맞춘다. 다중 선택과 기본 선택을 지원할 때만 **3개 모두 기본 선택**으로 제시한다. 기본 선택은 사용자가 제출한 답이나 실행 승인이 아니다.

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

다중 선택을 지원하지 않으면 세 단계 각각을 예/아니오 단일 선택으로 묻는다. 질문 개수 제한에 맞춰 나누고 선택지 최소 개수나 자유 입력 제한 때문에 이를 표현할 수 없으면 일반 대화로 `1. 설정 생성, 2. 그래프 빌드, 3. 훅 설치 — 실행할 번호를 조합해 답해주세요(예: 1,3 / 전체 / 없음)`이라고 묻는다. `multiSelect` 같은 미지원 필드는 보내지 않는다.

이 선택은 필수 답변이다. 사용자가 실제로 제출한 선택에 따라 아래 단계를 순서대로 실행한다. 명시적으로 아무것도 선택하지 않거나 `없음`이라고 답하면 중단한다. 무응답, 도구의 빈 응답, 취소는 빈 선택 확정이나 전체 실행 동의로 해석하지 않고 종속 실행을 멈춘다. 비동기 질문을 썼어도 답을 받기 전에는 선택된 단계가 있다고 가정하지 않는다.

---

### Step 2 — gestalt.json 생성 (선택된 경우)

프로젝트 루트에 `gestalt.json`이 이미 존재하는지 확인한다.

**파일이 없으면**: Bash로 생성한다.

```bash
gestalt setup
```

실제 명령은 [`../_shared/cli-launcher.md`](../_shared/cli-launcher.md)의 런처로 실행한다. 설치된 플러그인에서도 버전 고정 런처를 사용한다. Codex에서는 먼저 `gestalt setup --help`에 `--client`가 있는지 확인한다. 지원하면 `gestalt setup --client codex`를 실행한다. 이전 서버와 함께 설치된 버전이라 옵션이 없으면 `gestalt setup`을 실행한 뒤 새 설정의 `client`만 `codex`로 바꾼다. 기존 설정의 다른 값은 유지한다.

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
printf 'n\n' | gestalt init --skip-graph
```

부르는 형태는 위 Step 2와 같다. Step 2에서 다룬 설정을 다시 덮어쓰지 않도록 기존 파일 질문에는 `n`을 보낸다. `--client`를 지원하는 버전의 Codex 호출에는 `--client codex`를 더한다. 성공 여부는 종료 코드만 보지 않고 `✓ post-commit 훅 설치` 출력도 확인한다.

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
