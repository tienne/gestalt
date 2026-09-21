/**
 * 스캔은 "이번에 볼 룰"을 좁히는 장치다. 좁히기가 실제로 되는지,
 * 좁히다가 볼 것을 빠뜨리지는 않는지 둘 다 본다.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DETECTABLE_RULE_IDS } from '../../../src/humanize/detectors.js';
import { parseRuleBook, s1Ids } from '../../../src/humanize/rules.js';
import { formatScan, scan } from '../../../src/humanize/scan.js';
import { EXIT_CODE } from '../../../src/humanize/check.js';
import { SCAN_EXIT, humanizeScanCommand } from '../../../src/cli/commands/humanize-scan.js';

const book = parseRuleBook();

describe('scan', () => {
  it('걸린 룰만 처방과 함께 내놓는다', () => {
    const report = scan('이 문제에 대해 검토했다. 결론적으로 캐시가 원인이다.');
    expect(report.hits.map((h) => h.ruleId).sort()).toEqual(['A-1', 'D-1']);
    expect(report.s1Total).toBe(2);
    expect(report.hits.every((h) => h.prescription.length > 0)).toBe(true);
  });

  it('안 걸린 룰은 아예 언급하지 않는다', () => {
    const report = scan('이 문제에 대해 검토했다.');
    const mentioned = new Set(report.hits.map((h) => h.ruleId));
    expect(mentioned.has('D-1')).toBe(false);
    expect(mentioned.size).toBeLessThan(s1Ids(book, 'doc').length);
  });

  it('걸리는 게 없으면 윤문하지 않는다', () => {
    const report = scan('배포는 내일입니다. 롤백 기준도 정했습니다.');
    expect(report.worthHumanizing).toBe(false);
    expect(formatScan(report)).toContain('원문을 그대로 낸다');
  });

  it('맞춤법은 S1 총계와 따로 센다', () => {
    const report = scan('Approve 합니다. 6564d04 에서 고쳤어요.');
    expect(report.s1Total).toBe(0);
    expect(report.worthHumanizing).toBe(false);
    expect(report.spacing.map((issue) => issue.count)).toEqual([1, 1]);
    expect(formatScan(report)).toContain('맞춤법');
  });

  it('맞춤법이 없으면 그 절을 안 만든다', () => {
    expect(formatScan(scan('배포는 내일입니다.'))).not.toContain('맞춤법');
  });

  it('조사가 다음 줄에 있으면 띄어쓰기가 아니다', () => {
    expect(scan('커밋 6564d04\n\n에서 시작했다.').spacing).toEqual([]);
  });

  it('말투에 따라 볼 룰이 달라진다', () => {
    const draft = '이 작업을 통해 유지보수성을 손봤습니다.';
    expect(scan(draft, { register: 'doc' }).hits.map((h) => h.ruleId)).not.toContain('A-2');
    expect(scan(draft, { register: 'chat' }).hits.map((h) => h.ruleId)).toContain('A-2');
  });

  it('건수가 많은 룰을 앞에 둔다', () => {
    const draft = '이 문제에 대해, 저 문제에 대해, 그 문제에 대해 봤다. 결론적으로 캐시다.';
    const report = scan(draft);
    expect(report.hits[0]!.ruleId).toBe('A-1');
    expect(report.hits[0]!.count).toBe(3);
  });

  it('탐지기가 없는 S1은 감추지 않고 목록으로 넘긴다', () => {
    const report = scan('이 문제에 대해 검토했다.');
    const detectable = new Set(DETECTABLE_RULE_IDS);
    expect(report.unverifiable.length).toBeGreaterThan(0);
    expect(report.unverifiable.every((id) => !detectable.has(id))).toBe(true);
  });

  it('탐지 가능과 직접 확인을 합치면 그 말투의 S1 전체가 된다', () => {
    for (const register of ['doc', 'chat', 'report'] as const) {
      const report = scan('이 문제에 대해 검토했다.', { register });
      const detectableS1 = s1Ids(book, register).filter((id) =>
        new Set(DETECTABLE_RULE_IDS).has(id),
      );
      const covered = new Set([...detectableS1, ...report.unverifiable]);
      expect([...covered].sort()).toEqual(s1Ids(book, register).sort());
    }
  });
});

/**
 * 리뷰 스킬은 리포트를 `report` 로, 인라인 코멘트를 `chat` 으로 스캔한다. 두 자리가
 * 룰북을 두 번 읽으니 한 번으로 합치고 싶어지는데, 합치면 검사가 조용히 약해진다 —
 * `chat` 이 S1 으로 올려 보는 룰들을 `report` 는 S2 로 두고 지나간다.
 *
 * 문서 쪽 단언은 tests/unit/review/review-parallel-wave.test.ts 에 있다. 여기서는 같은
 * 갈림이 코드에도 실재하는지 본다 — 문서만 지키면 룰북의 심각도 칸이 바뀌어 두 register
 * 가 같아지는 날에 아무 데도 안 걸린다.
 */
describe('register 가 같은 원고를 다르게 판정한다', () => {
  // I-7: 리뷰 코멘트를 "지적"이라 부르는 자리. 룰북이 대화와 리뷰에서만 S1 로 올려 둔다
  const draft = '리뷰에서 나온 지적 사항을 정리했다. 남은 것은 다음 라운드에 본다.';

  it('report 에서는 안 걸리고 chat 에서는 걸린다', () => {
    const asReport = scan(draft, { register: 'report' });
    const asChat = scan(draft, { register: 'chat' });

    expect(asReport.worthHumanizing, 'report 기준으로 이 원고가 걸렸다').toBe(false);
    expect(asReport.hits.map((h) => h.ruleId)).not.toContain('I-7');

    expect(asChat.worthHumanizing, 'chat 기준으로 이 원고가 안 걸렸다').toBe(true);
    expect(asChat.hits.map((h) => h.ruleId)).toContain('I-7');
  });

  it('chat 에서 걸린 자리는 처방까지 함께 온다 (스킬이 룰북 대신 싣는 값)', () => {
    const hit = scan(draft, { register: 'chat' }).hits.find((h) => h.ruleId === 'I-7');
    expect(hit, 'chat 스캔이 I-7 을 안 잡았다').toBeDefined();
    expect(hit!.prescription.length, 'I-7 처방이 비어 있다').toBeGreaterThan(0);
    expect(formatScan(scan(draft, { register: 'chat' }))).toContain('처방:');
  });

  it('report 의 S1 은 chat 의 S1 에 통째로 담긴다 — 합치면 chat 쪽만 잃는다', () => {
    const asReport = s1Ids(book, 'report');
    const asChat = new Set(s1Ids(book, 'chat'));
    expect(
      asReport.every((id) => asChat.has(id)),
      'report 에만 있는 S1 이 생겼다',
    ).toBe(true);
    // 두 register 가 같아지면 합쳐도 잃는 게 없어 보인다. 그 순간 이 단언이 걸린다
    expect(asChat.size, 'chat 이 report 보다 더 보는 룰이 없다').toBeGreaterThan(asReport.length);
  });

  it('chat 에서만 S1 인 룰 중에 탐지기가 실제로 가리는 게 있다', () => {
    const reportS1 = new Set(s1Ids(book, 'report'));
    const detectable = new Set(DETECTABLE_RULE_IDS);
    const chatOnlyDetectable = s1Ids(book, 'chat').filter(
      (id) => !reportS1.has(id) && detectable.has(id),
    );
    // 탐지기가 못 가리는 룰만 갈린다면 register 를 합쳐도 스캔 결과는 안 변한다.
    // 실제로 갈리는지를 여기서 고정한다
    expect(chatOnlyDetectable, 'chat 전용 S1 중 탐지 가능한 룰이 없다').toContain('I-7');
  });
});

describe('humanize-scan 종료 코드', () => {
  // humanize-check 는 판정을 종료 코드로 답한다. scan 도 같은 계약을 지켜야
  // 셸에서 stdout 을 파싱하지 않고 0단계 분기를 탈 수 있다.
  // 상수만 확인하면 커맨드 안의 삼항을 뒤집어도 안 잡히므로 실제로 부른다
  const dir = mkdtempSync(join(tmpdir(), 'gestalt-scan-'));
  const write = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, body, 'utf-8');
    return path;
  };

  afterEach(() => vi.restoreAllMocks());

  const exitCodeOf = (file: string) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // process.exit 를 막아 뒀으니 커맨드가 그 뒤로도 흘러간다. 파일이 없는 경로에서
    // readFileSync 가 터지는 건 정상이다. 우리가 볼 건 이미 기록된 exit 인자다
    try {
      humanizeScanCommand({ file });
    } catch {
      // 무시
    }
    return exit.mock.calls[0]?.[0];
  };

  it('걸린 S1이 있으면 found 로 끝난다', () => {
    const file = write('dirty.md', '이 문제에 대해 검토했다. 결론적으로 캐시가 원인이다.\n');
    expect(exitCodeOf(file)).toBe(SCAN_EXIT.found);
  });

  it('걸리는 게 없으면 clean 으로 끝난다', () => {
    const file = write('clean.md', '배포는 내일입니다. 롤백 기준도 정했습니다.\n');
    expect(exitCodeOf(file)).toBe(SCAN_EXIT.clean);
  });

  it('파일이 없으면 판정이 아니라 unknown 으로 끝난다', () => {
    expect(exitCodeOf(join(dir, '없는파일.md'))).toBe(EXIT_CODE.unknown);
  });

  it('맞춤법만 걸리면 clean 이 아니라 spacingOnly 로 끝난다', () => {
    const file = write('spacing.md', 'Approve 합니다.\n');
    expect(exitCodeOf(file)).toBe(SCAN_EXIT.spacingOnly);
  });

  it('상한을 넘는 파일은 읽지 않고 unknown 으로 끝난다', () => {
    const file = write('big.md', 'a'.repeat(2_000_001));
    expect(exitCodeOf(file)).toBe(EXIT_CODE.unknown);
  });

  it('파일이 아니면 unknown 으로 끝난다', () => {
    expect(exitCodeOf(dir)).toBe(EXIT_CODE.unknown);
  });

  it('세 코드가 서로 다르다', () => {
    expect(new Set([SCAN_EXIT.found, SCAN_EXIT.clean, SCAN_EXIT.spacingOnly]).size).toBe(3);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('humanize-scan 다중 파일 하위호환', () => {
  // --file 을 여러 번 받는 배치 경로가 생겼다고 기존에 --file 하나만 넘기던 스킬들의
  // 계약(stdout, 종료 코드)이 흔들리면 안 된다. 네 가지 종료 코드마다 단일 인자 호출과
  // 길이 1짜리 배열 호출이 바이트 단위로 같은지 확인한다.
  const testDir = join('.gestalt-test', `humanize-scan-compat-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });

  const write = (name: string, body: string) => {
    const path = join(testDir, name);
    writeFileSync(path, body, 'utf-8');
    return path;
  };

  afterEach(() => vi.restoreAllMocks());

  const run = (file: string | string[], options: { json?: boolean; register?: string } = {}) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      humanizeScanCommand({ file, ...options });
    } catch {
      // process.exit 를 막아 뒀으니 그 뒤 흐름에서 던지는 예외는 무시한다
    }
    return { exitCode: exit.mock.calls[0]?.[0], stdout: log.mock.calls[0]?.[0] };
  };

  const cases: Array<{ label: string; exitCode: number; body: string; register?: string }> = [
    {
      label: 'found',
      exitCode: SCAN_EXIT.found,
      body: '이 문제에 대해 검토했다. 결론적으로 캐시가 원인이다.\n',
    },
    {
      label: 'clean',
      exitCode: SCAN_EXIT.clean,
      body: '배포는 내일입니다. 롤백 기준도 정했습니다.\n',
    },
    {
      label: 'spacingOnly',
      exitCode: SCAN_EXIT.spacingOnly,
      body: 'Approve 합니다.\n',
    },
    {
      label: 'allQuoted',
      exitCode: SCAN_EXIT.allQuoted,
      body: '> 전부 인용줄이다.\n',
      register: 'chat',
    },
  ];

  for (const { label, exitCode, body, register } of cases) {
    it(`종료 코드 ${label} 에서 단일 인자와 길이 1 배열이 stdout과 종료 코드 모두 같다`, () => {
      const file = write(`${label}.md`, body);
      const single = run(file, { register });
      expect(single.exitCode).toBe(exitCode);

      const asArray = run([file], { register });
      expect(asArray.exitCode).toBe(single.exitCode);
      expect(asArray.stdout).toBe(single.stdout);
      // 배치 포맷의 `== <path> EXIT=<n>` 헤더는 파일이 둘 이상일 때만 붙는다.
      // 단일 파일 경로가 이 헤더를 얹으면 기존에 stdout 을 그대로 파싱하던
      // 스킬들이 첫 줄부터 어긋난다
      expect(single.stdout).not.toMatch(/^== .+ EXIT=\d+/);
    });

    it(`종료 코드 ${label} 에서 --json 최상위는 files 키 없이 ScanReport 그 자체다`, () => {
      const file = write(`${label}-json.md`, body);
      const single = run(file, { json: true, register });
      const asArray = run([file], { json: true, register });

      expect(single.stdout).toBe(asArray.stdout);
      const parsed = JSON.parse(single.stdout as string);
      expect(parsed).not.toHaveProperty('files');
      expect(parsed).toHaveProperty('register');
      expect(parsed).toHaveProperty('hits');
    });
  }

  it('임시 디렉터리를 정리한다', () => {
    rmSync(testDir, { recursive: true, force: true });
    expect(existsSync(testDir)).toBe(false);
  });
});

describe('humanize-scan 다중 파일 배치', () => {
  const testDir = join('.gestalt-test', `humanize-scan-batch-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });

  const write = (name: string, body: string) => {
    const path = join(testDir, name);
    writeFileSync(path, body, 'utf-8');
    return path;
  };

  afterEach(() => vi.restoreAllMocks());

  const run = (files: string[], options: { json?: boolean; register?: string } = {}) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      humanizeScanCommand({ file: files, ...options });
    } catch {
      // 무시
    }
    return { exitCode: exit.mock.calls[0]?.[0], stdout: log.mock.calls[0]?.[0] as string };
  };

  const found = () =>
    write(`found-${randomUUID()}.md`, '이 문제에 대해 검토했다. 결론적으로 캐시가 원인이다.\n');
  const clean = () =>
    write(`clean-${randomUUID()}.md`, '배포는 내일입니다. 롤백 기준도 정했습니다.\n');
  const spacingOnly = () => write(`spacing-${randomUUID()}.md`, 'Approve 합니다.\n');
  const allQuoted = () => write(`quoted-${randomUUID()}.md`, '> 전부 인용줄이다.\n');

  it('found 와 clean 을 섞으면 전체가 found 로 닫힌다', () => {
    const files = [clean(), found()];
    const result = run(files);
    expect(result.exitCode).toBe(SCAN_EXIT.found);
  });

  it('allQuoted 와 clean 을 섞으면 전체가 allQuoted 로 닫힌다', () => {
    const files = [clean(), allQuoted()];
    const result = run(files, { register: 'chat' });
    expect(result.exitCode).toBe(SCAN_EXIT.allQuoted);
  });

  it('spacingOnly 와 clean 을 섞으면 전체가 spacingOnly 로 닫힌다', () => {
    const files = [clean(), spacingOnly()];
    const result = run(files);
    expect(result.exitCode).toBe(SCAN_EXIT.spacingOnly);
  });

  it('전부 clean 이면 전체도 clean 이다', () => {
    const files = [clean(), clean()];
    const result = run(files);
    expect(result.exitCode).toBe(SCAN_EXIT.clean);
  });

  it('텍스트 출력에 파일 수만큼 == 경로 EXIT=코드 헤더가 붙는다', () => {
    const files = [clean(), found(), spacingOnly()];
    const result = run(files);
    const headers = files.map(
      (file) => new RegExp(`^== ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} EXIT=\\d+$`, 'm'),
    );
    for (const header of headers) {
      expect(result.stdout).toMatch(header);
    }
    expect(result.stdout.match(/^== /gm)?.length).toBe(files.length);
  });

  it('--json 은 파일마다 다른 exitCode 를 담고 바깥에 합산 exitCode 를 따로 둔다', () => {
    const files = [clean(), found()];
    const result = run(files, { json: true });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files[0].exitCode).toBe(SCAN_EXIT.clean);
    expect(parsed.files[1].exitCode).toBe(SCAN_EXIT.found);
    expect(parsed.exitCode).toBe(SCAN_EXIT.found);
    expect(parsed.exitCode).not.toBe(parsed.files[0].exitCode);
  });

  it('인용으로만 된 파일은 다른 파일이 산문으로 가득해도 자기 항목에서 그대로 12로 남는다', () => {
    // 두 파일을 이어붙여 한 번에 스캔하면 인용 판정의 분모(산문 줄 수)가 다른 파일의
    // 산문까지 포함해 커져서 allQuoted 가 false 로 뒤집힌다. 파일마다 따로 스캔해야
    // 이 파일 하나만의 12 가 살아남는다
    const quoted = allQuoted();
    const prose = write(
      `prose-${randomUUID()}.md`,
      '이 기능은 어제 배포했고 오늘 아침에 문제없이 돌아갔다. 로그도 깨끗하고 지표도 정상이다. 내일도 이대로 두면 된다.\n',
    );
    const result = run([quoted, prose], { json: true, register: 'chat' });
    const parsed = JSON.parse(result.stdout);
    const quotedEntry = parsed.files.find((entry: { file: string }) => entry.file === quoted);
    expect(quotedEntry.exitCode).toBe(SCAN_EXIT.allQuoted);
    expect(quotedEntry.report.allQuoted).toBe(true);
  });

  it('세 파일이 found, allQuoted, spacingOnly 로 서로 다르면 합산은 found 다 (some이 아니라 every로 바꾸면 깨진다)', () => {
    // aggregateExitCode 가 "코드 중 하나라도 found 면 found" (some) 대신
    // "전부 found 여야 found" (every) 로 바뀌면, 세 파일이 서로 다른 코드를 갖는 이 배치는
    // 어느 분기에도 안 걸려 기본값인 clean(10) 으로 잘못 떨어진다
    const files = [found(), allQuoted(), spacingOnly()];
    const result = run(files, { register: 'chat' });
    expect(result.exitCode).toBe(SCAN_EXIT.found);
  });

  it('임시 디렉터리를 정리한다', () => {
    rmSync(testDir, { recursive: true, force: true });
    expect(existsSync(testDir)).toBe(false);
  });
});
