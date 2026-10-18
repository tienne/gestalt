---
name: app-store-reviews
description: 앱스토어 리뷰 RSS에서 사용자가 같이 쓰는 다른 서비스 이름을 뽑는다
stage: [product-discovery, evidence]
axis: [same-problem]
access:
  - http: { host: itunes.apple.com }
evidence: observation
limits: "한 번에 최근 리뷰 50개 정도만 줘서 표본이 작다"
fallback: "후보 확장은 검색어를 바꿔 앱스토어 검색을 반복하는 것으로 대신한다"
---

## 찾는 법

1. 후보 앱의 번들이 아니라 스토어 앱 ID(숫자)를 쓴다. 앱스토어 검색 결과의 `trackId`다.
2. `https://itunes.apple.com/kr/rss/customerreviews/page=1/id=<앱ID>/sortby=mostrecent/json`을 GET으로 부른다.
3. 리뷰 본문에서 다른 서비스 이름이 나온 것을 센다. 나온 횟수는 `foundVia.reviewMentions`에 적는다.
4. 상위 후보의 리뷰에서 새 이름을 뽑고 그 앱의 리뷰를 다시 본다. 새 이름이 안 나오면 멈춘다.
5. 리뷰 문장을 인용할 때는 작성자 이름과 닉네임을 빼고 문장만 적는다.

## 멈추는 곳

- 리뷰에 개인정보(전화번호, 주문 번호)가 섞여 있으면 인용하지 않는다.
- 같은 앱을 반복해서 빠르게 부르지 않는다. 앱마다 한 번이면 된다.
- 표본이 작아서 이름이 한두 번 나온 것은 후보로 올리지 않고 `foundVia`에 참고로만 둔다.
