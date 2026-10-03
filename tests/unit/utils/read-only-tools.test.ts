import { describe, it, expect } from 'vitest';
import {
  classifyCliCommand,
  classifyToolName,
  filterReadOnlyTools,
  READ_ONLY_ALLOW_WORDS,
  READ_ONLY_DENY_WORDS,
} from '../../../src/utils/read-only-tools.js';

describe('classifyToolName', () => {
  it('allow 단어만 포함하면 allow 반환', () => {
    expect(classifyToolName('jira_get_issue')).toBe('allow');
    expect(classifyToolName('getPagesInConfluenceSpace')).toBe('allow');
    expect(classifyToolName('slack_read_canvas')).toBe('allow');
    expect(classifyToolName('fetch')).toBe('allow');
    expect(classifyToolName('list_property_annotations')).toBe('allow');
  });

  it('deny 단어가 하나라도 있으면 deny 반환', () => {
    expect(classifyToolName('confluence_update_page_section')).toBe('deny');
    expect(classifyToolName('mcp__x__post_api_v1_files_presign')).toBe('deny');
    expect(classifyToolName('search_and_create')).toBe('deny');
    expect(classifyToolName('slack_update_canvas')).toBe('deny');
    expect(classifyToolName('post_api_v1_schemas_schemaName_dml')).toBe('deny');
    expect(classifyToolName('createJiraIssue')).toBe('deny');
  });

  it('allow와 deny 단어가 모두 없으면 ambiguous 반환', () => {
    expect(classifyToolName('run_report')).toBe('ambiguous');
    expect(classifyToolName('')).toBe('ambiguous');
    expect(classifyToolName('getter_tool')).toBe('ambiguous');
  });

  it('부분 문자열은 토큰 경계를 무시하고 안 걸린다', () => {
    // getter는 토큰이고 get은 ALLOW_WORDS지만 getter는 다른 토큰이므로 안 걸린다
    expect(classifyToolName('getter_tool')).toBe('ambiguous');
    // putty는 put을 부분 문자열로 포함하지만 토큰이 putty이므로 안 걸린다
    expect(classifyToolName('putty_app')).toBe('ambiguous');
  });

  it('대소문자를 정규화하고 camelCase를 분리한다', () => {
    expect(classifyToolName('getPagesInConfluenceSpace')).toBe('allow');
    expect(classifyToolName('createJiraIssue')).toBe('deny');
  });

  it('여러 구분자를 지원한다', () => {
    // _ 분리
    expect(classifyToolName('jira_get_issue')).toBe('allow');
    // - 분리
    expect(classifyToolName('jira-get-issue')).toBe('allow');
    // . 분리
    expect(classifyToolName('jira.get.issue')).toBe('allow');
    // : 분리
    expect(classifyToolName('jira:get:issue')).toBe('allow');
    // / 분리
    expect(classifyToolName('jira/get/issue')).toBe('allow');
    // 혼합
    expect(classifyToolName('mcp__x__post_api_v1_files_presign')).toBe('deny');
  });
});

describe('filterReadOnlyTools', () => {
  it('도구 이름들을 분류별로 나눈다', () => {
    const names = [
      'jira_get_issue',
      'confluence_update_page_section',
      'mcp__x__post_api_v1_files_presign',
      'search_and_create',
      'getPagesInConfluenceSpace',
      'slack_read_canvas',
      'slack_update_canvas',
      'post_api_v1_schemas_schemaName_dml',
      'run_report',
      'fetch',
      'createJiraIssue',
      'list_property_annotations',
      '',
      'getter_tool',
    ];

    const result = filterReadOnlyTools(names);

    expect(result.allowed).toEqual([
      'jira_get_issue',
      'getPagesInConfluenceSpace',
      'slack_read_canvas',
      'fetch',
      'list_property_annotations',
    ]);

    expect(result.denied).toEqual([
      'confluence_update_page_section',
      'mcp__x__post_api_v1_files_presign',
      'search_and_create',
      'slack_update_canvas',
      'post_api_v1_schemas_schemaName_dml',
      'createJiraIssue',
    ]);

    expect(result.ambiguous).toEqual(['run_report', '', 'getter_tool']);
  });

  it('입력 순서를 유지한다', () => {
    const names = ['fetch', 'createJiraIssue', 'run_report', 'getPagesInConfluenceSpace'];
    const result = filterReadOnlyTools(names);

    expect(result.allowed).toEqual(['fetch', 'getPagesInConfluenceSpace']);
    expect(result.denied).toEqual(['createJiraIssue']);
    expect(result.ambiguous).toEqual(['run_report']);
  });

  it('세 배열이 서로소이다', () => {
    const names = [
      'jira_get_issue',
      'confluence_update_page_section',
      'run_report',
      'fetch',
      'createJiraIssue',
      'getPagesInConfluenceSpace',
    ];

    const result = filterReadOnlyTools(names);

    const allNames = [...result.allowed, ...result.denied, ...result.ambiguous];
    const uniqueNames = new Set(allNames);

    expect(uniqueNames.size).toBe(allNames.length);
  });

  it('중복 없이 입력을 그대로 돌려준다', () => {
    const names = ['fetch', 'fetch', 'create', 'create'];
    const result = filterReadOnlyTools(names);

    expect([...result.allowed, ...result.denied, ...result.ambiguous]).toEqual(names);
  });

  it('빈 리스트를 처리한다', () => {
    const result = filterReadOnlyTools([]);

    expect(result.allowed).toEqual([]);
    expect(result.denied).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });
});

describe('상수 정의', () => {
  it('ALLOW_WORDS와 DENY_WORDS 중복 없음', () => {
    const allowSet = new Set(READ_ONLY_ALLOW_WORDS);
    const denySet = new Set(READ_ONLY_DENY_WORDS);

    for (const word of allowSet) {
      expect(denySet.has(word)).toBe(false);
    }
  });
});

describe('classifyCliCommand', () => {
  it('하위 명령이 list, get, describe로 시작하는 aws 명령은 allow다', () => {
    expect(classifyCliCommand('aws sts get-caller-identity --profile acme-prod')).toBe('allow');
    expect(classifyCliCommand('aws cloudfront list-distributions --output json')).toBe('allow');
    expect(classifyCliCommand('aws s3api get-bucket-website --bucket acme-web')).toBe('allow');
    expect(classifyCliCommand('aws ec2 describe-instances')).toBe('allow');
    expect(classifyCliCommand('aws configure list-profiles')).toBe('allow');
    expect(classifyCliCommand('aws-vault list')).toBe('allow');
  });

  it('전역 옵션이 서비스 앞에 와도 서비스와 하위 명령을 찾는다', () => {
    expect(
      classifyCliCommand(
        'aws --profile acme-prod --region us-east-1 cloudfront list-distributions',
      ),
    ).toBe('allow');
    expect(classifyCliCommand('aws --no-cli-pager --output=json s3api list-buckets')).toBe('allow');
    expect(classifyCliCommand('aws --profile acme-prod s3 rm s3://acme-web --recursive')).toBe(
      'deny',
    );
  });

  it('쓰기 하위 명령과 읽기 동사가 아닌 하위 명령은 deny다', () => {
    expect(classifyCliCommand('aws s3api put-bucket-policy --bucket x')).toBe('deny');
    expect(classifyCliCommand('aws cloudfront create-invalidation --distribution-id X')).toBe(
      'deny',
    );
    expect(classifyCliCommand('aws s3 ls')).toBe('deny');
    expect(classifyCliCommand('aws s3 sync dist s3://acme-web')).toBe('deny');
    expect(classifyCliCommand('aws configure get aws_secret_access_key')).toBe('deny');
    expect(classifyCliCommand('aws-vault exec acme-prod -- aws s3 ls')).toBe('deny');
  });

  it('이름은 get이어도 비밀값이나 자격증명을 내주거나 파일을 내려받는 동작은 deny다', () => {
    expect(classifyCliCommand('aws secretsmanager get-secret-value --secret-id x')).toBe('deny');
    expect(classifyCliCommand('aws ecr get-login-password')).toBe('deny');
    expect(classifyCliCommand('aws sts get-session-token')).toBe('deny');
    expect(classifyCliCommand('aws sso get-role-credentials --role-name r')).toBe('deny');
    expect(classifyCliCommand('aws s3api get-object --bucket b --key k out.txt')).toBe('deny');
    expect(classifyCliCommand('aws ssm get-parameter --name p --with-decryption')).toBe('deny');
  });

  it('셸 연결이나 치환, 리다이렉션이 섞이면 deny다', () => {
    expect(classifyCliCommand('aws sts get-caller-identity; rm -rf /')).toBe('deny');
    expect(classifyCliCommand('aws s3api list-buckets | tee out.json')).toBe('deny');
    expect(classifyCliCommand('aws s3api list-buckets > out.json')).toBe('deny');
    expect(classifyCliCommand('aws s3api list-buckets --profile $(whoami)')).toBe('deny');
    expect(classifyCliCommand('aws sts get-caller-identity && aws s3 rb s3://x')).toBe('deny');
  });

  it('aws 밖의 CLI나 하위 명령이 없는 명령은 ambiguous다', () => {
    expect(classifyCliCommand('gcloud compute instances list')).toBe('ambiguous');
    expect(classifyCliCommand('aws cloudfront')).toBe('ambiguous');
    expect(classifyCliCommand('')).toBe('ambiguous');
  });
});
