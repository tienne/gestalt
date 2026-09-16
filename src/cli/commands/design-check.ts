import { resolve } from 'node:path';
import { loadConfig } from '../../core/config.js';
import { exitCodeOf, formatReport, runDesignCheck } from '../../design/index.js';

export interface DesignCheckOptions {
  /** 검사할 레포 루트. 기본은 현재 디렉토리 */
  repo?: string;
  /** 이번 작업 태그. 소스의 scope와 맞는 것만 읽는다 */
  tags?: string;
  /** 디자인 시스템 import를 알아보는 정규식. 조직마다 패키지 이름이 다르다 */
  dsImport?: string;
  json?: boolean;
}

export function designCheckCommand(options: DesignCheckOptions): void {
  const repoRoot = resolve(options.repo ?? process.cwd());
  // 검사 대상 레포의 선언을 읽는다. 게슈탈트가 선 디렉토리 것을 읽으면 남의 레포를
  // 검사하면서 내 기준을 들이대는 꼴이 된다
  const config = loadConfig({}, { cwd: repoRoot });

  // 선언이 없으면 잴 기준이 없다. 실패가 아니라 이 레포가 안 쓰는 검사라는 뜻이므로
  // 0으로 끝낸다 — 게이트에 걸어둔 레포에서 설정 없이 빌드가 막히면 안 된다
  if (config.ruleSources.length === 0 && config.ruleSourceErrors.length === 0) {
    console.log('gestalt.json에 ruleSources 선언이 없어 디자인 검사를 건너뜁니다.');
    console.log('설정 방법은 docs/configuration.md의 "레포 밖 규칙 소스"를 보세요.');
    return;
  }

  // 선언이 깨진 것과 선언이 없는 것은 다르다. 깨진 걸 "없음"으로 읽으면 오타 하나가
  // 검사를 통째로 끄는 자리가 된다
  if (config.ruleSourceErrors.length > 0) {
    console.error('gestalt.json의 ruleSources 선언에 문제가 있어 기준을 읽지 못했습니다.');
    for (const e of config.ruleSourceErrors) console.error(`  ${e}`);
    process.exitCode = 2;
    return;
  }

  const report = runDesignCheck({
    repoRoot,
    ruleSources: config.ruleSources,
    tags: options.tags
      ? options.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : [],
    zone: options.dsImport ? { dsImport: new RegExp(options.dsImport) } : undefined,
  });

  console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
  process.exitCode = exitCodeOf(report);
}
