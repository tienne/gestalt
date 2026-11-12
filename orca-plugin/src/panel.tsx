import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Code,
  CodeView,
  Collapsible,
  EmptyState,
  Grid,
  Heading,
  IconButton,
  Input,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  Skeleton,
  Stack,
  Text,
  Tree,
  type PanelContext,
  type TreeItem
} from 'orca'
import { buildHierarchy, hasNesting, type HierarchyNode } from './hierarchy'
import {
  countByStatus,
  groupOrders,
  isTerminal,
  ms,
  splitRepo,
  STATUS_LABEL,
  STATUS_TONE,
  summarize,
  type RepoSummary,
  type Tone
} from './model'
import {
  type Bypass,
  type ConductorView,
  type GateDecision,
  type GateResolveResult,
  type GateView,
  type OrderView
} from './protocol'

const view = atom<ConductorView | null>(null)
const loadError = atom<string | null>(null)
/** 첫 누름이 고른 결정. 두 번째 누름이 있어야 워커로 보낸다 */
const pending = atom<{ gateId: string; decision: GateDecision } | null>(null)
const busy = atom<string | null>(null)
const answers = atom<Record<string, string>>({})
const lastResult = atom<GateResolveResult | null>(null)
const openError = atom<string | null>(null)
/** null이면 레포 지도, 값이 있으면 그 레포의 상세 */
const selectedRepo = atom<string | null>(null)

const RESOLVE_TIMEOUT_MS = 120_000

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

const DECISION_LABEL: Record<GateDecision, string> = { approve: '승인', reject: '거절' }

async function load(name: 'conductor.status' | 'conductor.refresh'): Promise<void> {
  try {
    set(view, await plugin.request(name))
    set(loadError, null)
  } catch (e) {
    set(loadError, errorText(e))
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('conductor.changed', (next) => {
      set(view, next)
      set(loadError, null)
    })
  )
  void load('conductor.status')
}

function choose(gateId: string, decision: GateDecision): void {
  set(lastResult, null)
  set(pending, { gateId, decision })
}

async function confirm(gate: GateView, decision: GateDecision): Promise<void> {
  const answer = read(answers)[gate.id]?.trim()
  set(busy, gate.id)
  try {
    const result = await plugin.request(
      'gate.resolve',
      { gateId: gate.id, decision, ...(answer ? { answer } : {}) },
      { timeoutMs: RESOLVE_TIMEOUT_MS }
    )
    set(lastResult, result)
  } catch (e) {
    set(lastResult, {
      ok: false,
      gateId: gate.id,
      decision,
      hostActions: [],
      errors: [],
      error: errorText(e)
    })
  } finally {
    set(busy, null)
    set(pending, null)
  }
}

async function openWorker(orderId: string): Promise<void> {
  set(openError, null)
  try {
    const out = await plugin.request('worker.open', { orderId })
    if (!out.opened) set(openError, out.error ?? '워크트리를 못 열었어요')
  } catch (e) {
    set(openError, errorText(e))
  }
}

function GateCard({ gate }: { gate: GateView }) {
  const p = read(pending)
  const inFlight = read(busy) === gate.id
  const asking = p?.gateId === gate.id ? p.decision : null
  const opened = ms(gate.openedAt)
  return (
    <Box border="warning" radius="md" padding="sm" key={gate.id}>
      <Stack gap="xs">
        <Row gap="xs" wrap>
          <Badge tone="warning">{gate.type}</Badge>
          <Text size="xs" muted>
            {gate.orderId ?? '주문 없음'}
          </Text>
          {opened !== null ? <RelativeTime at={opened} muted /> : null}
        </Row>
        <Text>{gate.reason}</Text>
        {gate.type === 'interview' ? (
          <Input
            label="답"
            placeholder="인터뷰 답을 적어 주세요"
            value={read(answers)[gate.id] ?? ''}
            onChange={(v) => set(answers, { ...read(answers), [gate.id]: v })}
            disabled={inFlight}
          />
        ) : null}
        {asking ? (
          <Callout tone={asking === 'approve' ? 'warning' : 'danger'} title={`정말 ${DECISION_LABEL[asking]}할까요?`}>
            <Stack gap="xs">
              <Text size="xs">
                {gate.id}를 {DECISION_LABEL[asking]}하면 컨덕터가 바로 워커에 전해요. 되돌릴 수 없어요.
              </Text>
              <Row gap="xs">
                <Button
                  tone={asking === 'approve' ? 'accent' : 'danger'}
                  disabled={inFlight}
                  onPress={() => confirm(gate, asking)}
                >
                  {inFlight ? '보내는 중' : `${DECISION_LABEL[asking]} 확정`}
                </Button>
                <Button variant="ghost" disabled={inFlight} onPress={() => set(pending, null)}>
                  취소
                </Button>
              </Row>
            </Stack>
          </Callout>
        ) : (
          <Row gap="xs">
            <Button size="sm" icon="check" disabled={read(busy) !== null} onPress={() => choose(gate.id, 'approve')}>
              승인
            </Button>
            <Button
              size="sm"
              variant="outline"
              tone="danger"
              icon="close"
              disabled={read(busy) !== null}
              onPress={() => choose(gate.id, 'reject')}
            >
              거절
            </Button>
          </Row>
        )}
      </Stack>
    </Box>
  )
}

function ResultCallout({ result }: { result: GateResolveResult }) {
  const label = `${result.gateId} ${DECISION_LABEL[result.decision]}`
  return (
    <Stack gap="xs">
      {result.ok ? (
        <Callout tone="success" title={`${label} 완료`} icon="check" />
      ) : (
        <Callout tone="danger" title={`${label} 실패`} icon="error">
          <Text size="xs">{result.error ?? '이유를 못 받았어요'}</Text>
        </Callout>
      )}
      {result.errors.length > 0 ? (
        <Callout tone="danger" title="컨덕터가 남긴 오류">
          <Stack gap="xs">
            {result.errors.map((e) => (
              <Text size="xs">{e}</Text>
            ))}
          </Stack>
        </Callout>
      ) : null}
      {result.hostActions.length > 0 ? (
        <Callout tone="accent" title="컨덕터 세션에서 처리할 일" icon="info">
          <Stack gap="xs">
            <Text size="xs" muted>
              플러그인은 실행하지 않아요. 컨덕터 세션이 다음 tick에 처리해요.
            </Text>
            <CodeView code={JSON.stringify(result.hostActions, null, 2)} language="json" label="hostActions" wrap />
          </Stack>
        </Callout>
      ) : null}
      <Button size="xs" variant="ghost" onPress={() => set(lastResult, null)}>
        닫기
      </Button>
    </Stack>
  )
}

function OrderRow({ order }: { order: OrderView }) {
  const at = ms(order.updatedAt)
  return (
    <Box key={order.id} border radius="sm" padding="sm">
      <Stack gap="xs">
        <Row justify="between" align="start">
          <Text weight="medium">{order.title || '(제목 없음)'}</Text>
          {order.workspaceId ? (
            <IconButton
              icon="open-external"
              label="워크트리 열기"
              tooltip="워커의 오르카 워크트리 열기"
              size="xs"
              variant="ghost"
              onPress={() => openWorker(order.id)}
            />
          ) : null}
        </Row>
        <Row gap="xs" wrap>
          <Code>{order.id}</Code>
          <Badge>{order.scope}</Badge>
        </Row>
        <Row gap="xs" wrap>
          {order.pr ? <Text size="xs">PR {order.pr}</Text> : null}
          {order.issue ? <Text size="xs">이슈 {order.issue}</Text> : null}
          {at !== null ? <RelativeTime at={at} muted /> : null}
        </Row>
      </Stack>
    </Box>
  )
}

function BypassList({ items }: { items: readonly Bypass[] }) {
  return (
    <Stack gap="xs">
      {items.map((b) => {
        const at = ms(b.at)
        return (
          <Row gap="xs" wrap>
            <Badge>{b.need}</Badge>
            <Text size="xs">{b.action}</Text>
            {at !== null ? <RelativeTime at={at} muted /> : null}
          </Row>
        )
      })}
    </Stack>
  )
}

function Bypasses({ title, orders, unassigned = [] }: { title: string; orders: readonly OrderView[]; unassigned?: readonly Bypass[] }) {
  const perOrder = orders.filter((o) => o.bypasses.length > 0)
  const total = perOrder.reduce((n, o) => n + o.bypasses.length, 0) + unassigned.length
  if (total === 0) return null
  return (
    <Collapsible title={`${title} ${total}건`} defaultOpen={false}>
      <Stack gap="sm">
        {perOrder.map((o) => (
          <Stack gap="xs" key={o.id}>
            <Text size="xs" weight="medium">
              {o.id} {o.title}
            </Text>
            <BypassList items={o.bypasses} />
          </Stack>
        ))}
        {unassigned.length > 0 ? <BypassList items={unassigned} /> : null}
      </Stack>
    </Collapsible>
  )
}

function RepoTile({ s }: { s: RepoSummary }) {
  const { name, owner } = splitRepo(s.repo)
  const border: boolean | Tone = s.needsPerson > 0 ? 'warning' : s.active > 0 ? 'accent' : true
  return (
    <Box key={s.repo} border={border} radius="md" padding="sm" background={s.active > 0 || s.gates.length > 0 ? 'card' : 'muted'}>
      <Stack gap="xs">
        <Button variant="ghost" size="sm" tooltip={`${s.repo} 자세히 보기`} onPress={() => set(selectedRepo, s.repo)}>
          {name}
        </Button>
        {owner ? (
          <Text size="xs" muted truncate>
            {owner}
          </Text>
        ) : null}
        <Row gap="xs" wrap>
          {s.gates.length > 0 ? <Badge tone="warning">{`확인 대기 ${s.gates.length}`}</Badge> : null}
          {s.nested > 0 ? <Badge>{`하위 ${s.nested}`}</Badge> : null}
          {countByStatus(s.orders)
            // 게이트 배지와 waiting-gate 상태 배지가 둘 다 "확인 대기"라 겹치면 하나만 남긴다
            .filter(([status]) => !(status === 'waiting-gate' && s.gates.length > 0))
            .map(([status, n]) => (
            <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{`${STATUS_LABEL[status] ?? status} ${n}`}</Badge>
          ))}
        </Row>
      </Stack>
    </Box>
  )
}

function RepoMap({ v }: { v: ConductorView }) {
  const { repos, orphanGates } = summarize(v)
  const active = v.orders.filter((o) => !isTerminal(o.status)).length
  return (
    <Stack gap="md">
      <Row gap="xs" wrap>
        <Badge tone={v.gates.length > 0 ? 'warning' : 'neutral'}>{`확인 대기 ${v.gates.length}`}</Badge>
        <Badge tone="accent">{`진행 중 주문 ${active}`}</Badge>
        <Text size="xs" muted>
          {`레포 ${repos.length}곳`}
        </Text>
      </Row>
      {orphanGates.length > 0 ? (
        <Stack gap="sm">
          <Heading level={3}>주문 없는 확인 대기</Heading>
          {orphanGates.map((g) => (
            <GateCard gate={g} />
          ))}
        </Stack>
      ) : null}
      {repos.length === 0 ? (
        <EmptyState icon="layers" title="받은 주문이 없어요" description="컨덕터가 주문을 받으면 레포마다 여기에 칸이 생겨요." />
      ) : (
        <Grid minItemWidth="sm" gap="sm">
          {repos.map((s) => (
            <RepoTile s={s} />
          ))}
        </Grid>
      )}
      <Bypasses title="주문 없는 bypass" orders={[]} unassigned={v.unassignedBypasses} />
    </Stack>
  )
}

function treeItems(nodes: readonly HierarchyNode[]): TreeItem[] {
  return nodes.map((n): TreeItem => {
    const children = n.children.length > 0 ? { children: treeItems(n.children) } : {}
    if (n.kind === 'worktree')
      return {
        key: n.key,
        label: n.label,
        description: n.branch ? `부모 워크트리, ${n.branch}` : '부모 워크트리',
        icon: 'folder',
        ...children
      }
    const o = n.order
    return {
      key: n.key,
      label: o.title || o.id,
      description: `${STATUS_LABEL[o.status] ?? o.status}, ${o.id}${o.branch ? `, ${o.branch}` : ''}`,
      icon: o.workspaceId ? 'branch' : 'layers',
      ...children
    }
  })
}

function allKeys(nodes: readonly HierarchyNode[]): string[] {
  return nodes.flatMap((n) => (n.children.length > 0 ? [n.key, ...allKeys(n.children)] : []))
}

function Hierarchy({ orders }: { orders: readonly OrderView[] }) {
  const roots = buildHierarchy(orders)
  if (!hasNesting(roots)) return null
  const opener = new Map(orders.filter((o) => o.workspaceId).map((o) => [`order:${o.id}`, o.id]))
  return (
    <Stack gap="xs">
      <Heading level={3}>위계</Heading>
      <Text size="xs" muted>
        하위 주문은 상위 주문 밑에, 하위 워크트리는 부모 워크트리 밑에 그려요. Enter로 워크트리를 열어요.
      </Text>
      <Tree
        label="주문 위계"
        items={treeItems(roots)}
        defaultExpanded={allKeys(roots)}
        maxHeight="md"
        onAction={(item) => {
          const id = opener.get(item.key)
          if (id) void openWorker(id)
        }}
      />
    </Stack>
  )
}

function RepoDetail({ s }: { s: RepoSummary }) {
  const { name, owner } = splitRepo(s.repo)
  return (
    <Stack gap="md">
      <Stack gap="xs">
        <Row>
          <Button variant="ghost" size="xs" onPress={() => set(selectedRepo, null)}>
            ← 지도
          </Button>
        </Row>
        <Heading level={3}>{name}</Heading>
        {owner ? (
          <Text size="xs" muted>
            {owner}
          </Text>
        ) : null}
      </Stack>
      {s.gates.length > 0 ? (
        <Stack gap="sm">
          <Row gap="xs">
            <Heading level={3}>확인 대기</Heading>
            <Badge tone="warning">{s.gates.length}</Badge>
          </Row>
          {s.gates.map((g) => (
            <GateCard gate={g} />
          ))}
        </Stack>
      ) : null}
      <Hierarchy orders={s.orders} />
      {groupOrders(s.orders).map(([status, orders]) => (
        <Collapsible
          key={status}
          title={`${STATUS_LABEL[status] ?? status} ${orders.length}`}
          defaultOpen={!isTerminal(status)}
        >
          <Stack gap="xs">
            {orders.map((o) => (
              <OrderRow order={o} />
            ))}
          </Stack>
        </Collapsible>
      ))}
      <Bypasses title="bypass 사후 보고" orders={s.orders} />
    </Stack>
  )
}

function Header({ v }: { v: ConductorView | null }) {
  const tick = ms(v?.lastTickAt)
  return (
    <Row justify="between">
      <Row gap="xs">
        <Heading level={2}>컨덕터</Heading>
        {tick !== null ? (
          <Text size="xs" muted>
            tick <RelativeTime at={tick} muted />
          </Text>
        ) : null}
      </Row>
      <IconButton icon="refresh" label="새로고침" variant="ghost" size="sm" onPress={() => load('conductor.refresh')} />
    </Row>
  )
}

export default function Panel() {
  const v = read(view)
  const err = read(loadError)
  const result = read(lastResult)
  const openErr = read(openError)
  if (!v)
    return (
      <Stack gap="md">
        <Header v={null} />
        {err ? <Callout tone="danger" title="워커에 못 닿았어요">{err}</Callout> : <Skeleton lines={4} label="불러오는 중" />}
      </Stack>
    )
  if (v.state === 'missing')
    return (
      <Stack gap="md">
        <Header v={v} />
        <EmptyState
          icon="database"
          title="컨덕터 저장소 없음"
          description={`${v.stateDir ?? '상태 폴더'}에 events.jsonl이 아직 없어요. 컨덕터가 첫 주문을 받으면 여기에 보여요.`}
        />
      </Stack>
    )
  const picked = read(selectedRepo)
  // 고른 레포의 주문이 다 사라졌으면 지도로 돌아간다
  const detail = picked === null ? undefined : summarize(v).repos.find((s) => s.repo === picked)
  return (
    <Stack gap="md">
      <Header v={v} />
      {v.state === 'error' ? (
        <Callout tone="danger" title="gestalt CLI가 실패했어요" icon="error">
          <Text size="xs">{v.error ?? ''}</Text>
        </Callout>
      ) : null}
      {err ? <Callout tone="danger" title="워커에 못 닿았어요">{err}</Callout> : null}
      {openErr ? (
        <Callout tone="warning" title="워크트리를 못 열었어요">
          {openErr}
        </Callout>
      ) : null}
      {result ? <ResultCallout result={result} /> : null}
      {/* 지도와 상세가 같은 자리에 그려져서 key로 나누지 않으면 지도에서 펼친 상태가 상세로 넘어간다 */}
      {detail ? <RepoDetail key={`repo:${detail.repo}`} s={detail} /> : <RepoMap key="map" v={v} />}
    </Stack>
  )
}
