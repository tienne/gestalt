import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isPlainObject } from '../core/json-file.js';
import { GhAccounts, writeQueueMessage } from './adapters.js';
import { acquireLock } from './engine.js';
import { execRunner, type CommandRunner } from './launcher.js';
import { normalizePrRef } from './pr-ref.js';
import type { ConductorStore } from './store.js';

const COMMENT_LINK =
  /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/([1-9]\d*)#issuecomment-([1-9]\d*)$/;

export async function readGithubOrder(
  link: string,
  policy: Record<string, unknown>,
  accounts: GhAccounts,
  run: CommandRunner = execRunner,
) {
  const match = COMMENT_LINK.exec(link);
  if (!match) throw new Error('GitHub 이슈나 PR의 일반 댓글 링크가 필요해요');
  const repo = match[1]!;
  const kind = match[2]!;
  const issue = match[3]!;
  const comment = match[4]!;
  const key = repo.toLowerCase();
  const repositories = policy['githubRepositories'];
  const allowed =
    isPlainObject(repositories) && Object.hasOwn(repositories, key) ? repositories[key] : undefined;
  if (!Array.isArray(allowed)) throw new Error('이 레포는 팀 주문을 받지 않아요');
  const env = await accounts.envFor(repo);
  const response = await run(
    'gh',
    ['api', '--hostname', 'github.com', `repos/${repo}/issues/comments/${comment}`],
    { ...(env ? { env } : {}), timeoutMs: 15_000 },
  );
  if (response.code !== 0) throw new Error('GitHub에서 원본 댓글을 확인하지 못했어요');
  const record: unknown = JSON.parse(response.stdout);
  const thread = `https://github.com/${repo}/${kind}/${issue}`;
  if (
    !isPlainObject(record) ||
    record['id'] !== Number(comment) ||
    typeof record['html_url'] !== 'string' ||
    record['html_url'].toLowerCase() !== link.toLowerCase() ||
    !isPlainObject(record['user']) ||
    record['user']['type'] !== 'User' ||
    !Number.isSafeInteger(record['user']['id']) ||
    !allowed.includes(record['user']['id'])
  )
    throw new Error('이 스레드에서 주문을 넣을 수 있는 GitHub 작성자를 확인하지 못했어요');

  const body = record['body'];
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 16_000)
    throw new Error('팀 주문은 16KB 이내의 GitHub 댓글로 적어 주세요');
  const lines = body.trim().split(/\r?\n/);
  // Orca의 호출 멘션을 첫 줄에 둘 수 있다. 권한과 주문 내용은 GitHub API 응답에서 읽는다.
  if (/^@[\w/-]+$/.test(lines[0] ?? '')) lines.shift();
  const command = lines.shift()?.trim() ?? '';
  const prefix = `github-${createHash('sha256').update(key).digest('hex').slice(0, 16)}-${issue}-`;
  if (command === 'gestalt status' && !lines.some((line) => line.trim())) {
    return { kind: 'status', repo, thread, prefix } as const;
  }
  const title = /^gestalt order (\S.{0,199})$/.exec(command)?.[1];
  if (!title) throw new Error('댓글 첫 명령은 gestalt order <제목> 또는 gestalt status여야 해요');
  return {
    kind: 'order',
    repo,
    thread,
    id: prefix + comment,
    title,
    description: lines.join('\n').trim(),
  } as const;
}

export function handleGithubOrder(
  store: ConductorStore,
  request: Awaited<ReturnType<typeof readGithubOrder>>,
) {
  const queueDir = join(store.dir, 'queue');
  if (request.kind === 'status') {
    store.reload();
    const orders = store
      .orders()
      .filter(
        (order) =>
          order.repo.toLowerCase() === request.repo.toLowerCase() &&
          order.sourceRef.startsWith(`queue:${request.prefix}`),
      )
      .map(({ id, status, prRef }) => {
        const ref = prRef ? normalizePrRef(prRef) : undefined;
        return {
          id,
          status,
          ...(ref ? { pr: `https://github.com/${ref.replace('#', '/pull/')}` } : {}),
        };
      });
    let pending: string[] = [];
    try {
      pending = readdirSync(queueDir, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.startsWith(request.prefix) &&
            /^\d+\.json$/.test(entry.name.slice(request.prefix.length)),
        )
        .map((entry) => `queue:${entry.name.slice(0, -'.json'.length)}`)
        .filter((sourceRef) => !store.hasSourceRef(sourceRef));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { thread: request.thread, orders, pending };
  }

  const lock = acquireLock(store.dir);
  if (!lock.ok)
    throw new Error('컨덕터가 상태를 갱신 중이에요. 잠시 뒤 같은 댓글로 다시 시도해 주세요');
  try {
    store.reload();
    const sourceRef = `queue:${request.id}`;
    const existing = store.findOrderBySourceRef(sourceRef);
    if (existing || store.hasSourceRef(sourceRef))
      return {
        thread: request.thread,
        sourceRef,
        status: existing?.status ?? (store.removedAtOf(sourceRef) ? 'removed' : 'archived'),
        orderId: existing?.id,
      };
    try {
      writeQueueMessage(
        queueDir,
        {
          repo: request.repo,
          title: request.title,
          description: request.description,
          scope: 'approval',
          skillChain: ['solve', 'ship'],
        },
        request.id,
      );
    } catch (error) {
      if ((error as { cause?: NodeJS.ErrnoException }).cause?.code === 'EEXIST')
        return { thread: request.thread, sourceRef, status: 'queued', duplicate: true };
      throw error;
    }
    return { thread: request.thread, sourceRef, status: 'queued' };
  } finally {
    lock.release();
  }
}
