import { findExistingSpec } from '../../spec/repository.js';
import type { IEventStore } from '../../events/store.js';
import type { InterviewEngine } from '../../interview/engine.js';
import type { SpecGenerator } from '../../spec/generator.js';
import type { SpecInput } from '../schemas.js';
import { resolveInterviewSessionId } from '../session-selector.js';

export async function handleSpec(
  engine: InterviewEngine,
  generator: SpecGenerator,
  rawInput: SpecInput,
  store?: IEventStore,
): Promise<string> {
  if (rawInput.specId && store) {
    const spec = findExistingSpec(store, { specId: rawInput.specId });
    return JSON.stringify(
      spec
        ? { status: 'existing', spec }
        : { error: '저장된 Spec을 찾지 못했어요. 보관한 Spec JSON을 사용해 주세요' },
    );
  }
  const resolved = resolveInterviewSessionId(engine, rawInput.sessionId);
  if (!resolved.ok) return JSON.stringify({ error: resolved.error }, null, 2);
  const input: SpecInput = { ...rawInput, sessionId: resolved.sessionId };

  try {
    if (!input.sessionId) return JSON.stringify({ error: 'sessionId is required' }, null, 2);
    const session = engine.getSession(input.sessionId);
    if (input.reuse && store) {
      if (session.status !== 'completed')
        return JSON.stringify({ error: '완료된 인터뷰만 사용할 수 있어요' });
      const existing = findExistingSpec(store, { sessionId: session.sessionId });
      if (existing) return JSON.stringify({ status: 'existing', spec: existing });
    }
    const result = await generator.generate(session, input.force);

    if (!result.ok) {
      return JSON.stringify({ error: result.error.message }, null, 2);
    }

    return JSON.stringify(
      {
        status: 'generated',
        spec: result.value,
      },
      null,
      2,
    );
  } catch (e) {
    return JSON.stringify(
      {
        error: e instanceof Error ? e.message : String(e),
      },
      null,
      2,
    );
  }
}
