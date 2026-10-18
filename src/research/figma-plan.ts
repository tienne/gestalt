import {
  ADOPTION_LABEL,
  ANNOTATION_LABEL,
  axisText,
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
import { metricCasesByProduct, type Research } from './schema.js';
import type { ResearchAudience } from './store.js';
import { targetView, type TargetCell } from './target-view.js';

export type TextStyle = 'title' | 'h2' | 'h3' | 'body' | 'caption' | 'notice';

/** 구획 배경색. 판단은 초록, 검증은 파랑, 와우와 페인은 주황이라 한눈에 갈린다 */
export type SectionTint = 'green' | 'blue' | 'orange';

export type PlanNode =
  | { type: 'text'; style: TextStyle; text: string }
  | { type: 'table'; head: string[]; rows: string[][] }
  | { type: 'images'; items: { imageId: string; caption: string }[] }
  | { type: 'section'; title: string; tint?: SectionTint; children: PlanNode[] };

export interface RefNote {
  kind: keyof typeof ANNOTATION_LABEL;
  label: string;
  text: string;
}

/** 화면 캡처 열의 한 덩어리. 제품 하나의 캡처 줄과 그 옆에 붙는 와우와 페인 메모 */
export interface RefGroup {
  title: string;
  description?: string;
  images: { imageId: string; caption: string }[];
  notes: RefNote[];
}

export type BoardColumnKind = 'captures' | 'conclusion' | 'evidence';

/** board 배치에서 열이 어떤 구획을 어떤 순서로 담는지. sections는 plan.nodes의 구획 제목이다 */
export interface FigmaBoard {
  columns: { kind: BoardColumnKind; title: string; sections: string[] }[];
  groups: RefGroup[];
}

export type FigmaLayout = 'board' | 'page';

export interface FigmaPlan {
  version: 1;
  pageName: string;
  width: number;
  layout: FigmaLayout;
  nodes: PlanNode[];
  /** layout이 board일 때만 있다. 캡처는 nodes가 아니라 board.groups에 담는다 */
  board?: FigmaBoard;
  /** 스크립트가 이미지 fill로 붙일 캡처. data는 계획에 싣지 않는다 */
  images: { id: string; path: string }[];
}

export type FigmaPlanResult =
  | { ok: true; plan: FigmaPlan }
  | { ok: false; code: 'SHARE_BLOCKED'; message: string; captureIds: string[] };

const PAGE_WIDTH = 1440;

const bullets = (items: string[]): string =>
  items.length === 0 ? '-' : items.map((i) => `• ${i}`).join('\n');

/**
 * 열마다 담는 구획과 순서. 세 열의 높이가 비슷하도록 나눴다. 캡처 열에는 캡처 묶음만 있다.
 * 시안과 와우 페인은 판단 가까이에 두고 레퍼런스 선정은 전제와 함께 근거 열에 둔다
 */
const CONCLUSION_ORDER = ['종합', '6', '2', '4', '7', '8'];
const EVIDENCE_ORDER = ['0', '1', '3', '5'];
const TINT_BY_KEY: Record<string, SectionTint> = { '6': 'green', '7': 'blue', '4': 'orange' };

const sectionKey = (title: string): string => /^(\d+)\./.exec(title)?.[1] ?? title;

export function buildFigmaPlan(
  research: Research,
  opts: { audience: ResearchAudience; layout?: FigmaLayout },
): FigmaPlanResult {
  const layout = opts.layout ?? 'board';
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

  const tv = targetView(research, shared);
  const targetCell = (c: TargetCell): string => {
    const tag = c.basis && c.basis !== 'observation' ? `[${BASIS_LABEL[c.basis]}] ` : '';
    const ev = c.evidence ? evidenceText(c.evidence) : '';
    return [`${tag}${c.text}${ev}`, c.note, c.sub].filter(Boolean).join('\n');
  };
  const targetNodes: PlanNode[] = tv
    ? [
        text('h3', '목표치 근거'),
        {
          type: 'table',
          head: ['항목', '내용'],
          rows: tv.rows.map(([k, c]) => [k, targetCell(c)]),
        },
        ...(tv.steps.length > 0
          ? [
              {
                type: 'table',
                head: ['단계', '값', '어디서 온 숫자'],
                rows: tv.steps.map((x) => [x.label, targetCell(x.value), x.method]),
              } satisfies PlanNode,
            ]
          : []),
        ...(tv.coverage ? [text('body', tv.coverage)] : []),
        ...(tv.shortfall ? [text('body', tv.shortfall)] : []),
        ...(tv.power.length > 0
          ? [
              {
                type: 'table',
                head: ['가설', '기대 효과', '군당 표본', '걸리는 일수', '기대 효과 근거'],
                rows: tv.power.map((row) => [...row.cells, targetCell(row.liftBasis)]),
              } satisfies PlanNode,
            ]
          : []),
      ]
    : [];
  nodes.push(
    section('0. 전제', [
      {
        type: 'table',
        head: ['항목', '내용'],
        rows: [
          ['목표 지표', pr.goalMetric],
          ...(pr.attachTo
            ? [
                [
                  '붙는 흐름',
                  [`${pr.attachTo.flow} (${pr.attachTo.domain})`, pr.attachTo.note]
                    .filter(Boolean)
                    .join('\n'),
                ],
              ]
            : []),
          ['규모 가정', pr.scaleAssumption ?? '없음'],
          ['구조 제약', bullets(pr.structureConstraints)],
          ['아직 안 온 입력', bullets(pr.pendingInputs)],
          ['근거의 한계', bullets(pr.evidenceLimits)],
          ['기호 범례', pr.symbolLegend],
        ],
      },
      ...targetNodes,
    ]),
  );

  const s1: PlanNode[] = [];
  const casesByProduct = metricCasesByProduct(research);
  const caseLines = (productIds: string[]): string =>
    productIds
      .flatMap((id) => casesByProduct.get(id) ?? [])
      .map((m) => `${m.metric} ${m.value}`)
      .join('\n');
  if (research.references.length > 0) {
    const withCases = research.references.some((r) =>
      r.productIds.some((id) => casesByProduct.has(id)),
    );
    s1.push({
      type: 'table',
      head: ['유형', '제품', '고른 이유', ...(withCases ? ['지표 사례'] : [])],
      rows: research.references.map((r) => [
        `${r.symbol}. ${r.typeName}`,
        r.productIds.map((id) => productName.get(id) ?? id).join(', '),
        r.reason,
        ...(withCases ? [caseLines(r.productIds)] : []),
      ]),
    });
  }
  if (research.productCandidates.length > 0) {
    s1.push(text('h3', '제품 후보'));
    s1.push({
      type: 'table',
      head: ['제품', '축', '이유', '규모', ...(casesByProduct.size > 0 ? ['지표 사례'] : [])],
      rows: research.productCandidates.map((p) => [
        p.name,
        axisText(p),
        p.reason,
        p.scale
          ? `${p.scale.value}\n(${EVIDENCE_LABEL[p.scale.evidence]}) ${p.scale.source}`
          : '확인 못함',
        ...(casesByProduct.size > 0 ? [caseLines([p.id])] : []),
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
  const groups: RefGroup[] = [];
  if (research.captures.length > 0) {
    const byProduct = new Map<string, typeof research.captures>();
    for (const c of research.captures) {
      byProduct.set(c.productId, [...(byProduct.get(c.productId) ?? []), c]);
    }
    const captureItems = (caps: typeof research.captures) =>
      caps.map((c) => {
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
      });
    if (layout === 'page') {
      s1.push(text('h3', '캡처'));
      for (const [productId, caps] of byProduct) {
        s1.push(text('body', productName.get(productId) ?? productId));
        s1.push({ type: 'images', items: captureItems(caps) });
      }
    } else {
      for (const [productId, caps] of byProduct) {
        const ref = research.references.find((r) => r.productIds.includes(productId));
        const name = productName.get(productId) ?? productId;
        const capIds = new Set(caps.map((c) => c.id));
        const linked = research.wowPain.findings.filter((f) => {
          if (f.screenMapId) return screenById.get(f.screenMapId)?.productId === productId;
          return f.captureId !== undefined && capIds.has(f.captureId);
        });
        const note = (kind: RefNote['kind'], body: string): RefNote => ({
          kind,
          label: ANNOTATION_LABEL[kind],
          text: body,
        });
        const notes: RefNote[] = linked.map((f) => {
          const screen = f.screenMapId ? screenById.get(f.screenMapId)?.screen : undefined;
          const body = `${screen ? `${screen}: ` : ''}${f.text}${f.concrete ? ` (${f.concrete})` : ''}`;
          return note(f.kind, body);
        });
        if (notes.length === 0 && ref) {
          for (const w of research.wowPain.items.filter((x) => x.referenceId === ref.id)) {
            for (const t of [...w.userWow, ...w.bizWow]) notes.push(note('wow', t));
            for (const t of [...w.userPain, ...w.bizPain]) notes.push(note('pain', t));
          }
        }
        groups.push({
          title: ref ? `${ref.symbol}. ${name}` : name,
          description: ref ? ref.typeName : undefined,
          images: captureItems(caps),
          notes,
        });
      }
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
      const hasPlacement = research.adoptions.some((a) => a.placement?.trim());
      adoptionSection.children.push(text('h3', '시안이 가져온 것과 푼 것'));
      adoptionSection.children.push({
        type: 'table',
        head: [
          '시안',
          ...(hasPlacement ? ['자리'] : []),
          '레퍼런스',
          '판단',
          '가져온 것',
          '덜어낸 것',
          '가져오는 와우',
          '푸는 페인',
        ],
        rows: research.adoptions.map((a) => [
          a.variant,
          ...(hasPlacement ? [a.placement ?? ''] : []),
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
            `${tag}${f.text}${evidenceText(f.evidence)}${grey && f.note ? `\n${f.note}` : ''}${f.excludedReason ? `\n이번 시안에서 뺌: ${f.excludedReason}` : ''}`,
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

  const hasDesign = research.verification.some((v) => v.sample || v.period || v.successCriteria);
  const caseById = new Map(research.metricCases.map((m) => [m.id, m]));
  const caseTable: PlanNode[] =
    research.metricCases.length > 0
      ? [
          text('body', '타사 지표 사례'),
          {
            type: 'table',
            head: ['회사', '지표', '분모', '값', '바꾼 것', '시점'],
            rows: research.metricCases.map((m) => {
              const tag = m.basis !== 'observation' ? `[${BASIS_LABEL[m.basis]}] ` : '';
              const grey = m.basis === 'unconfirmed' || m.basis === 'absent';
              return [
                m.company,
                m.metric,
                m.denominator ?? '',
                `${tag}${m.value}${evidenceText(m.evidence)}${grey && m.note ? `\n${m.note}` : ''}`,
                m.change ?? '',
                m.period ?? '',
              ];
            }),
          },
        ]
      : [];
  const hasCases = research.verification.some((v) => v.metricCaseIds.length > 0);
  const hasLift = research.verification.some(
    (v) => v.expectedLiftPp !== undefined || v.events.length > 0,
  );
  const trackingNodes: PlanNode[] =
    tv && tv.tracking.length > 0
      ? [
          text('h3', '심어야 할 이벤트'),
          { type: 'table', head: ['이벤트', '단계', '상태', '메모'], rows: tv.tracking },
        ]
      : [];
  nodes.push(
    section('7. 검증 제안', [
      ...caseTable,
      {
        type: 'table',
        head: [
          '가설',
          '볼 지표',
          '나눠 볼 조건',
          ...(hasDesign ? ['표본', '기간', '성공 기준'] : []),
          ...(hasCases ? ['근거 사례'] : []),
          ...(hasLift ? ['기대 효과', '볼 이벤트'] : []),
          '주의',
        ],
        rows: research.verification.map((v) => [
          v.hypothesis,
          v.metric,
          v.splitBy,
          ...(hasDesign ? [v.sample ?? '', v.period ?? '', v.successCriteria ?? ''] : []),
          ...(hasCases
            ? [
                v.metricCaseIds
                  .map((id) => caseById.get(id))
                  .filter((m): m is NonNullable<typeof m> => Boolean(m))
                  .map((m) => `${m.company} ${m.metric} ${m.value}`)
                  .join('\n'),
              ]
            : []),
          ...(hasLift
            ? [v.expectedLiftPp !== undefined ? `+${v.expectedLiftPp}%p` : '', v.events.join('\n')]
            : []),
          v.caveat ?? '',
        ]),
      },
      ...trackingNodes,
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

  if (layout === 'page') {
    return {
      ok: true,
      plan: { version: 1, pageName: research.meta.title, width: PAGE_WIDTH, layout, nodes, images },
    };
  }

  const sections = nodes.filter((n) => n.type === 'section');
  for (const n of sections) {
    const tint = TINT_BY_KEY[sectionKey(n.title)];
    if (tint) n.tint = tint;
  }
  const titles = sections.map((n) => n.title);
  const ordered = (keys: string[]): string[] =>
    keys.flatMap((k) => titles.filter((t) => sectionKey(t) === k));
  const hasCaptureColumn = groups.length > 0;
  const conclusion = ordered(CONCLUSION_ORDER);
  const placed = new Set([...conclusion, ...ordered(EVIDENCE_ORDER)]);
  const evidence = [...ordered(EVIDENCE_ORDER), ...titles.filter((t) => !placed.has(t))];
  const columns: FigmaBoard['columns'] = [
    ...(hasCaptureColumn ? [{ kind: 'captures' as const, title: '화면 캡처', sections: [] }] : []),
    { kind: 'conclusion', title: '결론과 다음 할 일', sections: conclusion },
    { kind: 'evidence', title: '근거 (전제, 비교, 이유)', sections: evidence },
  ];
  return {
    ok: true,
    plan: {
      version: 1,
      pageName: research.meta.title,
      width: PAGE_WIDTH,
      layout,
      nodes,
      board: { columns, groups },
      images,
    },
  };
}
