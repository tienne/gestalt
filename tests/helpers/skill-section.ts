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
