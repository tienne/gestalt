# 플러그인과 같은 버전의 CLI 실행

스킬 본문의 `gestalt ...` 예시는 아래 런처로 실행한다. 전역 `gestalt` 설치는 필요하지 않다.
이 문서가 있는 디렉토리(`.../skills/_shared`)에서 두 단계 위가 플러그인 루트다.
런처는 그 아래 `scripts/gestalt-cli.mjs`에 있다. 예를 들어 문서가 `/cache/gestalt/skills/_shared/cli-launcher.md`이면 런처는 `/cache/gestalt/scripts/gestalt-cli.mjs`다.
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
   터미널 Ctrl-C는 자식도 함께 받으므로 중복 전달하지 않는다. 래퍼 pid만 지정해 취소할 때는 SIGTERM을 사용한다.
   SIGTERM과 SIGHUP은 npm 실행과 버전 확인, 실제 명령에 전달하고 자식 종료를 기다린다.
   npm 실행과 버전 확인 중에는 SIGTERM이나 SIGHUP을 보낸 뒤 5초간 자식이 끝나지 않으면 SIGKILL을 보낸다.
   SIGKILL은 직접 실행한 프로세스 하나에만 보낸다. npm이 신호를 자식에게 넘기지 못하고 멈추면 설치 스크립트 같은 자손은 남을 수 있다.
   이 두 단계에서 SIGINT를 받으면 SIGINT를 다시 전달하지 않고 2초 동안 자식이 스스로 끝나기를 기다린다.
   그래도 남아 있으면 SIGTERM을 보낸다. 래퍼 pid만 받은 SIGINT도 이 경로로 정리된다.
   취소한 뒤에는 임시 디렉토리를 지운다. 오프라인 해석이나 버전 확인이 실패하거나 시간을 넘기면 같은 버전을 온라인으로 한 번 더 시도한다.
   온라인 시도도 실패하거나 시간을 넘기면 사용자 취소가 아닌 오류로 알린다.

npm 해석은 별도의 임시 디렉토리에서 한다. 작업 레포의 로컬 패키지나 다른 버전의 전역 CLI를
선택하지 않으며 `latest`로 떨어지지 않는다.
npm으로 CLI 패키지를 받는 동안에는 알려진 비밀 환경 변수를 npm에 넘기지 않는다.
모델 공급자 접두어(`ANTHROPIC_`, `OPENAI_` 등)로 시작하는 변수와 클라우드, GitHub의 인증 변수(`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN` 등)가 여기에 든다.
이름이 `_API_KEY`, `_PASSWORD`, `_SECRET`, `_AUTH_TOKEN` 등으로 끝나는 변수도 대소문자 구분 없이 제외한다. 이 필터는 알려진 이름과 패턴만 검사한다.
`NPM_*`, `NODE_AUTH_TOKEN`과 `npm_config_*`는 보존한다. 사용자 `.npmrc`와 전역 설정 파일에서 `${NAME}` 또는 `${NAME?}`으로 참조한 변수도 인증에 필요하므로 예외로 남긴다.
사용자 설정 경로는 `npm_config_userconfig` 또는 홈의 `.npmrc`다. 전역 설정은 `npm_config_globalconfig` 또는 npm prefix의 `etc/npmrc`에서 읽는다. prefix를 지정하지 않았으면 Node 설치 경로를 기준으로 한다.
프록시와 CA 설정은 유지하며 최종 CLI에는 원래 환경을 전달한다. 처음 실행할 때 Node.js >=22와 npm, 네트워크가 필요할 수 있다.
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
`xargs`는 자식의 종료 코드 `10`을 그대로 전달하지 않는다. 검사 판정에는 파일별 출력의 `EXIT=` 값을 사용한다. 단일 파일처럼 파일별 표지가 없는 호출에서 종료 코드가 필요하면 `xargs` 대신 런처를 직접 실행한다.
런처를 찾지 못했거나 버전 해석이 실패하면 필수 검사와 그 수치에 의존하는 단계는 중단하고 오류를 알린다.
그 밖의 선택적 단계는 실행하지 못한 단계를 완료 보고에 적는다. 검사 결과를 직접 지어내거나
다른 버전의 실행을 같은 결과로 보고하지 않는다. MCP 도구는 [`tool-availability.md`](./tool-availability.md)를 따른다.
