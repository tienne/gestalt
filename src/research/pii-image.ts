import { execFile } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import type { PiiRedactor } from './pii.js';

const execFileAsync = promisify(execFile);

export interface VisionBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrToken {
  start: number;
  end: number;
  box: VisionBox;
}

export interface OcrLine {
  text: string;
  box: VisionBox;
  confidence: number;
  tokens: OcrToken[];
}

export interface OcrResult {
  width: number;
  height: number;
  languages: string[];
  lines: OcrLine[];
  faces: VisionBox[];
  barcodes: { payload?: string | null; symbology: string; box: VisionBox }[];
}

export interface PaintItem {
  type: 'text' | 'avatar' | 'barcode';
  box: VisionBox;
  text?: string;
}

export interface RedactionPlan {
  items: PaintItem[];
  counts: { text: number; avatars: number; barcodes: number };
}

export type PiiState = 'replaced' | 'none' | 'unchecked';

export interface ImageRedactionResult {
  pii: PiiState;
  outputPath: string;
  counts: RedactionPlan['counts'];
  warnings: string[];
}

function union(boxes: VisionBox[]): VisionBox {
  const x1 = Math.min(...boxes.map((b) => b.x));
  const y1 = Math.min(...boxes.map((b) => b.y));
  const x2 = Math.max(...boxes.map((b) => b.x + b.w));
  const y2 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** 라벨 줄의 값은 같은 행 오른쪽이나 바로 아래 줄에 있다 */
function valueLineFor(label: OcrLine, lines: OcrLine[], labelIdx: number): number {
  const lb = label.box;
  const cy = lb.y + lb.h / 2;
  let best = -1;
  let bestDist = Infinity;
  lines.forEach((cand, i) => {
    if (i === labelIdx) return;
    const cb = cand.box;
    const sameRow =
      Math.abs(cb.y + cb.h / 2 - cy) < Math.max(lb.h, cb.h) * 0.6 && cb.x >= lb.x + lb.w * 0.5;
    const below =
      cb.y >= lb.y + lb.h * 0.8 &&
      cb.y - (lb.y + lb.h) < lb.h * 2.5 &&
      Math.abs(cb.x - lb.x) < Math.max(lb.w, lb.h * 6);
    if (!sameRow && !below) return;
    const dist = sameRow
      ? cb.x - (lb.x + lb.w)
      : (cb.y - (lb.y + lb.h)) * 2 + Math.abs(cb.x - lb.x);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  return best;
}

function spanBox(
  line: OcrLine,
  start: number,
  end: number,
): { box: VisionBox; coverStart: number; coverEnd: number } {
  const hit = line.tokens.filter((t) => t.start < end && t.end > start);
  if (hit.length === 0) {
    const len = Math.max(1, line.text.length);
    const b = line.box;
    return {
      box: { x: b.x + (b.w * start) / len, y: b.y, w: (b.w * (end - start)) / len, h: b.h },
      coverStart: start,
      coverEnd: end,
    };
  }
  return {
    box: union(hit.map((t) => t.box)),
    coverStart: Math.min(...hit.map((t) => t.start)),
    coverEnd: Math.max(...hit.map((t) => t.end)),
  };
}

/** OCR 결과에서 가려야 할 칸과 그 자리에 그릴 가짜 값을 정한다. 이미지는 건드리지 않는다 */
export function planRedaction(ocr: OcrResult, pii: PiiRedactor): RedactionPlan {
  const items: PaintItem[] = [];
  const counts = { text: 0, avatars: 0, barcodes: 0 };

  const ctxByLine = new Map<number, string>();
  ocr.lines.forEach((line, i) => {
    const kind = pii.labelKindOf(line.text);
    if (!kind) return;
    const target = valueLineFor(line, ocr.lines, i);
    if (target >= 0 && !ctxByLine.has(target)) ctxByLine.set(target, kind);
  });

  ocr.lines.forEach((line, i) => {
    if (pii.labelKindOf(line.text)) return;
    const spans = pii.detect(line.text, ctxByLine.get(i) ?? null);
    for (const span of spans) {
      const { box, coverStart, coverEnd } = spanBox(line, span.start, span.end);
      const text =
        line.text.slice(coverStart, span.start) +
        span.replacement +
        line.text.slice(span.end, coverEnd);
      items.push({ type: 'text', box, text });
      counts.text++;
    }
  });

  for (const face of ocr.faces) {
    items.push({ type: 'avatar', box: face });
    counts.avatars++;
  }
  for (const code of ocr.barcodes) {
    const fake = code.payload ? pii.fakeDigits(code.payload) : undefined;
    items.push({ type: 'barcode', box: code.box, ...(fake ? { text: fake } : {}) });
    counts.barcodes++;
  }
  return { items, counts };
}

export type VisionRunner = (args: string[]) => Promise<string>;

export function swiftRunner(scriptPath: string, timeoutMs = 180_000): VisionRunner {
  return async (args) => {
    const { stdout } = await execFileAsync('swift', [scriptPath, ...args], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  };
}

let visionProbe: Promise<boolean> | undefined;

/** macOS이고 swift 도구체인이 있을 때만 Vision을 쓸 수 있다. 첫 호출 결과를 프로세스 동안 재사용한다 */
export function isVisionAvailable(): Promise<boolean> {
  visionProbe ??=
    process.platform !== 'darwin'
      ? Promise.resolve(false)
      : execFileAsync('swift', ['--version'], { timeout: 15_000 }).then(
          () => true,
          () => false,
        );
  return visionProbe;
}

export function outputExtFor(inputPath: string, replaced: boolean): string {
  const ext = extname(inputPath).toLowerCase();
  if (!replaced) return ext;
  return ext === '.png' ? '.png' : '.jpg';
}

export interface RedactImageOptions {
  inputPath: string;
  /** 확장자를 뺀 출력 경로. 실제 확장자는 결과의 outputPath에 있다 */
  outputBase: string;
  pii: PiiRedactor;
  run: VisionRunner | undefined;
}

/**
 * 이미지 한 장의 개인정보를 가짜 값으로 바꿔 저장한다.
 * - Vision을 못 쓰면 원본을 그대로 복사하고 `unchecked`로 남긴다
 * - 탐지가 0건이면 원본을 복사하고 `none`이다. 라벨 없는 이름은 못 잡을 수 있어서 보증은 아니다
 */
export async function redactImageFile(opts: RedactImageOptions): Promise<ImageRedactionResult> {
  const warnings: string[] = [];
  const emptyCounts = { text: 0, avatars: 0, barcodes: 0 };
  const copyAs = (replaced: boolean): string => {
    const out = opts.outputBase + outputExtFor(opts.inputPath, replaced);
    copyFileSync(opts.inputPath, out);
    return out;
  };

  if (!opts.run) {
    warnings.push(
      'Vision을 쓸 수 없는 환경이라 개인정보 치환을 못 했다. 캡처는 unchecked로 남고 공유용 HTML 렌더가 막힌다.',
    );
    return { pii: 'unchecked', outputPath: copyAs(false), counts: emptyCounts, warnings };
  }

  let ocr: OcrResult;
  try {
    ocr = JSON.parse(await opts.run(['ocr', opts.inputPath])) as OcrResult;
  } catch (e) {
    warnings.push(`OCR을 못 돌려 치환을 건너뛰었다: ${e instanceof Error ? e.message : String(e)}`);
    return { pii: 'unchecked', outputPath: copyAs(false), counts: emptyCounts, warnings };
  }

  const plan = planRedaction(ocr, opts.pii);
  if (plan.items.length === 0) {
    return { pii: 'none', outputPath: copyAs(false), counts: plan.counts, warnings };
  }

  const outputPath = opts.outputBase + outputExtFor(opts.inputPath, true);
  const dir = mkdtempSync(join(tmpdir(), 'ges-pii-'));
  try {
    const planPath = join(dir, 'plan.json');
    writeFileSync(planPath, JSON.stringify({ items: plan.items }), { mode: 0o600 });
    await opts.run(['paint', opts.inputPath, planPath, outputPath]);
  } catch (e) {
    warnings.push(`치환 그리기에 실패했다: ${e instanceof Error ? e.message : String(e)}`);
    return { pii: 'unchecked', outputPath: copyAs(false), counts: emptyCounts, warnings };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { pii: 'replaced', outputPath, counts: plan.counts, warnings };
}
