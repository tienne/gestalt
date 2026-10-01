import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { StructuralCommand, StructuralResult } from '../core/types.js';

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

interface PackageJsonLike {
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
}

function readPackageJson(root: string): PackageJsonLike | null {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as PackageJsonLike;
  } catch {
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
 * 구조 검사 명령을 만든다. testFiles가 비어 있으면 테스트를 좁히지 않고 전체를 돌린다.
 * package.json에 없는 스크립트는 빼지만 test는 남긴다 — 테스트를 안 돌리고 통과시키는 길을 막기 위해서다.
 */
export function buildStructuralCommands(
  root: string,
  testFiles: string[] = [],
): StructuralCommand[] {
  const pm = detectPackageManager(root);
  const scripts = readPackageJson(root)?.scripts;
  return STRUCTURAL_SCRIPTS.filter(
    (name) => name === 'test' || !scripts || scripts[name] !== undefined,
  ).map((name) => ({
    name,
    command: scriptCommand(pm, name, name === 'test' ? testFiles : []),
  }));
}

function gitLines(repoRoot: string, args: string[]): string[] {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 직전 커밋과 작업 트리(스테이징, 미스테이징, 추적 안 된 새 파일)의 변경 파일을 합친다.
 * 첫 커밋뿐인 레포에서는 HEAD~1이 없어 그 조회만 빈 결과가 된다.
 */
export function collectChangedFiles(repoRoot: string): string[] {
  const files = new Set<string>([
    ...gitLines(repoRoot, ['diff', '--name-only', 'HEAD~1', 'HEAD']),
    ...gitLines(repoRoot, ['diff', '--name-only', 'HEAD']),
    ...gitLines(repoRoot, ['ls-files', '--others', '--exclude-standard']),
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
