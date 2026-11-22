import { assert, test } from 'orca/testing'
import { esc } from './html'

test('esc는 다섯 글자를 바꿔 텍스트와 속성값 어디에 넣어도 태그나 속성이 안 열린다', () => {
  assert.equal(esc(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;')
})

test('esc는 이미 바꾼 글자도 한 번 더 바꿔 원문 그대로 보이게 한다', () => {
  assert.equal(esc('&amp; &lt;'), '&amp;amp; &amp;lt;')
})

test('esc는 null과 undefined를 빈 문자열로, 숫자는 문자열로 바꾼다', () => {
  assert.equal(esc(null), '')
  assert.equal(esc(undefined), '')
  assert.equal(esc(0), '0')
})
