import { loadConfig } from '../../core/config.js';
import { isReadFailure, readInput } from '../../humanize/read-input.js';
import { createAdapter } from '../../llm/factory.js';
import {
  EXIT_CODE,
  AUDIENCES,
  decide,
  formatExplainReport,
  judgeAccuracy,
  parseAudience,
  runExplainCheck,
  withAxis,
} from '../../explain/index.js';

export interface ExplainCheckOptions {
  source: string;
  explain: string;
  audience?: string;
  judge?: boolean;
  json?: boolean;
  /** 몇 번째 설명본인지. 재시도를 소진하면 사람에게 넘긴다 */
  attempt?: string | number;
}

function read(label: string, path: string): string {
  const input = readInput(path, label);
  if (isReadFailure(input)) {
    console.error(input.message);
    process.exit(EXIT_CODE.unknown);
  }
  return input;
}

export async function explainCheckCommand(options: ExplainCheckOptions): Promise<void> {
  const audience = parseAudience(options.audience);
  if (!audience) {
    console.error(`모르는 대상입니다: ${options.audience} (${AUDIENCES.join(', ')} 중 하나)`);
    process.exit(EXIT_CODE.unknown);
  }

  const source = read('원문', options.source);
  const explanation = read('설명본', options.explain);

  if (source.trim().length === 0) {
    console.error('원문이 비어 있어 판정할 수 없습니다.');
    process.exit(EXIT_CODE.unknown);
  }
  if (explanation.trim().length === 0) {
    console.error('설명본이 비어 있어 판정할 수 없습니다.');
    process.exit(EXIT_CODE.unknown);
  }

  const attempt = Math.max(1, Number(options.attempt ?? 1) || 1);
  let report = runExplainCheck(source, explanation, { audience });

  // 심판은 옵트인이다. 안 켜면 결정론 여섯 축만으로 판정이 끝난다
  if (options.judge) {
    const config = loadConfig();
    if (!config.llm.apiKey) {
      console.error('--judge를 켰지만 API 키가 없습니다. 결정론 축만 판정합니다.');
    } else {
      report = withAxis(
        report,
        await judgeAccuracy(createAdapter(config.llm), {
          source,
          explanation,
          audience,
        }),
      );
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ ...report, attempt, decision: decide(report, attempt) }, null, 2));
  } else {
    console.log(formatExplainReport(report, attempt));
  }

  process.exit(report.exitCode);
}
