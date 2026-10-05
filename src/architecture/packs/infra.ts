import { classLook } from './render-classes.js';
import type { VocabularyPack } from './types.js';

/**
 * 네트워크와 실행 환경. 네트워크 안에 서브넷, 그 안에 클러스터와 워크로드가 들어간다.
 * 포함 관계가 깊어서 parent 나무로 한 단계씩 내려가며 본다
 */
export const INFRA_PACK = {
  id: 'infra',
  title: '인프라',
  description: '네트워크, 서브넷, 클러스터, 워크로드, 방화벽',
  requires: ['generic'],
  drilldown: 'tree',
  matchers: ['iac-ref'],
  nodeKinds: {
    firewall: {
      ...classLook('gateway', '방화벽', '드나드는 통신을 거르는 관문'),
      lane: 'infra_edge',
      rank: 0,
      parents: ['network', 'subnet'],
    },
    network: {
      ...classLook('infra', '네트워크', '격리된 사설 네트워크'),
      lane: 'infra_net',
      rank: 1,
    },
    subnet: {
      ...classLook('infra', '서브넷', '네트워크 안의 주소 구간'),
      lane: 'infra_net',
      rank: 1,
      parents: ['network'],
    },
    cluster: {
      ...classLook('infra', '클러스터', '워크로드를 띄우는 실행 묶음'),
      lane: 'infra_run',
      rank: 2,
      parents: ['network', 'subnet'],
    },
    workload: {
      ...classLook('service', '워크로드', '클러스터나 서브넷에서 도는 프로그램'),
      lane: 'infra_run',
      rank: 3,
      parents: ['network', 'subnet', 'cluster'],
    },
  },
  lanes: {
    infra_edge: { title: '경계', about: '드나드는 통신을 거르는 방화벽이 서는 칸이에요.' },
    infra_net: { title: '네트워크', about: '네트워크와 서브넷이 서는 칸이에요.' },
    infra_run: { title: '실행', about: '클러스터와 워크로드가 서는 칸이에요.' },
  },
  edgeKinds: {
    peers: {
      text: '피어링',
      about: '두 네트워크를 피어링으로 이은 연결이에요.',
      ends: { from: ['network'], to: ['network'] },
    },
    allows: {
      text: '통신 허용',
      about: '방화벽이 그 대상으로 가는 통신을 허용하는 연결이에요.',
      ends: { from: ['firewall'], to: ['subnet', 'cluster', 'workload'] },
    },
  },
} as const satisfies VocabularyPack;
