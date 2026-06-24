---
name: pr
version: "1.0.0"
description: "PR 작성 전용 스킬. 레포 규칙을 먼저 탐색하고, 미니 인터뷰로 컨텍스트를 수집한 뒤 diff 기반 PR description을 생성하고 gh pr create로 제출한다."
triggers:
  - "PR 작성"
  - "PR 만들어"
  - "PR 써줘"
  - "PR 올려"
  - "풀리퀘"
  - "풀 리퀘스트"
  - "pull request"
  - "create PR"
inputs:
  target:
    type: string
    required: false
    description: "비교 기준 브랜치 (생략 시 현재 브랜치 vs main)"
  repoRoot:
    type: string
    required: false
    description: "Repository root (기본값: 현재 디렉토리)"
outputs:
  - prIntent
  - changeContext
  - prDescription
  - prUrl
---

# PR Skill

레포의 PR 규칙을 먼저 탐색하고, 미니 인터뷰로 컨텍스트를 수집한 뒤, diff를 분석해 레포 규칙에 맞는 PR description을 생성하고 `gh pr create`로 제출합니다.

## 사용 방법

```
/pr                    # 현재 브랜치 vs main
/pr feature/auth       # 특정 브랜치
```

## 전제 조건

`repoRoot`가 주어지지 않으면 현재 작업 디렉토리를 절대 경로로 사용합니다.
`target`이 주어지지 않으면 현재 브랜치 vs `main`을 기준으로 삼습니다.

## Skill Instructions

### 0단계: 레포 규칙 탐색 (필수 — 스킵 불가)

PR을 작성하기 전에 레포의 PR 규칙을 반드시 먼저 탐색합니다. 아래 경로를 순서대로 확인하고, 발견한 규칙은 PR 작성에 반드시 적용합니다:

1. `.github/pull_request_template.md` / `.github/PULL_REQUEST_TEMPLATE.md`
2. `.github/PULL_REQUEST_TEMPLATE/*.md` (복수 템플릿이면 변경 유형에 맞는 것 선택)
3. `CONTRIBUTING.md` / `docs/contributing.md`
4. `CLAUDE.md` / `.claude/CLAUDE.md`
5. `.claude/rules/*.md`
6. `.github/CODEOWNERS`

**적용 우선순위**:

- **PR 템플릿 발견** → 해당 구조를 그대로 채웁니다. 임의 섹션 추가 금지. 다른 섹션 재구성 금지.
- **템플릿 없음 + CONTRIBUTING 있음** → CONTRIBUTING의 PR 규칙을 적용한 구조를 생성합니다.
- **둘 다 없음** → 표준 PR 포맷을 사용합니다:
  ```
  ## Summary
  ## Changes
  ## Test plan
  ## Related issues
  ```

탐색 결과는 `repoRules = { templatePath, templateContent, contributingRules, claudeRules }` 형태로 보관합니다.

### 1단계: 미니 인터뷰 (prIntent 수집)

본격 작성에 앞서 PR의 의도·특이사항·이슈 번호를 한 번에 가볍게 확인합니다. **세 질문을 단일 묶음으로 한 번에 제시**하고, 사용자의 한 번의 응답으로 처리합니다 (1턴 경량 인터뷰):

```
PR을 작성하기 전에 세 가지를 확인합니다. 없으면 Enter / "없음"으로 건너뛰어도 됩니다.

1. 이 PR의 주요 목적/의도는? (한 줄)
2. 리뷰어가 미리 알면 좋을 특이사항이 있나요?
3. 관련 이슈/티켓 번호가 있나요?
```

사용자 응답을 `prIntent = { purpose, notes, issueRef }` 형태로 보관합니다.

- 각 항목별로 빈 응답·`"없음"`은 해당 항목을 비워 둡니다.
- **전체 건너뛰기**: 사용자가 `"없음"` / `"스킵"` / `"바로 PR"` 등으로 (개별 질문이 아닌) 1단계 자체를 건너뛰겠다는 의사를 보이면, 1단계 전체를 건너뛰고 `prIntent`의 모든 항목을 비워 둔 채 2단계로 바로 진행합니다.

`prIntent`는 이후 단계에서 **Claude의 추론 컨텍스트로만** 활용합니다.

### 2단계: diff 수집

비교 기준(`target`) 대비 변경 내용을 수집합니다:

```bash
git log --oneline {target}..HEAD     # 커밋 목록
git diff {target}...HEAD --stat      # 변경 파일 통계
git diff {target}...HEAD             # 실제 diff (핵심 변경만)
```

`changedFiles`와 커밋 목록을 수집합니다.

### 3단계: change-context-writer로 변경 분석

`ges_agent { action: "get", name: "change-context-writer" }`로 에이전트 시스템 프롬프트를 가져온 뒤, 해당 관점에서 diff를 분석해 변경 컨텍스트를 작성합니다.

1단계에서 수집한 `prIntent.purpose`·`prIntent.notes`가 비어 있지 않다면, diff 분석 입력에 함께 전달해 더 정확한 분석을 생성하도록 합니다.

분석 결과를 `changeContext`로 보관합니다.

### 4단계: PR description 생성

0단계의 `repoRules` 구조 + 3단계의 `changeContext` + 1단계의 `prIntent`를 합성해 PR description을 작성합니다.

- **PR 제목**: `CLAUDE.md`가 있으면 그 커밋 컨벤션을 따릅니다 (예: `type(scope): subject`).
- 생성된 description을 **사용자에게 미리보기로 먼저 표시**합니다.

### 5단계: gh pr create 확인 및 실행

사용자에게 확인합니다:

```
이 내용으로 PR을 생성할까요?
- 생성: 바로 생성
- 수정: 어떤 부분을 수정할지 알려주세요
- 취소: description 텍스트만 출력하고 종료
```

생성 시 heredoc 패턴으로 실행합니다. **PR 작성자 자신을 어사인**하기 위해 `--assignee @me`를 항상 포함합니다. 명령 앞에 `GESTALT_PR=1` 표식을 붙입니다 (raw `gh pr create`를 가로채는 PreToolUse 훅이 이 스킬의 호출은 통과시키도록 하는 우회 표식):

```bash
GESTALT_PR=1 gh pr create --assignee @me --title "..." --body "$(cat <<'EOF'
{description 내용}
EOF
)"
```

- `GESTALT_PR=1`은 환경변수 형태의 표식일 뿐 동작에 영향을 주지 않습니다. 이미 gestalt:pr 플로우 안이므로 PR 생성 확인 프롬프트가 중복되지 않게 해줍니다.
- `@me`는 `gh`에 인증된 현재 사용자를 가리키므로, PR이 생성되면 작성자 본인이 자동으로 assignee로 지정됩니다.
- 어사인이 실패해도(권한·레포 설정 등) PR 생성 자체는 막지 않습니다. 실패 시 PR 생성 후 `gh pr edit {prUrl} --add-assignee @me`로 재시도합니다.

반환된 PR URL을 사용자에게 표시합니다 (`prUrl`).
