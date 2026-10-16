import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { PII_CORE_SOURCE } from './pii-core.js';

export interface PiiSpan {
  kind: string;
  start: number;
  end: number;
  replacement: string;
}

export interface PiiRedactor {
  detect(text: string, ctxKind?: string | null): PiiSpan[];
  redactText(text: string, ctxKind?: string | null): { text: string; spans: PiiSpan[] };
  labelKindOf(text: string): string | null;
  kindFromHints(hints: string): string | null;
  fakeDigits(value: string): string;
}

type CreatePii = (seed: string) => {
  detect(text: string, ctxKind?: string | null): PiiSpan[];
  redactText(text: string, ctxKind?: string | null): { text: string; spans: PiiSpan[] };
  labelKindOf(text: string): string | null;
  kindFromHints(hints: string): string | null;
  fakeDigits(value: string): string;
};

let factory: CreatePii | undefined;

function loadFactory(): CreatePii {
  factory ??= vm.runInNewContext(PII_CORE_SOURCE, {}, { timeout: 2000 }) as CreatePii;
  return factory;
}

function plainSpans(spans: PiiSpan[]): PiiSpan[] {
  return spans.map((s) => ({
    kind: s.kind,
    start: s.start,
    end: s.end,
    replacement: s.replacement,
  }));
}

/** 같은 seed면 같은 값에 같은 가명을 준다. 실제 값과 가명의 대응표는 만들지 않는다 */
export function createPiiRedactor(seed: string): PiiRedactor {
  const core = loadFactory()(seed);
  return {
    detect: (text, ctxKind) => plainSpans(core.detect(text, ctxKind ?? null)),
    redactText: (text, ctxKind) => {
      const r = core.redactText(text, ctxKind ?? null);
      return { text: r.text, spans: plainSpans(r.spans) };
    },
    labelKindOf: (text) => core.labelKindOf(text),
    kindFromHints: (hints) => core.kindFromHints(hints),
    fakeDigits: (value) => core.fakeDigits(value),
  };
}

/**
 * 리서치(slug)마다 프로세스 메모리에만 두는 seed.
 * 디스크에 쓰지 않으므로 서버가 재시작되면 같은 값도 다른 가명이 된다.
 */
const seeds = new Map<string, string>();

export function seedFor(slug: string): string {
  let seed = seeds.get(slug);
  if (!seed) {
    seed = randomUUID();
    seeds.set(slug, seed);
  }
  return seed;
}

export function redactorFor(slug: string): PiiRedactor {
  return createPiiRedactor(seedFor(slug));
}
