import { z } from 'zod';
import type { DigestIssue } from './lint.js';
import { citeSchema, idSchema, textSchema } from './schema-base.js';

/**
 * 단계형 그림이 같이 쓰는 단계 모델. 요소 목록은 위젯에 한 번 적고 단계에는 그 위의 변화만 적는다.
 * 렌더러가 단계마다 그림을 미리 그려 두고 뷰어는 보일 단계만 바꾼다. 단계 사이를 보간하지 않는다
 */

const stateKey = z.string().min(1).max(30);

export const stepSchema = z.object({
  label: z.string().min(1).max(60),
  note: textSchema.optional(),
  /** 이 단계가 옮긴 원문 문단. D 그림은 단계마다 단다 */
  cite: citeSchema.optional(),
  /** 이 단계에서 처음 보이는 요소. 어느 단계의 show에도 없는 요소는 처음부터 보인다 */
  show: z.array(idSchema).max(40).optional(),
  /** 이 단계에서 점선으로 그리고 다음 단계부터 숨길 요소 */
  gone: z.array(idSchema).max(40).optional(),
  focus: z.array(idSchema).max(40).optional(),
  /** 그림 옆 상태 칸. 키 목록은 첫 단계가 정한다 */
  state: z
    .array(z.object({ key: stateKey, value: z.string().min(1).max(60) }))
    .max(6)
    .optional(),
});

export const stepsSchema = z.array(stepSchema).min(2).max(16);

export type Step = z.infer<typeof stepSchema>;

export type ElementLook = 'hidden' | 'shown' | 'gone' | 'focus';

export interface StepFrame {
  /** 요소 id마다 이 단계에서의 모습 */
  looks: Map<string, ElementLook>;
  /** 첫 단계 키 순서대로 맞춘 상태 칸. 이 단계에 없는 키는 바로 앞 단계 값을 이어 쓴다 */
  state: Array<{ key: string; value: string }>;
}

/**
 * 단계마다 요소가 어떻게 보이는지 미리 푼다. 렌더러와 마크다운이 같은 결과를 본다.
 * gone은 그 단계에서 점선으로 남고 다음 단계부터 사라진다
 */
export function stepFrames(elementIds: readonly string[], steps: readonly Step[]): StepFrame[] {
  const shownLater = new Set(steps.flatMap((s) => s.show ?? []));
  const visible = new Set(elementIds.filter((id) => !shownLater.has(id)));
  const removed = new Set<string>();
  const keys = (steps[0]?.state ?? []).map((s) => s.key);
  let carried = new Map<string, string>();
  return steps.map((s) => {
    for (const id of s.show ?? []) if (!removed.has(id)) visible.add(id);
    const gone = new Set(s.gone ?? []);
    const focus = new Set(s.focus ?? []);
    const looks = new Map<string, ElementLook>();
    for (const id of elementIds) {
      if (!visible.has(id)) looks.set(id, 'hidden');
      else if (gone.has(id)) looks.set(id, 'gone');
      else if (focus.has(id)) looks.set(id, 'focus');
      else looks.set(id, 'shown');
    }
    for (const id of gone) {
      visible.delete(id);
      removed.add(id);
    }
    const next = new Map(carried);
    for (const kv of s.state ?? []) if (keys.includes(kv.key)) next.set(kv.key, kv.value);
    carried = next;
    return {
      looks,
      state: keys.filter((k) => next.has(k)).map((k) => ({ key: k, value: next.get(k)! })),
    };
  });
}

/** 단계가 가리키는 id와 상태 키를 본다. 위젯 lint가 요소 id 목록을 넘긴다 */
export function lintSteps(
  steps: readonly Step[],
  elementIds: readonly string[],
  sp: string,
  issues: DigestIssue[],
): void {
  const err = (path: string, code: string, message: string) =>
    issues.push({ path, severity: 'error', code, message });
  const ids = new Set(elementIds);
  const keys = new Set((steps[0]?.state ?? []).map((s) => s.key));
  const goneAt = new Map<string, number>();
  steps.forEach((s, k) => {
    for (const field of ['show', 'gone', 'focus'] as const) {
      (s[field] ?? []).forEach((id, j) => {
        if (!ids.has(id)) {
          err(`${sp}.${k}.${field}.${j}`, 'STEP_REF_UNKNOWN', `${id}가 이 그림의 요소에 없다`);
        }
      });
    }
    (s.show ?? []).forEach((id, j) => {
      const at = goneAt.get(id);
      if (at !== undefined) {
        err(
          `${sp}.${k}.show.${j}`,
          'STEP_REVIVES_GONE',
          `${id}는 ${at}번째 단계에서 숨겼다. 다시 보이려면 새 id로 요소를 하나 더 둔다`,
        );
      }
    });
    for (const id of s.gone ?? []) if (!goneAt.has(id)) goneAt.set(id, k + 1);
    if (k === 0) return;
    (s.state ?? []).forEach((kv, j) => {
      if (!keys.has(kv.key)) {
        err(
          `${sp}.${k}.state.${j}.key`,
          'STEP_STATE_KEY_UNKNOWN',
          `상태 키 "${kv.key}"가 첫 단계에 없다. 키는 첫 단계에 다 적고 뒤 단계는 값만 바꾼다`,
        );
      }
    });
  });
}
