import { textUnits } from './layout.js';
import type {
  ArchitectureProjection,
  ProjectionBlock,
  ProjectionMessage,
  SequenceBlockKind,
} from './types.js';

// 순서도의 다른 두 보기(단계별 카드, 따라가기) 좌표. 순서도처럼 열과 줄이 곧 의미라 elkjs를 안 쓴다

/** 렌더러가 쓰는 구간 하나. messageIds는 그린 메시지만 담고 participants는 순서도 머리 순서를 따른다 */
export interface SequencePhase {
  id: string;
  label: string;
  /** IR에 phases가 없어 렌더할 때 자른 구간이면 true */
  auto: boolean;
  messageIds: string[];
  participants: string[];
}

type PhaseMessage = Pick<ProjectionMessage, 'id' | 'from' | 'to' | 'reply' | 'block'>;

/**
 * 맨 위 참여자가 지금 구간에서 아직 안 만난 대상을 부르는 자리에서 새 구간을 연다.
 * 자기 호출, 응답, 이미 만난 대상 호출은 지금 구간에 붙는다. 묶음 한가운데에서는 자르지 않는다.
 * 구간 이름은 그 구간을 연 메시지가 부른 대상의 이름이다
 */
export function autoSequencePhases(
  messages: readonly PhaseMessage[],
  root: string | undefined,
  nameOf: (id: string) => string,
): { label: string; messageIds: string[] }[] {
  const out: { label: string; messageIds: string[]; seen: Set<string> }[] = [];
  messages.forEach((m, i) => {
    const cur = out[out.length - 1];
    const prev = i > 0 ? messages[i - 1] : undefined;
    const opens =
      !cur ||
      (m.from === root &&
        m.to !== root &&
        !m.reply &&
        !cur.seen.has(m.to) &&
        !(m.block !== undefined && m.block === prev?.block));
    if (opens) out.push({ label: nameOf(m.to), messageIds: [], seen: new Set() });
    const ph = out[out.length - 1]!;
    ph.messageIds.push(m.id);
    ph.seen.add(m.from);
    ph.seen.add(m.to);
  });
  return out.map(({ label, messageIds }) => ({ label, messageIds }));
}

/**
 * IR의 phases를 그린 메시지에 맞춰 푼다. 근거가 없어 안 그린 메시지는 빼고 빈 구간은 버린다.
 * phases가 없거나 그린 메시지를 다 덮지 못하면 자동으로 자른다. order는 순서도 머리 순서이고 맨 앞이 자동 분할의 기준이다
 */
export function resolveSequencePhases(
  projection: Pick<ArchitectureProjection, 'messages' | 'phases'>,
  drawn: ReadonlySet<string>,
  order: readonly string[],
  nameOf: (id: string) => string,
): SequencePhase[] {
  const messages = projection.messages.filter((m) => drawn.has(m.id));
  const byId = new Map(messages.map((m) => [m.id, m]));
  const participantsOf = (ids: readonly string[]): string[] => {
    const used = new Set(ids.flatMap((id) => [byId.get(id)!.from, byId.get(id)!.to]));
    return order.filter((id) => used.has(id));
  };
  if (projection.phases !== undefined) {
    const index = new Map(projection.messages.map((m, i) => [m.id, i]));
    const phases: SequencePhase[] = [];
    for (const ph of projection.phases) {
      const from = index.get(ph.from);
      const to = index.get(ph.to);
      if (from === undefined || to === undefined) continue;
      const ids = projection.messages
        .slice(from, to + 1)
        .map((m) => m.id)
        .filter((id) => byId.has(id));
      if (ids.length === 0) continue;
      phases.push({
        id: ph.id,
        label: ph.label,
        auto: false,
        messageIds: ids,
        participants: participantsOf(ids),
      });
    }
    const covered = phases.flatMap((ph) => ph.messageIds);
    if (covered.length === messages.length && covered.every((id, i) => id === messages[i]!.id)) {
      return phases;
    }
  }
  return autoSequencePhases(messages, order[0], nameOf).map((ph, i) => ({
    id: `auto-${i + 1}`,
    label: ph.label,
    auto: true,
    messageIds: ph.messageIds,
    participants: participantsOf(ph.messageIds),
  }));
}

/**
 * 맨 위 참여자에서 몇 번 건너 불리는지. 가장 짧은 경로로 세고 응답과 자기 호출은 세지 않는다.
 * 맨 위에서 못 닿는 참여자는 0이다
 */
export function sequenceCallDepths(
  messages: readonly PhaseMessage[],
  root: string | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  const next = new Map<string, string[]>();
  for (const m of messages) {
    for (const id of [m.from, m.to]) if (!next.has(id)) next.set(id, []);
    if (m.reply || m.from === m.to) continue;
    next.get(m.from)!.push(m.to);
  }
  if (root !== undefined && next.has(root)) {
    out.set(root, 0);
    const queue = [root];
    for (let i = 0; i < queue.length; i++) {
      const at = queue[i]!;
      for (const to of next.get(at)!) {
        if (out.has(to)) continue;
        out.set(to, out.get(at)! + 1);
        queue.push(to);
      }
    }
  }
  for (const id of next.keys()) if (!out.has(id)) out.set(id, 0);
  return out;
}

export interface WalkBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WalkStep {
  messageId: string;
  /** 번호. 그린 메시지만 1부터 센다 */
  n: number;
  phaseId: string;
  from: string;
  to: string;
  d: string;
  self: boolean;
}

export interface WalkLayout {
  width: number;
  height: number;
  /** 구간 이름 자리. 새 참여자를 들이지 않는 구간은 띠가 없다 */
  bands: { phaseId: string; label: string; x: number; y: number }[];
  nodes: WalkBox[];
  /** 메시지가 가리킨 지도 엣지. 같은 엣지는 한 번만 긋는다 */
  edges: { id: string; d: string }[];
  steps: WalkStep[];
}

const WALK_TOP = 22;
const WALK_PAD = 24;
const WALK_COL_GAP = 48;
const WALK_ROW_GAP = 16;
const WALK_BAND_GAP = 34;
const WALK_BAND_LABEL = 8;
const WALK_LOOP = 44;

/**
 * 따라가기 지도 좌표. 열은 호출 깊이이고 띠는 그 참여자가 처음 나온 구간이다.
 * 열 폭은 그 열에서 가장 넓은 카드 폭을 따른다. 좌표는 (0, 0)에서 시작한다.
 * 단계 번호는 numberOf로 순서도 번호를 그대로 받는다. 단계 목록과 같은 번호여야 목록을 눌러 그 단계로 간다
 * 양끝이 지도에 없는 메시지는 단계에서 빠지는데, 그러면 번호가 끊겨 클라이언트가 그 뒤 단계로 못 간다.
 * 렌더러는 그린 메시지에서 참여자를 뽑아 넘기므로 빠지는 메시지가 없다
 */
export function computeWalkLayout(
  phases: readonly SequencePhase[],
  messages: readonly Pick<ProjectionMessage, 'id' | 'from' | 'to' | 'edge'>[],
  depths: ReadonlyMap<string, number>,
  sizeOf: (id: string) => { width: number; height: number },
  edgeById: ReadonlyMap<string, { from: string; to: string }>,
  numberOf: (messageId: string) => number,
): WalkLayout {
  const placed = new Map<string, { col: number; band: number; row: number }>();
  const bandCols: Map<number, string[]>[] = [];
  const bandPhase: SequencePhase[] = [];
  for (const ph of phases) {
    const cols = new Map<number, string[]>();
    for (const id of ph.participants) {
      if (placed.has(id)) continue;
      const col = depths.get(id) ?? 0;
      if (!cols.has(col)) cols.set(col, []);
      const list = cols.get(col)!;
      placed.set(id, { col, band: bandCols.length, row: list.length });
      list.push(id);
    }
    if (cols.size === 0) continue;
    bandCols.push(cols);
    bandPhase.push(ph);
  }
  const usedCols = [...new Set([...placed.values()].map((p) => p.col))].sort((a, b) => a - b);
  const colWidth = new Map(usedCols.map((c) => [c, 0]));
  for (const [id, p] of placed) {
    colWidth.set(p.col, Math.max(colWidth.get(p.col)!, sizeOf(id).width));
  }
  const colX = new Map<number, number>();
  let x = WALK_PAD;
  for (const c of usedCols) {
    colX.set(c, x);
    x += colWidth.get(c)! + WALK_COL_GAP;
  }

  const boxes = new Map<string, WalkBox>();
  const bands: WalkLayout['bands'] = [];
  let y = WALK_TOP;
  bandCols.forEach((cols, band) => {
    let h = 0;
    for (const [col, list] of [...cols.entries()].sort((a, b) => a[0] - b[0])) {
      let at = y;
      for (const id of list) {
        const s = sizeOf(id);
        boxes.set(id, {
          id,
          x: round2(colX.get(col)!),
          y: round2(at),
          width: s.width,
          height: s.height,
        });
        at += s.height + WALK_ROW_GAP;
      }
      h = Math.max(h, at - WALK_ROW_GAP - y);
    }
    const ph = bandPhase[band]!;
    bands.push({ phaseId: ph.id, label: ph.label, x: WALK_PAD, y: round2(y - WALK_BAND_LABEL) });
    y += h + WALK_BAND_GAP;
  });

  const pathOf = (a: string, b: string): string => walkPath(boxes.get(a)!, boxes.get(b)!);
  const edges: WalkLayout['edges'] = [];
  const seenEdges = new Set<string>();
  for (const m of messages) {
    if (m.edge === undefined || seenEdges.has(m.edge)) continue;
    const e = edgeById.get(m.edge);
    if (!e || !boxes.has(e.from) || !boxes.has(e.to)) continue;
    seenEdges.add(m.edge);
    edges.push({ id: m.edge, d: pathOf(e.from, e.to) });
  }
  const phaseOf = new Map(phases.flatMap((ph) => ph.messageIds.map((id) => [id, ph.id])));
  const steps: WalkStep[] = messages
    .filter((m) => boxes.has(m.from) && boxes.has(m.to))
    .map((m) => ({
      messageId: m.id,
      n: numberOf(m.id),
      phaseId: phaseOf.get(m.id) ?? '',
      from: m.from,
      to: m.to,
      d: pathOf(m.from, m.to),
      self: m.from === m.to,
    }));
  const right = Math.max(WALK_PAD, ...[...boxes.values()].map((b) => b.x + b.width));
  return {
    width: round2(right + WALK_LOOP),
    height: round2(bandCols.length > 0 ? y - WALK_BAND_GAP + WALK_PAD : WALK_TOP + WALK_PAD),
    bands,
    nodes: [...boxes.values()],
    edges,
    steps,
  };
}

/** 두 카드를 잇는 선. 자기 호출은 오른쪽 위 고리, 같은 열은 오른쪽으로 불룩한 곡선, 나머지는 마주 보는 변을 잇는다 */
export function walkPath(a: WalkBox, b: WalkBox): string {
  const p = (x: number, y: number): string => `${round2(x)} ${round2(y)}`;
  if (a.id === b.id) {
    const r = a.x + a.width;
    const mid = a.y + a.height / 2;
    return `M${p(r - 30, a.y)}C${p(r - 30, a.y - 34)} ${p(r + 40, mid)} ${p(r, mid)}`;
  }
  const y1 = a.y + a.height / 2;
  const y2 = b.y + b.height / 2;
  if (a.x === b.x) {
    const ra = a.x + a.width;
    const rb = b.x + b.width;
    return `M${p(ra, y1)}C${p(ra + 40, y1)} ${p(rb + 40, y2)} ${p(rb, y2)}`;
  }
  const forward = a.x < b.x;
  const x1 = forward ? a.x + a.width : a.x;
  const x2 = forward ? b.x : b.x + b.width;
  const mx = (x1 + x2) / 2;
  return `M${p(x1, y1)}C${p(mx, y1)} ${p(mx, y2)} ${p(x2, y2)}`;
}

/** 단계별 카드 머리의 둘째 줄 */
export function phaseMetaText(phase: Pick<SequencePhase, 'messageIds' | 'participants'>): string {
  return `메시지 ${phase.messageIds.length}개, 참여자 ${phase.participants.length}명`;
}

export interface PhaseCardMessage {
  id: string;
  n: number;
  y: number;
  x1: number;
  x2: number;
  self: boolean;
  /** 번호를 뺀 라벨이 쓸 수 있는 글자 폭. textUnits 단위다 */
  labelUnits: number;
}

export interface PhaseCardBlock {
  id: string;
  kind: SequenceBlockKind;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  branches: { y: number; label: string }[];
}

export interface PhaseCardLayout {
  phaseId: string;
  /** 1부터 센 구간 번호 */
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 카드 안 작은 순서도. 좌표는 그 svg 기준이다 */
  svg: {
    x: number;
    y: number;
    width: number;
    height: number;
    heads: { id: string; x: number; y: number; width: number; height: number; cx: number }[];
    lifeline: { y1: number; y2: number };
    messages: PhaseCardMessage[];
    blocks: PhaseCardBlock[];
  };
}

export interface PhaseBoardLayout {
  width: number;
  height: number;
  cards: PhaseCardLayout[];
  /** 카드 사이 화살표의 가운데 자리 */
  arrows: { x: number; y: number }[];
}

const MINI_COL = 136;
const MINI_HEAD = 40;
const MINI_FIRST = 14;
const MINI_ROW = 26;
const MINI_BLOCK_HEAD = 18;
const MINI_BRANCH = 14;
const MINI_BLOCK_TAIL = 6;
const MINI_BOTTOM = 10;
const MINI_SELF_LABEL = 120;
const MINI_LABEL_UNIT = 6;
const CARD_PAD_X = 14;
const CARD_HEAD = 58;
const CARD_PAD_BOTTOM = 12;
const CARD_TITLE_UNIT = 8;
const CARD_META_UNIT = 6.5;
const CARD_TITLE_MAX = 360;
const BOARD_ARROW = 36;
const BOARD_ROW_GAP = 28;

/** 카드 한 장 안의 작은 순서도. 그 구간에 나오는 참여자만 열로 세운다 */
function miniSequence(
  phase: SequencePhase,
  messageById: ReadonlyMap<string, ProjectionMessage>,
  blockById: ReadonlyMap<string, ProjectionBlock>,
  numberOf: (id: string) => number,
): PhaseCardLayout['svg'] {
  const col = new Map(phase.participants.map((id, i) => [id, i]));
  const cx = (id: string): number => col.get(id)! * MINI_COL + MINI_COL / 2;
  const messages = phase.messageIds.map((id) => messageById.get(id)!);
  let width = phase.participants.length * MINI_COL;
  for (const m of messages) {
    if (m.from === m.to) width = Math.max(width, cx(m.from) + 24 + MINI_SELF_LABEL);
  }
  const out: PhaseCardMessage[] = [];
  const blocks: PhaseCardBlock[] = [];
  let y = MINI_HEAD + MINI_FIRST;
  let open: PhaseCardBlock | undefined;
  let openBranch: string | undefined;
  const close = (): void => {
    if (!open) return;
    y += MINI_BLOCK_TAIL;
    open.height = round2(y - open.y);
    blocks.push(open);
    open = undefined;
    y += 4;
  };
  for (const m of messages) {
    if (open && open.id !== m.block) close();
    const b = m.block !== undefined ? blockById.get(m.block) : undefined;
    if (!open && b) {
      open = { id: b.id, kind: b.kind, label: b.label, x: 4, y, width: 0, height: 0, branches: [] };
      openBranch = m.branch;
      y += MINI_BLOCK_HEAD;
    } else if (open && m.branch !== openBranch) {
      y += MINI_BRANCH / 2;
      open.branches.push({ y: round2(y), label: m.branch ?? '' });
      y += MINI_BRANCH / 2;
      openBranch = m.branch;
    }
    y += MINI_ROW / 2;
    const self = m.from === m.to;
    const x1 = cx(m.from);
    const x2 = cx(m.to);
    const n = numberOf(m.id);
    const room = self ? MINI_SELF_LABEL : Math.abs(x2 - x1) - 12;
    out.push({
      id: m.id,
      n,
      y: round2(y),
      x1,
      x2,
      self,
      labelUnits: Math.max(0, Math.floor(room / MINI_LABEL_UNIT) - textUnits(`${n}. `)),
    });
    y += MINI_ROW / 2;
  }
  close();
  const height = round2(y + MINI_BOTTOM);
  return {
    x: CARD_PAD_X,
    y: CARD_HEAD,
    width: round2(width),
    height,
    heads: phase.participants.map((id, i) => ({
      id,
      x: i * MINI_COL + 6,
      y: 4,
      width: MINI_COL - 12,
      height: MINI_HEAD - 8,
      cx: cx(id),
    })),
    lifeline: { y1: MINI_HEAD, y2: height },
    messages: out,
    blocks: blocks.map((b) => ({ ...b, width: round2(width - 8) })),
  };
}

/**
 * 단계별 카드 보드. 카드를 왼쪽에서 오른쪽으로 놓고 rowMax를 넘으면 다음 줄로 내린다.
 * 가장 넓은 카드가 rowMax보다 넓으면 그 폭이 줄 폭이다. 줄을 넘긴 카드 앞에도 화살표를 둔다
 */
export function computePhaseBoard(
  phases: readonly SequencePhase[],
  projection: Pick<ArchitectureProjection, 'messages' | 'blocks'>,
  numberOf: (id: string) => number,
  rowMax = 1280,
): PhaseBoardLayout {
  const messageById = new Map(projection.messages.map((m) => [m.id, m]));
  const blockById = new Map((projection.blocks ?? []).map((b) => [b.id, b]));
  const sized = phases.map((ph, i) => {
    const svg = miniSequence(ph, messageById, blockById, numberOf);
    const title = Math.min(CARD_TITLE_MAX, textUnits(`${i + 1}. ${ph.label}`) * CARD_TITLE_UNIT);
    const meta = textUnits(phaseMetaText(ph)) * CARD_META_UNIT;
    return {
      ph,
      svg,
      width: round2(CARD_PAD_X * 2 + Math.max(svg.width, title, meta)),
      height: round2(CARD_HEAD + svg.height + CARD_PAD_BOTTOM),
    };
  });
  const limit = Math.max(rowMax, ...sized.map((s) => s.width));
  const rows: (typeof sized)[] = [];
  let used = 0;
  for (const s of sized) {
    const row = rows[rows.length - 1];
    if (row && used + BOARD_ARROW + s.width <= limit) {
      row.push(s);
      used += BOARD_ARROW + s.width;
    } else {
      rows.push([s]);
      used = (rows.length > 1 ? BOARD_ARROW : 0) + s.width;
    }
  }
  const cards: PhaseCardLayout[] = [];
  const arrows: PhaseBoardLayout['arrows'] = [];
  let y = 0;
  let right = 0;
  rows.forEach((row, r) => {
    const h = Math.max(...row.map((s) => s.height));
    let x = 0;
    row.forEach((s, i) => {
      if (r > 0 || i > 0) {
        arrows.push({ x: round2(x + BOARD_ARROW / 2), y: round2(y + h / 2) });
        x += BOARD_ARROW;
      }
      cards.push({
        phaseId: s.ph.id,
        index: cards.length + 1,
        x: round2(x),
        y: round2(y),
        width: s.width,
        height: s.height,
        svg: s.svg,
      });
      x += s.width;
    });
    right = Math.max(right, x);
    y += h + (r < rows.length - 1 ? BOARD_ROW_GAP : 0);
  });
  return { width: round2(right), height: round2(y), cards, arrows };
}

/** 글자 폭이 units를 넘으면 잘라 말줄임표를 붙인다. 폭은 textUnits로 잰다 */
export function clipText(text: string, units: number): string {
  if (textUnits(text) <= units) return text;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const w = textUnits(ch);
    if (used + w > units - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
