import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';

const MAX_FILE_BYTES = 2_000_000;
const MAX_LINE_CHARS = 200;
const DEFAULT_CONTEXT_LINES = 3;

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
 * 인스턴스 캐시는 한 리포트 생성 동안만 유효하다. review_fix 루프가 파일을
 * 고치므로, 재시도 리포트는 새 인스턴스로 읽어야 한다.
 */
export class SnippetReader {
  private cache = new Map<string, string[] | null>();

  constructor(
    private repoRoot?: string,
    private contextLines: number = DEFAULT_CONTEXT_LINES,
  ) {}

  read(file: string, line?: number): CodeSnippet | null {
    if (line === undefined || !Number.isInteger(line) || line < 1) return null;

    const fileLines = this.readLines(file);
    if (fileLines === null || line > fileLines.length) return null;

    const start = Math.max(1, line - this.contextLines);
    const end = Math.min(fileLines.length, line + this.contextLines);

    const lines: SnippetLine[] = [];
    for (let no = start; no <= end; no++) {
      lines.push({ no, text: truncate(fileLines[no - 1]!), target: no === line });
    }

    return { lang: LANG_BY_EXT[extname(file).toLowerCase()] ?? '', lines };
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

function truncate(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;
}
