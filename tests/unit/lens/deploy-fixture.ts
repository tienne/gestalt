import type { Widget } from '../../../src/digest/lens-widget-schema.js';
import { lintDigest, lintErrors } from '../../../src/digest/lint.js';
import type { Transcript } from '../../../src/digest/schema.js';
import { lensDigest, lensReport, lensSource, lensTranscript } from './fixture.js';

/** 배포 절차를 글로 설명한 문단. 논문 원문 뒤에 덧붙여 D 그림과 비유 표가 옮길 대상으로 쓴다 */
const DEPLOY = [
  'release/20260721 브랜치를 main으로 rebase 머지하면 production에 나간다.',
  '그 직후 release/20260728이 main에서 갈라져 나와 alpha에 올라간다.',
  'main이 0721로 앞으로 나가면 release/20260728을 다시 rebase하고 force push한다.',
  '정기배포는 전주 수요일에 release 브랜치를 만들고 목요일부터 alpha QA를 한다.',
  '금요일 또는 다음 주 월요일에 beta QA로 넘어가고 화요일에 production 배포를 한다.',
  'PR은 release 브랜치로 squash 머지한다. alpha QA에서 버그가 나오면 수정 PR을 다시 squash 머지한다.',
  '배포 전에 전수검사를 할 수 있다.',
];

export function deployTranscript(): Transcript {
  const t = lensTranscript();
  const base = t.segments.length;
  DEPLOY.forEach((text, k) =>
    t.segments.push({ i: base + k, startSec: 0, text, page: 3, role: 'para' }),
  );
  return t;
}

/** 덧붙인 배포 문단 k번째의 출처 */
export const at = (k: number) => {
  const i = lensTranscript().segments.length + k;
  return { key: i, from: i, to: i };
};

export function withWidget(w: Widget) {
  const r = lensReport();
  r.sections[1]!.subsections[0]!.widgets = [w];
  return r;
}

/** 덧붙인 배포 문단은 리포트 섹션이 덮지 않아 SECTION_GAP이 난다. 그림 검사와 무관해 뺀다 */
export const deployCodes = (w: Widget) =>
  lintErrors(lintDigest(lensDigest(withWidget(w)), deployTranscript(), { source: lensSource() }))
    .map((i) => i.code)
    .filter((c) => c !== 'SECTION_GAP');
