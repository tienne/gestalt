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
5. `CHANGELOG.md`에 이번 버전 항목이 있음 → 아래 2.5단계

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

### 2.5. CHANGELOG 작성 (버전 범프 앞에 한다)

**이 단계를 건너뛰면 릴리즈가 나간 뒤에야 빠진 걸 안다.** 0.72.2와 0.72.3이 연속으로 누락된 적이 있다. 체크리스트에 없어서 두 번 다 사람 기억에만 맡겨졌다.

버전 범프 **앞**에 쓴다. `npm version`이 찍는 태그가 CHANGELOG를 포함해야 GitHub Release 본문과 태그 내용이 어긋나지 않는다.

이전 태그부터의 커밋을 훑어 재료를 모은다.

```bash
git describe --tags --abbrev=0                 # 직전 태그
git log <직전태그>..HEAD --format="%s%n%b%n---" # 제목과 본문 전부
```

**커밋 제목만 옮겨 적지 않는다.** 본문에 측정값, 실패 사례, 판단 근거가 들어 있고 그게 CHANGELOG가 실어야 할 것이다. 커밋 제목은 무엇을 했는지만 말하고 왜 그랬는지는 본문에 있다.

형식은 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)다. 최신 버전을 파일 맨 위에 붙인다.

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
### Changed
### Fixed
```

기존 항목들의 어투를 따른다 — `~했어요` 체다. 무엇을 왜 바꿨는지를 문장으로 푼다. 항목 하나가 여러 줄이면 하위 불릿으로 근거를 나눈다.

두 절을 관행으로 갖는다. 있으면 적고 없으면 뺀다.

- **검증 범위** — 리뷰를 몇 라운드 돌렸는지, 이슈가 몇 건에서 몇 건으로 줄었는지. 무엇이 걸렸는지도 한 줄
- **남긴 것** — 알면서 안 고친 것과 그 이유. 다음 사람이 "왜 이건 안 했지"를 다시 묻지 않게 한다

작성 후 검사한다.

```bash
pnpm tsx bin/gestalt.ts humanize-scan --file CHANGELOG.md --register doc
pnpm verify:rules   # baseline 초과분이 있으면 여기서 걸린다
```

`verify:rules`가 `CHANGELOG.md — S1 어투 패턴 N건 (허용 M건)`으로 걸리면 **새로 쓴 문장이 원인이다.** baseline을 낮추지 말고 문장을 고친다. 실제로 매번 `C-11`(연결어미 뒤 쉼표)이 걸린다.

**여기서 바로 커밋한다.** `npm version`은 working tree가 깨끗하기를 요구해서 스테이징만 해두면 `Git working directory not clean`으로 막힌다.

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): vX.Y.Z 항목 추가"
```

이 커밋이 5.5단계에서 옮길 태그의 조상이 되므로 태그에 그대로 실린다. 태그를 안 옮기면 CHANGELOG가 빠지니 5.5단계를 건너뛰지 않는다.

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

`sync-version.ts`는 일곱 자리를 건드린다 — 버전 필드 셋과 npx 스펙이 박힌 MCP 매니페스트 넷이다. **하나라도 빠지면 배포판에 옛 핀이 실리고 `tests/unit/mcp-manifests.test.ts`가 main에서 깨진다.** 목록을 손으로 적는 대신 스크립트가 실제로 건드린 것을 그대로 담는다.

```bash
pnpm run version:sync            # 이미 postversion이 돌렸지만 멱등하다
git add -u                       # sync-version이 건드린 자리만 스테이징된다
git status --short               # 일곱 자리가 다 올라왔는지 눈으로 본다
git commit -m "chore(plugin): bump plugin manifest to vX.Y.Z"
```

`git add -u`가 다른 작업 중인 변경까지 담을까 걱정되면 3단계 전에 `git status`가 깨끗했는지 확인한다. 1단계가 그걸 이미 요구한다.

`git status --short`에 아래 일곱이 다 보여야 한다.

```
.claude-plugin/plugin.json        .claude-plugin/marketplace.json
plugin/.codex-plugin/plugin.json
.mcp.json                         .claude-plugin/.mcp.json
plugin/mcp.json                   plugin/.mcp.json
```

CHANGELOG는 2.5단계에서 이미 커밋했으므로 여기 안 보인다.

### 5.5. 태그를 매니페스트 커밋으로 옮긴다 (빠뜨리면 안 됨)
`npm version`이 찍은 태그는 5단계 커밋보다 **앞**을 가리킨다. GitHub Actions는 태그를 체크아웃해 빌드하므로, 그대로 두면 배포되는 패키지에 **한 버전 뒤처진 매니페스트**가 실린다. `plugin/`이 npm `files`에 포함되어 있어 Codex 사용자에게 그 값이 그대로 보인다 (v0.47.1 태그에 0.47.0 매니페스트가 실려 나간 실제 사례가 있다).

```bash
git tag -f vX.Y.Z            # 매니페스트 커밋(HEAD)으로 이동
git show vX.Y.Z:plugin/.codex-plugin/plugin.json | grep version   # 확인
git show vX.Y.Z:plugin/mcp.json | grep @tienne/gestalt            # npx 핀도 확인
git show vX.Y.Z:CHANGELOG.md | head -12                          # 이번 버전 항목이 실렸는지
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
| `verify:rules`가 CHANGELOG로 걸림 | baseline을 낮추지 말고 새로 쓴 문장을 고친다 (대개 `C-11`) |
| CHANGELOG를 안 쓰고 태그를 푸시함 | 태그는 옮기지 않는다. 다음 커밋으로 채우고 그 사실을 사용자에게 알린다 |
| `npm version`이 `Git working directory not clean` | 2.5단계의 CHANGELOG를 스테이징만 하고 안 커밋한 것이다. 커밋하고 재시도 |
| GitHub Actions 실패 | Actions 탭에서 로그 확인 요청. NPM_TOKEN 시크릿 미설정 여부 점검 |
