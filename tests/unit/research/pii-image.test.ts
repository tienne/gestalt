import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDomRedactionScript } from '../../../src/research/pii-dom.js';
import {
  planRedaction,
  redactImageFile,
  type OcrResult,
  type VisionRunner,
} from '../../../src/research/pii-image.js';
import { createPiiRedactor } from '../../../src/research/pii.js';

const pii = createPiiRedactor('image-seed');
const dirs: string[] = [];

function tmpDir(): string {
  const dir = resolve('.gestalt-test', `pii-image-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function line(text: string, x: number, y: number, w: number, h = 20) {
  const tokens: OcrResult['lines'][number]['tokens'] = [];
  let pos = 0;
  for (const word of text.split(' ')) {
    const start = text.indexOf(word, pos);
    const end = start + word.length;
    pos = end;
    const tw = (w * word.length) / text.length;
    tokens.push({ start, end, box: { x: x + (w * start) / text.length, y, w: tw, h } });
  }
  return { text, box: { x, y, w, h }, confidence: 1, tokens };
}

const ocr: OcrResult = {
  width: 400,
  height: 600,
  languages: ['ko-KR'],
  lines: [
    line('연락처 010-1234-5678', 20, 100, 200),
    line('수령인', 20, 140, 60),
    line('김민준', 20, 170, 60),
    line('오늘의 추천 상품', 20, 220, 160),
  ],
  faces: [{ x: 300, y: 20, w: 60, h: 60 }],
  barcodes: [
    { payload: '1234567890123', symbology: 'EAN13', box: { x: 20, y: 300, w: 200, h: 60 } },
  ],
};

describe('이미지 개인정보 치환 계획', () => {
  it('값 글자의 칸만 덮고 가짜 값을 그릴 글자를 정한다', () => {
    const plan = planRedaction(ocr, pii);
    const texts = plan.items.filter((i) => i.type === 'text');
    expect(texts).toHaveLength(2);
    const phone = texts.find((t) => t.text?.includes('010'));
    expect(phone?.text).not.toContain('1234');
    expect(phone?.box.x).toBeGreaterThan(20);
    expect(plan.counts).toEqual({ text: 2, avatars: 1, barcodes: 1 });
  });

  it('라벨 바로 아래 줄의 이름을 라벨 문맥으로 잡는다', () => {
    const plan = planRedaction(ocr, pii);
    const name = plan.items.find((i) => i.type === 'text' && i.box.y === 170);
    expect(name).toBeDefined();
    expect(name?.text).not.toBe('김민준');
    expect(name?.text).toHaveLength(3);
  });

  it('얼굴은 아바타로, 바코드는 같은 길이의 가짜 페이로드로 바꾼다', () => {
    const plan = planRedaction(ocr, pii);
    expect(plan.items.some((i) => i.type === 'avatar')).toBe(true);
    const bar = plan.items.find((i) => i.type === 'barcode');
    expect(bar?.text).toHaveLength('1234567890123'.length);
    expect(bar?.text).not.toBe('1234567890123');
  });

  it('계획에 실제 값이 남지 않는다', () => {
    const json = JSON.stringify(planRedaction(ocr, pii));
    expect(json).not.toContain('5678');
    expect(json).not.toContain('김민준');
  });
});

describe('이미지 치환 파이프라인', () => {
  it('Vision이 없으면 원본을 복사하고 unchecked로 남긴다', async () => {
    const dir = tmpDir();
    const input = resolve(dir, 'in.png');
    writeFileSync(input, 'raw');
    const r = await redactImageFile({
      inputPath: input,
      outputBase: resolve(dir, 'out'),
      pii,
      run: undefined,
    });
    expect(r.pii).toBe('unchecked');
    expect(readFileSync(r.outputPath, 'utf-8')).toBe('raw');
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('탐지가 없으면 none이다', async () => {
    const dir = tmpDir();
    const input = resolve(dir, 'in.jpg');
    writeFileSync(input, 'raw');
    const run: VisionRunner = async () =>
      JSON.stringify({
        ...ocr,
        lines: [line('오늘의 추천 상품', 20, 220, 160)],
        faces: [],
        barcodes: [],
      });
    const r = await redactImageFile({
      inputPath: input,
      outputBase: resolve(dir, 'out'),
      pii,
      run,
    });
    expect(r.pii).toBe('none');
    expect(r.outputPath.endsWith('.jpg')).toBe(true);
  });

  it('탐지가 있으면 paint를 호출하고 replaced로 돌려준다', async () => {
    const dir = tmpDir();
    const input = resolve(dir, 'in.webp');
    writeFileSync(input, 'raw');
    const calls: string[][] = [];
    const run: VisionRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'ocr') return JSON.stringify(ocr);
      const planJson = readFileSync(args[2]!, 'utf-8');
      expect(planJson).not.toContain('5678');
      writeFileSync(args[3]!, 'painted');
      return '';
    };
    const r = await redactImageFile({
      inputPath: input,
      outputBase: resolve(dir, 'out'),
      pii,
      run,
    });
    expect(r.pii).toBe('replaced');
    expect(r.outputPath.endsWith('.jpg')).toBe(true);
    expect(readFileSync(r.outputPath, 'utf-8')).toBe('painted');
    expect(calls.map((c) => c[0])).toEqual(['ocr', 'paint']);
    expect(existsSync(calls[1]![2]!)).toBe(false);
  });

  it('OCR가 실패하면 unchecked로 돌려주고 경고를 남긴다', async () => {
    const dir = tmpDir();
    const input = resolve(dir, 'in.png');
    writeFileSync(input, 'raw');
    const run: VisionRunner = async () => {
      throw new Error('timeout');
    };
    const r = await redactImageFile({
      inputPath: input,
      outputBase: resolve(dir, 'out'),
      pii,
      run,
    });
    expect(r.pii).toBe('unchecked');
    expect(r.warnings[0]).toContain('timeout');
  });
});

describe('웹 DOM 치환 스크립트', () => {
  it('문법이 맞고 seed를 담는다', () => {
    const script = buildDomRedactionScript('seed-x', { observe: true });
    expect(() => new Function(`return ${script}`)).not.toThrow();
    expect(script).toContain('"seed-x"');
    expect(script).toContain('var OBSERVE = true');
  });

  it('observe를 끄면 관찰자를 달지 않는다', () => {
    expect(buildDomRedactionScript('s')).toContain('var OBSERVE = false');
  });
});
