/**
 * 레포를 훑어 디자인 검사를 돌린다.
 *
 * 파일 수집과 판정을 잇는 자리다. 판정 규칙 자체는 check.ts가 갖고 있고 여기는 무엇을
 * 읽어 넘길지만 정한다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { RuleSource } from '../core/config.js';
import { judge, type DesignReport, type FileFinding } from './check.js';
import { detectBypasses } from './detectors.js';
import { findDuplicates, type DuplicateInput } from './duplicates.js';
import { inferImportPattern } from './import-pattern.js';
import { resolveInventory } from './inventory.js';
import { zoneOf, type ZoneOptions } from './scope.js';

/** 검사 대상 확장자. 스타일시트는 미채택 구역으로만 들어간다 */
const TARGET_EXT = /\.(tsx|jsx|css|scss|sass|less)$/;

/** 어느 레포에나 있고 훑을 이유가 없는 디렉토리 */
const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|out|coverage|\.next|\.turbo|\.nx)(\/|$)/;

export interface RunOptions {
  repoRoot: string;
  ruleSources: readonly RuleSource[];
  /** 이번 작업 태그. 소스의 `scope`와 맞는 것만 읽는다 */
  tags?: string[];
  /** 디자인 시스템 import를 알아보는 정규식 */
  zone?: ZoneOptions;
  /**
   * 세션이 미리 읽어 넘긴 컴포넌트 목록.
   *
   * MCP 소스는 CLI가 못 부른다. 스킬이 도구로 읽어 여기 실어 주면 CLI가 그걸 쓴다.
   * 이 값이 있으면 같은 id의 소스를 못 읽었다고 세지 않는다.
   */
  providedComponents?: { id: string; components: string[] }[];
}

function collectFiles(root: string): string[] {
  const out: string[] = [];
  for (const d of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!d.isFile() || !TARGET_EXT.test(d.name)) continue;
    const full = join(d.parentPath, d.name);
    if (SKIP_DIR.test(full)) continue;
    out.push(full);
  }
  return out;
}

export function runDesignCheck(options: RunOptions): DesignReport {
  const { repoRoot, ruleSources } = options;
  const inv = resolveInventory(ruleSources, { cwd: repoRoot, tags: options.tags });

  const components = [...inv.components];
  const basis = [...inv.basis];
  let notMeasured = [...inv.notMeasured];

  // 선언이 곧 기준이다. 게슈탈트가 패키지 이름을 기본값으로 들고 있으면 다른 조직
  // 레포에서 모든 파일이 바깥으로 판정돼 누수가 0건으로 나온다.
  //
  // 손으로 적은 게 없으면 ref가 가리킨 곳의 package.json에서 알아낸다. 훑어서 고르는
  // 것과 다르다 — 사용자가 이미 그 소스를 지목했고 여기서는 그 경로가 어느 패키지인지만
  // 읽는다. 추론했으면 어떻게 알았는지 보고에 남긴다
  const patterns: string[] = [];
  for (const rs of ruleSources) {
    if (rs.importPattern) {
      patterns.push(rs.importPattern);
      basis.push(`${rs.id} import 패턴: 선언값`);
      continue;
    }
    if (rs.kind !== 'file') continue;
    const inferred = inferImportPattern(rs.ref, repoRoot);
    if (inferred) {
      patterns.push(inferred.pattern.source);
      basis.push(`${rs.id} import 패턴: ${inferred.reason}`);
    }
  }
  const dsImport =
    options.zone?.dsImport ?? (patterns.length > 0 ? new RegExp(patterns.join('|')) : undefined);

  // 세션이 넘겨준 목록이 있으면 그 소스는 읽은 것으로 친다
  for (const p of options.providedComponents ?? []) {
    components.push(...p.components);
    basis.push(`${p.id} (세션이 읽어 넘김, ${p.components.length}개)`);
    notMeasured = notMeasured.filter((n) => !n.startsWith(`${p.id}:`));
  }

  const files: FileFinding[] = [];
  const dupInput: DuplicateInput[] = [];

  for (const full of collectFiles(repoRoot)) {
    let source: string;
    try {
      source = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const filePath = relative(repoRoot, full);
    const zone = zoneOf(filePath, source, { ...options.zone, dsImport });
    files.push({
      filePath,
      zone,
      // 대상이 아닌 파일은 훑지 않는다. 걸려도 리포트에 못 올리는 값이라 세는 값이 없다
      bypasses: zone === 'excluded' ? [] : detectBypasses(source, filePath),
    });
    if (zone !== 'excluded') {
      dupInput.push({ filePath, usesDesignSystem: zone === 'inside' });
    }
  }

  // 목록이 없으면 대조할 게 없다. 빈 목록으로 돌리면 중복 0건이 나와 "깨끗함"처럼
  // 보이므로, 못 쟀다는 사실을 남겨 판정이 통과를 주지 않게 한다
  const duplicates =
    components.length > 0 ? findDuplicates([...new Set(components)], dupInput) : [];
  if (components.length === 0) {
    notMeasured.push('중복 컴포넌트: 제공 목록을 못 읽어 대조하지 못함');
  }
  if (!dsImport) {
    notMeasured.push(
      '누수: 디자인 시스템 import 패턴이 선언되지 않아 시스템 안팎을 가르지 못함 ' +
        '(ruleSources[].importPattern 또는 --ds-import)',
    );
  }

  return judge({ files, duplicates, basis, notMeasured });
}
