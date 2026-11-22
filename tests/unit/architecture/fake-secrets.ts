// 비밀값처럼 생긴 테스트 값. 시크릿 스캐너에 안 걸리게 소스에 그대로 쓰지 않고 실행할 때 조각을 이어 만든다

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** 시드로 정해지는 무작위 꼴 글자. 실행마다 같다 */
export function noise(seed: number, len: number, alphabet = ALNUM): string {
  let x = seed + 7919;
  let out = '';
  for (let i = 0; i < len; i++) {
    x = (x * 48271) % 2147483647;
    out += alphabet[Math.floor((x / 2147483647) * alphabet.length)]!;
  }
  return out;
}

/** 알려진 키 형식 하나. 산출물에 이 글자가 남으면 안 된다 */
export const FAKE_TOKEN = ['gh', 'p_', noise(101, 36)].join('');
/** 접속 주소에 넣을 비밀번호 */
export const FAKE_PASSWORD = ['Tr', '0ub', '4dor', '-', noise(102, 8)].join('');
