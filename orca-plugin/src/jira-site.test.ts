import { assert, test } from 'orca/testing'
import { jiraSiteFromConnection } from './jira-site'

const sites = [
  { id: 'first', siteUrl: 'https://first.atlassian.net/' },
  { id: 'second', siteUrl: 'https://second.atlassian.net/' }
]

test('오르카에서 활성화한 Jira 사이트를 쓰고 활성 사이트가 없으면 선택한 사이트를 쓴다', () => {
  assert.equal(jiraSiteFromConnection({ ok: true, result: { sites, activeSiteId: 'second', selectedSiteId: 'first' } }), 'https://second.atlassian.net')
  assert.equal(jiraSiteFromConnection({ ok: true, result: { sites, selectedSiteId: 'first' } }), 'https://first.atlassian.net')
})

test('연결이 하나면 그 사이트를 쓰고 여러 사이트 중 어느 곳인지 모르면 주소를 만들지 않는다', () => {
  assert.equal(jiraSiteFromConnection({ ok: true, result: { sites: sites.slice(0, 1) } }), 'https://first.atlassian.net')
  assert.equal(jiraSiteFromConnection({ ok: true, result: { sites } }), undefined)
  assert.equal(jiraSiteFromConnection({ ok: false }), undefined)
  assert.equal(jiraSiteFromConnection({ ok: true, result: { sites: [{ id: 'a', siteUrl: 'javascript:alert(1)' }] } }), undefined)
})
