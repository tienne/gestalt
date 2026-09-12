import { expect } from 'vitest';

/**
 * 헤딩 하나가 덮는 범위만 잘라낸다. 파일 끝까지 흘러가면 절 단위 단언이 뜻을 잃는다.
 *
 * 코드펜스 안의 `# 주석` 줄을 헤딩으로 세지 않는다. 스킬 문서는 bash 블록을 많이 써서
 * 그걸 안 걸러내면 절이 첫 스니펫에서 끊긴다. 들여쓴 펜스와 백틱 넷으로 연 블록까지
 * 다루는 이유는 여러 문서에 둘 다 있어서다 — 여는 마커보다 짧은 마커로는 안 닫는다.
 */
export function section(body: string, heading: string): string {
  const lines = body.split('\n');
  const fence = /^\s*(`{3,}|~{3,})/;
  const level = heading.match(/^#+/)![0]!.length;
  const boundary = new RegExp(`^#{1,${level}} `);

  let open: string | null = null;
  let start = -1;
  let end = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = line.match(fence)?.[1];
    if (marker) {
      if (open === null) open = marker;
      else if (marker[0] === open[0] && marker.length >= open.length) open = null;
      continue;
    }
    if (open !== null) continue;

    if (line === heading) {
      expect(start, `${heading} 헤딩이 펜스 밖에 두 번 있다`).toBe(-1);
      start = i;
    } else if (start !== -1 && end === lines.length && boundary.test(line)) {
      end = i;
    }
  }

  expect(open, '코드펜스가 안 닫혔다').toBeNull();
  expect(start, `${heading} 헤딩을 못 찾았다`).toBeGreaterThan(-1);
  return lines.slice(start, end).join('\n');
}

/**
 * 헤딩이 정확한 문자열이 아니라 접두어로만 알려진 자리를 잡는다.
 *
 * 헤딩 뒤에 설명을 덧붙이는 스킬 문서가 있어서(`### 2.2 판정 결정 — ⓟ가 여기 있다`),
 * 그 꼬리까지 테스트가 외우면 문구를 다듬을 때마다 깨진다.
 */
export function sectionStartingWith(body: string, prefix: string): string {
  const heading = body.split('\n').find((l) => l.startsWith(prefix));
  expect(heading, `${prefix} 로 시작하는 헤딩을 못 찾았다`).toBeDefined();
  return section(body, heading!);
}

/**
 * 절 안의 n번째 코드펜스 내용을 꺼낸다.
 *
 * 테스트가 문서의 스크립트를 검증하려면 그 스크립트를 문서에서 가져와야 한다. 사본을
 * 테스트에 베껴 두면 문서 쪽이 바뀌어도 사본이 그대로 통과해, 검증한다는 말만 남고
 * 실제로는 자기가 쓴 코드를 자기가 돌리는 꼴이 된다.
 */
export function codeBlock(body: string, heading: string, index = 0): string {
  const lines = section(body, heading).split('\n');
  const fence = /^\s*(`{3,}|~{3,})/;
  const blocks: string[] = [];
  let open: string | null = null;
  let buf: string[] = [];

  for (const line of lines) {
    const marker = line.match(fence)?.[1];
    if (marker) {
      if (open === null) {
        open = marker;
        buf = [];
      } else if (marker[0] === open[0] && marker.length >= open.length) {
        open = null;
        blocks.push(buf.join('\n'));
      }
      continue;
    }
    if (open !== null) buf.push(line);
  }

  expect(open, `${heading} 안의 코드펜스가 안 닫혔다`).toBeNull();
  expect(
    blocks.length,
    `${heading} 안에 코드블록이 ${blocks.length}개뿐인데 ${index}번째를 찾는다`,
  ).toBeGreaterThan(index);
  return blocks[index]!;
}

/**
 * 절 안에서 특정 문자열을 품은 코드블록을 찾는다.
 *
 * 순번으로 집으면 문서에 블록이 하나 끼는 순간 엉뚱한 걸 돌리게 된다. 찾는 블록이
 * 가진 고유한 글자로 집으면 위치가 바뀌어도 같은 걸 잡는다.
 */
export function codeBlockContaining(body: string, heading: string, needle: string): string {
  const lines = section(body, heading).split('\n');
  const fence = /^\s*(`{3,}|~{3,})/;
  const hits: string[] = [];
  let open: string | null = null;
  let buf: string[] = [];

  for (const line of lines) {
    const marker = line.match(fence)?.[1];
    if (marker) {
      if (open === null) {
        open = marker;
        buf = [];
      } else if (marker[0] === open[0] && marker.length >= open.length) {
        open = null;
        const block = buf.join('\n');
        if (block.includes(needle)) hits.push(block);
      }
      continue;
    }
    if (open !== null) buf.push(line);
  }

  expect(open, `${heading} 안의 코드펜스가 안 닫혔다`).toBeNull();
  expect(hits.length, `${heading} 안에 "${needle}"를 품은 블록이 ${hits.length}개다`).toBe(1);
  return hits[0]!;
}

/**
 * 작은따옴표 리터럴만 지운다. 그 안은 셸이 전개하지 않으므로 참조가 아니다.
 *
 * 큰따옴표 안의 작은따옴표는 리터럴을 열지 않는다. 정규식으로 한 번에 지우면
 * `echo "it's $a and it's $b"` 의 가운데가 통째로 사라져 `$a` 를 놓친다.
 */
function stripSingleQuoted(block: string): string {
  let out = '';
  let inDouble = false;
  let inSingle = false;
  for (const ch of block) {
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '"') inDouble = !inDouble;
    else if (ch === "'" && !inDouble) {
      inSingle = true;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 셸 코드블록이 자기 안에서 정의하지 않고 쓰는 변수를 찾는다.
 *
 * 스킬 문서의 코드블록은 각각 다른 Bash 호출로 실행된다. 셸 상태가 호출 사이에 안 남는
 * 런타임에서는 앞 블록의 변수가 빈 문자열로 풀린다. 그 값이 판정에 쓰이면 조용히 틀린
 * 수가 나온다. 중복을 걷어 통합할 때 이 자기완결성이 가장 먼저 깨진다.
 *
 * jq 의 `--arg me "$me"` 처럼 셸 값을 넘기는 자리도 셸 변수 참조로 센다. jq 필터 안쪽의
 * `$me` 는 jq 변수라 세지 않는다 — 작은따옴표 안은 셸이 전개하지 않는다.
 */
export function freeVariables(block: string, allowed: readonly string[] = []): string[] {
  // 인용 heredoc 안은 셸이 전개하지 않는다. 그 구간을 먼저 걷어낸다
  const body = stripQuotedHeredocs(block);
  const withoutLiterals = stripSingleQuoted(body);

  const defined = new Set<string>(allowed);
  // name=... 과 name+=... — local 과 export 말고 readonly 와 declare, typeset 도 대입이다
  for (const m of withoutLiterals.matchAll(
    /^\s*(?:(?:local|export|readonly|declare|typeset)\s+)*([A-Za-z_][A-Za-z0-9_]*)\+?=/gm,
  )) {
    defined.add(m[1]!);
  }
  // read -r a b — herestring 이 뒤따르든 파이프로 받든 이름을 심는 건 같다
  for (const m of withoutLiterals.matchAll(
    /\bread\s+((?:-\w+\s+)*)([A-Za-z0-9_][A-Za-z0-9_\s]*)/g,
  )) {
    for (const name of m[2]!.trim().split(/\s+/)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) defined.add(name);
    }
  }
  for (const m of withoutLiterals.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/g)) {
    defined.add(m[1]!);
  }
  // for ((i=0; i<3; i++)) 의 i
  for (const m of withoutLiterals.matchAll(/\bfor\s*\(\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) {
    defined.add(m[1]!);
  }
  // eval "$(... @sh "a=\(.x) b=\(.y)" ...)" 가 셸에 심는 이름. 원문(리터럴 포함)에서 찾는다.
  if (/\beval\b/.test(block)) {
    for (const m of block.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=\\\(/g)) defined.add(m[1]!);
  }

  const used = new Set<string>();
  // ${!ref} 와 ${arr[idx]} 의 안쪽 이름도 참조다
  for (const m of withoutLiterals.matchAll(/\$\{!?([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(m[1]!);
  for (const m of withoutLiterals.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(m[1]!);
  for (const m of withoutLiterals.matchAll(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g)) used.add(m[1]!);
  // 산술 전개 안에서는 `$` 없이 이름만 써도 셸이 값을 읽는다. `$((n + 1))` 의 n 이
  // 그 자리라, `$` 만 보면 선언을 지워도 안 걸린다
  for (const inner of arithmeticBodies(withoutLiterals)) {
    // 달러로 시작하는 조각은 앞의 규칙이 이미 봤다. 여기 남겨두면 `$(( $(cat f) + 1 ))`
    // 의 명령 이름까지 산술 식별자로 세어 거짓 양성이 난다
    for (const name of stripDollarSpans(inner).matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      used.add(name[0]);
    }
  }

  // 위치 인자와 특수 변수는 셸이 준다.
  const builtin = new Set(['IFS', 'HOME', 'PATH', 'PWD', 'USER', 'SHELL', 'PS1', 'PS2']);
  return [...used].filter((name) => !defined.has(name) && !builtin.has(name)).sort();
}

/** `$(...)`, `${...}`, `$name` 을 지운다. 산술 본문에서 순수 식별자만 남기려는 자리다 */
function stripDollarSpans(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '$') {
      out += text[i];
      continue;
    }
    const open = text[i + 1];
    if (open === '(' || open === '{') {
      const close = open === '(' ? ')' : '}';
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === open) depth++;
        else if (text[j] === close) {
          depth--;
          if (depth === 0) break;
        }
      }
      i = j;
      continue;
    }
    while (i + 1 < text.length && /[A-Za-z0-9_]/.test(text[i + 1]!)) i++;
  }
  return out;
}

/**
 * `$(( ... ))` 와 `(( ... ))` 의 안쪽을 꺼낸다.
 *
 * 괄호 깊이로 센다. `[^)]*` 로 잡으면 `$(( (a+b) * c ))` 처럼 중첩된 자리에서 매칭이
 * 끊겨 안쪽 이름을 통째로 놓친다.
 */
function arithmeticBodies(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    const at = text[i] === '$' ? i + 1 : i;
    if (text[at] !== '(' || text[at + 1] !== '(') continue;
    // `$(` 뒤의 `(` 가 명령 치환 안의 그룹일 수 있으니 `$` 없는 자리는 줄 첫머리나
    // 공백 뒤일 때만 산술로 본다
    if (text[i] !== '$' && i > 0 && !/[\s;&|]/.test(text[i - 1]!)) continue;

    let depth = 0;
    let j = at;
    for (; j < text.length; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;
    out.push(text.slice(at + 2, j - 1));
    i = j;
  }
  return out;
}

/**
 * 인용 heredoc(`<<'MARK'`) 구간을 걷어낸다.
 *
 * 마커를 따옴표로 감싸면 셸이 그 안을 전개하지 않으므로 `$var` 가 참조가 아니다.
 * 안 걷어내면 문서가 그 문법을 쓰는 순간 실체 없는 이유로 테스트가 막힌다.
 */
function stripQuotedHeredocs(block: string): string {
  const lines = block.split('\n');
  const out: string[] = [];
  let marker: string | null = null;
  for (const line of lines) {
    if (marker !== null) {
      if (line.trim() === marker) marker = null;
      continue;
    }
    const m = /<<-?\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/.exec(line);
    out.push(line);
    if (m) marker = m[1]!;
  }
  return out.join('\n');
}
