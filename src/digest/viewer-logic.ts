/**
 * 브라우저에 싣는 코드라 문자열로 둔다. 판단만 하는 순수 함수와 타이머로 확인할 복사 알림은 VIEWER_LOGIC_JS에 모아
 * 테스트가 이 문자열을 그대로 실행해 본다. DOM과 유튜브 플레이어를 다루는 IIFE는 viewer-js.ts에 있고
 * 테스트에서 문법만 확인한다. OCR처럼 Node 쪽에서 같은 판단이 필요한 코드는 뷰어 스크립트 대신 이 모듈을 가져온다.
 */
export const VIEWER_LOGIC_JS = `
function findSegmentIndex(starts, t) {
  if (!starts.length || !(t >= starts[0])) return -1;
  var lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    var mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}
function shouldFollow(idx, from, to, now, manualUntil) {
  if (now < manualUntil) return false;
  return !(idx >= from && idx <= to);
}
function shouldFollowHeld(state, idx, from, to, now, manualUntil) {
  if (state === 1 || state === 3) return false;
  return shouldFollow(idx, from, to, now, manualUntil);
}
function cueAction(state) {
  return state === 1 || state === 2 || state === 3 ? 'seek' : 'cue';
}
function citeWindow(from, to, max) {
  var end = Math.min(to, from + max - 1);
  return { end: end, more: Math.max(0, to - end) };
}
function pickReport(reports, length, difficulty) {
  for (var i = 0; i < reports.length; i++) {
    var r = reports[i];
    if (r.preset && r.length === length && r.difficulty === difficulty) return i;
  }
  return -1;
}
function reportCommand(slug, length, difficulty, lang) {
  var cmd = '/gestalt:video-digest slug=' + slug + ' length=' + length + ' difficulty=' + difficulty;
  return lang ? cmd + ' reportLang=' + lang : cmd;
}
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return ''; }
}
function videoState(ended, paused, time, readyState) {
  if (ended) return 0;
  if (paused) return time > 0 ? 2 : -1;
  return readyState < 3 ? 3 : 1;
}
// 두 복사 버튼이 라이브 영역 하나를 같이 써서 타이머도 하나로 묶는다. 앞 타이머가 남으면 뒤 문구를 일찍 지운다
// 버튼 글자만 바꾸면 스크린리더가 결과를 안 읽어서 결과 문구는 라이브 영역에 따로 쓴다.
// 같은 문구를 그대로 다시 넣으면 안 읽는 리더가 있어서 한 번 비우고 setTimeout 0으로 미뤄 쓴다
function makeFlash(getStatus) {
  var flashTimer = null;
  var flashBtn = null;
  var flashLabel = '';
  return function flash(btn, label, failed) {
    var status = getStatus();
    clearTimeout(flashTimer);
    if (flashBtn && flashBtn !== btn) flashBtn.textContent = flashLabel;
    flashBtn = btn;
    flashLabel = label;
    btn.textContent = failed ? '복사 실패' : '복사했어요';
    if (status) status.textContent = '';
    flashTimer = setTimeout(function(){
      if (status) status.textContent = failed ? '복사하지 못했어요. 직접 선택해 복사해 주세요' : '복사했어요';
      flashTimer = setTimeout(function(){
        btn.textContent = label;
        flashBtn = null;
        if (status) status.textContent = '';
      }, failed ? 3000 : 1500);
    }, 0);
  };
}
`;

export interface ViewerLogic {
  /** 재생 시각 t에 해당하는 문장 번호. 첫 문장보다 이르면 -1 */
  findSegmentIndex: (starts: number[], t: number) => number;
  /** 읽는 소섹션이 바뀌었을 때 영상을 그 구간으로 옮길지 */
  shouldFollow: (
    idx: number,
    from: number,
    to: number,
    now: number,
    manualUntil: number,
  ) => boolean;
  /** 시각을 누른 직후라 미뤄 둔 소섹션 이동을 유예가 끝난 뒤 할지. 그사이 재생이나 버퍼링 중이면 사용자가 옮긴 자리를 둔다 */
  shouldFollowHeld: (
    state: number,
    idx: number,
    from: number,
    to: number,
    now: number,
    manualUntil: number,
  ) => boolean;
  /** 유튜브 재생 상태별로 seekTo를 쓸지 cueVideoById를 쓸지 */
  cueAction: (state: number) => 'seek' | 'cue';
  /** 출처 툴팁에 보일 마지막 문장 번호와 생략한 문장 수 */
  citeWindow: (from: number, to: number, max: number) => { end: number; more: number };
  /** 툴바의 분량과 난이도 조합에 맞는 리포트 자리. 없으면 -1 */
  pickReport: (
    reports: { preset: boolean; length: string; difficulty: string }[],
    length: string,
    difficulty: string,
  ) => number;
  /** 없는 조합을 고르면 복사해 주는 생성 명령. 지금 보는 리포트의 언어를 따라가야 다른 언어 리포트가 안 생긴다 */
  reportCommand: (slug: string, length: string, difficulty: string, lang?: string) => string;
  /** 공유 링크의 앵커는 외부 입력이라 깨진 인코딩이면 빈 문자열로 받는다 */
  safeDecode: (s: string) => string;
  /** HTML5 video 상태를 유튜브 재생 상태 코드로 옮긴다. 따라가기 판정이 그 코드만 본다 */
  videoState: (ended: boolean, paused: boolean, time: number, readyState: number) => number;
  /** 복사 결과를 버튼 글자와 라이브 영역에 잠깐 보이는 함수를 만든다. 버튼 둘이 타이머 하나를 같이 쓴다 */
  makeFlash: (
    getStatus: () => { textContent: string | null } | null,
  ) => (btn: { textContent: string | null }, label: string, failed: boolean) => void;
}

export const viewerLogic = new Function(
  `${VIEWER_LOGIC_JS}; return { findSegmentIndex: findSegmentIndex, shouldFollow: shouldFollow, shouldFollowHeld: shouldFollowHeld, cueAction: cueAction, citeWindow: citeWindow, pickReport: pickReport, reportCommand: reportCommand, safeDecode: safeDecode, videoState: videoState, makeFlash: makeFlash };`,
)() as ViewerLogic;

export const findSegmentIndex = viewerLogic.findSegmentIndex;
