import { describe, expect, it } from 'vitest';
import { createPiiRedactor } from '../../../src/research/pii.js';

const pii = createPiiRedactor('test-seed');

describe('개인정보 가짜 값 치환', () => {
  it('전화번호는 지역번호만 남기고 같은 값에 같은 가명을 준다', () => {
    const a = pii.redactText('연락처 010-1234-5678 입니다').text;
    const b = pii.redactText('다시 010-1234-5678 로 연락').text;
    expect(a).not.toContain('1234');
    expect(a).toMatch(/010-0000-\d{4}/);
    const tailA = /010-0000-(\d{4})/.exec(a)![1];
    const tailB = /010-0000-(\d{4})/.exec(b)![1];
    expect(tailA).toBe(tailB);
  });

  it('구분자 없는 번호도 길이를 유지한다', () => {
    const out = pii.redactText('01012345678').text;
    expect(out).toHaveLength(11);
    expect(out.startsWith('010')).toBe(true);
    expect(out).not.toBe('01012345678');
  });

  it('이메일은 example.com 가명으로 바꾸고 이미 가명이면 건너뛴다', () => {
    const out = pii.redactText('문의 hong.real@company.co.kr').text;
    expect(out).toMatch(/user\d{3}@example\.com/);
    expect(out).not.toContain('company');
    expect(pii.redactText('user100@example.com').spans).toHaveLength(0);
  });

  it('라벨 뒤 이름은 같은 글자 수 가명으로 바꾸고 님은 유지한다', () => {
    const out = pii.redactText('수령인 김민준님').text;
    expect(out).not.toContain('민준');
    expect(out.endsWith('님')).toBe(true);
    const name = out.replace('수령인 ', '').replace('님', '');
    expect(name).toHaveLength(3);
  });

  it('라벨 없는 이름님은 성씨로 시작할 때만 바꾼다', () => {
    expect(pii.redactText('박서준님 환영합니다').text).not.toContain('서준');
    expect(pii.redactText('고객님 환영합니다').text).toBe('고객님 환영합니다');
  });

  it('앱이 별표로 가린 이름님도 성씨로 시작하면 가명으로 바꾼다', () => {
    const out = pii.redactText('백도*님의 상품권 총액').text;
    expect(out).not.toContain('백도');
    expect(out).not.toContain('*');
    expect(out).toContain('님의 상품권 총액');
    expect(pii.redactText('백*님').spans).toHaveLength(1);
    expect(pii.redactText('고객*님 환영합니다').spans).toHaveLength(0);
    expect(pii.redactText('라이*님 환영합니다').spans).toHaveLength(0);
  });

  it('주민등록번호와 카드 번호를 바꾼다', () => {
    const rrn = pii.redactText('900101-1234567').text;
    expect(rrn).toMatch(/^\d{6}-1000000$/);
    const card = pii.redactText('1234-5678-9012-3456').text;
    expect(card).toMatch(/^0000-0000-0000-\d{4}$/);
  });

  it('생년월일은 같은 형식의 가짜 날짜로 바꾼다', () => {
    const out = pii.redactText('생년월일 1992.03.15').text;
    expect(out).toMatch(/생년월일 \d{4}\.\d{2}\.\d{2}/);
    expect(out).not.toContain('1992.03.15');
  });

  it('주소는 가짜 도로명 주소로 바꾼다', () => {
    const out = pii.redactText('배송지 서울특별시 강남구 테헤란로 123 4층').text;
    expect(out).toContain('서울특별시 샘플구 예시로');
    expect(out).not.toContain('테헤란');
  });

  it('상품권 바코드와 핀 번호는 형태를 유지하며 바꾼다', () => {
    const out = pii.redactText('핀 번호 1234 5678 9012 3456').text;
    expect(out).not.toContain('1234 5678');
    const bare = pii.redactText('코드 1234567890123456').text;
    expect(bare).not.toContain('1234567890123456');
  });

  it('주문 번호는 문자 자리를 지키고 숫자만 바꾼다', () => {
    const out = pii.redactText('주문번호 A20261016-0012345').text;
    expect(out.startsWith('주문번호 ')).toBe(true);
    expect(out).not.toContain('0012345');
  });

  it('사업자 정보 줄은 대표자 이름과 등록 번호까지 함께 바꾼다', () => {
    const out = pii.redactText(
      '대표이사 서지훈 사업자등록번호 123-45-67890 통신판매업신고번호 2024-서울강남-01234 주소 서울특별시 강남구 테헤란로 123',
    ).text;
    expect(out).not.toContain('서지훈');
    expect(out).not.toContain('67890');
    expect(out).not.toContain('01234');
    expect(out).not.toContain('테헤란로 123');
    expect(out).toMatch(/사업자등록번호 000-00-0\d{4}/);
    expect(out).toContain('서울강남');
  });

  it('콜론이 붙은 대표 라벨만 이름으로 본다', () => {
    expect(pii.redactText('대표: 서지훈').text).not.toContain('서지훈');
    expect(pii.redactText('대표 이미지').spans).toHaveLength(0);
  });

  it('사업자 번호는 같은 값에 같은 가명을 주고 라벨과 입력 속성 힌트로도 정한다', () => {
    const a = pii.redactText('사업자등록번호: 123-45-67890').text;
    const b = pii.redactText('다시 사업자등록번호 123-45-67890').text;
    expect(a.match(/0\d{4}$/)![0]).toBe(b.match(/0\d{4}$/)![0]);
    expect(pii.redactText('123-45-67890', 'biz').text).not.toContain('67890');
    expect(pii.labelKindOf('사업자등록번호')).toBe('biz');
    expect(pii.kindFromHints('name=business_no')).toBe('biz');
  });

  it('seed가 다르면 같은 값도 다른 가명이 나온다', () => {
    const other = createPiiRedactor('other-seed');
    const outs = new Set<string>();
    for (const p of [pii, other, createPiiRedactor('third')]) {
      outs.add(p.redactText('user@real.com').text);
    }
    expect(outs.size).toBeGreaterThan(1);
  });

  it('라벨이 따로 떨어진 글자에는 문맥 종류로 판정한다', () => {
    expect(pii.labelKindOf('수령인')).toBe('name');
    expect(pii.labelKindOf('휴대폰 번호:')).toBe('phone');
    expect(pii.labelKindOf('오늘의 추천 상품')).toBeNull();
    const ctx = pii.redactText('홍실제', 'name');
    expect(ctx.spans).toHaveLength(1);
    expect(ctx.text).not.toBe('홍실제');
  });

  it('개인정보가 없는 글은 그대로 둔다', () => {
    const plain = '지금 구매하면 최대 10% 할인, 2026년 10월 16일까지';
    expect(pii.redactText(plain).text).toBe(plain);
  });

  it('입력 속성 힌트로 종류를 정한다', () => {
    expect(pii.kindFromHints('autocomplete=tel')).toBe('phone');
    expect(pii.kindFromHints('name=email')).toBe('email');
    expect(pii.kindFromHints('class=title')).toBeNull();
  });
});
