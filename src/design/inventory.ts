/**
 * 선언된 규칙 소스에서 디자인 시스템 목록을 읽어온다.
 *
 * 게슈탈트가 이 목록을 소유하지 않는다. `gestalt.json`의 `ruleSources`가 어디서 읽을지
 * 정하고 여기는 그대로 따른다 (plugin/skills/_shared/rule-sources.md).
 *
 * **CLI는 MCP 소스를 못 읽는다.** MCP 도구는 클라이언트가 부르는 것이라 CLI 프로세스에는
 * 그 경로가 없다. 못 읽는 걸 읽은 척하면 기준 없이 만든 결과가 통과로 보고되므로, 못
 * 읽었다는 사실을 그대로 실어 보내고 판정이 막게 한다.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { RuleSource } from '../core/config.js';

export interface ResolvedInventory {
  /** 디자인 시스템이 제공하는 컴포넌트 이름 */
  components: string[];
  /** 어느 기준으로 쟀는지. 리포트에 그대로 싣는다 */
  basis: string[];
  /** 못 읽은 소스와 그 이유. 비어 있지 않으면 판정이 통과를 안 준다 */
  notMeasured: string[];
}

export interface InventoryOptions {
  /** 상대 경로를 푸는 기준. 기본은 프로세스 작업 디렉토리 */
  cwd?: string;
  /** 이번 작업 태그. 소스의 `scope`와 맞는 것만 읽는다 */
  tags?: string[];
}

function inScope(source: RuleSource, tags: readonly string[]): boolean {
  if (source.scope.length === 0) return true;
  return source.scope.some((s) => tags.includes(s));
}

/**
 * 파일 소스에서 컴포넌트 이름을 뽑는다.
 *
 * 디렉토리면 하위 디렉토리 이름이 곧 컴포넌트 목록이다 (`components/bottom-sheet/`).
 * 파일이면 한 줄에 하나씩 적힌 목록으로 읽는다.
 */
function readFileSource(path: string): string[] {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
      .map((d) => d.name);
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/**
 * 선언을 훑어 컴포넌트 목록을 모은다.
 *
 * `delegate` 소스는 여기서 안 본다. 그건 이 작업을 다른 스킬이 맡는다는 뜻이지 목록을
 * 주는 자리가 아니다.
 */
export function resolveInventory(
  sources: readonly RuleSource[],
  options: InventoryOptions = {},
): ResolvedInventory {
  const cwd = options.cwd ?? process.cwd();
  const tags = options.tags ?? [];
  const components: string[] = [];
  const basis: string[] = [];
  const notMeasured: string[] = [];

  for (const s of sources) {
    if (s.trust === 'delegate') continue;
    if (!inScope(s, tags)) continue;

    if (s.kind === 'mcp') {
      // onMissing이 skip이면 선언한 쪽이 없어도 된다고 한 것이다. 그 판단을 여기서
      // 뒤집지 않는다
      if (s.onMissing !== 'skip') {
        notMeasured.push(`${s.id}: MCP 소스라 CLI에서 못 읽는다 (${s.ref})`);
      }
      continue;
    }

    if (s.kind === 'skill') {
      if (s.onMissing !== 'skip') {
        notMeasured.push(`${s.id}: 스킬 소스라 CLI에서 못 읽는다 (${s.ref})`);
      }
      continue;
    }

    const path = isAbsolute(s.ref) ? s.ref : resolve(cwd, s.ref);
    if (!existsSync(path)) {
      if (s.onMissing !== 'skip') notMeasured.push(`${s.id}: 경로 없음 (${s.ref})`);
      continue;
    }
    try {
      const found = readFileSource(path);
      components.push(...found);
      basis.push(`${s.id} (${s.ref}, ${found.length}개)`);
    } catch (e) {
      if (s.onMissing !== 'skip') {
        notMeasured.push(`${s.id}: 읽기 실패 — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  return { components: [...new Set(components)], basis, notMeasured };
}

/** `onMissing: "stop"`인 소스를 못 읽었는지. 그러면 검사 자체를 시작하지 않는다 */
export function hasBlockingGap(
  sources: readonly RuleSource[],
  notMeasured: readonly string[],
): boolean {
  const stopIds = new Set(sources.filter((s) => s.onMissing === 'stop').map((s) => s.id));
  return notMeasured.some((n) => stopIds.has(n.split(':')[0] ?? ''));
}
