import { frameFileName } from './frames.js';
import { CAPTION_LABEL, formatTime, stripNumbering, watchUrlAt } from './format.js';
import { reportLabel } from './reports.js';
import {
  keywordPattern,
  type Bullet,
  type Cite,
  type Digest,
  type Report,
  type Transcript,
} from './schema.js';

export interface RenderMdOptions {
  /** 이 이름의 프레임이 있으면 소섹션에 `<framesHref>/...` 상대 경로로 싣는다 */
  frameExists?: (fileName: string) => boolean;
  /** 마크다운 파일에서 frames 폴더까지의 상대 경로. 슬러그 폴더 밖에 쓸 때만 바꾼다 */
  framesHref?: string;
  /** 내보낼 리포트. 없으면 첫 리포트다 */
  report?: Report;
}

/** 키워드 마커는 표시 글자만 남긴다. 굵게(`**`)는 마크다운 문법 그대로라 둔다 */
const plain = (text: string) => text.replace(keywordPattern(), (_m, _id, label: string) => label);

/**
 * digest.json을 마크다운 한 파일로 바꾼다. LLM을 부르지 않는다.
 * 기존 video-summarizer가 직접 쓰던 마크다운을 이 출력이 대신한다.
 */
export function renderDigestMarkdown(
  digest: Digest,
  transcript: Transcript,
  opts: RenderMdOptions = {},
): string {
  const { meta, segments } = transcript;
  const long = meta.durationSec >= 3600;
  const at = (i: number) => segments[i]?.startSec ?? 0;
  const framesHref = opts.framesHref ?? 'frames';
  const cite = (c: Cite) => {
    const url = watchUrlAt(meta, at(c.key));
    return url ? ` [[${c.key + 1}]](${url})` : ` [${c.key + 1} ${formatTime(at(c.key), long)}]`;
  };
  const out: string[] = [];

  out.push(`# ${meta.title}`, '');
  const facts = [
    meta.channel,
    meta.publishedAt,
    formatTime(meta.durationSec, long),
    CAPTION_LABEL[meta.captionSource],
  ].filter(Boolean);
  out.push(`> ${facts.join(' | ')}`);
  if (meta.source === 'youtube' && meta.url) out.push(`> ${meta.url}`);
  out.push('');

  const report = opts.report ?? digest.reports[0]!;
  // 리포트가 하나뿐이고 옵션도 기본이면 1차 출력과 같게 둔다
  if (digest.reports.length > 1 || report.options.range || report.options.prompt) {
    out.push(`> 리포트: ${reportLabel(report.options, long)}`);
    if (report.options.prompt) {
      out.push(`> 요청: ${report.options.prompt.replace(/\s+/g, ' ')}`);
    }
    out.push('');
  }
  const { lead, sections, skipped, keywords } = report;
  out.push(`**${plain(lead.question)}**`, '', plain(lead.answer), '', plain(lead.takeaway), '');

  const bullet = (b: Bullet, depth: number): string[] => {
    const pad = '  '.repeat(depth);
    const lines = [`${pad}- ${plain(b.text)}${cite(b.cite)}`];
    for (const c of b.children ?? []) lines.push(...bullet(c, depth + 1));
    return lines;
  };

  sections.forEach((s, si) => {
    out.push(`## ${si + 1}. ${stripNumbering(s.title)}`, '', plain(s.conclusion), '');
    s.subsections.forEach((sub, ui) => {
      out.push(`### ${si + 1}.${ui + 1}. ${stripNumbering(sub.title)}`, '');
      const frame = frameFileName(sub.frameSec);
      if (opts.frameExists?.(frame))
        out.push(`![${formatTime(sub.frameSec, long)}](${framesHref}/${frame})`, '');
      for (const b of sub.bullets) out.push(...bullet(b, 0));
      out.push('');
    });
  });

  if (keywords.length > 0) {
    out.push('## 키워드', '');
    for (const k of keywords)
      out.push(`- **${k.term}**: ${plain(k.explanation)}${cite(k.firstCite)}`);
    out.push('');
  }
  if (skipped.length > 0) {
    out.push('## 요약에서 뺀 구간', '');
    for (const s of skipped) {
      out.push(
        `- ${formatTime(at(s.from), long)}~ 문장 ${s.from + 1}-${s.to + 1}: ${plain(s.reason)}`,
      );
    }
    out.push('');
  }
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}
