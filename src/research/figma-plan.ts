import {
  ADOPTION_LABEL,
  AXIS_LABEL,
  buildFlowTables,
  buildSummaryTables,
  gridFindings,
  BASIS_LABEL,
  CAPTURE_KIND_LABEL,
  CAPTURE_STATE_LABEL,
  CONFIDENCE_LABEL,
  EVIDENCE_LABEL,
  FINDING_KIND_LABEL,
  OWNER_LABEL,
  PATTERN_LABEL,
  PII_LABEL,
  ROW_KIND_LABEL,
  SOURCE_LABEL,
  buildVideoTables,
  evidenceGroupLabel,
  hasVideoSection,
  VIEWPOINT_LABEL,
  videoSectionTitle,
} from './render-html.js';
import type { EvidenceRef } from './evidence.js';
import type { Research } from './schema.js';
import type { ResearchAudience } from './store.js';

export type TextStyle = 'title' | 'h2' | 'h3' | 'body' | 'caption' | 'notice';

export type PlanNode =
  | { type: 'text'; style: TextStyle; text: string }
  | { type: 'table'; head: string[]; rows: string[][] }
  | { type: 'images'; items: { imageId: string; caption: string }[] }
  | { type: 'section'; title: string; children: PlanNode[] };

export interface FigmaPlan {
  version: 1;
  pageName: string;
  width: number;
  nodes: PlanNode[];
  /** 스크립트가 이미지 fill로 붙일 캡처. data는 계획에 싣지 않는다 */
  images: { id: string; path: string }[];
}

export type FigmaPlanResult =
  | { ok: true; plan: FigmaPlan }
  | { ok: false; code: 'SHARE_BLOCKED'; message: string; captureIds: string[] };

const PAGE_WIDTH = 1440;

const bullets = (items: string[]): string =>
  items.length === 0 ? '-' : items.map((i) => `• ${i}`).join('\n');

export function buildFigmaPlan(
  research: Research,
  opts: { audience: ResearchAudience },
): FigmaPlanResult {
  const shared = opts.audience === 'shared';
  const unchecked = research.captures.filter((c) => c.pii === 'unchecked');
  if (shared && unchecked.length > 0) {
    return {
      ok: false,
      code: 'SHARE_BLOCKED',
      captureIds: unchecked.map((c) => c.id),
      message: `개인정보를 확인하지 않은 캡처가 ${unchecked.length}개 있어 공유용 Figma 계획을 만들지 않는다. redact_image로 치환하거나 화면을 확인해 pii 상태를 정한 뒤 다시 만든다`,
    };
  }

  const productName = new Map(research.productCandidates.map((p) => [p.id, p.name]));
  const refById = new Map(research.references.map((r) => [r.id, r]));
  const screenById = new Map(research.screenMap.map((s) => [s.id, s]));
  const refLabel = (id: string): string => {
    const r = refById.get(id);
    return r ? `${r.symbol}. ${r.typeName}` : id;
  };
  const evidenceText = (list: EvidenceRef[]): string =>
    list.some((ev) => ev.type === 'url')
      ? `${evidenceGroupLabel(research, list, shared)}(링크)`
      : evidenceGroupLabel(research, list, shared);
  const text = (style: TextStyle, value: string): PlanNode => ({
    type: 'text',
    style,
    text: value,
  });

  const nodes: PlanNode[] = [text('title', research.meta.title), text('body', research.meta.task)];
  if (!research.plan.confirmedAt) {
    nodes.push(
      text(
        'notice',
        '리서치 구성(제품 후보와 화면 지도)을 아직 확인받지 않았습니다. 확인 전의 결과입니다.',
      ),
    );
  }
  if (!shared && research.plan.note) nodes.push(text('caption', research.plan.note));

  const pr = research.premise;
  const section = (title: string, children: PlanNode[]): PlanNode => ({
    type: 'section',
    title,
    children,
  });

  const summaryTables = buildSummaryTables(research);
  if (summaryTables.length > 0) {
    nodes.push(
      section('종합', [
        text(
          'caption',
          '아래 표는 비교표의 기호와 판단 순위와 발견에서 모은 것이다. 새 주장은 없다.',
        ),
        ...summaryTables.flatMap((t): PlanNode[] => [
          text('h3', t.heading),
          { type: 'table', head: t.head, rows: t.rows },
        ]),
      ]),
    );
  }

  nodes.push(
    section('0. 전제', [
      {
        type: 'table',
        head: ['항목', '내용'],
        rows: [
          ['목표 지표', pr.goalMetric],
          ['규모 가정', pr.scaleAssumption ?? '없음'],
          ['구조 제약', bullets(pr.structureConstraints)],
          ['아직 안 온 입력', bullets(pr.pendingInputs)],
          ['근거의 한계', bullets(pr.evidenceLimits)],
          ['기호 범례', pr.symbolLegend],
        ],
      },
    ]),
  );

  const s1: PlanNode[] = [];
  if (research.references.length > 0) {
    s1.push({
      type: 'table',
      head: ['유형', '제품', '고른 이유'],
      rows: research.references.map((r) => [
        `${r.symbol}. ${r.typeName}`,
        r.productIds.map((id) => productName.get(id) ?? id).join(', '),
        r.reason,
      ]),
    });
  }
  if (research.productCandidates.length > 0) {
    s1.push(text('h3', '제품 후보'));
    s1.push({
      type: 'table',
      head: ['제품', '축', '이유', '규모'],
      rows: research.productCandidates.map((p) => [
        p.name,
        AXIS_LABEL[p.axis],
        p.reason,
        p.scale
          ? `${p.scale.value}\n(${EVIDENCE_LABEL[p.scale.evidence]}) ${p.scale.source}`
          : '확인 못함',
      ]),
    });
  }
  if (research.screenMap.length > 0) {
    s1.push(text('h3', '화면 지도'));
    s1.push({
      type: 'table',
      head: ['제품', '화면', '들어가는 길', '출처', '상태'],
      rows: research.screenMap.map((s) => [
        productName.get(s.productId) ?? s.productId,
        s.screen,
        s.entryPath.join(' > '),
        SOURCE_LABEL[s.source],
        CAPTURE_STATE_LABEL[s.capture],
      ]),
    });
  }
  const images: FigmaPlan['images'] = [];
  if (research.captures.length > 0) {
    s1.push(text('h3', '캡처'));
    const byProduct = new Map<string, typeof research.captures>();
    for (const c of research.captures) {
      byProduct.set(c.productId, [...(byProduct.get(c.productId) ?? []), c]);
    }
    for (const [productId, caps] of byProduct) {
      s1.push(text('body', productName.get(productId) ?? productId));
      s1.push({
        type: 'images',
        items: caps.map((c) => {
          const screen = c.screenMapId ? screenById.get(c.screenMapId)?.screen : undefined;
          const first = c.label ?? screen ?? c.id;
          images.push({ id: c.id, path: c.path });
          const lines = [
            first,
            ...(c.caption ? [c.caption] : []),
            ...(c.frameNo ? [`프레임 ${c.frameNo}`] : []),
            CAPTURE_KIND_LABEL[c.kind],
            PII_LABEL[c.pii],
            ...(c.sourceNote ? [c.sourceNote] : []),
          ];
          return { imageId: c.id, caption: lines.join('\n') };
        }),
      });
    }
  }
  nodes.push(section('1. 레퍼런스 선정', s1));

  // 영상 분석 문서는 2~8번을 쓰지 않는다. 아래 구간을 만든 뒤 버린다
  const standalone = research.meta.kind === 'video-analysis';
  const bodyStart = nodes.length;
  nodes.push(
    section(
      '2. 시안',
      research.mockups.length === 0
        ? [text('caption', '시안이 없는 조사라 3번 비교표의 열은 시안 대신 레퍼런스 화면이다.')]
        : [
            {
              type: 'table',
              head: ['레퍼런스', '시안', '메모'],
              rows: research.mockups.map((m) => [
                refLabel(m.referenceId),
                m.url ?? '',
                m.note ?? '',
              ]),
            },
          ],
    ),
  );

  if (research.adoptions.length > 0) {
    const findingText = new Map(research.wowPain.findings.map((f) => [f.id, f.text]));
    const named = (ids: string[]): string => bullets(ids.map((id) => findingText.get(id) ?? id));
    const adoptionSection = nodes[nodes.length - 1];
    if (adoptionSection?.type === 'section') {
      adoptionSection.children.push(text('h3', '시안이 가져온 것과 푼 것'));
      adoptionSection.children.push({
        type: 'table',
        head: ['시안', '레퍼런스', '판단', '가져온 것', '덜어낸 것', '가져오는 와우', '푸는 페인'],
        rows: research.adoptions.map((a) => [
          a.variant,
          a.referenceIds.map(refLabel).join(', '),
          a.reason ? `${ADOPTION_LABEL[a.status]}\n${a.reason}` : ADOPTION_LABEL[a.status],
          bullets(a.adopted),
          bullets(a.mitigated),
          named(a.takesFindingIds),
          named(a.solvesFindingIds),
        ]),
      });
    }
  }

  const refs = research.references;
  nodes.push(
    section(
      '3. 비교표',
      research.comparison.length === 0
        ? [text('caption', '비교표가 없습니다.')]
        : [
            {
              type: 'table',
              head: ['단계', '기준', ...refs.map((r) => `${r.symbol}. ${r.typeName}`)],
              rows: research.comparison.map((row) => [
                row.phase,
                [
                  row.kind === 'graded'
                    ? row.criterion
                    : `[${ROW_KIND_LABEL[row.kind]}] ${row.criterion}`,
                  ...(row.pattern ? [`(${PATTERN_LABEL[row.pattern]})`] : []),
                  ...(row.definition ? [row.definition] : []),
                ].join('\n'),
                ...refs.map((r) => {
                  const cell = row.cells.find((c) => c.referenceId === r.id);
                  if (!cell) return '-';
                  const tag =
                    cell.basis && cell.basis !== 'observation'
                      ? `[${BASIS_LABEL[cell.basis]}] `
                      : '';
                  const body = `${cell.symbol ? `${cell.symbol} ` : ''}${cell.text}${evidenceText(cell.evidence)}`;
                  const grey = cell.basis === 'unconfirmed' || cell.basis === 'absent';
                  const found = gridFindings(research, r.id, row.criterion).map(
                    (f) => `\n[${FINDING_KIND_LABEL[f.kind]}] ${f.text}`,
                  );
                  return `${tag}${body}${grey && cell.note ? `\n${cell.note}` : ''}${found.join('')}`;
                }),
              ]),
            },
          ],
    ),
  );

  const s4: PlanNode[] = [];
  if (research.wowPain.userViewpoint)
    s4.push(text('body', `사용자 관점: ${research.wowPain.userViewpoint}`));
  if (research.wowPain.bizViewpoint)
    s4.push(text('body', `비즈니스 관점: ${research.wowPain.bizViewpoint}`));
  for (const ref of research.references) {
    const items = research.wowPain.items.filter((w) => w.referenceId === ref.id);
    const found = research.wowPain.findings.filter((f) => f.referenceId === ref.id);
    if (items.length === 0 && found.length === 0) continue;
    s4.push(text('h3', refLabel(ref.id)));
    for (const w of items) {
      s4.push({
        type: 'table',
        head: ['', '와우 포인트', '페인 포인트'],
        rows: [
          ['사용자 관점', bullets(w.userWow), bullets(w.userPain)],
          ['비즈니스 관점', bullets(w.bizWow), bullets(w.bizPain)],
        ],
      });
    }
    if (found.length > 0) {
      s4.push({
        type: 'table',
        head: ['구분', '발견', '구좌나 단계', '조작과 수치'],
        rows: found.map((f) => {
          const tag = f.basis !== 'observation' ? `[${BASIS_LABEL[f.basis]}] ` : '';
          const grey = f.basis === 'unconfirmed' || f.basis === 'absent';
          const screen = f.screenMapId ? screenById.get(f.screenMapId)?.screen : undefined;
          return [
            `${FINDING_KIND_LABEL[f.kind]}\n${VIEWPOINT_LABEL[f.viewpoint]}`,
            `${tag}${f.text}${evidenceText(f.evidence)}${grey && f.note ? `\n${f.note}` : ''}`,
            [f.slot, screen].filter(Boolean).join(' / '),
            f.concrete ?? '',
          ];
        }),
      });
    }
  }
  nodes.push(section('4. 와우 포인트와 페인 포인트', s4));

  const s5: PlanNode[] = [];
  for (const r of research.reasons) {
    s5.push(text('h3', refLabel(r.referenceId)));
    s5.push({
      type: 'table',
      head: ['항목', '내용'],
      rows: [
        ['비즈니스', r.business],
        ['화면', r.screens],
        ['우리와 다른 점', r.difference],
        ['가져올 것', bullets(r.take)],
        ['가져오지 않을 것', bullets(r.skip)],
      ],
    });
  }
  for (const t of buildFlowTables(research, shared)) {
    s5.push(text('h3', t.heading));
    s5.push({ type: 'table', head: t.head, rows: t.rows });
  }
  nodes.push(section('5. 레퍼런스가 그렇게 한 이유', s5));

  nodes.push(
    section('6. 판단 (해석)', [
      {
        type: 'table',
        head: ['영역', '결론', '확신', '근거'],
        rows: research.judgment.map((j) => [
          j.rank ? `${j.area}\n우선순위 ${j.rank}` : j.area,
          j.todo ? `${j.conclusion}\n할 일: ${j.todo}` : j.conclusion,
          j.confidence === 'hold' && j.holdUntil
            ? `${CONFIDENCE_LABEL[j.confidence]} (${j.holdUntil} 결정)`
            : CONFIDENCE_LABEL[j.confidence],
          `${j.rationale}${evidenceText(j.evidence)}`,
        ]),
      },
    ]),
  );

  nodes.push(
    section('7. 검증 제안', [
      {
        type: 'table',
        head: ['가설', '볼 지표', '나눠 볼 조건', '주의'],
        rows: research.verification.map((v) => [v.hypothesis, v.metric, v.splitBy, v.caveat ?? '']),
      },
    ]),
  );

  const oq = research.openQuestions;
  nodes.push(
    section(
      '8. 열린 질문',
      oq && oq.items.length > 0
        ? [
            text('body', oq.recipient),
            text('body', oq.intro),
            {
              type: 'table',
              head: oq.items.some((q) => q.owner)
                ? ['질문', '임시로 둔 가정', '영향', '확인 주체']
                : ['질문', '임시로 둔 가정', '영향'],
              rows: oq.items.map((q) => {
                const base = [q.question, q.temporary, q.affects];
                if (!oq.items.some((x) => x.owner)) return base;
                const owner = q.owner ? OWNER_LABEL[q.owner] : '';
                return [...base, q.ownerNote ? `${owner}\n${q.ownerNote}` : owner];
              }),
            },
          ]
        : [text('caption', '열린 질문이 없습니다.')],
    ),
  );

  if (standalone) nodes.length = bodyStart;

  if (hasVideoSection(research)) {
    const tables = buildVideoTables(research);
    const children: PlanNode[] = [];
    for (const t of tables) {
      children.push(text('h3', t.heading));
      children.push({ type: 'table', head: t.head, rows: t.rows });
    }
    if (tables.length === 0) children.push(text('caption', '영상 분석이 없습니다.'));
    nodes.push(section(videoSectionTitle(research), children));
  }

  return {
    ok: true,
    plan: { version: 1, pageName: research.meta.title, width: PAGE_WIDTH, nodes, images },
  };
}
