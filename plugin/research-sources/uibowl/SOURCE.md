---
name: uibowl
description: 유아이볼의 앱 화면 DB에서 화면과 사용자 흐름을 찾는다
stage: [screen-map, product-discovery]
axis: [same-market, same-problem]
access:
  - mcp: { server: uibowl }
  - browser: { site: uibowl.io, login: human }
evidence: observation
limits: "무료 계정은 MCP 검색당 3개, 웹 앱당 8장만 본다. 화면 수집 시점이 지금이 아닐 수 있다"
fallback: "화면은 직접 앱을 탐색하거나 스토어 스크린샷으로 채운다"
---

## 찾는 법

1. MCP(`uibowl`)가 연결돼 있으면 화면 유형, 사용자 흐름, 화면 속 문구, 컴포넌트로 검색한다. 결과는 이미지와 유아이볼 화면 링크로 온다.
2. MCP가 없으면 로그인된 브라우저 세션에서 `https://uibowl.io/name/<앱이름>`을 연다. 앱이 있는지는 로그인 없이 `https://uibowl.io/server-sitemap.xml`로 먼저 확인한다.
3. 화면은 클라이언트에서 그려지므로 curl로는 이미지가 안 나온다. 브라우저 세션으로 본다.
4. 캡처는 `kind: reference-db`로 두고 `sourceNote`에 `유아이볼, 수집 시점 확인 못함`을 적어 직접 캡처와 구분한다.

## 멈추는 곳

- 로그인은 사람이 한다. 비밀번호나 인증 코드를 대신 입력하지 않는다.
- 결제나 멤버십 업그레이드 화면이 나오면 멈춘다.
- 사람 속도로 필요한 화면만 연다. 한꺼번에 많은 앱을 훑지 않는다.
- 이미지를 내려받아 저장하기 전에 개인정보 치환을 거친다.
