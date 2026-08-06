---
name: gestalt-release
description: "Gestalt @tienne/gestalt 패키지를 npm에 배포한다. '릴리즈', 'npm 배포', 'version bump', '버전 올려줘', 'publish', '배포해줘' 요청 시 반드시 이 스킬을 사용할 것. 테스트 통과 및 빌드 성공을 보장한 뒤 배포한다."
---

# Gestalt Release — npm 배포 파이프라인

`@tienne/gestalt` 패키지를 npm에 안전하게 배포하는 파이프라인.

> **자동화 방식**: `git push --tags` 시 GitHub Actions가 빌드 → npm publish → GitHub Release 생성을 자동 처리한다. 로컬에서 `npm publish`를 직접 실행하지 않는다.

## 배포 전 체크리스트

다음 순서대로 확인한다. 하나라도 실패하면 즉시 중단:

1. uncommitted changes 없음 → `git status` 확인
2. `pnpm test` — 모든 테스트 통과
3. `pnpm run lint` — TypeScript 에러 없음
4. `pnpm run format:check` — Prettier 포맷 통과 (CI 3-gate와 동일)

## 버전 범프 기준

사용자가 명시하지 않으면 변경 내용을 기반으로 판단:

| 변경 내용 | 버전 타입 |
|---------|---------|
| 버그 수정만 | `patch` |
| 새 기능 (하위 호환) | `minor` |
| Breaking change | `minor` (v1.0 이전 정책) |

## 릴리즈 단계

### 1. 사전 검증
```bash
git status              # uncommitted 없음 확인
pnpm test               # 전체 테스트
pnpm run lint           # 타입 체크
pnpm run format:check   # Prettier 포맷 (실패 시: pnpm format → 커밋 후 재시도)
```

### 2. 배포 확인 (사용자에게 반드시 확인)
배포 전 다음 내용을 사용자에게 확인받는다:
- 배포할 버전: vX.Y.Z
- 주요 변경 내용: [요약]
- 배포 대상: npm public registry (@tienne/gestalt)
- 플러그인 스킬 변경 여부: skills/ 디렉토리 변경 시 명시

### 3. 버전 업데이트
```bash
npm version patch   # 또는 minor
```
`postversion` hook이 자동으로 `pnpm run version:sync`를 실행하여 `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `plugin/.codex-plugin/plugin.json` 세 매니페스트를 업데이트한다. `src/core/version.ts`는 런타임에 `package.json`을 읽으므로 동기화 대상이 아니다.

### 4. 빌드
```bash
pnpm build
```
`postbuild` hook이 `dist/plugin`을 비우고 `agents/`, `role-agents/`, `review-agents/`, `personas/`, `skills/`와 `schemas/`를 `dist/`에 다시 복사한 뒤, `verify-plugin-assets.ts`로 원본과 바이트 단위로 일치하는지 확인한다. 어긋나면 빌드가 여기서 끊긴다 — 복사 누락, 원본에서 삭제된 유령 자산, 내용 불일치를 각각 보고한다.

### 5. 플러그인 매니페스트 커밋
`postversion` 훅이 매니페스트를 업데이트하지만 버전 커밋 이후에 실행되므로 별도로 커밋해야 한다.

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json plugin/.codex-plugin/plugin.json
git commit -m "chore(plugin): bump plugin manifest to vX.Y.Z"
```

### 5.5. 태그를 매니페스트 커밋으로 옮긴다 (빠뜨리면 안 됨)
`npm version`이 찍은 태그는 5단계 커밋보다 **앞**을 가리킨다. GitHub Actions는 태그를 체크아웃해 빌드하므로, 그대로 두면 배포되는 패키지에 **한 버전 뒤처진 매니페스트**가 실린다. `plugin/`이 npm `files`에 포함되어 있어 Codex 사용자에게 그 값이 그대로 보인다 (v0.47.1 태그에 0.47.0 매니페스트가 실려 나간 실제 사례가 있다).

```bash
git tag -f vX.Y.Z            # 매니페스트 커밋(HEAD)으로 이동
git show vX.Y.Z:plugin/.codex-plugin/plugin.json | grep version   # 확인
```

푸시 전이라면 태그 이동은 안전하다. 이미 푸시했다면 옮기지 말고 다음 패치 버전으로 넘긴다.

### 6. git push — 이 순간 npm 자동 배포 시작
```bash
git push && git push --tags
```
태그 push 즉시 GitHub Actions(`.github/workflows/release.yml`)가 트리거되어:
1. pnpm install → pnpm build
2. npm publish --access public (NPM_TOKEN 시크릿 사용)
3. GitHub Release 자동 생성

### 7. 배포 확인
```bash
npm view @tienne/gestalt version   # npm 반영 확인 (보통 1~2분 소요)
```

### 8. 플러그인 업데이트 안내

`skills/` 디렉토리는 npm 패키지에 포함되어 자동 배포된다. 기존 플러그인 사용자가 새 버전을 받으려면:

```
/plugin install gestalt@gestalt
```

변경된 스킬이 있으면 배포 확인 메시지에 **플러그인 스킬 변경 내용**도 함께 안내한다.

## 에러 처리

| 에러 | 대응 |
|------|------|
| uncommitted changes 있음 | 커밋 후 재시도 또는 사용자에게 처리 요청 |
| `pnpm test` 실패 | 실패 내용 보고, 배포 중단 |
| `pnpm run lint` 에러 | 타입 에러 목록 보고, 배포 중단 |
| `pnpm run format:check` 실패 | `pnpm format` 실행 후 변경 파일 커밋, 재검증 |
| `pnpm build` 실패 | 빌드 에러 보고, 배포 중단 |
| GitHub Actions 실패 | Actions 탭에서 로그 확인 요청. NPM_TOKEN 시크릿 미설정 여부 점검 |
