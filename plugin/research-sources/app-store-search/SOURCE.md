---
name: app-store-search
description: 앱스토어 검색 API로 제품 후보와 평점 수(규모 짐작)를 찾는다
stage: [product-discovery, scale]
axis: [same-market, same-problem]
access:
  - http: { host: itunes.apple.com, probe: "https://itunes.apple.com/search?term=gift&country=kr&entity=software&limit=1" }
evidence: observation
limits: "큰 앱 안의 기능은 검색 결과에 안 나온다. 평점 수는 규모의 대용치이지 사용자 수가 아니다"
fallback: "기술 블로그와 웹 검색으로 후보를 찾는다"
---

## 찾는 법

1. 사용자가 그 기능을 부르는 일반 말로 검색어를 정한다. 한 가지로 끝내지 않고 비슷한 말로 두세 번 더 돌린다.
2. `https://itunes.apple.com/search?term=<검색어>&country=kr&entity=software&limit=50`을 GET으로 부른다. 키는 필요 없다.
3. 결과의 장르(`primaryGenreName`), 평점 수(`userRatingCount`), 번들 ID(`bundleId`), 설명(`description`)을 읽는다.
4. 장르와 설명에 검색어가 있는지로 먼저 거른다. 남은 것은 같은 시장인지 같은 문제인지 판단해 후보로 올린다. 리워드 앱, 게임, 매장 앱이 섞여 나온다.
5. 평점 수는 `scale`에 `store-rating-count`로 적는다. 규모를 짐작한 것이라 `(해석)`을 붙인다.

## 멈추는 곳

- 검색어에 공개 전 기획 내용(내부 기능 이름, 가격, 출시 일정)을 넣지 않는다. 사용자가 부르는 일반 말만 쓴다.
- 요청이 막히거나 오류가 반복되면 간격을 두고 한 번만 다시 시도한 뒤 건너뛴다.
- 큰 플랫폼 앱 안의 기능은 이 출처로 안 나온다. 기술 블로그와 화면 지도 단계에서 찾는다.
