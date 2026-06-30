---
name: brief
version: "1.0.0"
description: "성과 분석·의사결정·기획 문서 작성 스킬. 분기 성과 보고, KPI 회고, 제안서, RFC, 의사결정 메모를 이해관계자 설득용 산문으로 작성한다. '성과 보고서 써줘', '분기 리포트', '제안서 작성', 'RFC 써줘', '의사결정 메모', '성과 분석 문서', '회고 정리', '경영진 보고 자료' 요청에 반드시 사용. 다시 써줘·보완·업데이트 같은 후속 수정도 이 스킬로 처리. 코드·API 기술문서는 technical-writer가 담당하니 제외."
triggers:
  - "성과 보고서"
  - "성과 분석"
  - "분기 리포트"
  - "분기 보고"
  - "KPI 리포트"
  - "제안서 작성"
  - "제안서 써줘"
  - "RFC 써줘"
  - "RFC 작성"
  - "의사결정 메모"
  - "회고 정리"
  - "회고 써줘"
  - "경영진 보고"
  - "성과 문서"
  - "이 문서 다시 써줘"
  - "보고서 보완"
inputs:
  docType:
    type: string
    required: false
    description: "문서 유형: report(성과분석) | retro(회고) | proposal(제안서) | rfc | memo(의사결정). 생략 시 요청 맥락에서 추론하고 모호하면 작성자에게 확인."
  data:
    type: string
    required: false
    description: "지표·회고 자료·결정 맥락 등 입력 데이터. 파일 경로, 붙여넣은 표, 또는 MCP 데이터 소스 참조."
  audience:
    type: string
    required: false
    description: "독자: exec(경영진) | cross-team(타팀) | internal(팀 내부). 톤과 전문 용어 수위를 좌우한다."
outputs:
  - docType
  - draft
  - finalDoc
---

# Brief Skill

성과 분석과 의사결정·기획 문서를 이해관계자 설득용 산문으로 작성합니다. `impact-writer` 에이전트가 초안을 쓰고 `humanize-monolith`가 다듬는 워크플로우입니다. 코드 중심 기술문서(API·README·튜토리얼)는 이 스킬이 아니라 `technical-writer` 영역입니다.

## 사용 방법

```
/brief                          # 유형·데이터를 대화로 수집
/brief report                   # 성과 분석 리포트
/brief proposal "검색 개편 투자 제안"
/brief rfc "이벤트 소싱 도입"
```

## Skill Instructions

### 1단계 — 컨텍스트 확인 (후속 작업 판별)

먼저 이번 요청이 신규 작성인지 기존 문서 수정인지 판별합니다.

- 작성자가 기존 문서나 초안을 주며 "다시 써줘 / 보완 / 업데이트"를 요청하면 → **부분 수정**. 기존 문서를 읽고 피드백받은 부분만 고칩니다. 전체를 새로 쓰지 않습니다.
- 새 주제·새 데이터면 → **신규 작성**. 2단계로 진행합니다.

### 2단계 — 유형 판별과 입력 수집

`docType`이 없으면 요청에서 추론합니다. 성과·지표 → report, 프로젝트 돌아보기 → retro, 투자·리소스 설득 → proposal, 기술 선택 합의 → rfc, 결정 기록 → memo. 모호하면 작성자에게 한 번 확인합니다.

설득 문서의 품질은 입력 데이터에서 갈립니다. 다음이 없으면 작성자에게 요청하고, **없는 수치를 지어내지 않습니다.**

- 성과/회고: 지표 원본(기간·정의·목표값 포함), 전기 대비 비교 기준
- 제안서: 해결하려는 문제의 현재 비용, 기대 효과 근거
- RFC: 검토한 대안들, 제약 조건
- 의사결정 메모: 고려한 선택지, 결정 시점

데이터가 Amplitude·Analytics 같은 MCP 소스에 있으면 해당 도구로 직접 조회해 채울 수 있습니다.

### 3단계 — 게슈탈트 렌즈로 뼈대 잡기 (가볍게)

초안 전에 두 가지만 정합니다.

1. **전경 정하기** — 독자가 가져갈 핵심 메시지 한 문장을 먼저 확정합니다. 이게 문서 맨 앞에 옵니다. "이번 분기 핵심은 X" 한 줄이 안 나오면 데이터를 더 봐야 한다는 신호입니다.
2. **빈틈 점검** — 각 수치에 기준값(목표/전기/비교)과 so-what이 붙는지 확인합니다. 숫자만 있고 "그래서?"가 비면 독자가 메워야 하므로 그 자리를 채울 해석을 준비합니다.

### 4단계 — 초안 작성

`ges_agent { action: "get", name: "impact-writer" }`로 에이전트 시스템 프롬프트를 가져와 적용합니다. 유형별 구조는 `role-agents/impact-writer/references/doc-playbooks.md`, 어투·문체는 `role-agents/impact-writer/references/voice.md`를 따릅니다.

`audience`에 따라 register를 전환합니다 — `exec`(경영진)·`cross-team`(타팀)은 격식체로 결론과 요청을 앞세우고 전문 용어를 풀어 쓰고, `internal`(팀 내부)은 해요체로 솔직하게 씁니다. 어느 쪽이든 사실·수치는 단정하고 해석·추정·권고는 제안형으로 엽니다. `audience`가 불명확하면 cross-team 격식체를 기본으로 잡습니다.

### 5단계 — 윤문 (humanize)

초안 완성 후 `ges_agent { action: "get", name: "humanize-monolith" }`로 S1 규칙을 적용해 번역투와 AI-tell을 제거합니다. 성과·설득 문서는 한국어 자연스러움이 설득력에 직결됩니다.

윤문 시 voice.md 4절의 구분을 humanize에 함께 전달합니다 — 팀 내부 문서의 해석·권고 제안형("~하면 어떨까요?")은 보존하고, 사실·수치를 흐리는 헤징만 단정으로 교정합니다. humanize가 voice를 일괄로 평탄화하지 않게 합니다.

## 테스트 시나리오

**정상 흐름**: `/brief report` + 지표 표 입력 → 유형 report 확정 → 전경 메시지 도출 → 핵심 지표 표 + 잘된 것/아쉬운 것 + 다음 포커스 작성 → humanize → publish-ready 리포트 반환.

**입력 부족 흐름**: `/brief proposal` 만 입력하고 데이터 없음 → 문제의 현재 비용과 기대 효과 근거를 작성자에게 요청 → 데이터 확보 후 작성. 수치를 추측으로 채우지 않음.
