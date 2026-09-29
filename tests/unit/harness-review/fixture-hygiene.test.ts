import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
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

// 금지 목록 파일에서 금지 문자열 목록을 파싱한다
function parseDenylist(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

// 파일이 금지어를 포함하는지 확인한다 (대소문자 무시)
function checkFileForBannedTerms(
  filePath: string,
  terms: string[],
): { term: string; lines: number[] }[] {
  try {
    const content = readFileSync(filePath, 'utf-8');
    if (content.includes('\0')) return [];
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

  // 목록 파일은 커밋하지 않는다(.gestalt/는 gitignore). 로컬에서는 각자 두고 CI는 시크릿으로 받아 쓴다.
  // 없으면 검사를 건너뛰고 그 사실만 남긴다. 포크 PR에는 시크릿이 안 넘어가서 CI에서도 건너뛴다
  it.runIf(!existsSync(denylistPath))('금지 목록 파일이 없어 이름 검사를 건너뛴다', () => {
    console.info(`[fixture-hygiene] ${relative(repoRoot, denylistPath)} 없음, 이름 검사 건너뜀`);
  });

  describe.skipIf(!existsSync(denylistPath))('fixture hygiene checks', () => {
    let denylist: string[] = [];

    beforeAll(() => {
      denylist = parseDenylist(readFileSync(denylistPath, 'utf-8'));
    });

    // fixture 몇 곳만 보면 설정 테스트 예시처럼 다른 자리로 샌 이름을 놓친다. 그래서 커밋될 파일을 전부 본다
    it('커밋될 파일 어디에도 금지어가 없다', () => {
      const files = execFileSync(
        'git',
        ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
      )
        .split('\0')
        .filter(Boolean);

      const violations: string[] = [];
      for (const file of files) {
        const matches = checkFileForBannedTerms(join(repoRoot, file), denylist);
        for (const m of matches) {
          // CI 로그는 공개라 금지어 자체는 찍지 않고 목록의 몇 번째 항목인지만 적는다
          const index = denylist.indexOf(m.term) + 1;
          violations.push(`${file}: 금지 목록 ${index}번째 항목, ${m.lines.join(', ')}줄`);
        }
      }

      if (violations.length > 0) expect.fail(`금지 문자열 발견:\n${violations.join('\n')}`);
      expect(violations).toEqual([]);
    });
  });
});
