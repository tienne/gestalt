---
name: gestalt-release
description: "Gestalt @tienne/gestalt 패키지를 npm에 배포한다. '릴리즈', 'npm 배포', 'version bump', '버전 올려줘', 'publish', '배포해줘' 요청 시 반드시 이 스킬을 사용할 것. 테스트 통과 및 빌드 성공을 보장한 뒤 배포한다."
---

# Gestalt Release — npm 배포 파이프라인

`@tienne/gestalt` 패키지를 npm에 안전하게 배포하는 파이프라인.

## 배포 전 체크리스트

다음 순서대로 확인한다. 하나라도 실패하면 즉시 중단:

1. uncommitted changes 없음 → `git status` 확인
2. `pnpm test` — 모든 테스트 통과
3. `pnpm run lint` — TypeScript 에러 없음

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
git status          # uncommitted 없음 확인
pnpm test           # 전체 테스트
pnpm run lint       # 타입 체크
```

### 2. 버전 업데이트
```bash
npm version patch   # 또는 minor
```
`postversion` hook이 자동으로 `pnpm run version:sync`를 실행하여 `src/core/version.ts`를 업데이트한다.

### 3. 빌드
```bash
pnpm build
```
`postbuild` hook이 자동으로 `agents/`, `role-agents/`, `review-agents/`, `skills/`, `schemas/`를 `dist/`에 복사한다.

### 4. 배포 확인 (사용자에게 반드시 확인)
배포 전 다음 내용을 사용자에게 확인받는다:
- 배포할 버전: vX.Y.Z
- 주요 변경 내용: [요약]
- 배포 대상: npm public registry (@tienne/gestalt)

### 5. npm 배포
```bash
npm publish --access public
```

## 에러 처리

| 에러 | 대응 |
|------|------|
| uncommitted changes 있음 | 커밋 후 재시도 또는 사용자에게 처리 요청 |
| `pnpm test` 실패 | 실패 내용 보고, 배포 중단 |
| `pnpm run lint` 에러 | 타입 에러 목록 보고, 배포 중단 |
| `pnpm build` 실패 | 빌드 에러 보고, 배포 중단 |
| `npm publish` 실패 | npm 로그인 상태 확인 요청 (`npm whoami`) |
