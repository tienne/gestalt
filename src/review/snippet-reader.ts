import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';

const MAX_FILE_BYTES = 2_000_000;
const MAX_LINE_CHARS = 200;
/** 지목 라인 위아래 기본 창 */
const BASE_CONTEXT_LINES = 5;
/** 감싸는 선언을 찾아 위로 훑는 최대 거리. 이보다 멀면 도움이 안 되니 포기한다 */
const MAX_HEADER_LOOKUP = 60;
/** 붙이는 감싸는 선언 개수 상한. 함수 + 그 안의 블록 정도면 충분하다 */
const MAX_HEADERS = 2;

/** 확장자 → 마크다운 코드펜스 언어 힌트. 없으면 하이라이팅 없이 렌더링한다. */
const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
  '.mjs': 'js',
  '.cjs': 'js',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.rb': 'ruby',
  '.php': 'php',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cs': 'csharp',
  '.sh': 'bash',
  '.sql': 'sql',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.md': 'markdown',
};

export interface SnippetLine {
  no: number;
  text: string;
  /** 이슈가 지목한 라인 */
  target: boolean;
  /** 이 라인과 다음 라인 사이가 잘려 있다 (생략 표시 대상) */
  gapAfter?: boolean;
}

export interface CodeSnippet {
  lang: string;
  lines: SnippetLine[];
}

/**
 * 리뷰 이슈가 가리키는 라인 주변 코드를 파일에서 직접 읽는다.
 *
 * 에이전트가 제출한 스니펫을 믿지 않고 디스크를 읽는 이유는, 사용자가 파일을
 * 열었을 때 보게 되는 것과 리포트가 일치해야 하기 때문이다. 읽을 수 없으면
 * null을 돌려주고 리포트는 기존처럼 위치 텍스트만 보여준다.
 *
 * 창 크기는 코드 모양에 맞춰 늘어난다. 들여쓰기로 감싸는 블록을 추정해서
 * 선언 라인을 위에 붙이고, 아래로는 블록이 끝나는 지점에서 멈춘다. 언어별
 * 파서 없이 들여쓰기만 보므로, 판단이 안 되면 기본 창으로 떨어진다.
 *
 * 인스턴스 캐시는 한 리포트 생성 동안만 유효하다. review_fix 루프가 파일을
 * 고치므로, 재시도 리포트는 새 인스턴스로 읽어야 한다.
 */
export class SnippetReader {
  private cache = new Map<string, string[] | null>();

  constructor(
    private repoRoot?: string,
    private contextLines: number = BASE_CONTEXT_LINES,
  ) {}

  read(file: string, line?: number): CodeSnippet | null {
    if (line === undefined || !Number.isInteger(line) || line < 1) return null;

    const fileLines = this.readLines(file);
    if (fileLines === null || line > fileLines.length) return null;

    const window = this.resolveWindow(fileLines, line);

    const nos = [...window.headers];
    for (let no = window.start; no <= window.end; no++) {
      if (!nos.includes(no)) nos.push(no);
    }
    nos.sort((a, b) => a - b);

    const lines: SnippetLine[] = nos.map((no, i) => {
      const next = nos[i + 1];
      return {
        no,
        text: truncate(fileLines[no - 1]!),
        target: no === line,
        // 다음에 붙는 라인이 바로 아랫줄이 아니면 사이가 잘린 것이다
        gapAfter: next !== undefined && next !== no + 1,
      };
    });

    // 태그를 비우면 윤문 검사가 펜스 안을 산문으로 읽는다. 모르는 확장자는 text로 정한다
    return { lang: LANG_BY_EXT[extname(file).toLowerCase()] ?? 'text', lines };
  }

  /**
   * 기본 창에서 시작해 코드 모양에 맞춰 조정한다.
   * - 아래: 감싸는 블록이 끝나는 라인까지만 (다음 함수로 넘어가지 않게)
   * - 위: 감싸는 선언 라인들을 headers로 따로 확보
   */
  private resolveWindow(
    fileLines: string[],
    line: number,
  ): { start: number; end: number; headers: number[] } {
    const start = Math.max(1, line - this.contextLines);
    const end = Math.min(fileLines.length, line + this.contextLines);

    const targetIndent = indentOf(fileLines[line - 1]!);
    // 빈 줄이나 최상위 라인은 감쌀 블록이 없다고 보고 기본 창을 쓴다
    if (targetIndent === null || targetIndent === 0) return { start, end, headers: [] };

    const boundary = this.findBlockEnd(fileLines, line, targetIndent);

    return {
      start,
      end: boundary === undefined ? end : Math.min(end, boundary),
      // 이미 창 안에 보이는 선언은 중복이므로 제외한다
      headers: this.findEnclosingHeaders(fileLines, line, targetIndent).filter((no) => no < start),
    };
  }

  /** 지목 라인 아래에서 들여쓰기가 얕아지는 첫 라인 (블록 닫힘). 그 라인까지 포함한다. */
  private findBlockEnd(
    fileLines: string[],
    line: number,
    targetIndent: number,
  ): number | undefined {
    for (let no = line + 1; no <= fileLines.length; no++) {
      const indent = indentOf(fileLines[no - 1]!);
      if (indent !== null && indent < targetIndent) return no;
    }
    return undefined;
  }

  /**
   * 지목 라인을 감싸는 선언 라인들을 위로 훑어 모은다 (오름차순).
   *
   * 들여쓰기가 한 단계씩 얕아지는 라인을 따라가므로 `for` 같은 중간 블록뿐
   * 아니라 그걸 감싼 함수 선언까지 잡힌다. 이슈가 어느 함수 안에 있는지가
   * 리포트에서 제일 알고 싶은 정보이기 때문이다. MAX_HEADERS로 끊어 스니펫이
   * 길어지지 않게 한다.
   */
  private findEnclosingHeaders(fileLines: string[], line: number, targetIndent: number): number[] {
    const headers: number[] = [];
    const limit = Math.max(1, line - MAX_HEADER_LOOKUP);
    let wanted = targetIndent;

    for (let no = line - 1; no >= limit && headers.length < MAX_HEADERS; no--) {
      const indent = indentOf(fileLines[no - 1]!);
      if (indent === null || indent >= wanted) continue;

      headers.push(no);
      if (indent === 0) break;
      wanted = indent;
    }

    return headers.reverse();
  }

  private readLines(file: string): string[] | null {
    const cached = this.cache.get(file);
    if (cached !== undefined) return cached;

    const result = this.loadLines(file);
    this.cache.set(file, result);
    return result;
  }

  private loadLines(file: string): string[] | null {
    try {
      const path = isAbsolute(file) ? file : resolve(this.repoRoot ?? process.cwd(), file);
      if (!existsSync(path)) return null;

      const stat = statSync(path);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;

      const content = readFileSync(path, 'utf-8');
      // NUL이 있으면 바이너리로 보고 건너뛴다
      if (content.includes('\0')) return null;

      return content.split(/\r?\n/);
    } catch {
      return null;
    }
  }
}

/** 앞쪽 공백 폭. 빈 줄은 들여쓰기를 판단할 수 없으므로 null. 탭은 4칸으로 센다. */
function indentOf(text: string): number | null {
  if (text.trim() === '') return null;

  let width = 0;
  for (const char of text) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += 4;
    else break;
  }
  return width;
}

function truncate(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;
}
