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
  type PanelContext
} from 'orca'
import {
  ORDER_STATUSES,
  TERMINAL_ORDER_STATUSES,
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

const RESOLVE_TIMEOUT_MS = 120_000

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const ms = (iso?: string | null) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isNaN(t) ? null : t
}

const STATUS_LABEL: Record<string, string> = {
  queued: '대기',
  running: '진행',
  'waiting-gate': '확인 대기',
  merged: '머지됨',
  done: '끝남',
  failed: '실패',
  escalated: '사람 결정 필요',
  cancelled: '취소'
}

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
          <Text size="xs" muted>
            {order.repo}
          </Text>
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

function groupOrders(orders: readonly OrderView[]): [string, OrderView[]][] {
  const known: readonly string[] = ORDER_STATUSES
  const groups = new Map<string, OrderView[]>()
  for (const o of orders) groups.set(o.status, [...(groups.get(o.status) ?? []), o])
  // 모르는 status도 버리지 않고 뒤에 붙인다. CLI가 앞서 나가도 주문이 사라져 보이지 않게
  const order = [...known, ...[...groups.keys()].filter((s) => !known.includes(s))]
  return order.filter((s) => groups.has(s)).map((s) => [s, groups.get(s)!])
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

function Bypasses({ v }: { v: ConductorView }) {
  const perOrder = v.orders.filter((o) => o.bypasses.length > 0)
  const total = perOrder.reduce((n, o) => n + o.bypasses.length, 0) + v.unassignedBypasses.length
  if (total === 0) return null
  return (
    <Collapsible title={`bypass 사후 보고 ${total}건`} defaultOpen={false}>
      <Stack gap="sm">
        {perOrder.map((o) => (
          <Stack gap="xs" key={o.id}>
            <Text size="xs" weight="medium">
              {o.id} {o.title}
            </Text>
            <BypassList items={o.bypasses} />
          </Stack>
        ))}
        {v.unassignedBypasses.length > 0 ? (
          <Stack gap="xs">
            <Text size="xs" weight="medium">
              주문 없음
            </Text>
            <BypassList items={v.unassignedBypasses} />
          </Stack>
        ) : null}
      </Stack>
    </Collapsible>
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
  const active = v.orders.filter((o) => !TERMINAL_ORDER_STATUSES.includes(o.status))
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
      <Stack gap="sm">
        <Row gap="xs">
          <Heading level={3}>확인 대기</Heading>
          <Badge tone={v.gates.length > 0 ? 'warning' : 'neutral'}>{v.gates.length}</Badge>
        </Row>
        {v.gates.length === 0 ? (
          <Text size="xs" muted>
            사람 확인을 기다리는 게이트가 없어요.
          </Text>
        ) : (
          v.gates.map((g) => <GateCard gate={g} />)
        )}
      </Stack>
      <Stack gap="sm">
        <Row gap="xs">
          <Heading level={3}>주문</Heading>
          <Badge tone="accent">{active.length}</Badge>
        </Row>
        {v.orders.length === 0 ? (
          <Text size="xs" muted>
            받은 주문이 없어요.
          </Text>
        ) : (
          groupOrders(v.orders).map(([status, orders]) => (
            <Collapsible
              key={status}
              title={`${STATUS_LABEL[status] ?? status} ${orders.length}`}
              description={status}
              defaultOpen={!TERMINAL_ORDER_STATUSES.includes(status)}
            >
              <Stack gap="xs">
                {orders.map((o) => (
                  <OrderRow order={o} />
                ))}
              </Stack>
            </Collapsible>
          ))
        )}
      </Stack>
      <Bypasses v={v} />
    </Stack>
  )
}
