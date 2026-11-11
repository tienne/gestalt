import type { DoctorResult } from './doctor.js';
import { tildify } from './paths.js';
import type { RevertResult } from './revert.js';
import type { ApplyResult } from './sync.js';
import type { TargetDiscovery } from './targets.js';

type T = (p: string) => string;

function section(title: string, items: string[]): string[] {
  return items.length > 0 ? ['', title, ...items.map((i) => `  - ${i}`)] : [];
}

function targetLines(d: TargetDiscovery, t: T): string[] {
  const lines = ['대상 홈', ...d.targets.map((x) => `  - ${x.label}  ${t(x.home)}`)];
  if (d.skipped.length > 0) {
    lines.push(
      '건너뛴 홈',
      ...d.skipped.map((s) => {
        // 오르카가 준 id는 빈 값이나 공백, 제어 문자가 들 수 있어 따옴표로 감싸 경계를 보인다
        const label =
          s.rejectedId === undefined ? s.label : `${s.label} ${JSON.stringify(s.rejectedId)}`;
        return `  - ${label}  ${s.home ? t(s.home) : '(경로 없음)'}  ${s.reason}`;
      }),
    );
  }
  return lines;
}

function runLines(run: ApplyResult['run'], t: T): string[] {
  if (!run) return [];
  return ['', `백업 폴더  ${t(run.dir)}`, `기록 파일  ${t(run.recordFile)}`];
}

function prunedLines(pruned: string[]): string[] {
  return pruned.length > 0
    ? ['', `보관 기간(6개월)이 지난 실행 폴더 ${pruned.length}개를 지웠어요: ${pruned.join(', ')}`]
    : [];
}

export function formatSync(
  home: string,
  d: TargetDiscovery,
  r: ApplyResult,
  dryRun: boolean,
): string {
  const t: T = (p) => tildify(p, home);
  const lines = [
    dryRun ? 'gestalt sync 미리보기 (아무것도 바꾸지 않았어요)' : 'gestalt sync',
    '',
    ...targetLines(d, t),
  ];
  if (r.changes.length === 0) {
    lines.push('', '바꿀 게 없어요. 모든 홈이 ~/.agents에 연결돼 있어요');
  } else {
    lines.push(...section(dryRun ? '바꿀 것' : '바꾼 것', r.changes));
  }
  lines.push(
    ...section('참고', r.hints),
    ...section('경고', d.warnings),
    ...runLines(r.run, t),
    ...prunedLines(r.pruned),
  );
  if (r.run) lines.push(`되돌리려면  gestalt sync --revert ${r.run.runId}`);
  if (dryRun && r.changes.length > 0)
    lines.push('', '실제로 바꾸려면 --dry-run 없이 다시 실행해 주세요');
  return lines.join('\n');
}

export function formatRevert(home: string, r: RevertResult, dryRun: boolean): string {
  const t: T = (p) => tildify(p, home);
  const head = `${r.reverted.runId} (${r.reverted.createdAt}) sync 실행`;
  const lines = [
    dryRun ? `되돌리기 미리보기: ${head} (아무것도 바꾸지 않았어요)` : `되돌리기: ${head}`,
  ];
  lines.push(...section(dryRun ? '할 일' : '한 일', r.changes), ...section('참고', r.notes));
  lines.push(...runLines(r.run, t), ...prunedLines(r.pruned));
  return lines.join('\n');
}

export function formatDoctor(
  home: string,
  d: TargetDiscovery,
  r: DoctorResult,
  fix: boolean,
): string {
  const t: T = (p) => tildify(p, home);
  const lines = ['gestalt doctor', '', ...targetLines(d, t)];
  const issueLine = (i: DoctorResult['issues'][number]) =>
    `${i.label}: ${i.message}${i.fixable ? '' : ' (doctor가 고칠 수 없어요)'}`;
  if (r.issues.length === 0) lines.push('', '어긋난 연결이 없어요');
  else lines.push(...section(`어긋난 연결 ${r.issues.length}개`, r.issues.map(issueLine)));
  lines.push(
    ...section(
      '도구 경고',
      r.toolWarnings.map((w) => w.message),
    ),
    ...section('경고', [...d.warnings, ...r.recordWarnings]),
  );
  if (fix) {
    lines.push(...section('고친 것', r.fixed), ...section('참고', r.hints));
    if (r.issues.length > 0) {
      lines.push(
        ...(r.remaining.length > 0
          ? section('아직 남은 문제', r.remaining.map(issueLine))
          : ['', '고칠 것을 다 고쳤어요']),
      );
    }
    lines.push(...runLines(r.run, t), ...prunedLines(r.pruned));
    if (r.run)
      lines.push(
        'doctor가 고친 것은 sync --revert 대상이 아니에요. 되돌리려면 백업 폴더에서 직접 꺼내 주세요',
      );
  } else if (r.issues.some((i) => i.fixable)) {
    lines.push('', '백업하고 고치려면  gestalt doctor --fix');
  }
  return lines.join('\n');
}
