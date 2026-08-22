import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 커밋 전에 빠른 게이트를 강제하는 훅을 설치한다.
 *
 * `pnpm gate`가 있어도 사람이 안 부르면 소용이 없다. 실제로 이 레포에서 게이트 출력을
 * grep에 물려 종료 코드를 삼킨 채 커밋한 일이 두 번 났다 — 위반이 담긴 커밋이 그대로
 * 나갔다. 규율에 맡기지 않고 커밋 자체를 막는다.
 *
 * 훅에 넣는 건 빠른 셋(11초)뿐이다. test와 build는 분 단위라 매 커밋에 물리면 사람이
 * `--no-verify`를 습관처럼 붙이게 된다. 그 둘은 `pnpm gate`와 CI가 본다.
 *
 * `.git/hooks/`에 쓴다. `core.hooksPath`를 옮기면 `gestalt init`이 같은 자리에 두는
 * post-commit 훅이 무시된다.
 */

const MARKER = '# gestalt-pre-commit';

const HOOK = `#!/bin/sh
${MARKER}
# 이 파일은 scripts/install-hooks.ts가 만든다. 직접 고치면 다음 설치가 덮어쓴다.
set -e

echo "[gestalt] 커밋 전 검사 — verify:rules, lint, format:check"
pnpm verify:rules
pnpm lint
pnpm format:check
`;

export function installHooks(repoRoot = process.cwd()): 'installed' | 'kept' | 'skipped' {
  const hooksDir = join(repoRoot, '.git', 'hooks');
  if (!existsSync(join(repoRoot, '.git'))) return 'skipped';

  const path = join(hooksDir, 'pre-commit');
  if (existsSync(path) && !readFileSync(path, 'utf-8').includes(MARKER)) {
    // 남이 둔 훅을 덮지 않는다
    return 'kept';
  }

  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(path, HOOK, 'utf-8');
  chmodSync(path, 0o755);
  return 'installed';
}

if (process.argv[1]?.endsWith('install-hooks.ts')) {
  const result = installHooks();
  const message = {
    installed: 'pre-commit 훅 설치',
    kept: 'pre-commit 훅이 이미 있어 그대로 둡니다',
    skipped: 'git 저장소가 아니라 건너뜁니다',
  }[result];
  process.stderr.write(`[gestalt] ${message}\n`);
}
