import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';

// 금지 목록 파일(.gestalt/hygiene-denylist.txt) 형식:
// - 한 줄에 하나의 문자열
// - # 문자로 시작하는 줄은 주석 (무시)
// - 빈 줄 무시
// - 대소문자 구분 안 함 (grep -i 사용)

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const denyCacheRoot = join(repoRoot, '.gestalt');
const denylistPath = join(denyCacheRoot, 'hygiene-denylist.txt');
const fixturesDir = join(repoRoot, 'tests/fixtures');

// 금지 목록 파일에서 금지 문자열 목록을 파싱한다
function parseDenylist(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

// 파일 시스템에서 모든 파일을 재귀적으로 수집한다
function collectAllFiles(dirPath: string): string[] {
  const files: string[] = [];

  function traverse(currentDir: string) {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        traverse(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  }

  traverse(dirPath);
  return files;
}

// 파일이 금지어를 포함하는지 확인한다 (대소문자 무시)
function checkFileForBannedTerms(
  filePath: string,
  terms: string[],
): { term: string; lines: number[] }[] {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const results: { term: string; lines: number[] }[] = [];

    for (const term of terms) {
      const termLower = term.toLowerCase();
      const matchedLines: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.toLowerCase().includes(termLower)) {
          matchedLines.push(i + 1);
        }
      }
      if (matchedLines.length > 0) {
        results.push({ term, lines: matchedLines });
      }
    }

    return results;
  } catch {
    // 읽을 수 없는 파일은 건너뛴다
    return [];
  }
}

describe('fixture-hygiene', () => {
  describe('denylist parsing', () => {
    it('파싱: 정상 목록 (주석, 빈 줄, 유효 항목)', () => {
      const content = `# 사내 레포 금지어 목록
acme
widget-kit
# 또 다른 레포
lonely-kit

`;
      const result = parseDenylist(content);
      expect(result).toEqual(['acme', 'widget-kit', 'lonely-kit']);
    });

    it('파싱: 공백만 있는 줄은 제외', () => {
      const content = `acme

widget-kit

lonely-kit`;
      const result = parseDenylist(content);
      expect(result).toEqual(['acme', 'widget-kit', 'lonely-kit']);
    });

    it('파싱: 모든 줄이 주석이거나 빈 줄', () => {
      const content = `# 주석 1
# 주석 2

`;
      const result = parseDenylist(content);
      expect(result).toEqual([]);
    });

    it('파싱: 공백을 포함한 항목', () => {
      const content = `some company
another org

leading-space-item`;
      const result = parseDenylist(content);
      expect(result).toEqual(['some company', 'another org', 'leading-space-item']);
    });
  });

  // 목록 파일은 로컬에만 있다(.gestalt/는 커밋되지 않는다). 없으면 검사를 건너뛰고 그 사실만 남긴다
  it.runIf(!existsSync(denylistPath))('금지 목록 파일이 없어 이름 검사를 건너뛴다', () => {
    console.info(`[fixture-hygiene] ${relative(repoRoot, denylistPath)} 없음, 이름 검사 건너뜀`);
  });

  describe.skipIf(!existsSync(denylistPath))('fixture hygiene checks', () => {
    let denylist: string[] = [];

    beforeAll(() => {
      if (existsSync(denylistPath)) {
        const content = readFileSync(denylistPath, 'utf-8');
        denylist = parseDenylist(content);
      }
    });

    it('tests/fixtures/harness-repos 아래 파일에 금지어가 없다', () => {
      const files = collectAllFiles(join(fixturesDir, 'harness-repos'));
      const violations: Array<{ file: string; matches: { term: string; lines: number[] }[] }> = [];

      for (const file of files) {
        const matches = checkFileForBannedTerms(file, denylist);
        if (matches.length > 0) {
          violations.push({ file, matches });
        }
      }

      if (violations.length > 0) {
        const msg = violations
          .map((v) => {
            const relPath = relative(repoRoot, v.file);
            const details = v.matches
              .map((m) => `  - '${m.term}' at lines ${m.lines.join(', ')}`)
              .join('\n');
            return `${relPath}\n${details}`;
          })
          .join('\n');
        expect.fail(`금지 문자열 발견:\n${msg}`);
      }

      expect(violations).toEqual([]);
    });

    it('src/harness-review 아래 파일에 금지어가 없다', () => {
      const files = collectAllFiles(join(repoRoot, 'src/harness-review'));
      const violations: Array<{ file: string; matches: { term: string; lines: number[] }[] }> = [];

      for (const file of files) {
        const matches = checkFileForBannedTerms(file, denylist);
        if (matches.length > 0) {
          violations.push({ file, matches });
        }
      }

      if (violations.length > 0) {
        const msg = violations
          .map((v) => {
            const relPath = relative(repoRoot, v.file);
            const details = v.matches
              .map((m) => `  - '${m.term}' at lines ${m.lines.join(', ')}`)
              .join('\n');
            return `${relPath}\n${details}`;
          })
          .join('\n');
        expect.fail(`금지 문자열 발견:\n${msg}`);
      }

      expect(violations).toEqual([]);
    });

    it('plugin/review-agents/harness-reviewer 아래 파일에 금지어가 없다', () => {
      const harnessReviewerPath = join(repoRoot, 'plugin/review-agents/harness-reviewer');
      if (!existsSync(harnessReviewerPath)) {
        // 아직 생성되지 않은 경우는 이 테스트 자체를 skip한다
        expect(true).toBe(true);
        return;
      }

      const files = collectAllFiles(harnessReviewerPath);
      const violations: Array<{ file: string; matches: { term: string; lines: number[] }[] }> = [];

      for (const file of files) {
        const matches = checkFileForBannedTerms(file, denylist);
        if (matches.length > 0) {
          violations.push({ file, matches });
        }
      }

      if (violations.length > 0) {
        const msg = violations
          .map((v) => {
            const relPath = relative(repoRoot, v.file);
            const details = v.matches
              .map((m) => `  - '${m.term}' at lines ${m.lines.join(', ')}`)
              .join('\n');
            return `${relPath}\n${details}`;
          })
          .join('\n');
        expect.fail(`금지 문자열 발견:\n${msg}`);
      }

      expect(violations).toEqual([]);
    });
  });

  it('목록이 없으면 검사를 건너뛴다', () => {
    if (!existsSync(denylistPath)) {
      console.log(
        `⏭️  hygiene denylist(${denylistPath})가 없어 fixture 검사를 건너뜁니다. 테스트 파일 상단 주석 참고.`,
      );
    }
    expect(true).toBe(true);
  });
});
