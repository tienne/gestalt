/**
 * 디자인 시스템 타입 바깥으로 나간 자리를 찾는다.
 *
 * 타입이 이미 막는 건 여기서 안 본다. plate의 Sprinkles는 `padding="13px"`을 컴파일에서
 * 거부한다. deprecated 토큰은 eslint-config-plate-recipe가 잡는다. 같은 걸 세 번 잡으면
 * 사람이 셋 다 무시한다.
 *
 * 남는 건 타입이 닿지 않는 자리다 — `style` prop, `className`으로 넣은 CSS, 디자인 시스템을
 * 아예 안 거친 엘리먼트. 타입이 강할수록 우회로가 이쪽 하나로 몰린다.
 */

export type BypassRule = 'style-length' | 'style-color' | 'raw-css-length' | 'raw-css-color';

export interface Bypass {
  rule: BypassRule;
  line: number;
  /** 걸린 자리의 원문 일부. 리포트에 그대로 싣는다 */
  sample: string;
}

/** 리포트에 넣을 한 줄 설명. 룰 본문은 룰북이 원본이고 여기는 라벨만 갖는다 */
export const BYPASS_LABEL: Record<BypassRule, string> = {
  'style-length': 'style prop에 길이값을 직접 적음',
  'style-color': 'style prop에 색상값을 직접 적음',
  'raw-css-length': 'CSS 블록에 길이값을 직접 적음',
  'raw-css-color': 'CSS 블록에 색상값을 직접 적음',
};

const SAMPLE_MAX = 80;

function clamp(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= SAMPLE_MAX ? t : `${t.slice(0, SAMPLE_MAX - 1)}…`;
}

/**
 * 0과 100%처럼 토큰으로 대체할 수 없는 값은 세지 않는다.
 *
 * `0`은 어느 스케일에도 안 걸리고 `100%`, `auto`, `inherit`는 길이 토큰의 대상이 아니다.
 * 이걸 세면 리포트가 대체 불가능한 것으로 채워져 진짜 걸린 자리가 묻힌다.
 */
const EXEMPT_LENGTH = /^(0|0px|0%|100%|auto|inherit|initial|unset|none)$/;

/** 길이 리터럴: 숫자 + 단위. 단위 없는 맨 숫자는 z-index나 flex일 수 있어 안 센다 */
const LENGTH_LITERAL = /(-?\d+(?:\.\d+)?)(px|rem|em|vh|vw)\b/g;

/** 색상 리터럴: hex, rgb(), hsl() */
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/g;

/**
 * 계산식 안의 리터럴은 세지 않는다.
 *
 * `calc(100% - 16px)`나 `translateY(-50%)`는 토큰으로 못 바꾸는 자리가 많다. 이런 걸
 * 걸면 정당한 코드가 리포트를 채워 사람이 검사 자체를 끄게 된다.
 */
const IN_EXPRESSION = /\b(calc|translate[XYZ]?|scale|rotate|clamp|min|max|env|var)\s*\(/;

function scanValue(value: string): { length: boolean; color: boolean } {
  if (IN_EXPRESSION.test(value)) return { length: false, color: false };
  let length = false;
  for (const m of value.matchAll(LENGTH_LITERAL)) {
    if (!EXEMPT_LENGTH.test(m[0])) {
      length = true;
      break;
    }
  }
  return { length, color: COLOR_LITERAL.test(value) };
}

/** `style={{ ... }}` 안의 내용만 뽑는다. 중첩 중괄호를 세어 끝을 찾는다 */
function styleBlocks(source: string): { body: string; index: number }[] {
  const out: { body: string; index: number }[] = [];
  const open = /style=\{\{/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(source)) !== null) {
    let depth = 2;
    let i = m.index + m[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      const ch = source[i]!;
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    // depth가 0이 되는 시점에 `}}` 둘 다 소비했다. i-1은 바깥 중괄호라 안쪽 것까지
    // 빼려면 i-2까지 잘라야 한다. 속성이 여럿이면 뒤에 붙은 `}`가 값에 안 걸려
    // 눈에 안 띈다. 속성이 하나면 마지막 값에 그대로 붙는다
    out.push({ body: source.slice(start, Math.max(start, i - 2)), index: m.index });
  }
  return out;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

/** CSS 선언 한 줄 (`padding: 13px;`). 프로퍼티 이름까지 받아야 오탐이 준다 */
const CSS_DECL = /^\s*([a-z-]+)\s*:\s*([^;{}]+);/;

/** 길이 토큰이 대신할 수 있는 프로퍼티만 본다. `line-height: 1.5` 같은 건 대상이 아니다 */
const LENGTH_PROPS =
  /^(padding|margin|gap|width|height|top|right|bottom|left|inset|border-radius|font-size|row-gap|column-gap)(-(top|right|bottom|left|x|y|inline|block))?$/;

const COLOR_PROPS = /(color|background|border|outline|shadow|fill|stroke)/;

/** `style={{ padding: 12 }}`처럼 단위 없는 숫자도 React가 px로 읽는다. 키:값 쌍을 본다 */
const JS_ENTRY = /([A-Za-z][A-Za-z0-9]*)\s*:\s*([^,]+?)(?=,\s*[A-Za-z][A-Za-z0-9]*\s*:|,?\s*$)/g;

/** camelCase 프로퍼티를 CSS 이름으로. `paddingTop` → `padding-top` */
function kebab(prop: string): string {
  return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * JSX `style` prop 안의 리터럴을 찾는다.
 *
 * 디자인 시스템 컴포넌트를 쓰면서 `style`을 같이 다는 경우가 가장 흔하다 — props는 타입이
 * 막으니 막히지 않는 쪽으로 값이 새어 나간다.
 *
 * 블록을 통째로 보지 않고 프로퍼티 단위로 본다. 통째로 보면 한 블록 안에 길이값이 하나만
 * 있어도 블록 전체가 걸려 `justifyContent` 같은 무관한 줄이 리포트에 인용된다.
 */
export function styleBypasses(source: string): Bypass[] {
  const out: Bypass[] = [];
  for (const block of styleBlocks(source)) {
    const line = lineOf(source, block.index);
    for (const m of block.body.matchAll(JS_ENTRY)) {
      const prop = kebab(m[1]!);
      const value = m[2]!.trim();
      const hit = scanValue(value);
      const sample = clamp(`${m[1]!}: ${value}`);
      // 단위 없는 숫자는 React가 px로 넣는다. CSS 쪽에서는 z-index 같은 게 섞여 못 세지만
      // 여기서는 프로퍼티를 알고 있어 길이 자리인지 가릴 수 있다
      const bareNumber = /^-?\d+(\.\d+)?$/.test(value) && !EXEMPT_LENGTH.test(value);
      if (LENGTH_PROPS.test(prop) && (hit.length || bareNumber)) {
        out.push({ rule: 'style-length', line, sample });
      }
      if (COLOR_PROPS.test(prop) && hit.color) {
        out.push({ rule: 'style-color', line, sample });
      }
    }
  }
  return out;
}

/**
 * `.css`, `.scss`, 템플릿 리터럴 안의 CSS 선언을 본다.
 *
 * `style` prop과 달리 여기는 프로퍼티 이름이 있어서 대상을 좁힐 수 있다. 좁히지 않으면
 * `z-index: 100`이나 `line-height: 20px` 같은 것까지 걸려 리포트가 못 쓰게 된다.
 */
export function cssBypasses(source: string): Bypass[] {
  const out: Bypass[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = CSS_DECL.exec(lines[i]!);
    if (!m) continue;
    const prop = m[1]!;
    const value = m[2]!;
    const hit = scanValue(value);
    const line = i + 1;
    if (hit.length && LENGTH_PROPS.test(prop)) {
      out.push({ rule: 'raw-css-length', line, sample: clamp(`${prop}: ${value}`) });
    }
    if (hit.color && COLOR_PROPS.test(prop)) {
      out.push({ rule: 'raw-css-color', line, sample: clamp(`${prop}: ${value}`) });
    }
  }
  return out;
}

/** 파일 하나에서 우회 자리를 전부 찾는다 */
export function detectBypasses(source: string, filePath: string): Bypass[] {
  const isStyleSheet = /\.(css|scss|sass|less)$/.test(filePath);
  return isStyleSheet ? cssBypasses(source) : [...styleBypasses(source), ...cssBypasses(source)];
}
