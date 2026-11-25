import type { Spec } from '../core/types.js';
import type { IEventStore } from '../events/store.js';
import { EventType } from '../events/types.js';
import { specSchema } from './schema.js';

export function findExistingSpec(
  store: IEventStore,
  selector: { specId: string } | { sessionId: string },
): Spec | undefined {
  const byId = new Map<string, Spec>();
  const collect = (payload: unknown) => {
    if (payload === null || typeof payload !== 'object' || !('spec' in payload)) return;
    const result = specSchema.safeParse(payload.spec);
    if (!result.success) return;
    const spec = result.data;
    if (
      'specId' in selector
        ? spec.metadata.specId === selector.specId
        : spec.metadata.interviewSessionId === selector.sessionId
    ) {
      byId.set(spec.metadata.specId, spec);
    }
  };
  const records =
    'specId' in selector
      ? store.getByAggregate('spec', selector.specId)
      : Array.from(store.getAllByAggregateType('spec').values()).flat();
  for (const event of records) {
    if (event.eventType === EventType.SPEC_GENERATED) collect(event.payload);
  }
  if (byId.size === 0) {
    // 구버전 Spec 이벤트는 요약만 남겼다. 공식 플래닝을 시작했다면 그 세션에 Spec이 있다.
    for (const events of store.getAllByAggregateType('execute').values()) {
      const start = events[0];
      if (start?.eventType === EventType.EXECUTE_SESSION_STARTED) collect(start.payload);
    }
  }
  if (byId.size > 1) throw new Error('이 인터뷰의 Spec이 여러 개예요. Spec ID를 골라 주세요');
  return byId.values().next().value;
}
