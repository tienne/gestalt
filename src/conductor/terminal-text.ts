import { isControlChar } from './intake.js';

/**
 * 워커 보고처럼 바깥에서 온 값을 터미널에 찍을 꼴로 바꾼다. ESC 같은 제어 문자가 화면을 조작하지 못하게
 * 개행 말고는 공백으로 바꾸고 이어지는 줄은 들여써 다른 항목 줄로 보이지 않게 한다. 전문을 읽는 자리라 자르지 않는다
 */
export function terminalText(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    out += ch !== '\n' && isControlChar(c) ? ' ' : ch;
  }
  return out.replace(/\n/g, '\n    ');
}
