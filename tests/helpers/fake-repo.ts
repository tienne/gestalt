import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type FileMap = Record<string, string>;

export interface FakeRepoOptions {
  /** 레포 이름. 원격 URL과 조직 안의 디렉토리 이름에 쓴다. */
  name?: string;
  /** 원격 URL의 owner. 기본값은 acme. */
  owner?: string;
  /** false면 원격을 안 붙인다. 문자열이면 그 URL을 그대로 origin으로 쓴다. */
  remote?: false | string;
  /** 기본 브랜치 이름. */
  branch?: string;
  /** 지정하면 이 파일들로 첫 커밋을 만든다. 없으면 빈 첫 커밋만 있다. */
  files?: FileMap;
}

export interface FakeRepo {
  root: string;
  name: string;
  owner: string;
  /** origin URL. 원격이 없으면 null. */
  remoteUrl: string | null;
  git(...args: string[]): string;
  write(relPath: string, content: string): void;
  writeAll(files: FileMap): void;
  remove(relPath: string): void;
  /** 변경을 전부 스테이징해서 커밋하고 SHA를 돌려준다. files를 주면 먼저 쓴다. */
  commit(message: string, files?: FileMap): string;
  head(): string;
  /** 현재 HEAD에서 새 브랜치를 만들고 옮겨 간다. from을 주면 그 ref에서 딴다. */
  branch(name: string, from?: string): void;
  checkout(ref: string): void;
  /** ref 시점의 파일 blob SHA. ref를 안 주면 워킹트리 파일 기준(HEAD에 커밋된 것). */
  blobSha(relPath: string, ref?: string): string;
  diff(base: string, head: string): string;
  /** 두 ref 사이에 바뀐 파일 이름. */
  changedFiles(base: string, head: string): string[];
  cleanup(): void;
}

export interface FakeOrg {
  owner: string;
  root: string;
  repos: Record<string, FakeRepo>;
  cleanup(): void;
}

export interface CommitPair {
  baseSha: string;
  headSha: string;
  diff: string;
}

const created: string[] = [];

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
};

// 커밋 순서가 시간순으로 안정적이어야 co-change나 log 기반 검색기 테스트가 흔들리지 않는다.
let clock = Date.UTC(2026, 0, 1);

function nextDate(): string {
  clock += 60_000;
  return new Date(clock).toISOString();
}

function uniqueRoot(): string {
  return resolve('.gestalt-test', `fake-${randomUUID()}`);
}

function buildRepo(root: string, opts: FakeRepoOptions): FakeRepo {
  const name = opts.name ?? 'widget-kit';
  const owner = opts.owner ?? 'acme';
  const branch = opts.branch ?? 'main';
  const remoteUrl =
    opts.remote === false ? null : (opts.remote ?? `https://github.com/${owner}/${name}.git`);

  mkdirSync(root, { recursive: true });

  const git = (...args: string[]): string => {
    const date = nextDate();
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };

  git('init', '-q', '-b', branch);
  git('config', 'commit.gpgsign', 'false');
  if (remoteUrl) git('remote', 'add', 'origin', remoteUrl);

  const repo: FakeRepo = {
    root,
    name,
    owner,
    remoteUrl,
    git,
    write(relPath, content) {
      const abs = join(root, relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
    writeAll(files) {
      for (const [p, c] of Object.entries(files)) repo.write(p, c);
    },
    remove(relPath) {
      rmSync(join(root, relPath), { force: true });
    },
    commit(message, files) {
      if (files) repo.writeAll(files);
      git('add', '-A');
      git('commit', '-q', '--allow-empty', '-m', message);
      return repo.head();
    },
    head() {
      return git('rev-parse', 'HEAD').trim();
    },
    branch(branchName, from) {
      git('checkout', '-q', '-b', branchName, ...(from ? [from] : []));
    },
    checkout(ref) {
      git('checkout', '-q', ref);
    },
    blobSha(relPath, ref = 'HEAD') {
      return git('rev-parse', `${ref}:${relPath}`).trim();
    },
    diff(base, head) {
      return git('diff', '--no-color', `${base}..${head}`);
    },
    changedFiles(base, head) {
      return git('diff', '--name-only', `${base}..${head}`).split('\n').filter(Boolean);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };

  repo.commit('chore: init', opts.files);
  return repo;
}

/** 임시 디렉토리에 git 레포를 만든다. 경로는 호출마다 고유해서 병렬 실행에 안전하다. */
export function createFakeRepo(opts: FakeRepoOptions = {}): FakeRepo {
  const root = uniqueRoot();
  created.push(root);
  return buildRepo(root, opts);
}

export interface FakeOrgOptions {
  owner?: string;
  /** 레포 이름 → 첫 커밋 파일. remote: false를 주려면 객체 꼴을 쓴다. */
  repos: Record<string, FileMap | (Omit<FakeRepoOptions, 'name' | 'owner'> & { files?: FileMap })>;
}

const REPO_OPTION_KEYS = ['remote', 'branch', 'files'];

function isRepoOptions(v: FileMap | Record<string, unknown>): v is FakeRepoOptions {
  const keys = Object.keys(v);
  return (
    keys.length > 0 &&
    keys.every((k) => REPO_OPTION_KEYS.includes(k)) &&
    typeof v.files !== 'string'
  );
}

/**
 * 같은 owner 아래 레포 여럿을 한 조직 디렉토리에 나란히 만든다.
 * 레포끼리 서로의 상대 경로(../name)로 닿을 수 있어 플러그인 루트 기준 해석을 재현할 수 있다.
 */
export function createFakeOrg(opts: FakeOrgOptions): FakeOrg {
  const owner = opts.owner ?? 'acme';
  const root = uniqueRoot();
  created.push(root);
  mkdirSync(root, { recursive: true });

  const repos: Record<string, FakeRepo> = {};
  for (const [name, spec] of Object.entries(opts.repos)) {
    const repoOpts: FakeRepoOptions = isRepoOptions(spec) ? spec : { files: spec };
    repos[name] = buildRepo(join(root, name), { ...repoOpts, name, owner });
  }

  return {
    owner,
    root,
    repos,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * base 커밋과 head 커밋을 만들어 diff를 낸다. base는 현재 브랜치에 쌓고
 * head는 headBranch(주면)에서 딴다. 삭제는 값을 null로 준다.
 */
export function createCommitPair(
  repo: FakeRepo,
  spec: { base: FileMap; head: Record<string, string | null>; headBranch?: string },
): CommitPair {
  const baseSha = repo.commit('base', spec.base);
  if (spec.headBranch) repo.branch(spec.headBranch);
  for (const [p, c] of Object.entries(spec.head)) {
    if (c === null) repo.remove(p);
    else repo.write(p, c);
  }
  const headSha = repo.commit('head');
  return { baseSha, headSha, diff: repo.diff(baseSha, headSha) };
}

/** 내용이 같아 blob SHA가 같은 파일 쌍을 커밋한다. 사본 어긋남 검색기의 입력이다. */
export function writeIdenticalPair(
  repo: FakeRepo,
  pathA: string,
  pathB: string,
  content: string,
): { sha: string; blobSha: string } {
  const sha = repo.commit('add identical pair', { [pathA]: content, [pathB]: content });
  return { sha, blobSha: repo.blobSha(pathA) };
}

/** 커밋 n개를 쌓는다. 각 커밋은 fileSets[i]를 쓴다. 코드 그래프 co-change 입력용. */
export function commitSeries(repo: FakeRepo, fileSets: FileMap[]): string[] {
  return fileSets.map((files, i) => repo.commit(`change ${i + 1}`, files));
}

export function cleanupFakeRepos(): void {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
}
