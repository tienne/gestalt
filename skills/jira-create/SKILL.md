---
name: jira-create
version: "1.0.0"
description: "지라 티켓을 jira-writer로 구조화해 승인 게이트를 거친 뒤 Atlassian MCP로 생성한다. '티켓 만들어줘/이슈 생성해줘/지라에 올려줘' 요청 시 자동 발동. jira-writer로 본문 → 프로젝트·이슈타입·필수필드 확정 → 미리보기 승인 → createJiraIssue."
triggers:
  - "지라 티켓"
  - "지라 이슈"
  - "티켓 만들어"
  - "티켓 생성"
  - "이슈 만들어"
  - "이슈 생성"
  - "지라에 올려"
  - "지라에 등록"
  - "백로그에 추가"
  - "jira 티켓"
  - "jira 이슈"
  - "create jira"
inputs:
  request:
    type: string
    required: false
    description: "티켓으로 만들 요청·상황(버그 현상, 기능 요청 등)"
  project:
    type: string
    required: false
    description: "대상 프로젝트키(예: FE, WEB). 비우면 생성 단계에서 후보를 보여주고 확인"
  issueType:
    type: string
    required: false
    description: "이슈타입(Bug/Story/Task/Epic). 비우면 jira-writer 추천값으로 확인"
outputs:
  - created_issue_key_and_link
---

# Jira Create Skill

지라 티켓을 **jira-writer로 구조화 → 프로젝트·필드 확정 → 승인받고 → 생성**하는 파이프라인.
`jira-writer` role agent(본문 작성)와 Atlassian MCP(생성)를 잇는다.

> **불변 규칙: 승인 없이는 절대 생성하지 않는다.** 미리보기(프로젝트·이슈타입·요약·설명·AC)를 보여주고 명시적 "OK"를 받은 뒤에만 `createJiraIssue`를 호출한다. 티켓은 팀 백로그에 남는 외부 산출물이라 오생성 시 정리가 번거롭다 — 이게 스킬의 존재 이유다.

## 파이프라인

### 1. 입력 수집

요청에서 파악한다. 빠진 건 되묻되, 본문 세부는 다음 단계(jira-writer)에서 채운다.

- **요청 내용**: 티켓으로 만들 상황(필수). 없으면 물어본다.
- **대상 프로젝트**: 명시 없으면 3단계에서 후보를 보여주고 확인. **추측해서 아무 프로젝트에 만들지 않는다.**
- **이슈타입**: 명시 없으면 jira-writer 추천값으로 4단계 미리보기에서 확인.

### 2. 본문 작성 (jira-writer)

`jira-writer` role agent로 티켓 본문을 구조화한다.

```
/agent jira-writer "<요청 상황 원문>"
```

- 에이전트가 이슈타입·요약·설명·AC·제안 메타를 반환한다.
- `[???]`나 `[확인 필요]`로 남긴 항목이 있으면 **여기서 채워 받는다** — 빈 재현 절차·모호한 AC 채로 생성하지 않는다.

### 3. 대상 확정 (cloudId → projectKey → issueType)

Atlassian MCP로 시스템 값을 확정한다. 추측 금지.

1. **cloudId**: `getAccessibleAtlassianResources`로 접근 가능한 사이트 확인. 여러 개면 사용자에게 어느 사이트인지 확인.
2. **프로젝트**: `getVisibleJiraProjects`로 후보 조회. 입력에 프로젝트키가 없거나 여러 개 매칭되면 **후보를 보여주고 사용자가 선택**하게 한다(오생성 1순위 원인).
3. **이슈타입 + 필수필드**: `getJiraProjectIssueTypesMetadata`로 해당 프로젝트가 지원하는 이슈타입 확인 → `getJiraIssueTypeMetaWithFields`로 **필수 필드**를 확인한다. 프로젝트마다 필수 커스텀 필드(컴포넌트, 스프린트, Epic Link 등)가 다르므로 required 필드가 비면 사용자에게 물어 채운다.
4. **담당자**(선택): 지정 요청이 있으면 `lookupJiraAccountId`로 accountId 확정.

### 4. 미리보기 + 승인 게이트 (필수)

아래를 한 화면에 모아 보여주고 명시적 승인을 받는다.

```
[사이트]     catchtable.atlassian.net
[프로젝트]   FE — 프론트엔드 (FE)
[이슈타입]   Bug
[우선순위]   High
[담당자]     (미지정)
[요약]       토큰 만료 시 자동 재발급 실패로 강제 로그아웃됨
[설명]
<jira-writer가 구조화한 본문 전문 — 현상/재현/기대/실제/영향>

이대로 생성할까요? (수정할 곳 있으면 말씀해주세요)
```

- 사용자가 "OK/만들어/응" 등 **명시 승인**하기 전엔 5단계로 넘어가지 않는다.
- 수정 요청이 오면 2단계(본문) 또는 3단계(프로젝트·필드)로 돌아가 고치고 재확인한다.
- 승인이 모호하면("음..", "글쎄") 생성하지 말고 재확인한다.

### 5. 생성

승인 후에만 호출한다.

- `createJiraIssue(cloudId, projectKey, issueTypeName, summary, description, ...필수필드)`
- 필수 필드가 하나라도 비어 있으면 호출하지 않고 3단계로 돌아간다.

### 6. 완료 보고

생성된 **이슈 키(FE-1234)와 브라우저 링크**를 사용자에게 돌려준다. 후속으로 하위 태스크·연관 이슈 링크(`createIssueLink`)가 필요한지 한 줄로 물어본다.

## Do-NOT

- **승인 전 생성 금지.** 미리보기·승인을 건너뛰지 않는다.
- **프로젝트 불명확 시 생성 금지.** 하나로 특정되지 않으면 후보를 보여주고 물어본다.
- 재현 절차·수치·담당자를 지어내 채우지 않는다(`[???]`로 남기고 확인).
- 필수 필드를 임의값으로 채워 생성하지 않는다 — 모르면 물어본다.
- 한 요청에 여러 티켓 동시 대량 생성은 하지 않는다(요청이 명확해도 건별로 확인).

## 에러 처리

| 상황 | 대응 |
|------|------|
| 프로젝트 조회 0건/다수 | 후보 보여주고 사용자에게 선택 요청 |
| 필수 필드 누락 | 어떤 필드가 필요한지 알리고 값 확인 |
| 이슈타입 미지원(프로젝트에 없음) | 지원 타입 목록 보여주고 재선택 |
| 생성 실패(권한/필드 검증) | Atlassian 에러 메시지 그대로 보고, 재시도 여부 확인 |
| 승인 응답 모호 | 생성 보류, 명시 승인 재요청 |
