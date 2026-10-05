import { describe, expect, it } from 'vitest';
import { matchNameRefs, type NameRefMatcher } from '../../../src/architecture/name-ref-match.js';

const run = (matcher: NameRefMatcher, refs: string[], decls: string[]) =>
  matchNameRefs({
    matcher,
    refs: refs.map((name, i) => ({ id: `r${i}`, name })),
    decls: decls.map((name, i) => ({ id: `d${i}`, name })),
  });

describe('matchNameRefs', () => {
  it('iac-ref는 속성 참조를 리소스에, module과 data 소스는 접두까지 보고 잇는다', () => {
    const r = run(
      'iac-ref',
      [
        'aws_lb.main.arn',
        '${module.vpc.private_subnets}',
        'data.aws_iam_policy.read.json',
        'Secret/db',
      ],
      ['aws_lb.main', 'module.vpc', 'data.aws_iam_policy.read', 'secret/db'],
    );
    expect(r.matches).toEqual([
      { refId: 'r0', declId: 'd0' },
      { refId: 'r1', declId: 'd1' },
      { refId: 'r2', declId: 'd2' },
      { refId: 'r3', declId: 'd3' },
    ]);
    expect(run('iac-ref', ['aws_lb.other.arn'], ['aws_lb.main']).unmatched).toEqual([
      { refId: 'r0', reason: 'no_decl', candidates: [] },
    ]);
  });

  it('dataset-io는 dbt ref와 source, 따옴표 친 식별자를 펴고 스키마를 한쪽만 적었으면 테이블 이름으로 찾는다', () => {
    const r = run(
      'dataset-io',
      ["ref('orders')", "source('raw', 'events')", '"Analytics"."Daily"', 'daily'],
      ['orders', 'raw.events', 'analytics.daily'],
    );
    expect(r.matches.map((m) => m.declId)).toEqual(['d0', 'd1', 'd2', 'd2']);
  });

  it('dataset-io는 같은 테이블 이름이 스키마 여럿에 있으면 고르지 않고 후보를 돌려준다', () => {
    const r = run('dataset-io', ['orders', 'raw.orders'], ['raw.orders', 'mart.orders']);
    expect(r.matches).toEqual([{ refId: 'r1', declId: 'd0' }]);
    expect(r.unmatched).toEqual([
      { refId: 'r0', reason: 'multiple_decls', candidates: ['d0', 'd1'] },
    ]);
  });

  it('dataset-io는 양쪽 다 스키마를 적었는데 다르면 잇지 않는다', () => {
    expect(run('dataset-io', ['stage.orders'], ['mart.orders']).unmatched[0]!.reason).toBe(
      'no_decl',
    );
  });

  it('state-value는 대문자 밑줄, 카멜, 하이픈 표기를 같은 값으로 본다', () => {
    const r = run(
      'state-value',
      ['changesRequested', "'changes-requested'", 'ChangesRequested', 'MERGED'],
      ['CHANGES_REQUESTED', 'merged'],
    );
    expect(r.matches.map((m) => m.declId)).toEqual(['d0', 'd0', 'd0', 'd1']);
  });

  it('name-ref는 대소문자만 안 가리고 그대로 비교한다', () => {
    const r = run('name-ref', ['Mailer', 'mail-er'], ['mailer']);
    expect(r.matches).toEqual([{ refId: 'r0', declId: 'd0' }]);
    expect(r.unmatched.map((u) => u.refId)).toEqual(['r1']);
  });
});
