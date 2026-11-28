import { readdirSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { SOURCE_KINDS, type SourceKind, videoMetaSchema } from './schema.js';
import { isValidSlug, readRaw } from './store.js';
import { escapeXml } from './svg.js';
import { digestThemeCss, THEME_BOOT_JS, THEME_BOOT_JS_SHA256 } from './theme-color.js';

const labels: Record<SourceKind, string> = {
  youtube: '유튜브',
  file: '영상 파일',
  pdf: 'PDF',
  web: '웹 글',
  podcast: '팟캐스트',
};

/** 보관함 화면 CSP. 영상 요약에서 고른 테마를 같이 쓰려고 테마 부트 스크립트만 해시로 연다 */
export const LIBRARY_CSP = `default-src 'none'; script-src 'sha256-${THEME_BOOT_JS_SHA256}'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

// 자료 유형마다 계열색 점을 붙여 목록을 훑을 때 유형이 먼저 보이게 한다
const KIND_SERIES: Record<SourceKind, number> = { youtube: 1, file: 2, pdf: 3, web: 4, podcast: 5 };

interface LibraryEntry {
  slug: string;
  title: string;
  kind: SourceKind;
  updated: number;
}

function storedFile(root: string, path: string) {
  const real = realpathSync(path);
  if (!real.startsWith(root + sep)) return null;
  const stat = statSync(real);
  return stat.isFile() ? { real, stat } : null;
}

function readLibrary(root: string): LibraryEntry[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((dir) => dir.isDirectory() && isValidSlug(dir.name))
    .flatMap(({ name: slug }) => {
      try {
        const html = storedFile(root, join(root, slug, 'digest.html'));
        const transcript = storedFile(root, join(root, slug, 'transcript.json'));
        if (!html || !transcript) return [];
        const raw = readRaw(transcript.real);
        if (raw.kind !== 'ok' || !raw.value || typeof raw.value !== 'object') return [];
        const value = raw.value as { slug?: string; meta?: unknown };
        const meta = videoMetaSchema.safeParse(value.meta);
        if (!meta.success || value.slug !== slug) return [];
        return [
          { slug, title: meta.data.title, kind: meta.data.source, updated: html.stat.mtimeMs },
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.updated - a.updated || a.slug.localeCompare(b.slug));
}

export function renderDigestLibrary(root: string, query: URLSearchParams): string {
  const entries = readLibrary(root);
  const title = (query.get('q') ?? '').trim();
  const normalized = title.normalize('NFC').toLowerCase();
  const kind = SOURCE_KINDS.find((value) => value === query.get('kind'));
  const matches = entries.filter(
    (entry) =>
      (!kind || entry.kind === kind) &&
      entry.title.normalize('NFC').toLowerCase().includes(normalized),
  );
  const items = matches.map((entry) => {
    const day = new Date(entry.updated).toISOString().slice(0, 10);
    return `<li><a href="/${entry.slug}/">${escapeXml(entry.title)}</a><small><span class="kind" data-kind="${entry.kind}">${labels[entry.kind]}</span> <time datetime="${day}">${day}</time></small></li>`;
  });
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>요약 보관함</title>
<script>${THEME_BOOT_JS}</script>
<style>
${digestThemeCss()}
:root{font-family:system-ui,sans-serif}
body{margin:0;background:var(--bg);color:var(--fg)}
main{max-width:46rem;margin:clamp(1rem,6vw,4rem) auto;padding:0 1rem}
h1{font-size:clamp(1.75rem,5vw,2.6rem);margin:0 0 1.25rem}
form{display:flex;align-items:end;gap:.75rem;flex-wrap:wrap}
label{display:grid;gap:.25rem;color:var(--muted)}label:first-child{flex:1 1 15rem}
input,select,button{font:inherit;padding:.5rem .65rem;border:1px solid var(--line);border-radius:.35rem;background:var(--card);color:var(--fg)}
button{cursor:pointer;background:var(--accent-fill);border-color:var(--accent-fill);color:var(--on-accent);font-weight:650}
:is(input,select,button,a):focus-visible{outline:2px solid var(--gestalt-color-focus);outline-offset:2px}
ul{list-style:none;padding:0;margin:1.5rem 0;display:grid;gap:.65rem}
li{position:relative;padding:.9rem 1rem;background:var(--card);border:1px solid var(--line);border-radius:.5rem;transition:border-color .15s}
li:hover,li:focus-within{border-color:var(--accent)}
a{color:var(--accent);font-weight:650;overflow-wrap:anywhere;text-decoration:none}
a::after{content:"";position:absolute;inset:0}
small{display:flex;align-items:center;gap:.7rem;margin-top:.35rem;color:var(--muted)}
.kind{display:inline-flex;align-items:center;gap:.35rem;padding:0 .5rem;border:1px solid var(--line);border-radius:999px;color:var(--fg)}
.kind::before{content:"";width:.5rem;height:.5rem;border-radius:50%;background:var(--kind)}
${Object.entries(KIND_SERIES)
  .map(([k, n]) => `.kind[data-kind="${k}"]{--kind:var(--gestalt-color-series-${n})}`)
  .join('')}
@media (prefers-reduced-motion:reduce){li{transition:none}}
</style></head>
<body><main><h1>요약 보관함</h1>
<form method="get" action="/">
<label>제목<input name="q" type="search" value="${escapeXml(title)}"></label>
<label>자료 유형<select name="kind"><option value="">전체</option>
${SOURCE_KINDS.map((value) => `<option value="${value}"${kind === value ? ' selected' : ''}>${labels[value]}</option>`).join('')}
</select></label><button type="submit">검색</button></form>
${items.length ? `<ul>${items.join('')}</ul>` : `<p>${entries.length ? '검색 결과가 없어요.' : '아직 열 수 있는 요약이 없어요.'}</p>`}
</main></body></html>`;
}
