import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSkillMd } from '../../../src/skills/parser.js';
import {
  section,
  sectionStartingWith,
  codeBlock,
  codeBlockContaining,
} from '../../helpers/skill-section.js';

/**
 * task-7이 1.5/3/3.5단계 서브에이전트 호출을 한 파도로 묶었다. 세 호출이 서로의
 * 산출물(리뷰어의 issues, continuity-judge의 continuityVerdict)을 안 받는다는 전제
 * 위에서만 병렬이 안전하다. 이 파일은 그 전제가 문서에서 계속 지켜지는지 본다 —
 * 특히 3.5단계 프롬프트에 나중에 누가 review_submit 산출물을 끼워 넣으면 그 즉시
 * 걸리도록 못을 박는다.
 */

const reviewPath = resolve('plugin/skills/review/SKILL.md');
const review = parseSkillMd(readFileSync(reviewPath, 'utf-8'), reviewPath);

describe('3.5단계 continuity-judge는 3단계 리뷰어 산출물을 입력으로 받지 않는다', () => {
  const continuityHeading = () => {
    const heading = review.body.split('\n').find((l) => l.startsWith('### 3.5단계'));
    expect(heading, '### 3.5단계 헤딩을 못 찾았다').toBeDefined();
    return heading!;
  };
  const continuitySection = () => sectionStartingWith(review.body, '### 3.5단계');
  const continuityPrompt = () => codeBlock(review.body, continuityHeading(), 0);

  it('프롬프트 블록에 review_submit 산출물 자리표가 없다', () => {
    const prompt = continuityPrompt();
    expect(prompt, '3.5단계 프롬프트가 review_submit을 참조한다').not.toMatch(/review_submit/);
    expect(prompt, '3.5단계 프롬프트가 리뷰어 issues를 입력으로 받는다').not.toMatch(/\bissues\b/);
    expect(prompt, '3.5단계 프롬프트가 3단계 산출물을 참조한다').not.toMatch(
      /3단계\s*(리뷰|산출|결과)/,
    );
  });

  it('독립성 근거 문장이 절 안에 있다 (미래 변경이 부딪힐 못)', () => {
    const s = continuitySection();
    expect(s, 'issues를 입력으로 받지 않는다는 문장이 없다').toMatch(
      /`continuity-judge`는 3단계 리뷰어의 `issues`를 입력으로 받지 않습니다/,
    );
  });
});

describe('3단계 절이 파도에 1.5단계와 3.5단계도 함께 담는다고 말한다', () => {
  const phase3 = () => sectionStartingWith(review.body, '### 3단계: 에이전트별 리뷰 제출');

  it('1.5단계 호출을 같은 메시지에 담는다고 적혀 있다', () => {
    expect(phase3(), '1.5단계를 파도에 담는다는 말이 없다').toMatch(/1\.5단계/);
  });

  it('3.5단계 호출을 같은 메시지에 담는다고 적혀 있다', () => {
    expect(phase3(), '3.5단계를 파도에 담는다는 말이 없다').toMatch(/3\.5단계/);
  });

  it('영향 범위 실험을 재보고 접었다는 한 줄이 있다 (task-11)', () => {
    expect(phase3(), '영향 범위 실험 결과를 가리키는 줄이 없다').toMatch(
      /docs\/experiments\/review-impact-radius\.md/,
    );
  });
});

describe('결과 표시 절이 1.5단계 문서를 리뷰 리포트보다 먼저 보여준다', () => {
  const resultSection = () => section(review.body, '## 결과 표시');

  it('기획 컨텍스트 문서를 리포트 앞에 먼저 표시한다고 적혀 있다', () => {
    expect(resultSection(), '1.5단계 문서를 먼저 표시한다는 문장이 없다').toMatch(
      /기획 컨텍스트 문서\(1\.5단계\)를 리뷰 리포트 앞에 먼저 표시한 뒤/,
    );
  });
});

/**
 * task-5가 4.7단계 어투 검사의 파일별 humanize-scan 반복 호출을 단일 배치 호출로
 * 바꿨다. 코멘트 열 개마다 프로세스를 새로 띄우던 게 스캔 시간 대부분이었다.
 *
 * 이 절이 다시 반복문으로 돌아가면 그 비용이 그대로 되살아난다. 배치로 넘긴 뒤에도
 * 코멘트 하나당 파일 하나라는 조건을 놓치면 인용 판정이 파일 경계를 넘어 다른
 * 코멘트의 산문에 묻힌다. 그 두 축을 여기서 고정한다.
 */
describe('4.7단계 어투 검사가 humanize-scan을 파일별 반복이 아니라 배치로 부른다', () => {
  const phase47Section = () => sectionStartingWith(review.body, '#### 어투 검사 (필수)');
  const scanBlock = () =>
    codeBlockContaining(review.body, '#### 어투 검사 (필수)', 'humanize-scan');

  it('while read 반복문이 없다', () => {
    expect(phase47Section(), '파일마다 프로세스를 새로 띄우는 반복문이 남아 있다').not.toMatch(
      /while\s+read/,
    );
  });

  it('humanize-scan 호출이 파일 하나짜리 반복 변수를 쓰지 않는다', () => {
    // 옛 반복문은 이 호출과 뒤이은 basename 호출 둘 다 $f 하나로 파일을 받았다.
    // 배치 호출은 파일 목록을 통째로 받으므로 그 변수가 나올 자리가 없다
    expect(scanBlock(), '옛 반복문의 파일 변수($f)가 아직 쓰인다').not.toMatch(/\$f\b/);
  });

  it('humanize-scan 호출이 --file을 파일 목록에서 동적으로 만든다', () => {
    const block = scanBlock();
    expect(block, 'humanize-scan 호출에 --file이 없다').toMatch(/--file/);
    // 리터럴 파일 하나를 고정으로 넘기면 배치가 아니다 — find로 모은 목록에서 만들어야 한다
    expect(block, '파일 목록을 find로 모으지 않는다').toMatch(/find/);
  });

  it('코멘트 여러 개를 한 파일에 모으면 무력화된다는 경고가 남아 있다', () => {
    expect(
      phase47Section(),
      '파일 하나에 코멘트 여러 개를 모으면 무력화된다는 문장이 없다',
    ).toMatch(/코멘트\s*여러\s*개를\s*파일\s*하나에[\s\S]{0,60}무력화/);
  });

  it('파일 여러 개를 한 호출에 실어도 무력화되지 않는다는 설명이 남아 있다', () => {
    expect(
      phase47Section(),
      '여러 파일을 한 프로세스로 배치해도 판정이 파일 단위로 선다는 설명이 없다',
    ).toMatch(/파일\s*여러\s*개를\s*한\s*프로세스[\s\S]{0,220}(다른 이야기|경계를 넘지 않)/);
  });
});

/**
 * task-12 가 두 어투 검사에 실리는 룰북 로딩을 줄였다. 줄이는 가장 쉬운 길은 4.5 와 4.7 의
 * 스캔을 한 register 로 합쳐 한 번만 돌리는 것인데, 그러면 검사가 조용히 약해진다 —
 * `chat` 은 F-7, I-7 같은 룰을 S1 으로 올려 보고 `report` 는 S2 로 둔 채 지나간다.
 * 코멘트를 `report` 로 보면 그 룰들이 그대로 통과한다. 그 사실은 리포트 어디에도 안 남는다.
 *
 * 그래서 두 자리의 register 를 각각 고정한다. 속도를 판정 품질로 사는 변경이 문서에서
 * 먼저 걸리게 하려는 자리다. 같은 갈림을 코드에서 잡는 단언은
 * tests/unit/humanize/scan.test.ts 의 register 절에 있다.
 */
describe('두 어투 검사의 register 가 갈려 있다', () => {
  const reportScan = () => sectionStartingWith(review.body, '#### 리포트 어투 검사 (필수)');
  const chatScan = () => sectionStartingWith(review.body, '#### 어투 검사 (필수)');

  it('4.5단계 리포트 어투 검사는 --register report 로 부른다', () => {
    const block = codeBlockContaining(review.body, '#### 리포트 어투 검사 (필수)', 'humanize-scan');
    expect(block, '리포트 스캔이 --register report 로 안 돈다').toMatch(/--register\s+report/);
    expect(block, '리포트 스캔이 chat 으로 돈다 — 코멘트 기준을 리포트에 씌운 것이다').not.toMatch(
      /--register\s+chat/,
    );
  });

  it('4.5단계 절이 report 를 고른 근거를 들고 있다', () => {
    expect(reportScan(), 'report 를 고른 근거 문장이 없다').toMatch(/`--register report`입니다/);
  });

  it('4.7단계 어투 검사는 --register chat 으로 부른다', () => {
    const block = codeBlockContaining(review.body, '#### 어투 검사 (필수)', 'humanize-scan');
    expect(block, '코멘트 스캔이 --register chat 으로 안 돈다').toMatch(/--register\s+chat/);
    expect(
      block,
      '코멘트 스캔이 report 로 돈다 — chat 에서만 S1 인 룰들이 통째로 빠진다',
    ).not.toMatch(/--register\s+report/);
  });

  it('4.7단계 절이 chat 이 아니면 무엇이 빠지는지 적어 둔다', () => {
    const s = chatScan();
    expect(s, 'chat 을 고른 근거 문장이 없다').toMatch(/`--register chat`입니다/);
    expect(s, '대화와 리뷰에서 격상되는 룰을 가리키는 말이 없다').toMatch(/F-7/);
    expect(s, '대화와 리뷰에서 격상되는 룰을 가리키는 말이 없다').toMatch(/I-7/);
  });

  it('두 절이 서로 다른 register 를 쓴다 (합치면 여기서 걸린다)', () => {
    const grab = (heading: string) =>
      codeBlockContaining(review.body, heading, 'humanize-scan').match(/--register\s+(\w+)/)?.[1];
    const report = grab('#### 리포트 어투 검사 (필수)');
    const chat = grab('#### 어투 검사 (필수)');
    expect(report, '리포트 스캔의 register 를 못 읽었다').toBeDefined();
    expect(chat, '코멘트 스캔의 register 를 못 읽었다').toBeDefined();
    expect(chat, '두 어투 검사가 같은 register 로 합쳐졌다').not.toBe(report);
  });
});

/**
 * 스킬이 register 를 갈라 불러도, 에이전트 쪽 문서가 어느 말투가 어느 자리인지를 잃으면
 * 스캔을 못 돌리는 경로(인라인 텍스트만 받은 경우)에서 기준이 흐려진다. task-12 가 이
 * 파일의 0단계 절을 건드렸으므로 그 대응표가 살아 있는지 함께 본다.
 */
describe('humanize-monolith AGENT.md 가 말투와 자리의 대응을 들고 있다', () => {
  const agentPath = resolve('plugin/role-agents/humanize-monolith/AGENT.md');
  const agent = readFileSync(agentPath, 'utf-8');

  it('리뷰 코멘트가 chat, 보고서가 report 라고 적혀 있다', () => {
    expect(agent, '말투와 자리의 대응표가 없다').toMatch(
      /리뷰 코멘트와 슬랙이 `chat`[\s\S]{0,20}보고서가 `report`/,
    );
  });

  it('스캔 호출이 세 register 를 모두 받는다고 적혀 있다', () => {
    expect(agent, 'register 선택지가 doc|chat|report 로 안 적혀 있다').toMatch(
      /--register <doc\|chat\|report>/,
    );
  });

  it('부르는 쪽이 스캔을 실어 보냈으면 룰북을 다시 안 연다고 적혀 있다 (task-12)', () => {
    expect(agent, '스캔을 받았을 때 룰북을 다시 안 읽는다는 문장이 없다').toMatch(
      /스캔 결과를 프롬프트에 실어 보냈으면[\s\S]{0,40}다시 열지\s*\n?않는다/,
    );
  });
});
