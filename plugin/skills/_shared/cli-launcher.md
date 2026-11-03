# 플러그인과 같은 버전의 CLI 실행

스킬 본문의 `gestalt ...` 예시는 아래 런처로 실행한다. 전역 `gestalt` 설치는 필요하지 않다.
이 문서를 읽은 **실제 절대 경로**에서 `../../scripts/gestalt-cli.mjs`를 계산한다.
현재 작업 레포의 동명 파일이나 `bin/gestalt.ts`를 찾아 실행하지 않는다.

```bash
node "/플러그인/절대경로/scripts/gestalt-cli.mjs" humanize-scan --file "$scanTmp/report.md" --register report
```

루트 `skills` 심링크로 읽었다면 먼저 이 문서 경로를 `realpath`로 풀고 부모 경로를 계산한다.
런처는 자신의 위치를 기준으로 다음을 수행한다.

1. `.codex-plugin/plugin.json`에서 설치된 플러그인의 버전을 읽는다. 버전을 모르면 중단한다.
2. 로컬 의존성이 있는 게슈탈트 개발 체크아웃이면 그 TypeScript 엔트리를 사용한다.
   같은 버전의 npm 설치본 안에 빌드된 CLI가 있으면 그 엔트리를 사용한다.
   소스만 있고 의존성이 없는 플러그인 설치본은 다음 npm 해석 단계로 진행한다.
3. 설치된 복사본이면 npm 캐시에서 정확히 같은 `@tienne/gestalt@<version>`을 해석하고
   캐시가 없으면 같은 버전을 다운로드한다. 패키지 이름과 버전, 실제 CLI 버전을 확인한다.
4. 실제 명령은 원래 작업 디렉토리에서 실행하며 stdin, 인자, 종료 코드를 보존한다.

npm 해석은 별도의 임시 디렉토리에서 한다. 작업 레포의 로컬 패키지나 다른 버전의 전역 CLI를
선택하지 않으며 `latest`로 떨어지지 않는다. 처음 실행할 때 Node.js >=22와 npm, 네트워크가 필요할 수 있다.
셸 함수가 필요하면 명령을 문자열 변수로 합치지 말고 인자를 그대로 넘긴다.

```bash
gestalt() { node "/플러그인/절대경로/scripts/gestalt-cli.mjs" "$@"; }
```

셸 함수는 `xargs`의 외부 실행 파일이 아니다. **파이프라인과 `xargs`를 포함한 모든 예시**에서도
`gestalt`를 `node`와 런처의 절대 경로로 치환한다. 함수 선언만 하고 `xargs gestalt`를 실행하지 않는다.

```bash
find "$scanTmp" -name '*.md' -print0 | xargs -0 node "/플러그인/절대경로/scripts/gestalt-cli.mjs" humanize-scan --register chat
```

`humanize-scan`의 종료 코드 `10`은 검사 실행 실패가 아니라 탐지 없음이다. 그 명령의 계약대로 읽는다.
런처를 찾지 못했거나 버전 해석이 실패하면 필수 검사와 그 수치에 의존하는 단계는 중단하고 오류를 알린다.
그 밖의 선택적 단계는 실행하지 못한 단계를 완료 보고에 적는다. 검사 결과를 직접 지어내거나
다른 버전의 실행을 같은 결과로 보고하지 않는다. MCP 도구는 [`tool-availability.md`](./tool-availability.md)를 따른다.
