// `orca plugin check`는 시나리오마다 진짜 워커를 띄운다. 실제 컨덕터 저장소를 안 건드리게
// 저장소와 gestalt 경로를 모두 레포 안 픽스처로 돌린다.
import { defineCheck } from 'orca/testing'

const path = (rel: string) => decodeURIComponent(new URL(rel, import.meta.url).pathname)
const FAKE = path('../test/fake-gestalt.mjs')

export default defineCheck({
  missing: { settings: { gestaltPath: FAKE, stateDir: path('../test/fixtures/empty') } },
  busy: {
    settings: { gestaltPath: FAKE, stateDir: path('../test/fixtures/busy') },
    results: {
      'workspace.list': {
        workspaces: [
          {
            id: 'ws-a1',
            kind: 'worktree',
            name: 'ord-a1-1',
            path: '/workspaces/web/ord-a1-1',
            branch: 'ord-a1',
            project: '웹 프론트',
            hostId: 'local'
          },
          {
            id: 'ws-feat',
            kind: 'worktree',
            name: 'feat-search',
            path: '/w/web/feat-search',
            branch: 'feat/search',
            hostId: 'local'
          }
        ],
        truncated: false
      }
    }
  },
  'cli-missing': {
    settings: { gestaltPath: path('../test/no-such-gestalt'), stateDir: path('../test/fixtures/busy') }
  }
})
