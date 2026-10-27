import type { Extension } from './blocks.js';
import { frameFileName, shotFileName } from './frames.js';
import { CAPTION_LABEL, formatTime, stripNumbering, watchUrlAt } from './format.js';
import { blockMarkdown, mdInline, sectionDiagramMd } from './render-blocks.js';
import { isCellRef, type Evidence } from './lens-schema.js';
import type { LensSource } from './lens-source.js';
import { GLANCE_LABEL, unitLabel } from './render-lens.js';
import { reportLabel } from './reports.js';
import {
  isTextKind,
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
  /** 읽기 렌즈의 source.json. 원문 표를 마크다운 표로 옮긴다 */
  source?: LensSource | null;
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
  const cite = mdCiter(transcript);
  const out = mdHeader(transcript);

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
  if (lead.glance?.length) {
    out.push('| 칸 | 내용 |', '| --- | --- |');
    for (const g of lead.glance) {
      out.push(`| ${GLANCE_LABEL[g.kind]} | ${cell(plain(g.text))}${cite(g.cite)} |`);
    }
    out.push('');
  }
  const source = opts.source ?? null;
  const evidence = (ev: Evidence): string => {
    if (!isCellRef(ev)) return cite(ev.cite).trim();
    const table = source?.tables.find((t) => t.id === ev.table);
    const value = table?.rows[ev.row]?.[ev.col] ?? '';
    return `(표 ${table?.number ?? ev.table} ${ev.row + 1}행 ${ev.col + 1}열: ${value})`;
  };

  const bullet = (b: Bullet, depth: number): string[] => {
    const pad = '  '.repeat(depth);
    const lines = [`${pad}- ${plain(b.text)}${cite(b.cite)}`];
    if (b.doubt) {
      lines.push(
        `${pad}  > **원문과 어긋남** ${plain(b.doubt.note)} ${b.doubt.evidence.map(evidence).join(' ')}`,
      );
    }
    for (const c of b.children ?? []) lines.push(...bullet(c, depth + 1));
    return lines;
  };

  const time = mdTimer(transcript);
  sections.forEach((s, si) => {
    out.push(`## ${si + 1}. ${stripNumbering(s.title)}`, '');
    if (s.intro) out.push(`*${plain(s.intro)}*`, '');
    out.push(plain(s.conclusion), '');
    if (s.diagram) out.push(...sectionDiagramMd(s.diagram, { cite, time }));
    s.subsections.forEach((sub, ui) => {
      out.push(`### ${si + 1}.${ui + 1}. ${stripNumbering(sub.title)}`, '');
      // 뷰어와 같이 장면이 있으면 첫 문장 프레임 대신 장면을 싣는다
      const shots = (sub.shots ?? []).filter((x) => opts.frameExists?.(shotFileName(x.sec)));
      for (const shot of shots) {
        // 개행이 남으면 이미지 문법이 깨져 다음 줄이 따로 해석된다
        const alt = shot.caption
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/[\\[\]<>!]/g, (ch) => `\\${ch}`);
        out.push(`![${alt}](${framesHref}/${shotFileName(shot.sec)})`, '');
        const url = watchUrlAt(transcript.meta, shot.sec);
        const at = formatTime(shot.sec, long);
        out.push(
          `*${mdInline(shot.caption)}* ${url ? `[${at}](${url})` : at}${cite(shot.cite)}`,
          '',
        );
      }
      const frameSec = sub.frameSec;
      const frame = frameSec === undefined ? null : frameFileName(frameSec);
      if (shots.length === 0 && frame && frameSec !== undefined && opts.frameExists?.(frame))
        out.push(`![${formatTime(frameSec, long)}](${framesHref}/${frame})`, '');
      for (const b of sub.bullets) out.push(...bullet(b, 0));
      out.push('');
      for (const t of sub.tables ?? []) {
        const table = source?.tables.find((x) => x.id === t.ref);
        if (table) out.push(...tableMd(table.number, table.caption, table.rows), '');
      }
      for (const f of sub.figures ?? []) {
        const fig = source?.figures.find((x) => x.id === f.ref);
        if (fig?.image) out.push(`![그림 ${fig.number}](${fig.image})`, '', `*${fig.caption}*`, '');
      }
    });
  });
  if (report.limits?.length) {
    out.push('## 검증 안 된 부분', '');
    for (const l of report.limits) {
      const refs = [...l.evidence.map(evidence), ...(l.card ? [`(맥락 카드 ${l.card})`] : [])];
      out.push(`- ${plain(l.text)} ${refs.join(' ')}`.trimEnd());
    }
    out.push('');
  }

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
  return finish(out);
}

/** 확장 리포트 한 벌을 마크다운으로. 머리말은 요약 마크다운과 같다 */
export function renderExtensionMarkdown(ext: Extension, transcript: Transcript): string {
  const cite = mdCiter(transcript);
  const out = mdHeader(transcript);
  out.push(`> 리포트: ${mdInline(ext.title)}`, '');
  const time = mdTimer(transcript);
  for (const b of ext.blocks) out.push(...blockMarkdown(b, { cite, time }));
  return finish(out);
}

/** 마크다운 표 칸에서 세로줄과 줄바꿈이 표를 깨지 않게 한다 */
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ');

function tableMd(num: string, caption: string, rows: string[][]): string[] {
  const [head, ...body] = rows;
  if (!head) return [];
  return [
    `**표 ${num}** ${caption.replace(/^Table\s*\d+\s*[:.]\s*/i, '')}`,
    '',
    `| ${head.map(cell).join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ];
}

function mdCiter(transcript: Transcript): (c: Cite) => string {
  const { meta, segments } = transcript;
  const long = meta.durationSec >= 3600;
  const at = (i: number) => segments[i]?.startSec ?? 0;
  // 글 자료는 시각이 없어 문단 번호와 쪽을 적는다
  if (isTextKind(meta.source)) {
    return (c) => {
      const label = unitLabel(transcript, c.key);
      return label.startsWith('p.') ? ` [¶${c.key + 1}, ${label}]` : ` [${label}]`;
    };
  }
  return (c) => {
    const url = watchUrlAt(meta, at(c.key));
    return url ? ` [[${c.key + 1}]](${url})` : ` [${c.key + 1} ${formatTime(at(c.key), long)}]`;
  };
}

function mdTimer({ meta, segments }: Transcript): (c: Cite) => string {
  const long = meta.durationSec >= 3600;
  return (c) => {
    const sec = segments[c.key]?.startSec ?? 0;
    const url = watchUrlAt(meta, sec);
    return url ? `[${formatTime(sec, long)}](${url})` : formatTime(sec, long);
  };
}

function mdHeader({ meta }: Transcript): string[] {
  const long = meta.durationSec >= 3600;
  const out = [`# ${meta.title}`, ''];
  const facts = [
    meta.channel,
    meta.publishedAt,
    isTextKind(meta.source) ? null : formatTime(meta.durationSec, long),
    CAPTION_LABEL[meta.captionSource],
  ].filter(Boolean);
  out.push(`> ${facts.join(' | ')}`);
  if (meta.source !== 'file' && meta.url && /^https?:/.test(meta.url)) out.push(`> ${meta.url}`);
  out.push('');
  return out;
}

const finish = (out: string[]) =>
  `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
