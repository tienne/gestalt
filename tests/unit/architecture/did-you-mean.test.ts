import { describe, expect, it } from 'vitest';
import {
  editDistance,
  suggestOne,
  suggestionThreshold,
} from '../../../src/architecture/did-you-mean.js';

describe('editDistance', () => {
  it('같은 문자열은 0이고 대소문자는 무시한다', () => {
    expect(editDistance('label', 'label')).toBe(0);
    expect(editDistance('Label', 'label')).toBe(0);
  });

  it('인접 글자 맞바꿈은 1로 센다', () => {
    expect(editDistance('lable', 'label')).toBe(1);
  });

  it('넣기, 빼기, 바꾸기를 1씩 센다', () => {
    expect(editDistance('discription', 'description')).toBe(1);
    expect(editDistance('descriptio', 'description')).toBe(1);
    expect(editDistance('', 'abc')).toBe(3);
  });
});

describe('suggestionThreshold', () => {
  it('길이의 1/3, 최소 1, 최대 3', () => {
    expect(suggestionThreshold('id')).toBe(1);
    expect(suggestionThreshold('label')).toBe(1);
    expect(suggestionThreshold('evidence')).toBe(2);
    expect(suggestionThreshold('discription')).toBe(3);
    expect(suggestionThreshold('averyveryverylongfieldname')).toBe(3);
  });
});

describe('suggestOne', () => {
  const keys = ['id', 'kind', 'label', 'description', 'displayName', 'evidence', 'repo'];

  it('가장 가까운 후보 하나만 돌려준다', () => {
    expect(suggestOne('discription', keys)).toBe('description');
    expect(suggestOne('lable', keys)).toBe('label');
  });

  it('문턱을 넘으면 제안하지 않는다', () => {
    expect(suggestOne('zzzzzz', keys)).toBeUndefined();
    expect(suggestOne('owner', keys)).toBeUndefined();
  });

  it('입력과 같은 후보는 제안이 아니다', () => {
    expect(suggestOne('label', ['label'])).toBeUndefined();
  });

  it('거리가 같으면 후보 순서를 따른다', () => {
    expect(suggestOne('ab', ['ac', 'ad'])).toBe('ac');
    expect(suggestOne('ab', ['ad', 'ac'])).toBe('ad');
  });
});
