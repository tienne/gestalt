import { isPlainObject } from '../core/json-file.js';
import type { GhAccounts } from './adapters.js';
import { execRunner, type CommandRunner } from './launcher.js';
import type { ApprovedDeployment, Gate } from './types.js';

const TAG_REQUEST =
  /^ship ⓐⓑⓒ 단계로 확인되지 않은 단순 승인이라 사람에게 올려요: ([\w.-]+\/[\w.-]+)의 커밋 ([0-9a-f]{40})에 ([\w.-]+) 태그를 붙여 origin에 push하면 ([\w -]+) 배포가 시작됩니다\.$/;

export function requestedDeployment(gate: Gate) {
  if (gate.type !== 'no-procedure' || !gate.orderId) return;
  const match = TAG_REQUEST.exec(gate.reason);
  if (!match) return;
  return { repo: match[1]!, sha: match[2]!, ref: match[3]!, environment: match[4]! };
}

export function matchesApprovedDeployment(gate: Gate, target: ApprovedDeployment): boolean {
  const request = requestedDeployment(gate);
  return (
    request !== undefined &&
    request.repo.toLowerCase() === target.repo.toLowerCase() &&
    request.sha === target.sha &&
    request.ref === target.ref &&
    request.environment === target.environment.replaceAll('-', ' ')
  );
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function approveDeployment(
  gate: Gate,
  orderRepo: string,
  input: string,
): ApprovedDeployment {
  const target = requestedDeployment(gate);
  const ids: unknown = JSON.parse(input);
  if (
    !target ||
    target.repo.toLowerCase() !== orderRepo.toLowerCase() ||
    !isPlainObject(ids) ||
    !positiveId(ids.runId) ||
    !positiveId(ids.attempt) ||
    !positiveId(ids.deploymentId) ||
    typeof ids.environment !== 'string' ||
    ids.environment.replaceAll('-', ' ') !== target.environment
  )
    throw new Error('게이트의 배포 요청과 일치하는 환경, 실행 ID, 시도 번호, 배포 ID를 주세요');
  return {
    ...target,
    repo: orderRepo,
    environment: ids.environment,
    runId: ids.runId,
    attempt: ids.attempt,
    deploymentId: ids.deploymentId,
  };
}

type DeploymentResult = { statusId: number; jobId: number } | { reason: string };
export type ReadDeploymentEvidence = (target: ApprovedDeployment) => Promise<DeploymentResult>;

export async function readDeploymentEvidence(
  target: ApprovedDeployment,
  accounts: GhAccounts,
  runner: CommandRunner = execRunner,
): Promise<DeploymentResult> {
  const { repo, runId, attempt, deploymentId, sha, ref, environment } = target;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || ![runId, attempt, deploymentId].every(positiveId))
    return { reason: '저장된 GitHub 배포 식별자를 확인할 수 없어요' };
  const env = await accounts.envFor(repo);
  async function get(path: string): Promise<unknown> {
    const result = await runner('gh', ['api', '--method', 'GET', `repos/${repo}/${path}`], {
      timeoutMs: 15_000,
      ...(env ? { env } : {}),
    });
    if (result.code !== 0) throw new Error('GitHub에서 배포 증빙을 읽지 못했어요');
    return JSON.parse(result.stdout) as unknown;
  }
  const [run, deployment, statuses] = await Promise.all([
    get(`actions/runs/${runId}`),
    get(`deployments/${deploymentId}`),
    get(`deployments/${deploymentId}/statuses?per_page=1`),
  ]);
  if (
    !isPlainObject(run) ||
    !isPlainObject(run.repository) ||
    typeof run.repository.full_name !== 'string' ||
    run.repository.full_name.toLowerCase() !== repo.toLowerCase() ||
    run.id !== runId ||
    run.run_attempt !== attempt ||
    run.head_sha !== sha ||
    run.event !== 'push' ||
    run.head_branch !== ref ||
    !isPlainObject(deployment) ||
    deployment.id !== deploymentId ||
    deployment.sha !== sha ||
    (deployment.ref !== ref && deployment.ref !== `refs/tags/${ref}`) ||
    deployment.environment !== environment
  )
    return { reason: 'GitHub 실행, 시도, 커밋, 태그 또는 배포 환경이 승인과 달라요' };
  if (run.status !== 'completed' || run.conclusion !== 'success')
    return { reason: '승인한 GitHub 실행의 성공이 확인되지 않았어요' };

  const latest: unknown = Array.isArray(statuses) ? statuses[0] : undefined;
  if (!isPlainObject(latest) || !positiveId(latest.id) || latest.environment !== environment)
    return { reason: '승인한 환경의 최신 GitHub 배포 상태를 확인할 수 없어요' };
  if (latest.state !== 'success')
    return { reason: '승인한 환경의 최신 배포 상태가 성공이 아니에요' };
  const prefix = `https://github.com/${repo.toLowerCase()}/actions/runs/${runId}/job/`;
  const logUrl = typeof latest.log_url === 'string' ? latest.log_url.toLowerCase() : '';
  const job = logUrl.startsWith(prefix) ? logUrl.slice(prefix.length) : '';
  const jobId = Number(job);
  if (/^[1-9]\d*$/.test(job) && positiveId(jobId)) {
    const result = await get(`actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`);
    if (
      isPlainObject(result) &&
      Array.isArray(result.jobs) &&
      result.jobs.some(
        (entry: unknown) =>
          isPlainObject(entry) &&
          entry.id === jobId &&
          entry.run_id === runId &&
          entry.head_sha === sha &&
          entry.status === 'completed' &&
          entry.conclusion === 'success',
      )
    )
      return { statusId: latest.id, jobId };
  }
  return { reason: '배포 상태가 승인한 실행 시도의 성공한 작업을 가리키지 않아요' };
}
