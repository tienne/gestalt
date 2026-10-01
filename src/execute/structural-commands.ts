import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { StructuralCommand, StructuralResult } from '../core/types.js';
import { log } from '../core/log.js';

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

// pnpm 체크아웃에 package-lock.json이 함께 커밋된 경우가 있어 npm을 맨 뒤에 둔다.
const LOCKFILES: ReadonlyArray<[string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

const STRUCTURAL_SCRIPTS = ['lint', 'build', 'test'] as const;

// 호스트가 이 문자열을 셸에 그대로 넘긴다. 인용 규칙을 셸마다 맞추기보다 이 문자만 허용하고 나머지는 전체 테스트로 돌린다
const SAFE_PATH = /^[\w@%+=:,./-]+$/;
// 이보다 많으면 명령줄이 길어지고 이벤트에도 그대로 실린다. 그 정도면 전체를 돌리는 쪽이 낫다
const MAX_TEST_FILES = 50;
const MAX_TEST_ARGS_LENGTH = 4000;

const GIT_OPTIONS = { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 } as const;

interface PackageJsonLike {
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
}

function readPackageJson(root: string): PackageJsonLike | null {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as PackageJsonLike;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(
        `[evaluate] could not read package.json in ${root}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return null;
  }
}

/**
 * package.json의 packageManager 필드를 먼저 따르고 없으면 lockfile로 추정한다.
 * 둘 다 없으면 npm.
 */
export function detectPackageManager(root: string): PackageManager {
  const declared = readPackageJson(root)?.packageManager;
  if (typeof declared === 'string') {
    const name = declared.split('@')[0];
    if (name === 'pnpm' || name === 'yarn' || name === 'bun' || name === 'npm') return name;
    log(`[evaluate] unsupported packageManager "${declared}", falling back to lockfile detection`);
  }
  for (const [file, pm] of LOCKFILES) {
    if (existsSync(join(root, file))) return pm;
  }
  return 'npm';
}

function scriptCommand(pm: PackageManager, script: string, args: string[]): string {
  const base = `${pm} run ${script}`;
  if (args.length === 0) return base;
  // npm만 `--` 없이는 인자를 스크립트에 안 넘긴다
  return pm === 'npm' ? `${base} -- ${args.join(' ')}` : `${base} ${args.join(' ')}`;
}

/**
 * 테스트 러너에 넘길 인자로 바꾼다. 경로는 root 기준 상대경로로 줄인다. 셸에 그대로 못 넘기는 경로가 있거나
 * 너무 많으면 빈 배열을 돌려 전체 테스트로 돌린다.
 */
function toTestArgs(root: string, testFiles: string[]): string[] {
  if (testFiles.length === 0 || testFiles.length > MAX_TEST_FILES) return [];
  const args = testFiles.map((f) => (isAbsolute(f) ? relative(root, f) : f));
  const unsafe = args.some((a) => a.startsWith('..') || a.startsWith('-') || !SAFE_PATH.test(a));
  if (unsafe || args.join(' ').length > MAX_TEST_ARGS_LENGTH) return [];
  return args;
}

/**
 * 구조 검사 명령을 만든다. testFiles가 비어 있으면 테스트를 좁히지 않고 전체를 돌린다.
 * package.json에 없는 스크립트는 빼지만 test는 남긴다 — 테스트를 안 돌리고 통과시키는 길을 막기 위해서다.
 */
export function buildStructuralCommands(
  root: string,
  testFiles: string[] = [],
): StructuralCommand[] {
  const pm = detectPackageManager(root);
  const scripts = readPackageJson(root)?.scripts;
  const testArgs = toTestArgs(root, testFiles);
  return STRUCTURAL_SCRIPTS.filter(
    (name) => name === 'test' || !scripts || scripts[name] !== undefined,
  ).map((name) => ({
    name,
    command: scriptCommand(pm, name, name === 'test' ? testArgs : []),
  }));
}

// -z라서 core.quotePath가 켜져 있어도 한글 경로가 이스케이프되지 않는다. 실패는 호출부가 받아 전체 테스트로 돌린다
function gitPaths(repoRoot: string, [subcommand, ...args]: [string, ...string[]]): string[] {
  return execFileSync('git', [subcommand, '-z', ...args], {
    ...GIT_OPTIONS,
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
    .split('\0')
    .filter(Boolean);
}

function hasParentCommit(repoRoot: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '-q', 'HEAD~1^{commit}'], {
      ...GIT_OPTIONS,
      cwd: repoRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 직전 커밋과 작업 트리(스테이징, 미스테이징, 추적 안 된 새 파일)의 변경 파일을 합친다.
 * 삭제된 파일도 남긴다. 그 파일을 import하던 테스트를 blast-radius가 찾아야 해서다.
 * 첫 커밋뿐인 레포에서는 HEAD~1 조회만 건너뛴다. 그 밖의 git 실패는 그대로 던진다.
 */
export function collectChangedFiles(repoRoot: string): string[] {
  // --relative로 diff도 ls-files처럼 repoRoot 기준 경로를 낸다. repoRoot가 레포 하위 디렉터리여도 어긋나지 않는다
  const files = new Set<string>([
    ...(hasParentCommit(repoRoot)
      ? gitPaths(repoRoot, ['diff', '--name-only', '--relative', 'HEAD~1', 'HEAD'])
      : []),
    ...gitPaths(repoRoot, ['diff', '--name-only', '--relative', 'HEAD']),
    ...gitPaths(repoRoot, ['ls-files', '--others', '--exclude-standard']),
  ]);
  return [...files].map((f) => resolve(repoRoot, f));
}

/**
 * 요청한 명령과 제출된 명령을 이름별로 맞춰본다. 빠졌거나 다른 명령을 돌렸으면 사유를 돌려준다.
 */
export function findCommandMismatches(
  requested: StructuralCommand[],
  submitted: StructuralResult,
): string[] {
  const byName = new Map(submitted.commands.map((c) => [c.name, c.command.trim()]));
  const mismatches: string[] = [];
  for (const req of requested) {
    const ran = byName.get(req.name);
    if (ran === undefined) {
      mismatches.push(`${req.name}: missing (expected "${req.command}")`);
    } else if (ran !== req.command.trim()) {
      mismatches.push(`${req.name}: expected "${req.command}", got "${ran}"`);
    }
  }
  return mismatches;
}
