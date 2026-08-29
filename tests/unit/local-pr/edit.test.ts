import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../../../src/events/store.js';
import { LocalPrEngine, PrError } from '../../../src/local-pr/engine.js';
import { PrEvent, PullRequestRepository } from '../../../src/local-pr/repository.js';
import { prEditCommand } from '../../../src/cli/commands/pr.js';
import * as git from '../../../src/local-pr/git.js';

/**
 * `pr edit` — 본문을 고치는 문.
 *
 * 리뷰 워커 셋이 PR 본문에 틀린 문장이 있는 걸 알고도 못 고쳐 코멘트로 정정하고
 * 스레드를 열어둔 채 머지에 실려 보냈다. 그래서 낸 문인데, 그 문이 열리면서
 * 리뷰 판정을 밟아 버리면 고친 게 아니라 망가뜨린 것이다. 여기서 보는 건 두 가지다
 * — 고쳐지는가, 그리고 고쳐도 아무것도 안 흔들리는가.
 */

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function makeRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  run(repo, ['init', '-q']);
  run(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  run(repo, ['config', 'user.email', 't@e.st']);
  run(repo, ['config', 'user.name', 'test']);
  writeFileSync(join(repo, 'a.txt'), 'line1\n');
  run(repo, ['add', '-A']);
  run(repo, ['commit', '-q', '-m', 'init']);
  run(repo, ['checkout', '-q', '-b', 'feat/x']);
  writeFileSync(join(repo, 'a.txt'), 'line1\nline2\n');
  run(repo, ['commit', '-q', '-am', '두 번째 줄']);
  return repo;
}

describe('LocalPrEngine.edit', () => {
  let repo: string;
  let engine: LocalPrEngine;

  beforeEach(() => {
    repo = makeRepo('gestalt-pr-edit-');
    engine = new LocalPrEngine(repo);
  });

  afterEach(() => {
    engine.dispose();
    rmSync(repo, { recursive: true, force: true });
  });

  it('본문을 갈아 끼우고 제목은 그대로 둔다', () => {
    const pr = engine.create({ title: '원래 제목', body: '틀린 문장', author: 'a' });

    const after = engine.edit(pr.id, { body: '고친 문장' }, 'codex:worker-edit');

    expect(after.body).toBe('고친 문장');
    expect(after.title).toBe('원래 제목');
  });

  it('제목만 줘도 고쳐지고 본문은 그대로 둔다', () => {
    const pr = engine.create({ title: '오타 잇는 제목', body: '본문', author: 'a' });

    const after = engine.edit(pr.id, { title: '오타 있는 제목' }, 'a');

    expect(after.title).toBe('오타 있는 제목');
    expect(after.body).toBe('본문');
  });

  it('빈 문자열이면 본문을 비운다 — "안 줬다"와 갈린다', () => {
    // 빈 값을 "그대로 둬라"로 접으면 잘못 쓴 본문을 지울 길이 없다
    const pr = engine.create({ title: 't', body: '지울 본문', author: 'a' });

    expect(engine.edit(pr.id, { body: '' }, 'a').body).toBe('');
  });

  it('한글과 백틱, 줄바꿈이 섞인 본문이 그대로 저장된다', () => {
    const pr = engine.create({ title: 't', body: 'x', author: 'a' });
    const body = '`line2`를 덧붙이는데,\n경계 조건을 안 봅니다.\n\n빈 파일이면?\n';

    expect(engine.edit(pr.id, { body }, 'a').body).toBe(body);
  });

  it('누가 고쳤는지 이벤트에 남는다', () => {
    const pr = engine.create({ title: 't', body: 'x', author: 'a' });
    engine.edit(pr.id, { body: 'y' }, 'codex:worker-edit');

    const store = new EventStore(git.reviewsDbPath(repo));
    const edited = store.replay('local-pr', pr.id).filter((e) => e.eventType === PrEvent.EDITED);
    store.close();

    expect(edited).toHaveLength(1);
    expect((edited[0]!.payload as { by: string }).by).toBe('codex:worker-edit');
  });

  it('안 고친 항목은 페이로드에 안 싣는다', () => {
    // 제목까지 실으면 "제목도 고쳤다"가 이력에 남는다. 안 건드린 걸 건드렸다고 적는 셈이다
    const pr = engine.create({ title: 't', body: 'x', author: 'a' });
    engine.edit(pr.id, { title: 't', body: 'y' }, 'a');

    const store = new EventStore(git.reviewsDbPath(repo));
    const edited = store.replay('local-pr', pr.id).find((e) => e.eventType === PrEvent.EDITED)!;
    store.close();

    expect(Object.keys(edited.payload as object).sort()).toEqual(['body', 'by']);
  });

  it('고칠 것을 안 주면 던진다', () => {
    const pr = engine.create({ title: 't', body: 'x', author: 'a' });
    expect(() => engine.edit(pr.id, {}, 'a')).toThrow(PrError);
  });

  it('지금 값과 같으면 던진다 — 아무것도 안 바뀐 줄을 이력에 안 남긴다', () => {
    const pr = engine.create({ title: 't', body: 'x', author: 'a' });
    expect(() => engine.edit(pr.id, { title: 't', body: 'x' }, 'a')).toThrow(PrError);
  });

  it('머지된 PR은 못 고친다', () => {
    const pr = engine.create({ title: 't', body: 'x', author: 'a' });
    run(repo, ['checkout', '-q', 'main']);
    engine.merge(pr.id, 'a');

    expect(() => engine.edit(pr.id, { body: 'y' }, 'a')).toThrow(PrError);
  });

  // ─── 흔들리면 안 되는 것들 ─────────────────────────────────

  it('changes_requested에서 본문을 고쳐도 판정이 안 풀린다', () => {
    // 이 작업의 핵심이다. `pr.updated`를 그대로 썼으면 여기서 open으로 돌아간다 —
    // 리뷰어가 변경을 요청했는데 작성자가 오타 하나 고쳤다고 그게 풀리면 안 된다
    const pr = engine.create({ title: 't', body: '틀린 문장', author: 'a' });
    engine.review(pr.id, { reviewer: 'r', verdict: 'request_changes', summary: '고쳐주세요' });
    expect(engine.get(pr.id)!.status).toBe('changes_requested');

    const after = engine.edit(pr.id, { body: '고친 문장' }, 'a');

    expect(after.status).toBe('changes_requested');
  });

  it('changes_requested에서 고쳐도 상태만 접는 갈래가 안 갈린다', () => {
    // `list(status)`는 `foldStatus`로 후보를 좁힌다. 두 갈래가 갈리면 목록과 상세가
    // 다른 상태를 보여준다 — `fold`가 판정을 지켰는데 `foldStatus`가 open으로 되돌리면
    // 위 테스트는 통과하면서 목록에서만 자리가 바뀐다
    const pr = engine.create({ title: 't', body: 'x', author: 'a' });
    engine.review(pr.id, { reviewer: 'r', verdict: 'request_changes', summary: 's' });
    engine.edit(pr.id, { body: 'y' }, 'a');

    expect(engine.list('changes_requested').map((p) => p.id)).toEqual([pr.id]);
    expect(engine.list('open')).toEqual([]);
    expect(engine.countByStatus()).toMatchObject({ open: 0, changes_requested: 1 });
  });

  it('본문을 고쳐도 라운드가 안 는다', () => {
    // 라운드를 여는 건 request_changes 판정 하나뿐이다. 글자 수정은 새 바퀴가 아니다
    const pr = engine.create({ title: 't', body: 'x', author: 'a' });
    engine.review(pr.id, { reviewer: 'r', verdict: 'request_changes', summary: 's' });
    const before = engine.get(pr.id)!.rounds.length;

    engine.edit(pr.id, { body: 'y' }, 'a');
    engine.edit(pr.id, { body: 'z' }, 'a');

    const after = engine.get(pr.id)!;
    expect(after.rounds).toHaveLength(before);
    expect(after.rounds[after.rounds.length - 1]!.commentCount).toBe(0);
  });

  it('open에서 고쳐도 open 그대로다', () => {
    const pr = engine.create({ title: 't', body: 'x', author: 'a' });
    expect(engine.edit(pr.id, { body: 'y' }, 'a').status).toBe('open');
  });

  it('head를 안 옮긴다', () => {
    const pr = engine.create({ title: 't', body: 'x', author: 'a' });
    writeFileSync(join(repo, 'a.txt'), 'line1\nline2\nline3\n');
    run(repo, ['commit', '-q', '-am', '세 번째 줄']);

    const after = engine.edit(pr.id, { body: 'y' }, 'a');

    expect(after.headSha).toBe(pr.headSha);
  });

  // ─── 옛 기록 ──────────────────────────────────────────────

  it('edit이 없던 시절의 이벤트만 재생해도 같은 상태가 나온다', () => {
    const pr = engine.create({ title: '원래 제목', body: '원래 본문', author: 'a' });
    engine.comment(pr.id, { author: 'r', path: 'a.txt', body: '의견' });
    engine.review(pr.id, { reviewer: 'r', verdict: 'request_changes', summary: 's' });
    const before = engine.get(pr.id)!;

    // edited를 빼고 넣으면 edit이 없던 시절 그대로다. 새 이벤트가 옛 기록을 안 깨는지
    const events = new EventStore(git.reviewsDbPath(repo))
      .replay('local-pr', pr.id)
      .filter((e) => e.eventType !== PrEvent.EDITED);
    const fresh = new EventStore(join(repo, 'old.db'));
    for (const e of events) fresh.append('local-pr', pr.id, e.eventType, e.payload);

    const after = new PullRequestRepository(fresh).reconstruct(pr.id)!;
    fresh.close();

    expect(after.title).toBe('원래 제목');
    expect(after.body).toBe('원래 본문');
    expect(after.status).toBe(before.status);
    expect(after.rounds).toHaveLength(before.rounds.length);
  });

  it('edit 이벤트를 이어 재생해도 같은 본문이 나온다', () => {
    const pr = engine.create({ title: '원래 제목', body: '원래 본문', author: 'a' });
    engine.review(pr.id, { reviewer: 'r', verdict: 'request_changes', summary: 's' });
    engine.edit(pr.id, { title: '고친 제목', body: '고친 본문' }, 'codex:worker-edit');

    const events = new EventStore(git.reviewsDbPath(repo)).replay('local-pr', pr.id);
    const fresh = new EventStore(join(repo, 'replay.db'));
    for (const e of events) fresh.append('local-pr', pr.id, e.eventType, e.payload);

    const after = new PullRequestRepository(fresh).reconstruct(pr.id)!;
    fresh.close();

    expect(after.title).toBe('고친 제목');
    expect(after.body).toBe('고친 본문');
    expect(after.status).toBe('changes_requested');
  });

  it('모르는 이벤트가 섞여도 접기가 안 죽는다', () => {
    // `fold`의 default가 무시로 두는 자리다. 새 이벤트를 낸 워크트리와 옛 코드가
    // 같은 `.gestalt/reviews.db`를 함께 본다 — 옛 코드 쪽이 죽으면 안 된다
    const pr = engine.create({ title: 't', body: 'x', author: 'a' });
    const store = new EventStore(git.reviewsDbPath(repo));
    store.append('local-pr', pr.id, 'pr.from.the.future', { whatever: 1 });
    const after = new PullRequestRepository(store).reconstruct(pr.id)!;
    store.close();

    expect(after.body).toBe('x');
    expect(after.status).toBe('open');
    expect(after.rounds).toHaveLength(1);
  });
});

/**
 * CLI 표면.
 *
 * 엔진만 보면 `--body-file`을 안 읽고 파일 경로를 그대로 본문으로 넣어도 안 걸린다.
 * 종료 코드도 이 층에만 있다.
 */
describe('gestalt pr edit CLI', () => {
  let repo: string;
  let engine: LocalPrEngine;
  let lines: string[];
  let exits: number[];

  beforeEach(() => {
    repo = makeRepo('gestalt-pr-edit-cli-');
    engine = new LocalPrEngine(repo);
    lines = [];
    exits = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exits.push(code ?? 0);
      return undefined as never;
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    engine.dispose();
    rmSync(repo, { recursive: true, force: true });
  });

  it('--body-file의 내용을 본문으로 넣는다', () => {
    const pr = engine.create({ title: 't', body: '틀린 본문', author: 'a' });
    const path = join(repo, 'body.md');
    const body = '## 제목\n\n- `코드` 인용, 한글\n\n끝\n';
    writeFileSync(path, body, 'utf-8');

    prEditCommand({ repoRoot: repo, id: pr.id, bodyFile: path, author: 'codex:worker-edit' });

    // 경로를 그대로 본문에 넣으면 여기서 갈린다
    expect(engine.get(pr.id)!.body).toBe(body);
    expect(exits).toEqual([]);
  });

  it('--title을 제목으로 넘긴다', () => {
    const pr = engine.create({ title: '옛 제목', body: 'x', author: 'a' });

    prEditCommand({ repoRoot: repo, id: pr.id, title: '새 제목', author: 'a' });

    expect(engine.get(pr.id)!.title).toBe('새 제목');
    expect(engine.get(pr.id)!.body).toBe('x');
  });

  it('--body-file만 주면 제목을 안 건드린다', () => {
    const pr = engine.create({ title: '지킬 제목', body: 'x', author: 'a' });
    const path = join(repo, 'b.md');
    writeFileSync(path, '새 본문', 'utf-8');

    prEditCommand({ repoRoot: repo, id: pr.id, bodyFile: path, author: 'a' });

    expect(engine.get(pr.id)!.title).toBe('지킬 제목');
  });

  it('아무것도 안 주면 1로 끝낸다', () => {
    const pr = engine.create({ title: 't', body: 'x', author: 'a' });

    prEditCommand({ repoRoot: repo, id: pr.id, author: 'a' });

    expect(exits).toEqual([1]);
    expect(engine.get(pr.id)!.body).toBe('x');
  });

  it('없는 PR은 3으로 끝낸다', () => {
    prEditCommand({ repoRoot: repo, id: 'nope0000', title: 'x', author: 'a' });

    expect(exits).toEqual([3]);
  });

  it('머지된 PR을 고치려 하면 4로 끝낸다', () => {
    const pr = engine.create({ title: 't', body: 'x', author: 'a' });
    run(repo, ['checkout', '-q', 'main']);
    engine.merge(pr.id, 'a');

    prEditCommand({ repoRoot: repo, id: pr.id, title: 'y', author: 'a' });

    expect(exits).toEqual([4]);
  });

  it('--author를 행위자로 넘긴다', () => {
    const pr = engine.create({ title: 't', body: 'x', author: 'a' });

    prEditCommand({ repoRoot: repo, id: pr.id, title: 'y', author: 'codex:worker-edit' });

    const store = new EventStore(git.reviewsDbPath(repo));
    const edited = store.replay('local-pr', pr.id).find((e) => e.eventType === PrEvent.EDITED)!;
    store.close();

    expect((edited.payload as { by: string }).by).toBe('codex:worker-edit');
  });
});

/**
 * 입력이 비었을 때.
 *
 * 둘 다 "안 줬다"와 "빈 값을 줬다"가 안 갈려서 열렸던 자리다. 조용히 성공하면
 * 사용자는 무언가 지워진 걸 나중에야 안다.
 */
describe('빈 입력 경계', () => {
  let repo: string;
  let engine: LocalPrEngine;
  let exits: number[];

  beforeEach(() => {
    repo = makeRepo('gestalt-pr-edit-empty-');
    engine = new LocalPrEngine(repo);
    exits = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exits.push(code ?? 0);
      return undefined as never;
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    engine.dispose();
    rmSync(repo, { recursive: true, force: true });
  });

  it('빈 제목은 도메인에서 막는다', () => {
    const pr = engine.create({ title: '원래 제목', author: 'a' });

    // 머지 커밋 메시지가 `Merge local PR <id>:`로 나가고 머지 뒤엔 못 되돌린다
    expect(() => engine.edit(pr.id, { title: '   ' }, 'a')).toThrow(PrError);
    expect(engine.get(pr.id)!.title).toBe('원래 제목');
  });

  it('--body-file이 빈 경로면 본문을 안 지우고 멈춘다', () => {
    const pr = engine.create({ title: 't', body: '지켜야 할 본문', author: 'a' });

    // 셸에서 안 풀린 `--body-file "$F"`가 이 자리로 온다
    prEditCommand({ repoRoot: repo, id: pr.id, bodyFile: '' });

    expect(exits).toEqual([1]);
    expect(new LocalPrEngine(repo).get(pr.id)!.body).toBe('지켜야 할 본문');
  });
});
