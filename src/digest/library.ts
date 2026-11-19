import { readdirSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { SOURCE_KINDS, type SourceKind, videoMetaSchema } from './schema.js';
import { isValidSlug, readRaw } from './store.js';
import { escapeXml } from './svg.js';

const labels: Record<SourceKind, string> = {
  youtube: '유튜브',
  file: '영상 파일',
  pdf: 'PDF',
  web: '웹 글',
  podcast: '팟캐스트',
};

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
    return `<li><a href="/${entry.slug}/">${escapeXml(entry.title)}</a><small>${labels[entry.kind]} <time datetime="${day}">${day}</time></small></li>`;
  });
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>요약 보관함</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}
body{margin:0;background:light-dark(#f7f5ef,#181b1e);color:light-dark(#242923,#e6e7df)}
main{max-width:46rem;margin:clamp(1rem,6vw,4rem) auto;padding:0 1rem}
h1{font-size:clamp(1.75rem,5vw,2.6rem);margin:0 0 1.25rem}
form{display:flex;align-items:end;gap:.75rem;flex-wrap:wrap}
label{display:grid;gap:.25rem}label:first-child{flex:1 1 15rem}
input,select,button{font:inherit;padding:.5rem .65rem;border:1px solid #83897f;border-radius:.35rem}
button{cursor:pointer}
ul{list-style:none;padding:0;margin:1.5rem 0;display:grid;gap:.65rem}
li{padding:.9rem 1rem;background:light-dark(#fff,#22262a);border:1px solid light-dark(#dedfd6,#444a48);border-radius:.5rem}
a{color:light-dark(#24554c,#9dd8c8);font-weight:650;overflow-wrap:anywhere}
small{display:flex;gap:.7rem;margin-top:.35rem}
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
