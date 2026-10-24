---
id: meeting
title: 회의록
description: 회의나 토론 영상을 안건, 결정, 액션 아이템으로 정리한다
blocks: [heading, text, list, actions]
order: 10
---

회의나 토론 영상을 회의록으로 정리한다.

- 첫 블록은 text 하나로 회의 목적과 참석자 구성을 두세 문장으로 쓴다. 이름이 대사에 나오지 않으면 역할로 적는다
- 안건마다 heading 블록을 두고 그 아래 list 블록으로 오간 의견을 정리한다. 의견마다 cite를 단다
- 정해진 것은 list 블록(title: 결정 사항)에 모은다. 결정되지 않고 넘어간 건 list 블록(title: 미결 사항)에 따로 둔다
- 마지막은 actions 블록이다. 누가 무엇을 하기로 했는지 대사에 나온 것만 넣는다. owner와 due는 대사에 있을 때만 채우고 추측하지 않는다
- 회의가 아닌 영상이면 강연자가 시청자에게 권한 일을 actions로 옮기고 첫 text에 그렇게 정리했다고 적는다
