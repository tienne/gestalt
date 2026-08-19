#!/usr/bin/env tsx
/**
 * 룰북과 그걸 인용하는 에이전트 문서가 갈라지지 않았는지 검사한다.
 *
 * `ai-tell-quick-rules.md`가 기준인데, 에이전트 14곳이 룰 ID와 금지 어휘를 손으로 옮겨 적는다.
 * 거기서 ID를 지우거나 심각도를 바꿔도 그 사본들은 그대로 남아 아무도 모른 채 어긋난다.
 * 여기서 막는다.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { citedRuleIds, parseRuleBook, s1Ids, QUICK_RULES_PATH } from '../src/humanize/index.js';
import { countByRule, proseLines, DETECTABLE_RULE_IDS } from '../src/humanize/detectors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PLUGIN = join(ROOT, 'plugin');
const DOCS = join(ROOT, 'docs');
const SRC = join(ROOT, 'src');
/** 레포 루트에 흩어져 있는 산문 문서 */
const ROOT_DOCS = ['README.md', 'README.ko.md', 'CLAUDE.md'];
const rel = (path: string) => path.slice(ROOT.length + 1);
const BASELINE_PATH = join(__dirname, 'humanize-baseline.json');

/** 룰 ID 나열은 목록이지 산문이 아니다 */
const RULE_ID_CHAIN = /^[A-J]-\d{1,2}(?:·[A-J]-\d{1,2})+$/;

/**
 * 룰 문서가 스스로 금지한 표현을 본문에 쓰면 산출물로 샌다.
 * 예시로 인용할 때는 백틱이나 따옴표로 감싼다 — 아래 bareProse가 그건 걷어낸다.
 */
const SELF_CONTAMINATION = ['결론적으로', '요약하자면', '정리하자면', '본질적으로', '핵심적으로'];

/**
 * B-3 대상 음차. 굳어진 음차 화이트리스트에 없는데 자꾸 들어오는 말들이다.
 * 명령어나 제품 기능 이름으로 쓸 때는 백틱으로 감싼다 (`orchestration gate-create`).
 */
const LOANWORDS: Record<string, string> = {
  SSOT: '기준 문서 / 기준값',
  SoT: '기준 문서 / 기준값',
  게이트: '승인 단계 / 검사',
  레이어: '계층 / 묶음 / 단계 / 역할',
};

/** 대체어가 여러 개인 건 자리마다 다르기 때문이다 — 하나 정해 일괄 치환하지 말 것 */
const LOANWORD_HINT = 'style-guide.md §음차를 옮길 때';

export interface RuleRefIssue {
  level: 'error' | 'warn';
  file: string;
  message: string;
}

function markdownFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * 예시로 인용한 금지어까지 잡으면 못 쓴다 — 따옴표와 괄호 안은 인용으로 본다.
 * 어느 줄이 산문인지는 proseLines가 정한다. 여기서 따로 세면 detect 경로와 갈라진다.
 */
function bareProse(markdown: string): { line: string; number: number }[] {
  return proseLines(markdown).map(({ text, number }) => ({
    line: text
      .replace(/`[^`\n]*`/g, ' ')
      .replace(/"[^"\n]*"|“[^”\n]*”|'[^'\n]*'/g, ' ')
      .replace(/\([^)\n]*\)/g, ' '),
    number,
  }));
}

/**
 * "화이트리스트" 가 적힌 줄에서 가장 긴 가운뎃점 나열을 정착어 목록으로 읽는다.
 * 꼬리의 "… 등 정착어는 그대로 둔다" 는 잘라낸다.
 */
function whitelistTerms(markdown: string): string[] {
  const terms: string[] = [];
  for (const line of markdown.split('\n')) {
    if (!line.includes('화이트리스트')) continue;
    const runs = line.match(/[가-힣][가-힣 ]*(?:·[가-힣][가-힣 ]*)+/g) ?? [];
    const longest = runs.sort((a, b) => b.length - a.length)[0];
    if (!longest) continue;
    for (const raw of longest.split('·')) {
      // 한글 뒤 \b 는 성립하지 않는다. 후행 부정 탐색으로 "등"의 끝을 잡는다
      const term = raw.split(/\s+등(?![가-힣])/)[0]!.trim();
      if (term) terms.push(term);
    }
  }
  return terms;
}

export function verifyRuleRefs(): RuleRefIssue[] {
  const issues: RuleRefIssue[] = [];
  const book = parseRuleBook(QUICK_RULES_PATH);

  if (book.rules.size === 0) {
    issues.push({
      level: 'error',
      file: rel(QUICK_RULES_PATH),
      message: '룰을 하나도 못 읽었습니다. 표 형식이 바뀌었는지 확인하세요.',
    });
    return issues;
  }

  const known = new Set(book.rules.keys());

  // 1. 에이전트 문서가 인용한 ID가 룰북에 실제로 있는가
  for (const file of markdownFiles(PLUGIN)) {
    if (file === QUICK_RULES_PATH) continue;
    const cited = citedRuleIds(readFileSync(file, 'utf-8'));
    const unknown = cited.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      issues.push({
        level: 'error',
        file: rel(file),
        message: `룰북에 없는 ID 인용: ${unknown.sort().join(', ')}`,
      });
    }
  }

  // 2. 자체검증 목록이 룰북 표와 맞는가
  const checklist = [...book.selfCheckS1, ...book.selfCheckChatS1];
  const strayInChecklist = checklist.filter((id) => !known.has(id));
  if (strayInChecklist.length > 0) {
    issues.push({
      level: 'error',
      file: rel(QUICK_RULES_PATH),
      message: `자체검증 5번이 없는 ID를 열거: ${strayInChecklist.sort().join(', ')}`,
    });
  }

  // 3. S1인데 자체검증 목록에서 빠진 룰 — S2로 흘러 강제되지 않는 자리다
  const declaredS1 = new Set([...s1Ids(book, 'doc'), ...s1Ids(book, 'chat')]);
  const listed = new Set(checklist);
  const detectable = new Set(DETECTABLE_RULE_IDS);
  const missing = [...declaredS1].filter((id) => !listed.has(id)).sort();

  for (const id of missing) {
    issues.push({
      level: detectable.has(id) ? 'error' : 'warn',
      file: rel(QUICK_RULES_PATH),
      message: `${id}은 S1인데 자체검증 5번 목록에 없습니다`,
    });
  }

  // 3b. 반대로 자체검증이 대화 S1이라 부르는데 표는 S2로 둔 룰 — 표를 고쳐야 강제된다
  for (const id of book.selfCheckChatS1) {
    const rule = book.rules.get(id);
    if (rule && rule.chatSeverity !== 'S1') {
      issues.push({
        level: 'error',
        file: rel(QUICK_RULES_PATH),
        message: `${id}은 자체검증이 대화 S1로 부르는데 표 심각도는 ${rule.chatSeverity}입니다`,
      });
    }
  }

  // 3c. 에이전트 문서가 "S1 패턴은 ~다"라고 재진술한 목록이 룰북과 맞는가.
  //     심각도를 내려도 이 사본들은 안 따라와서 낡은 목록이 그대로 강제된다.
  const declaredAnyS1 = new Set([...s1Ids(book, 'doc'), ...s1Ids(book, 'chat')]);
  for (const file of markdownFiles(PLUGIN)) {
    if (file === QUICK_RULES_PATH) continue;
    readFileSync(file, 'utf-8')
      .split('\n')
      .forEach((line, index) => {
        if (!line.includes('S1')) return;
        const stale = citedRuleIds(line).filter(
          (id) => known.has(id) && !declaredAnyS1.has(id),
        );
        if (stale.length > 0) {
          issues.push({
            level: 'error',
            file: `${rel(file)}:${index + 1}`,
            message: `S1 목록에 S1이 아닌 ID: ${stale.sort().join(', ')}`,
          });
        }
      });
  }

  // 3d. 음차 화이트리스트가 에이전트 문서에 두 벌 더 복사돼 있다.
  //     사본이 룰북에 없는 말을 정착어라고 우기면 그 말만 교정에서 빠져나간다.
  const allowed = new Set(whitelistTerms(readFileSync(QUICK_RULES_PATH, 'utf-8')));
  for (const file of markdownFiles(PLUGIN)) {
    if (file === QUICK_RULES_PATH) continue;
    const stray = whitelistTerms(readFileSync(file, 'utf-8')).filter((t) => !allowed.has(t));
    if (stray.length > 0) {
      issues.push({
        level: 'error',
        file: rel(file),
        message: `룰북 화이트리스트에 없는 정착어 주장: ${stray.sort().join(', ')}`,
      });
    }
  }

  // 4. 룰 문서가 자기가 금지한 표현을 본문에 쓰고 있는가
  for (const file of markdownFiles(join(PLUGIN, 'role-agents'))) {
    for (const { line, number } of bareProse(readFileSync(file, 'utf-8'))) {
      for (const banned of SELF_CONTAMINATION) {
        if (line.includes(banned)) {
          issues.push({
            level: 'error',
            file: `${rel(file)}:${number}`,
            message: `금지 표현을 본문에 사용: ${banned}`,
          });
        }
      }
    }
  }

  // 5. 화이트리스트에 없는 음차 (B-3) — 에이전트와 스킬 문서 전체가 대상
  for (const file of markdownFiles(PLUGIN)) {
    for (const { line, number } of bareProse(readFileSync(file, 'utf-8'))) {
      for (const [word, replacement] of Object.entries(LOANWORDS)) {
        if (line.includes(word)) {
          issues.push({
            level: 'error',
            file: `${rel(file)}:${number}`,
            message: `B-3 음차: ${word} → ${replacement} (${LOANWORD_HINT})`,
          });
        }
      }
    }
  }

  // 6. 에이전트가 읽는 문서에 S1 어투 패턴이 늘어나지 않았는가.
  //    문서가 AI-tell을 담고 있으면 에이전트가 그걸 배워 산출물로 내보낸다.
  //    남은 건 대부분 탐지기가 못 가리는 오탐이라 0건이 아니라 베이스라인으로 잠근다.
  const baseline = readBaseline();
  for (const [file, count] of countS1ByFile()) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) {
      issues.push({
        level: 'error',
        file,
        message: `S1 어투 패턴 ${count}건 (허용 ${allowed}건). 고치거나 pnpm humanize:baseline 으로 기준을 낮춰 잠근다`,
      });
    }
  }

  return issues;
}

/**
 * S1 검사 대상. 사람이 읽을 한국어 산문이 있는 자리는 전부 넣는다.
 *
 * 에이전트 문서만 훑던 때는 docs와 README, 소스 주석에 같은 패턴이 쌓여도 아무도
 * 몰랐다. writing-reviewer를 도입한 브랜치가 정작 그 세 자리에 C-11을 일곱 개
 * 남긴 게 이 범위 차이 때문이라, 검사도 사람이 읽는 자리까지 따라간다.
 */
function proseTargets(): string[] {
  const rootDocs = ROOT_DOCS.map((name) => join(ROOT, name)).filter((path) => existsSync(path));
  return [...markdownFiles(PLUGIN), ...markdownFiles(DOCS), ...rootDocs, ...sourceFiles(SRC)];
}

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * 소스 파일에서 주석만 뽑아 산문처럼 돌려준다.
 *
 * 코드 본문은 대상이 아니다. 문자열 리터럴 안의 한글도 빼는데, 프롬프트 템플릿이
 * 대부분이라 어투 룰로 재면 오탐만 는다. 사람이 읽는 설명은 주석에 있다.
 *
 * 줄을 통째로 차지하는 주석과 코드 뒤에 붙는 줄끝 주석을 모두 본다. 이 레포는
 * `filePath: string; // .gestalt-kb 경로` 같은 줄끝 주석을 흔하게 쓴다.
 *
 * 백틱 문자열 안은 건너뛴다. 템플릿 리터럴에 들어간 예시 코드의 `//`를 주석으로
 * 세면 문자열 데이터를 산문으로 재게 된다.
 */
function commentProse(source: string): { line: string; number: number }[] {
  const out: { line: string; number: number }[] = [];
  let inBlock = false;
  let inTemplate = false;

  source.split('\n').forEach((raw, index) => {
    const trimmed = raw.trim();
    let text: string | null = null;

    if (inBlock) {
      text = trimmed.replace(/^\*+\s?/, '').replace(/\*\/.*$/, '');
      if (trimmed.includes('*/')) inBlock = false;
    } else if (inTemplate) {
      // 템플릿 안은 문자열이다. 백틱 개수만 세어 언제 빠져나오는지 본다
      if (countBackticks(raw) % 2 === 1) inTemplate = false;
    } else if (trimmed.startsWith('/*')) {
      text = trimmed.replace(/^\/\*+\s?/, '').replace(/\*\/.*$/, '');
      if (!trimmed.includes('*/')) inBlock = true;
    } else if (trimmed.startsWith('//')) {
      text = trimmed.replace(/^\/\/+\s?/, '');
    } else {
      text = trailingComment(raw);
      if (countBackticks(raw) % 2 === 1) inTemplate = true;
    }

    if (text && /[가-힣]/.test(text)) out.push({ line: text, number: index + 1 });
  });

  return out;
}

/** 이스케이프되지 않은 백틱 수 */
function countBackticks(line: string): number {
  return (line.match(/(?<!\\)`/g) ?? []).length;
}

/**
 * 코드 뒤에 붙는 `// ...` 를 뽑는다.
 *
 * 따옴표와 백틱 안은 먼저 지운다. URL의 `//`를 주석으로 세지 않으려는 것이다.
 * 지운 자리의 길이를 맞춰 둬야 잘라낼 위치가 원본과 어긋나지 않는다.
 */
function trailingComment(raw: string): string | null {
  const masked = raw
    .replace(/`[^`]*`/g, (m) => ' '.repeat(m.length))
    .replace(/'[^']*'/g, (m) => ' '.repeat(m.length))
    .replace(/"[^"]*"/g, (m) => ' '.repeat(m.length))
    .replace(/https?:\/\//g, (m) => ' '.repeat(m.length));

  const at = masked.indexOf('//');
  if (at === -1) return null;
  return raw.slice(at).replace(/^\/\/+\s?/, '').trim() || null;
}

/** 파일별 S1 건수. 룰 예외(용어 목록·룰 ID 나열)는 세지 않는다 */
export function countS1ByFile(): Map<string, number> {
  const targets = s1Ids(parseRuleBook(), 'doc');
  const counts = new Map<string, number>();

  for (const file of proseTargets()) {
    const content = readFileSync(file, 'utf-8');
    const lines = file.endsWith('.ts') ? commentProse(content) : bareProse(content);
    let total = 0;
    for (const { line } of lines) {
      // 굳어진 음차 화이트리스트는 C-12 예외다
      if (line.includes('화이트리스트')) continue;
      const prose = line.replace(/[가-힣A-Za-z0-9-]+(?:·[가-힣A-Za-z0-9-]+)+/g, (chain) =>
        RULE_ID_CHAIN.test(chain) ? ' ' : chain,
      );
      for (const n of countByRule(prose, targets).values()) total += n;
    }
    if (total > 0) counts.set(rel(file), total);
  }

  return counts;
}

function readBaseline(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as Record<string, number>;
  } catch {
    return {};
  }
}

const __filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === __filename;

if (isDirectRun) {
  const issues = verifyRuleRefs();
  const errors = issues.filter((i) => i.level === 'error');

  for (const issue of issues) {
    const tag = issue.level === 'error' ? 'ERROR' : 'WARN ';
    console.error(`${tag} ${issue.file} — ${issue.message}`);
  }

  if (errors.length > 0) {
    console.error(`\n룰 참조 정합 실패: ${errors.length}건`);
    process.exit(1);
  }
  console.log(`룰 참조 정합 통과 (경고 ${issues.length}건)`);
}
