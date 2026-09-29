import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupFakeRepos } from '../../helpers/fake-repo.js';
import {
  buildCopyDriftRepo,
  buildFileNameOnlyRefOrg,
  buildFollowUpOrg,
  buildIsolatedOrg,
  buildKnowledgeDocOrg,
  buildMcpToolOrg,
  buildNoRemoteRepo,
  buildPlaceholderOrg,
  buildReceiveOnlyOrg,
  buildSelfContaminationRepo,
  buildThreeStateOrg,
} from '../../fixtures/harness-repos/scenarios.js';

afterEach(cleanupFakeRepos);

const read = (root: string, rel: string) =>
  existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf-8') : '';

describe('시나리오 fixture smoke', () => {
  it('자기오염: diff가 금지어를 더하고 동의어 문서가 남아 있다', () => {
    const s = buildSelfContaminationRepo();
    expect(s.diff).toContain(`+메타포를 쓰지 않는다`);
    for (const f of s.contaminatedFiles) {
      const text = read(s.repo.root, f);
      expect(s.synonyms.some((w) => text.includes(w))).toBe(true);
    }
    for (const f of s.cleanFiles) {
      const text = read(s.repo.root, f);
      expect([s.bannedTerm, ...s.synonyms].some((w) => text.includes(w))).toBe(false);
    }
  });

  it('사본 어긋남: blob 동일 쌍, co-change 쌍, 숨은 사본, 같게 유지 쌍이 갖춰진다', () => {
    const s = buildCopyDriftRepo();
    const { identicalPair: ip } = s;
    expect(s.repo.blobSha(ip.other, s.baseSha)).toBe(ip.blobSha);
    expect(s.repo.blobSha(ip.changed, s.baseSha)).toBe(ip.blobSha);
    expect(s.repo.blobSha(ip.changed, s.headSha)).not.toBe(ip.blobSha);
    const changed = s.repo.changedFiles(s.baseSha, s.headSha);
    expect(changed).toContain(ip.changed);
    expect(changed).not.toContain(ip.other);
    expect(changed).toContain(s.coChangePair.changed);
    expect(changed).not.toContain(s.coChangePair.other);
    const log = s.repo.git('log', '--format=', '--name-only', '--', s.coChangePair.other);
    expect(log.split('\n').filter(Boolean)).toHaveLength(3);
    expect(read(s.repo.root, s.hiddenCopy.path)).toContain(s.hiddenCopy.oldSentence);
    expect(changed).not.toContain(s.hiddenCopy.path);
    expect(changed).toContain(s.keepInSyncPair.changed);
    expect(read(s.repo.root, s.keepInSyncPair.other)).toContain('같게 유지');
  });

  it('자리표시자: 같은 토큰이 파일마다 다른 레포의 파일을 가리킨다', () => {
    const s = buildPlaceholderOrg();
    const has = (repo: string, rel: string) => existsSync(join(s.org.repos[repo]!.root, rel));
    const f = s.files;
    expect(read(s.org.repos[f.pointsToDesignKit.repo]!.root, f.pointsToDesignKit.file)).toContain(
      f.pointsToDesignKit.placeholder,
    );
    expect(f.pointsToDesignKit.placeholder).toBe(f.pointsToWidgetKit.placeholder);
    expect(has('design-kit', f.pointsToDesignKit.target)).toBe(true);
    expect(has(f.pointsToDesignKit.repo, f.pointsToDesignKit.target)).toBe(false);
    expect(has('widget-kit', f.pointsToWidgetKit.target)).toBe(true);
    expect(has(f.pointsToWidgetKit.repo, f.pointsToWidgetKit.target)).toBe(false);
    const owners = Object.keys(s.org.repos).filter((r) => has(r, f.ownRepoFirst.target));
    expect(owners).toContain(f.ownRepoFirst.repo);
    expect(owners.length).toBeGreaterThan(1);
    const common = Object.keys(s.org.repos).filter((r) => has(r, f.commonPathCollision.target));
    expect(common).toHaveLength(3);
    expect(Object.keys(s.org.repos).some((r) => has(r, f.matchesNothing.target))).toBe(false);
  });

  it('파일 이름만 적은 참조: 하나뿐인 이름이 삭제되고 흔한 이름은 여러 레포에 있다', () => {
    const s = buildFileNameOnlyRefOrg();
    const doc = read(s.org.repos[s.consumerDoc.repo]!.root, s.consumerDoc.file);
    expect(doc).toContain(s.fileName);
    expect(doc).not.toContain(`config/${s.fileName}`);
    expect(s.provider.diff).toContain(`-{ "colors": [] }`);
    expect(s.org.repos['widget-kit']!.changedFiles(s.provider.baseSha, s.provider.headSha)).toEqual(
      [`config/${s.fileName}`],
    );
    for (const r of Object.values(s.org.repos)) {
      expect(existsSync(join(r.root, 'config', s.commonFileName))).toBe(true);
    }
  });

  it('받기만 하는 레포: 이름이 바뀌고 호출한 문서는 다른 레포에 있다', () => {
    const s = buildReceiveOnlyOrg();
    const receiver = s.org.repos[s.receiver]!;
    expect(s.rename.diff).toContain(s.rename.newName);
    const all = readdirSync(receiver.root, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && !d.parentPath.includes('.git'))
      .map((d) => readFileSync(join(d.parentPath, d.name), 'utf-8'))
      .join('\n');
    expect(all).not.toContain('acme-app');
    expect(read(s.org.repos[s.caller.repo]!.root, s.caller.file)).toContain(s.rename.oldName);
  });

  it('참조 없는 레포: 다른 레포 이름이 어디에도 없다', () => {
    const s = buildIsolatedOrg();
    const files = (root: string) =>
      readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile() && !d.parentPath.includes('.git'))
        .map((d) => readFileSync(join(d.parentPath, d.name), 'utf-8'))
        .join('\n');
    const lonely = files(s.org.repos[s.isolated]!.root);
    const other = files(s.org.repos['acme-app']!.root);
    expect(lonely).not.toContain('acme-app');
    expect(other).not.toContain('lonely-kit');
    expect(s.change.diff).not.toBe('');
  });

  it('지식 문서: 설명만 있는 문서와 진짜 참조가 같은 레포에 따로 있다', () => {
    const s = buildKnowledgeDocOrg();
    const k = read(s.org.repos[s.knowledgeDoc.repo]!.root, s.knowledgeDoc.file);
    const h = read(s.org.repos[s.harnessRef.repo]!.root, s.harnessRef.file);
    expect(k).toContain('widget-kit');
    expect(k).not.toContain(s.change.removedPath);
    expect(h).toContain(s.change.removedPath);
    expect(s.change.diff).toContain(`deleted file mode`);
  });

  it('원격 없는 레포: origin이 없다', () => {
    const s = buildNoRemoteRepo();
    expect(s.repo.remoteUrl).toBeNull();
    expect(s.repo.git('remote').trim()).toBe('');
    expect(s.change.diff).toContain('먼저 인사한다');
  });

  it('MCP 도구 등록부: sdk 의존 패키지에 패턴으로 잡히는 등록과 동적 등록이 있다', () => {
    const s = buildMcpToolOrg();
    const root = s.org.repos[s.server.repo]!.root;
    expect(read(root, 'package.json')).toContain('@modelcontextprotocol/sdk');
    const src = read(root, s.server.file);
    for (const n of [s.rename.newName, 'acme_get_widget']) {
      expect(src).toContain(`server.tool('${n}'`);
    }
    expect(read(root, s.dynamicRegistry.file)).not.toMatch(/server\.tool\('/);
    expect(read(s.org.repos[s.caller.repo]!.root, s.caller.file)).toContain(s.rename.oldName);
    expect(s.rename.diff).toContain(`-server.tool('${s.rename.oldName}'`);
  });

  it.each([
    ['mergeOrder', 'ok', 'broken'],
    ['bothBroken', 'broken', 'broken'],
    ['relatedRemovesUsed', 'broken', 'ok'],
  ] as const)('세 상태 %s: main과 연관 PR head에서 식별자가 기대대로 보인다', (kind) => {
    const s = buildThreeStateOrg(kind);
    const provider = s.org.repos[s.provider.repo]!;
    const exists = (ref: string) => {
      try {
        provider.git('cat-file', '-e', `${ref}:rules/${s.identifier}.md`);
        return true;
      } catch {
        return false;
      }
    };
    const state = (ok: boolean) => (ok ? 'ok' : 'broken');
    expect(state(exists(s.provider.mainSha))).toBe(s.expected.onMain);
    expect(state(exists(s.provider.relatedHeadSha))).toBe(s.expected.onRelatedHead);
    expect(provider.git('rev-parse', s.provider.relatedBranch).trim()).toBe(
      s.provider.relatedHeadSha,
    );
    expect(provider.git('rev-parse', 'main').trim()).toBe(s.provider.mainSha);
    const consumer = s.org.repos[s.consumer.repo]!;
    expect(consumer.diff(s.consumer.baseSha, s.consumer.headSha)).toContain(
      `+스타일은 ${s.identifier}`,
    );
  });

  it('후속 PR: 표시가 가리킨 작업을 한 브랜치와 안 한 브랜치가 갈린다', () => {
    const s = buildFollowUpOrg();
    const app = s.org.repos[s.followUp.repo]!;
    expect(app.changedFiles('main', s.followUp.headSha)).toEqual(s.followUp.touchedFiles);
    expect(app.changedFiles('main', s.followUpMissingWork.headSha)).not.toEqual(
      s.followUp.touchedFiles,
    );
    expect(s.planned.targetRepo).toBe(s.followUp.repo);
  });

  it('원격 URL이 acme owner로 붙는다', () => {
    const s = buildPlaceholderOrg();
    for (const r of Object.values(s.org.repos)) {
      expect(r.remoteUrl).toBe(`https://github.com/acme/${r.name}.git`);
    }
  });
});
