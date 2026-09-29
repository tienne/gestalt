import { execFileSync, type SpawnSyncReturns } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildFollowUpMarker,
  parseFollowUpMarkers,
} from '../../../src/harness-review/follow-up-marker.js';
import { cleanupFakeRepos } from '../../helpers/fake-repo.js';
import { buildThreeStateOrg } from '../../fixtures/harness-repos/scenarios.js';

/**
 * ship, review-loop, review 스킬이 `gestalt harness-refs ...`를 셸에서 부르고 jq로 필드를 뽑는다.
 * 옵션 이름이나 출력 키가 바뀌면 스킬 문서가 조용히 깨지므로 여기서 고정한다.
 * gh를 부르는 경로는 네트워크가 필요해 단위 테스트(harness-refs-cross-pr.test.ts)에서 필드를 고정한다.
 */
describe('harness-refs 교차 PR 서브커맨드의 CLI 계약', { timeout: 60_000 }, () => {
  const bin = resolve('bin/gestalt.ts');
  const scratch: string[] = [];

  afterEach(() => {
    cleanupFakeRepos();
    for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const tempDir = () => {
    const dir = resolve('.gestalt-test', `cli-contract-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    scratch.push(dir);
    return dir;
  };

  const run = (args: string[]) => {
    try {
      const stdout = execFileSync('npx', ['tsx', bin, ...args], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout };
    } catch (e) {
      const err = e as SpawnSyncReturns<string> & { status: number | null };
      return { status: err.status ?? -1, stdout: err.stdout ?? '' };
    }
  };

  const optionsOf = (sub: string[]) =>
    [...run(['harness-refs', ...sub, '--help']).stdout.matchAll(/(--[a-z-]+)/g)]
      .map((m) => m[1]!)
      .filter((o) => o !== '--help');

  it.each<[string[], string[]]>([
    [
      ['related-prs'],
      [
        '--mode',
        '--pr',
        '--repo',
        '--candidates',
        '--related-repo',
        '--branch',
        '--author',
        '--title',
        '--body-file',
        '--json',
      ],
    ],
    [
      ['three-state'],
      [
        '--candidates',
        '--related-prs',
        '--repo',
        '--repo-dir',
        '--default-branch',
        '--confirm',
        '--json',
      ],
    ],
    [
      ['followup', 'build'],
      ['--pr', '--repo', '--thread-id', '--target-repo', '--work', '--work-file', '--json'],
    ],
    [
      ['followup', 'find'],
      ['--repo', '--pr', '--candidates', '--related-repo', '--trusted-author', '--json'],
    ],
    [
      ['followup', 'check'],
      ['--markers', '--pr', '--repo', '--body-file', '--diff-file', '--json'],
    ],
  ])('%s 옵션 이름', (sub, expected) => {
    expect(new Set(optionsOf(sub))).toEqual(new Set(expected));
  });

  it.each([
    ['모르는 --mode', ['related-prs', '--mode', 'auto', '--repo', 'acme/x', '--json']],
    ['없는 입력 파일', ['three-state', '--candidates', '/nonexistent', '--related-prs', '/x']],
    ['필수 옵션 빠짐', ['followup', 'check', '--json']],
    [
      '작업 문장 없음',
      [
        'followup',
        'build',
        '--pr',
        '30',
        '--repo',
        'acme/widget-kit',
        '--thread-id',
        'T_1',
        '--target-repo',
        'acme/acme-app',
        '--json',
      ],
    ],
    [
      '빈 작업 문장',
      [
        'followup',
        'build',
        '--pr',
        '30',
        '--repo',
        'acme/widget-kit',
        '--thread-id',
        'T_1',
        '--target-repo',
        'acme/acme-app',
        '--work',
        ' ',
        '--json',
      ],
    ],
  ])('%s은 stdout을 비우고 1로 끝난다', (_name, args) => {
    const r = run(['harness-refs', ...args]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  });

  it('three-state --json은 JSON 한 줄만 내고 키가 고정돼 있다', () => {
    const s = buildThreeStateOrg('mergeOrder');
    const dir = tempDir();
    const clone = join(dir, 'design-kit');
    execFileSync('git', ['clone', '-q', s.org.repos['design-kit']!.root, clone]);
    const candidates = join(dir, 'collect.json');
    writeFileSync(
      candidates,
      JSON.stringify({
        version: 1,
        repo: 'acme/widget-kit',
        relatedRepos: ['acme/design-kit'],
        identifiers: [
          { kind: 'ruleId', value: s.identifier, changeType: 'modified', extractedBy: 'pattern' },
        ],
        candidates: {},
      }),
    );
    const relatedPrs = join(dir, 'related.json');
    writeFileSync(
      relatedPrs,
      JSON.stringify({
        candidates: [
          {
            repo: 'acme/design-kit',
            number: 7,
            headSha: s.provider.relatedHeadSha,
            state: 'open',
            foundBy: 'bodyLink',
            confirmation: 'confirmed',
          },
        ],
      }),
    );

    const r = run([
      'harness-refs',
      'three-state',
      '--candidates',
      candidates,
      '--related-prs',
      relatedPrs,
      '--repo-dir',
      `acme/design-kit=${clone}`,
      '--json',
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(
      [
        'counts',
        'currentRepo',
        'fetches',
        'judgments',
        'limitations',
        'needsRecheck',
        'relatedPrHeads',
        'relatedPrLookupBlocked',
        'relatedPrUnconfirmed',
        'unconfirmedRelatedPrs',
        'version',
      ].sort(),
    );
    const j = (out.judgments as Record<string, unknown>[])[0]!;
    expect(j.status).toBe('mergeOrder');
    expect(Object.keys(j)).toEqual(
      expect.arrayContaining(['status', 'checked', 'verdict', 'basis', 'unconfirmedRelatedPrs']),
    );
  });

  it('followup build --json은 find가 되읽는 마커를 낸다', () => {
    const work = join(tempDir(), 'work.md');
    writeFileSync(work, '`release` 스킬 "갱신"\n');
    const r = run([
      'harness-refs',
      'followup',
      'build',
      '--pr',
      'https://github.com/acme/widget-kit/pull/30',
      '--thread-id',
      'PRRT_1',
      '--target-repo',
      'acme/acme-app',
      '--work-file',
      work,
      '--json',
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    const out = JSON.parse(r.stdout) as { version: number; marker: unknown; text: string };
    expect(Object.keys(out).sort()).toEqual(['marker', 'text', 'version']);
    expect(out.marker).toEqual({
      originRepo: 'acme/widget-kit',
      originPrNumber: 30,
      threadId: 'PRRT_1',
      targetRepo: 'acme/acme-app',
      plannedWork: '`release` 스킬 "갱신"',
    });
    expect(parseFollowUpMarkers(out.text)).toEqual([out.marker]);
    expect(out.text.split('\n')[1]).toContain('acme/acme-app');
  });

  it('followup check --json은 키가 고정돼 있다', () => {
    const dir = tempDir();
    const markers = join(dir, 'markers.json');
    const marker = {
      originRepo: 'acme/widget-kit',
      originPrNumber: 30,
      threadId: 'T_1',
      targetRepo: 'acme/acme-app',
      plannedWork: 'release 스킬 갱신',
    };
    expect(buildFollowUpMarker(marker)).toContain('gestalt-followup');
    writeFileSync(
      markers,
      JSON.stringify({
        status: 'found',
        markers: [
          { marker, source: { repo: 'acme/widget-kit', number: 30, url: '', author: 'kim' } },
        ],
      }),
    );
    const body = join(dir, 'body.md');
    writeFileSync(body, 'acme/widget-kit#30 release 스킬 갱신');

    const r = run([
      'harness-refs',
      'followup',
      'check',
      '--markers',
      markers,
      '--repo',
      'acme/acme-app',
      '--body-file',
      body,
      '--json',
    ]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(
      [
        'limitations',
        'lookupBlocked',
        'needsBodyMention',
        'pr',
        'repo',
        'results',
        'status',
        'unmetCount',
        'upstreamBlocked',
        'version',
      ].sort(),
    );
    const item = (out.results as Record<string, unknown>[])[0]!;
    expect(Object.keys(item).sort()).toEqual(['actions', 'marker', 'match', 'source']);
  });
});
