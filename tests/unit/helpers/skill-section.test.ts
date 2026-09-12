import { describe, expect, it } from 'vitest';
import { freeVariables } from '../../helpers/skill-section.js';

/**
 * 이 헬퍼는 스킬 문서의 셸 블록이 앞 블록 변수에 기대는지를 본다. 블록은 각각 다른
 * Bash 호출로 실행되므로 그런 참조가 빈 문자열로 풀리고, 그 값이 미대응 수이면 승인이
 * 조용히 열린다. 검사가 놓치면 그 회귀가 그대로 지나가므로 헬퍼 자체를 고정한다.
 */
describe('셸 블록이 자기 안에서 정의하지 않고 쓰는 변수', () => {
  describe('참조로 센다', () => {
    it.each([
      ['평범한 참조', 'echo "$a"', ['a']],
      ['중괄호', 'echo "${a}"', ['a']],
      ['기본값 전개', 'echo "${a:-$b}"', ['a', 'b']],
      ['접두 제거', 'echo "${a#$b}"', ['a', 'b']],
      ['간접 참조', 'echo "${!a}"', ['a']],
      ['배열 인덱스', 'echo "${arr[i]}"', ['arr', 'i']],
      ['백틱 명령 치환', 'x=`cat $f`', ['f']],
      ['명령 치환', 'x=$(cat "$f")', ['f']],
      ['산술 전개 — 달러 없이', 'n=$((count + 1))', ['count']],
      ['산술 전개 — 괄호 중첩', 'n=$(( (a + b) * c ))', ['a', 'b', 'c']],
      ['달러 없는 산술', '((n++))', ['n']],
    ])('%s', (_name, block, expected) => {
      expect(freeVariables(block)).toEqual(expected);
    });

    /**
     * 큰따옴표 안의 작은따옴표는 리터럴을 열지 않는다. 정규식으로 한 번에 지우면
     * 가운데가 통째로 사라져 그 사이 참조를 놓친다.
     */
    it('큰따옴표 안 아포스트로피가 참조를 삼키지 않는다', () => {
      expect(freeVariables(`echo "it's $a and it's $b"`)).toEqual(['a', 'b']);
    });
  });

  describe('참조가 아니다', () => {
    it.each([
      ['작은따옴표 리터럴', "echo 'literal $nope'"],
      ['jq 필터 안', `x=$(echo '{}' | jq -r '.a // $nope')`],
      ['인용 heredoc', "cat <<'EOT'\n$nope\nEOT"],
      ['들여쓴 인용 heredoc', "cat <<-'EOT'\n\t$nope\n\tEOT"],
    ])('%s', (_name, block) => {
      expect(freeVariables(block)).toEqual([]);
    });

    it('인용 안 한 heredoc 안은 전개된다', () => {
      expect(freeVariables('cat <<EOT\n$a\nEOT')).toEqual(['a']);
    });
  });

  describe('정의로 센다', () => {
    it.each([
      ['대입', 'a=1\necho "$a"'],
      ['덧붙이는 대입', 'a=1\na+=2\necho "$a"'],
      ['local', 'local a=1\necho "$a"'],
      ['export', 'export a=1\necho "$a"'],
      ['readonly', 'readonly a=1\necho "$a"'],
      ['declare', 'declare a=1\necho "$a"'],
      ['read 와 herestring', 'read -r a b <<<"1 2"\necho "$a$b"'],
      ['파이프로 받는 read', 'echo x | while read -r line; do echo "$line"; done'],
      ['for in', 'for f in a b; do echo "$f"; done'],
      ['C 스타일 for', 'for ((i=0; i<3; i++)); do echo "$i"; done'],
    ])('%s', (_name, block) => {
      expect(freeVariables(block)).toEqual([]);
    });

    it('허용 목록에 있으면 뺀다', () => {
      expect(freeVariables('echo "$loopTmp"', ['loopTmp'])).toEqual([]);
    });

    it('셸이 주는 변수는 안 센다', () => {
      expect(freeVariables('echo "$HOME $PATH $IFS"')).toEqual([]);
    });
  });

  it('정의를 지우면 잡는다 — 이 검사가 막으려는 회귀다', () => {
    const selfContained = 'me=$(cat login)\njq --arg me "$me" .';
    expect(freeVariables(selfContained)).toEqual([]);
    const broken = selfContained.split('\n').slice(1).join('\n');
    expect(freeVariables(broken)).toEqual(['me']);
  });
});
