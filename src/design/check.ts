/**
 * 디자인 시스템을 실제로 따랐는지 코드가 판단하는 검사.
 *
 * humanize와 explain과 판정 뼈대만 같고 재는 것이 다르다. 그쪽은 글을 보고 여기는 코드를
 * 본다. 셋이 같은 게이트에서 번갈아 돌고 사람은 종료 코드를 하나로 읽으므로 등급과
 * 종료 코드는 humanize 것을 빌려 쓴다 — 복사하면 값이 같아도 타입이 남남이라 세 리포트를
 * 함께 다루는 코드에서 타입이 아무것도 못 막는다.
 *
 * 타입이 이미 막는 건 재지 않는다. 남는 자리만 본다 (detectors.ts 머리말).
 */
import { EXIT_CODE, type Verdict } from '../humanize/check.js';
import { BYPASS_LABEL, type Bypass } from './detectors.js';
import type { DuplicateHit } from './duplicates.js';
import type { Zone } from './scope.js';

export { EXIT_CODE, type Verdict };

export interface FileFinding {
  filePath: string;
  zone: Zone;
  bypasses: Bypass[];
}

export interface DesignReport {
  verdict: Verdict;
  /** 시스템을 쓰면서 타입 바깥으로 샌 값. 바로 고칠 수 있는 것들이다 */
  leaks: FileFinding[];
  /** 시스템에 이미 있는데 새로 만든 컴포넌트 */
  duplicates: DuplicateHit[];
  counts: {
    scanned: number;
    inside: number;
    outside: number;
    unknown: number;
    excluded: number;
    leakFindings: number;
    duplicateFindings: number;
  };
  /** 어느 기준으로 쟀는지. 못 읽은 게 있으면 여기 적힌다 */
  basis: string[];
  /** 기준을 못 읽어 재지 못한 항목 */
  notMeasured: string[];
}

export interface JudgeInput {
  files: FileFinding[];
  duplicates: DuplicateHit[];
  basis: string[];
  notMeasured?: string[];
}

/**
 * 판정.
 *
 * 누수가 하나라도 있으면 막는다. 시스템을 쓰기로 한 파일에서 새어 나간 값이라 고치는
 * 비용이 작다. 여기서 안 막으면 다음 사람이 같은 자리를 또 판다.
 *
 * 중복 컴포넌트는 막지 않고 알린다. 지우려면 쓰는 쪽을 전부 옮겨야 해서 이 변경에서
 * 끝낼 수 있는 일이 아니다. 막아 버리면 사람이 검사를 끄게 된다.
 *
 * 기준을 못 읽었으면 통과로 보고하지 않는다. 못 잰 것과 재서 깨끗한 것이 겉보기에
 * 같으면 검사가 조용히 사라진다.
 */
export function judge(input: JudgeInput): DesignReport {
  const notMeasured = input.notMeasured ?? [];
  const leaks = input.files.filter((f) => f.zone === 'inside' && f.bypasses.length > 0);
  const leakFindings = leaks.reduce((n, f) => n + f.bypasses.length, 0);

  const counts = {
    scanned: input.files.length,
    inside: input.files.filter((f) => f.zone === 'inside').length,
    outside: input.files.filter((f) => f.zone === 'outside').length,
    unknown: input.files.filter((f) => f.zone === 'unknown').length,
    excluded: input.files.filter((f) => f.zone === 'excluded').length,
    leakFindings,
    duplicateFindings: input.duplicates.length,
  };

  // 못 잰 게 있으면 abort. 재서 깨끗한 것과 구분되지 않으면 검사가 조용히 사라진다
  const verdict: Verdict = notMeasured.length > 0 || leakFindings > 0 ? 'abort' : 'pass';

  return {
    verdict,
    leaks,
    duplicates: input.duplicates,
    counts,
    basis: input.basis,
    notMeasured,
  };
}

/** 받침에 따라 "와/과"를 고른다. 컴포넌트 이름이 영문이라 마지막 글자로 판별한다 */
function withParticle(word: string): string {
  const last = word.at(-1) ?? '';
  // 영문 자음으로 끝나면 받침이 있는 것처럼 읽힌다 (`button과`, `chip과`)
  return /[a-z]/i.test(last) && !/[aeiouy]/i.test(last) ? '과' : '와';
}

/** 사람이 읽는 리포트. 고칠 수 있는 것을 먼저 놓는다 */
export function formatReport(report: DesignReport): string {
  const out: string[] = [];
  const { counts } = report;

  out.push(
    `[디자인 검사] 파일 ${counts.scanned}개 (시스템 안 ${counts.inside} / 밖 ${counts.outside}` +
      (counts.unknown > 0 ? ` / 판별 불가 ${counts.unknown}` : '') +
      ` / 제외 ${counts.excluded})`,
  );

  if (report.notMeasured.length > 0) {
    out.push('', '재지 못한 기준');
    for (const n of report.notMeasured) out.push(`  ${n}`);
    out.push('  → 기준 없이 통과로 보고하지 않는다');
  }

  if (report.leaks.length > 0) {
    out.push('', `누수 ${counts.leakFindings}건 — 시스템을 쓰면서 타입 바깥으로 나간 값`);
    for (const f of report.leaks) {
      for (const b of f.bypasses) {
        out.push(`  ${f.filePath}:${b.line}  ${BYPASS_LABEL[b.rule]}`);
        out.push(`      ${b.sample}`);
      }
    }
  }

  if (report.duplicates.length > 0) {
    out.push('', `중복 ${counts.duplicateFindings}건 — 시스템에 이미 있는데 새로 만든 것`);
    const grouped = new Map<string, DuplicateHit[]>();
    for (const d of report.duplicates) {
      const list = grouped.get(d.name) ?? [];
      list.push(d);
      grouped.set(d.name, list);
    }
    for (const [name, list] of grouped) {
      const first = list[0]!;
      out.push(
        `  ${name} — 시스템의 \`${first.provided}\`${withParticle(first.provided)} 같은 이름, 레포에 ${list.length}곳`,
      );
      for (const d of list) out.push(`      ${d.filePath}`);
    }
    out.push('  → 막지는 않는다. 쓰는 쪽을 옮겨야 지울 수 있어 이 변경에서 끝나지 않는다');
  }

  if (report.leaks.length === 0 && report.duplicates.length === 0) {
    out.push('', '걸린 것 없음');
  }

  out.push('', `기준: ${report.basis.join(', ') || '(없음)'}`);
  return out.join('\n');
}

/** 판정에 맞는 종료 코드. humanize와 같은 값을 쓴다 */
export function exitCodeOf(report: DesignReport): number {
  return EXIT_CODE[report.verdict];
}
