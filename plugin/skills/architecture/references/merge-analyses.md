1. **합칠 IR을 모은다.** 각 분석의 `.gestalt/architecture/<view>.json`이다. 뷰가 같은 것끼리만 합친다. screen-chain과 deploy-path는 따로 합친다.
2. **`repos[].remote`를 확인한다.** 레포가 같은지는 별칭이 아니라 remote로 판단한다. remote가 비어 있으면 같은 레포인데도 따로 그려진다. 비어 있으면 그 레포에서 `git remote get-url origin`으로 채운 뒤 합친다.
3. **merge를 부른다.** 큰 IR은 요청과 응답에 통째로 싣지 말고 파일로 주고받는다.

   ```json
   {
     "action": "merge",
     "irPaths": ["<a>/screen-chain.json", "<b>/screen-chain.json"],
     "outPath": "<work>/merged.json",
     "groupNames": ["제품 A", "제품 B"],
     "prefixCandidates": ["/api"]
   }
   ```

   `prefixCandidates`는 Step 3-2에서 찾은 `gateway` prefix다. 한쪽 FE 경로에는 붙고 다른 쪽 BE 라우트에는 없는 prefix가 있으면 넣는다. `groupNames`에 제품 이름을 `irPaths` 순서대로 넣는다. 안 넣으면 입력의 서비스 이름이 붙는다.

4. **report를 읽는다.**
   - `sharedNodes`: 두 분석에 다 있던 노드. 같이 쓰는 `gateway`와 서버가 여기 나온다. 기대한 노드가 빠졌으면 두 IR의 label 꼴이 다른 것이다. 합친 IR을 고치지 말고 원래 분석의 label을 Step 3 꼴로 맞춰 다시 render한 뒤 다시 합친다.
   - `crossRepoEdges`: 레포를 넘는 매칭으로 새로 그은 `handles` 엣지
   - `conflictQuestions`: 같은 노드인데 표시 이름이나 parent가 갈려서 만든 질문. merge는 한쪽을 고르지 않는다. 값을 비우고 묻는다. `user` 근거가 있는 쪽 값은 그대로 둔다.
   - `micro_app`은 레포가 달라도 label이 같으면 한 노드로 모인다. 호스트 레포의 분석과 리모트 레포의 분석을 합치면 리모트 앱이 하나로 합쳐지고 리모트 쪽 기능영역과 사슬이 그 앱 아래 붙는다. 두 제품이 같은 리모트를 각자 자기 서비스에 달았으면 parent를 비운다. 이 경우는 질문을 만들지 않는다. 공유 리모트는 어느 한 서비스 것이 아니라서다.
   - `islands`: 1보다 크면 서로 안 이어진 분석이 있다. 겹치는 게 정말 없는지, label이나 remote가 어긋난 건지 확인한다.
5. **validate와 render를 그대로 탄다.** 합친 IR에는 제품마다 그룹(`groups`)이 붙는다. render가 맨 위에 같이 쓰는 띠를, 그 아래로 제품마다 전용 띠를 나눠 그린다. 같이 쓰는 `gateway`와 서버, 저장소는 맨 위 띠에 모이고 카드 위에 그 카드를 쓰는 제품 브릭이 꽂힌다. 제품이 셋 이상이어도 같다. `irPath`로 합친 파일을 넘긴다. **`repoRoot`는 원래 분석 레포가 아닌 따로 둔 디렉토리로 준다.** render는 `repoRoot`의 같은 뷰 IR과 병합하므로 원래 레포를 주면 그 레포의 단독 분석이 합친 결과로 덮인다. 입력의 `root`가 상대 경로였으면 `checkFiles: false`로 그린다.
6. **질문별 그림과 팩도 따라온다.** 입력마다의 질문별 그림은 나란히 들어가고 id가 부딪히면 `-2`가 붙는다. 입력 중 하나라도 `packs`를 적었으면 결과는 입력들 팩의 합집합이다. `packs`를 안 적은 입력은 `web-product`와 `harness`로 친다.
7. **충돌 질문은 Step 7처럼 사용자에게 묻는다.** 답은 원래 분석 쪽에 `user` 근거로 남기고 다시 합친다. 합친 IR에만 고쳐 두면 다음에 합칠 때 같은 질문이 또 생긴다.

보고에는 Step 8의 세 덩어리에 더해 `sharedNodes`(같이 쓰는 노드 이름과 레포), `crossRepoEdges` 수, 충돌 질문 목록을 적는다.
