import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { frameFileName } from '../../../src/digest/frames.js';
import { embedJson, renderDigestHtml } from '../../../src/digest/render-html.js';
import { renderDigestMarkdown } from '../../../src/digest/render-md.js';
import { exportMarkdown, renderToFiles } from '../../../src/digest/render.js';
import type { Digest, Transcript } from '../../../src/digest/schema.js';
import { DigestStore } from '../../../src/digest/store.js';
import { VIEWER_JS, VIEWER_JS_SHA256 } from '../../../src/digest/viewer-js.js';
import { findSegmentIndex, viewerLogic } from '../../../src/digest/viewer-logic.js';
import { SLUG, sampleDigest, sampleTranscript } from './fixture.js';

const tmpDirs: string[] = [];
function tmpRepo(): string {
  const dir = resolve('.gestalt-test', `digest-render-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fileTranscript(): Transcript {
  const t = sampleTranscript();
  return {
    ...t,
    meta: { ...t.meta, source: 'file', videoId: undefined, url: 'file:///tmp/talk.mp4' },
  };
}

function dataOf(html: string): Record<string, unknown> {
  const m = html.match(/<script type="application\/json" id="digest-data">([\s\S]*?)<\/script>/);
  return JSON.parse(m![1]!) as Record<string, unknown>;
}

describe('renderDigestHtml 마커', () => {
  it('escape한 뒤 굵게와 키워드 마커만 태그로 바꾼다', () => {
    const d = sampleDigest();
    d.reports[0]!.lead.question =
      '<img src=x onerror=alert(1)> **왜** {{kw:code-layers|코드 레이어}}?';
    const { html, warnings } = renderDigestHtml(d, sampleTranscript());
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('<strong>왜</strong>');
    expect(html).toContain(
      '<button type="button" class="kw" data-kw="code-layers">코드 레이어</button>',
    );
    expect(warnings).toEqual([]);
  });

  it('목록에 없는 키워드 마커는 글자만 남기고 경고한다', () => {
    const d = sampleDigest();
    d.reports[0]!.lead.answer = '{{kw:ghost|유령}} 이야기';
    const { html, warnings } = renderDigestHtml(d, sampleTranscript());
    expect(html).toContain('<p>유령 이야기</p>');
    expect(warnings).toEqual(['키워드 목록에 없는 마커: ghost']);
  });

  it('출처는 문장 번호를 1부터 보이고 범위를 data 속성으로 싣는다', () => {
    const { html } = renderDigestHtml(sampleDigest(), sampleTranscript());
    expect(html).toMatch(
      /class="cite" data-key="1" data-from="1" data-to="\d+" aria-label="출처 2">\[2\]/,
    );
  });

  it('제목 앞 번호는 떼고 렌더러가 다시 매긴다', () => {
    const { html } = renderDigestHtml(sampleDigest(), sampleTranscript());
    expect(html).toContain('<span class="num">1.1.</span> 캔버스로 코드 가져오기');
    expect(html).not.toContain('1.1. 1.1.');
    expect(html).toContain('href="#sec-');
    expect(html).toContain('data-nav="sec-');
  });

  it('제목은 마커를 해석하지 않고 본문, 목차, 미니맵 모두 escape만 한다', () => {
    const d = sampleDigest();
    d.reports[0]!.sections[0]!.title = '**굵게** {{kw:code-layers|코드}} <b>';
    d.reports[0]!.sections[0]!.subsections[0]!.title = '1.1. **소제목**';
    const { html } = renderDigestHtml(d, sampleTranscript());
    const raw = '**굵게** {{kw:code-layers|코드}} &lt;b&gt;';
    expect(html).toContain(`<span class="num">1.</span> ${raw} `);
    expect(html).toContain(`>1. ${raw}</a>`);
    expect(html).toContain(`title="${raw}" aria-label="1. ${raw}"`);
    expect(html).toContain('<span class="num">1.1.</span> **소제목** ');
    expect(html).not.toContain('<strong>굵게</strong>');
    expect(html).not.toContain('<strong>소제목</strong>');
  });

  it('본문에 </script>가 있어도 데이터 블록이 닫히지 않는다', () => {
    const t = sampleTranscript();
    t.segments[0]!.text = 'bad </script><script>alert(1)</script>';
    const { html } = renderDigestHtml(sampleDigest(), t);
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(dataOf(html).starts).toHaveLength(12);
    expect(embedJson({ a: '</script>' })).toBe('{"a":"\\u003c/script>"}');
  });
});

describe('renderDigestHtml 플레이어', () => {
  it('유튜브 영상은 썸네일과 유튜브에서 열기 링크를 기본으로 둔다', () => {
    const { html } = renderDigestHtml(sampleDigest(), sampleTranscript());
    expect(html).toContain(
      'class="player-fallback" href="https://www.youtube.com/watch?v=ukY9Dvwm7Gc"',
    );
    expect(html).toContain('유튜브에서 열기');
    expect(html).toContain('https://i.ytimg.com/vi/ukY9Dvwm7Gc/hqdefault.jpg');
    expect(html).toContain('<div id="player-frame"></div>');
    expect(html).toContain('<div id="player-slot" class="player-slot">');
    expect(html).toContain('id="player-dock"');
    const data = dataOf(html);
    expect(data.videoId).toBe('ukY9Dvwm7Gc');
    expect(data.watchBase).toBe('https://www.youtube.com/watch?v=ukY9Dvwm7Gc');
  });

  it('유튜브에서 열기 링크는 meta.url이 아니라 videoId로 만든 주소만 쓴다', () => {
    const t = sampleTranscript();
    t.meta.url = 'javascript:alert(1)';
    const { html } = renderDigestHtml(sampleDigest(), t);
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain(
      'class="player-fallback" href="https://www.youtube.com/watch?v=ukY9Dvwm7Gc"',
    );
  });

  it('스크립트 패널은 이름 있는 영역이고 줄별 시각 링크는 Tab 순서에서 빠진다', () => {
    const { html } = renderDigestHtml(sampleDigest(), sampleTranscript());
    expect(html).toContain(
      '<div id="script-body" class="script-body" tabindex="0" role="region" aria-label="영상 스크립트">',
    );
    expect(html).toContain(
      '<li data-i="0"><a class="ts" href="https://www.youtube.com/watch?v=ukY9Dvwm7Gc&amp;t=0s" target="_blank" rel="noopener" data-sec="0" tabindex="-1">',
    );
    const body = html.slice(html.indexOf('<main'));
    expect(body).not.toContain('tabindex="-1"');
  });

  it('복사 결과는 화면에 안 보이는 라이브 영역으로 알린다', () => {
    const { html } = renderDigestHtml(sampleDigest(), sampleTranscript());
    expect(html).toContain(
      '<p id="copy-status" class="sr-only" role="status" aria-live="polite"></p>',
    );
    expect(html).toContain('.sr-only{position:absolute;');
    expect(VIEWER_JS).toContain("getElementById('copy-status')");
    expect(VIEWER_JS).toContain('복사하지 못했어요. 직접 선택해 복사해 주세요');
  });

  it('noscript 안내는 자바스크립트와 화면 이름을 구분해 적는다', () => {
    const { html } = renderDigestHtml(sampleDigest(), sampleTranscript());
    expect(html).toContain(
      '자바스크립트가 꺼져 있어 출처 툴팁과 키워드 팝업, 재생 따라가기, 리포트 전환이 동작하지 않아요.',
    );
  });

  it('시각은 새 탭으로 그 시각을 여는 링크다. file://에서는 이 링크가 그대로 쓰인다', () => {
    const { html } = renderDigestHtml(sampleDigest(), sampleTranscript());
    expect(html).toContain(
      '<a class="ts" href="https://www.youtube.com/watch?v=ukY9Dvwm7Gc&amp;t=10s" target="_blank" rel="noopener" data-sec="10" tabindex="-1">00:10</a>',
    );
    expect(html).toContain('<noscript>');
  });

  it('로컬 파일 영상은 video 요소와 serve 안내를 싣고 시각은 링크가 아니다', () => {
    const { html } = renderDigestHtml(sampleDigest(), fileTranscript());
    expect(html).toContain(
      '<video id="player-video" controls playsinline preload="metadata" aria-label="영상 재생"></video>',
    );
    expect(html).toContain(`<code>gestalt digest serve ${SLUG}</code>로 열어야 재생돼요`);
    expect(html).toContain('id="player-slot"');
    expect(html).not.toContain('<div id="player-frame">');
    expect(html).toContain('<span class="ts" data-sec="10">00:10</span>');
    expect(dataOf(html).videoId).toBeNull();
    expect(dataOf(html).localVideo).toBe(true);
    expect(html).not.toContain('시각 링크는 유튜브 새 탭으로');
  });

  it('번역이 있으면 문장 아래 번역 줄과 숨겨 둔 토글을 싣는다', () => {
    const t = sampleTranscript();
    t.meta.translationLang = 'ko';
    t.segments[1]!.translation = '<b>두 번째</b> 문장';
    const { html } = renderDigestHtml(sampleDigest(), t);
    expect(html).toContain(
      '<span class="txt"><span class="src">Sentence number 1.</span><span class="tr" lang="ko">&lt;b&gt;두 번째&lt;/b&gt; 문장</span></span>',
    );
    expect(html).toContain('<span class="txt"><span class="src">Sentence number 0.</span></span>');
    expect(html).toContain(
      'id="tr-toggle" class="tr-toggle" aria-pressed="true" hidden>번역</button>',
    );
  });

  it('번역 언어가 없으면 번역 문장이 있어도 싣지 않는다', () => {
    const t = sampleTranscript();
    t.segments[1]!.translation = '두 번째 문장';
    const { html } = renderDigestHtml(sampleDigest(), t);
    expect(html).not.toContain('class="tr"');
    expect(html).not.toContain('id="tr-toggle"');
  });

  it('좁은 화면에서는 미니 플레이어 높이만큼 본문 아래를 비운다', () => {
    const { html } = renderDigestHtml(sampleDigest(), sampleTranscript());
    expect(html).toContain('.player.is-floating{position:fixed;');
    expect(html).toContain('width:var(--float-w);');
    const narrow = html.slice(html.indexOf('@media (max-width:900px){'));
    expect(narrow.slice(0, narrow.indexOf('\n}'))).toContain(
      '.main{padding-bottom:calc(var(--float-w) * 9 / 16 + 32px + env(safe-area-inset-bottom, 0px))}',
    );
  });

  it('1시간 넘는 영상은 시를 붙인다', () => {
    const t = sampleTranscript();
    t.meta.durationSec = 3700;
    const { html } = renderDigestHtml(sampleDigest(), t);
    expect(html).toContain('>0:00:10</a>');
  });
});

describe('renderDigestHtml 프레임', () => {
  it('있는 프레임만 상대 경로로 싣는다', () => {
    const has = frameFileName(0);
    const { html } = renderDigestHtml(sampleDigest(), sampleTranscript(), {
      frameExists: (f) => f === has,
    });
    expect(html).toContain(`src="frames/${has}"`);
    expect(html.match(/<figure class="frame">/g)).toHaveLength(1);
  });

  it('프레임 확인 수단이 있고 프레임이 없으면 자리를 비우고 경고한다', () => {
    const { warnings } = renderDigestHtml(sampleDigest(), sampleTranscript(), {
      frameExists: (f) => f === frameFileName(0),
    });
    expect(warnings).toEqual([
      `프레임이 없어 자리를 비웠다: s1-2 (${frameFileName(15)})`,
      `프레임이 없어 자리를 비웠다: s2-1 (${frameFileName(30)})`,
      `프레임이 없어 자리를 비웠다: s2-2 (${frameFileName(45)})`,
    ]);

    const inline = renderDigestHtml(sampleDigest(), sampleTranscript(), {
      inlineFrames: true,
      loadFrame: (f) => (f === frameFileName(0) ? Buffer.alloc(10) : null),
    });
    expect(inline.warnings).toHaveLength(3);
    expect(inline.warnings[0]).toBe(`프레임이 없어 자리를 비웠다: s1-2 (${frameFileName(15)})`);

    expect(renderDigestHtml(sampleDigest(), sampleTranscript()).warnings).toEqual([]);
  });

  it('인라인 모드는 data URI로 싣고 한 장 5MB, 합계 15MB를 넘으면 뺀다', () => {
    const sizes: Record<string, number> = {
      [frameFileName(0)]: 10,
      [frameFileName(15)]: 6 * 1024 * 1024,
      [frameFileName(30)]: 4.5 * 1024 * 1024,
      [frameFileName(45)]: 4.5 * 1024 * 1024,
    };
    let big = 0;
    const { html, warnings } = renderDigestHtml(sampleDigest(), sampleTranscript(), {
      inlineFrames: true,
      loadFrame: (f) => {
        const n = sizes[f];
        if (n === undefined) return null;
        if (n > 1024) big += 1;
        return Buffer.alloc(n);
      },
    });
    expect(big).toBe(3);
    expect(html.match(/src="data:image\/jpeg;base64,/g)).toHaveLength(3);
    expect(warnings).toEqual([`프레임이 5MB를 넘어 건너뛰었다: ${frameFileName(15)}`]);

    sizes[frameFileName(0)] = 4.5 * 1024 * 1024;
    sizes[frameFileName(15)] = 4.5 * 1024 * 1024;
    const again = renderDigestHtml(sampleDigest(), sampleTranscript(), {
      inlineFrames: true,
      loadFrame: (f) => Buffer.alloc(sizes[f]!),
    });
    expect(again.warnings).toEqual([
      `프레임 합계가 15MB를 넘어 프레임을 건너뛰었다: ${frameFileName(45)}`,
    ]);
  });
});

describe('renderDigestMarkdown', () => {
  it('번호를 다시 매기고 출처를 그 시각 링크로 단다', () => {
    const md = renderDigestMarkdown(sampleDigest(), sampleTranscript());
    expect(md).toMatch(
      /^# Design with Code Layers \| Figma\n\n> Figma \| 2026-10-15 \| 01:02 \| 자동 자막\n/,
    );
    expect(md).toContain('## 1. 코드 레이어 소개');
    expect(md).toContain('### 1.1. 캔버스로 코드 가져오기');
    expect(md).toContain('- **코드를 그대로** 가져온다.');
    expect(md).toMatch(/\[\[\d+\]\]\(https:\/\/www\.youtube\.com\/watch\?v=ukY9Dvwm7Gc&t=\d+s\)/);
    expect(md).toContain('코드 레이어는 캔버스 위에서');
    expect(md).not.toContain('{{kw:');
    expect(md).toContain('## 키워드');
    expect(md).not.toContain('## 요약에서 뺀 구간');
  });

  it('파일 영상은 출처에 링크 대신 시각을 적고 뺀 구간도 남긴다', () => {
    const d: Digest = sampleDigest();
    d.reports[0]!.skipped = [{ from: 10, to: 11, reason: '광고' }];
    const md = renderDigestMarkdown(d, fileTranscript());
    expect(md).toMatch(/ \[2 00:05\]/);
    expect(md).toContain('## 요약에서 뺀 구간\n\n- 00:50~ 문장 11-12: 광고');
  });

  it('있는 프레임만 이미지로 싣는다', () => {
    const md = renderDigestMarkdown(sampleDigest(), sampleTranscript(), {
      frameExists: (f) => f === frameFileName(15),
    });
    expect(md).toContain(`![00:15](frames/${frameFileName(15)})`);
    expect(md.match(/!\[/g)).toHaveLength(1);
  });
});

describe('renderToFiles와 exportMarkdown', () => {
  function seeded(digest: Digest = sampleDigest()) {
    const repo = tmpRepo();
    const store = new DigestStore(repo);
    store.saveTranscript(sampleTranscript());
    store.saveDigest(digest);
    return { repo, store };
  }

  it('HTML과 마크다운을 슬러그 폴더에 쓴다', () => {
    const { repo, store } = seeded();
    mkdirSync(store.framesDir(SLUG), { recursive: true });
    writeFileSync(join(store.framesDir(SLUG), frameFileName(0)), 'jpg');
    const r = renderToFiles(SLUG, { repoRoot: repo });
    expect(readFileSync(r.htmlPath, 'utf-8')).toContain(`src="frames/${frameFileName(0)}"`);
    expect(readFileSync(r.mdPath, 'utf-8')).toContain(`(frames/${frameFileName(0)})`);
  });

  it('validate 오류가 남아 있으면 렌더하지 않는다', () => {
    const d = sampleDigest();
    d.reports[0]!.sections[0]!.cite = { key: 99, from: 99, to: 99 };
    const { repo, store } = seeded(d);
    expect(() => renderToFiles(SLUG, { repoRoot: repo })).toThrow(/validate 오류/);
    expect(existsSync(store.htmlPath(SLUG))).toBe(false);
  });

  it('export --md는 지정한 경로에 쓴다', () => {
    const { repo } = seeded();
    const out = join(repo, 'out.md');
    expect(exportMarkdown(SLUG, { repoRoot: repo, out }).mdPath).toBe(out);
    expect(readFileSync(out, 'utf-8')).toContain('## 2. 여러 방향 만들기');
  });
});

describe('viewer-js', () => {
  it('findSegmentIndex는 재생 시각이 속한 문장을 이진 탐색으로 찾는다', () => {
    const starts = [0, 2.5, 5, 9];
    expect(findSegmentIndex(starts, -1)).toBe(-1);
    expect(findSegmentIndex(starts, 0)).toBe(0);
    expect(findSegmentIndex(starts, 2.4)).toBe(0);
    expect(findSegmentIndex(starts, 2.5)).toBe(1);
    expect(findSegmentIndex(starts, 8.99)).toBe(2);
    expect(findSegmentIndex(starts, 500)).toBe(3);
    expect(findSegmentIndex([], 3)).toBe(-1);
    expect(findSegmentIndex([1], Number.NaN)).toBe(-1);
  });

  it('소섹션은 스크롤로 영상을 옮길 문장 범위를 들고 있다', () => {
    const { html } = renderDigestHtml(sampleDigest(), sampleTranscript());
    expect(html).toContain('<div class="sub" id="sub-s1-1" data-from="0" data-to="2">');
    expect(html).toContain('<div class="sub" id="sub-s1-2" data-from="3" data-to="5">');
  });

  it('shouldFollow는 이미 그 구간이거나 방금 시각을 눌렀으면 영상을 옮기지 않는다', () => {
    const { shouldFollow } = viewerLogic;
    expect(shouldFollow(-1, 3, 5, 1000, 0)).toBe(true);
    expect(shouldFollow(2, 3, 5, 1000, 0)).toBe(true);
    expect(shouldFollow(3, 3, 5, 1000, 0)).toBe(false);
    expect(shouldFollow(5, 3, 5, 1000, 0)).toBe(false);
    expect(shouldFollow(6, 3, 5, 1000, 0)).toBe(true);
    expect(shouldFollow(6, 3, 5, 1000, 5000)).toBe(false);
    expect(shouldFollow(6, 3, 5, 5000, 5000)).toBe(true);
  });

  it('shouldFollowHeld는 유예가 끝났어도 재생이나 버퍼링 중이면 사용자가 옮긴 자리를 둔다', () => {
    const { shouldFollowHeld } = viewerLogic;
    expect(shouldFollowHeld(1, 9, 3, 5, 6000, 5000)).toBe(false);
    expect(shouldFollowHeld(3, 9, 3, 5, 6000, 5000)).toBe(false);
    expect(shouldFollowHeld(2, 9, 3, 5, 6000, 5000)).toBe(true);
    expect(shouldFollowHeld(-1, -1, 3, 5, 6000, 5000)).toBe(true);
    expect(shouldFollowHeld(2, 4, 3, 5, 6000, 5000)).toBe(false);
    expect(shouldFollowHeld(2, 9, 3, 5, 6000, 8000)).toBe(false);
  });

  it('cueAction은 재생, 일시정지, 버퍼링일 때만 seek으로 옮기고 나머지는 위치만 잡는다', () => {
    const { cueAction } = viewerLogic;
    expect([1, 2, 3].map(cueAction)).toEqual(['seek', 'seek', 'seek']);
    expect([-1, 0, 5].map(cueAction)).toEqual(['cue', 'cue', 'cue']);
  });

  it('citeWindow는 출처 툴팁 문장을 최대 개수로 자르고 남은 수를 센다', () => {
    const { citeWindow } = viewerLogic;
    expect(citeWindow(3, 3, 8)).toEqual({ end: 3, more: 0 });
    expect(citeWindow(0, 7, 8)).toEqual({ end: 7, more: 0 });
    expect(citeWindow(0, 20, 8)).toEqual({ end: 7, more: 13 });
  });

  it('페이지에 싣는 스크립트가 테스트한 판단 함수를 그대로 쓴다', () => {
    for (const name of [
      'findSegmentIndex',
      'shouldFollow',
      'shouldFollowHeld',
      'cueAction',
      'citeWindow',
      'safeDecode',
      'makeFlash',
    ]) {
      expect(VIEWER_JS).toContain(`function ${name}(`);
      expect(VIEWER_JS.match(new RegExp(`function ${name}\\(`, 'g'))).toHaveLength(1);
    }
  });

  it('뷰어 스크립트는 문법이 맞고 백틱이나 템플릿 치환이 없다', () => {
    expect(() => new Function(VIEWER_JS)).not.toThrow();
    expect(VIEWER_JS).not.toMatch(/`|\$\{/);
  });

  it('실행되는 인라인 스크립트는 VIEWER_JS 하나이고 CSP 해시와 맞는다', () => {
    const { html } = renderDigestHtml(sampleDigest(), sampleTranscript());
    const scripts = [
      ...html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g),
    ];
    expect(scripts).toHaveLength(1);
    const body = scripts[0]![1]!;
    expect(body).toBe(VIEWER_JS);
    expect(createHash('sha256').update(body, 'utf8').digest('base64')).toBe(VIEWER_JS_SHA256);
  });
});

describe('safeDecode', () => {
  it('깨진 퍼센트 인코딩이면 던지지 않고 빈 문자열을 돌려준다', () => {
    const { safeDecode } = viewerLogic;
    expect(safeDecode('sub-%EA%B0%80')).toBe('sub-가');
    expect(safeDecode('%E0%A4%A')).toBe('');
    expect(safeDecode('%')).toBe('');
    expect(safeDecode('')).toBe('');
  });
});

describe('videoState', () => {
  it('HTML5 video 상태를 유튜브 재생 상태 코드로 옮긴다', () => {
    const { videoState, cueAction } = viewerLogic;
    expect(videoState(true, true, 30, 4)).toBe(0);
    expect(videoState(false, true, 0, 1)).toBe(-1);
    expect(videoState(false, true, 12, 4)).toBe(2);
    expect(videoState(false, false, 12, 2)).toBe(3);
    expect(videoState(false, false, 12, 4)).toBe(1);
    expect(cueAction(videoState(false, true, 12, 4))).toBe('seek');
  });
});

describe('makeFlash', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('앞 알림이 남은 채 다른 버튼을 누르면 앞 버튼 글자를 되돌리고 뒤 알림을 1.5초 동안 둔다', () => {
    vi.useFakeTimers();
    const status = { textContent: '' as string | null };
    const flash = viewerLogic.makeFlash(() => status);
    const a = { textContent: 'A 복사' as string | null };
    const b = { textContent: 'B 복사' as string | null };

    flash(a, 'A 복사', false);
    vi.advanceTimersByTime(0);
    expect(status.textContent).toBe('복사했어요');
    vi.advanceTimersByTime(1000);

    flash(b, 'B 복사', false);
    expect(a.textContent).toBe('A 복사');
    expect(b.textContent).toBe('복사했어요');
    expect(status.textContent).toBe('');

    vi.advanceTimersByTime(0);
    expect(status.textContent).toBe('복사했어요');
    vi.advanceTimersByTime(1499);
    expect(status.textContent).toBe('복사했어요');
    expect(b.textContent).toBe('복사했어요');
    vi.advanceTimersByTime(1);
    expect(status.textContent).toBe('');
    expect(b.textContent).toBe('B 복사');
  });

  it('실패하면 직접 복사하라는 문구를 3초 동안 둔다', () => {
    vi.useFakeTimers();
    const status = { textContent: '' as string | null };
    const flash = viewerLogic.makeFlash(() => status);
    const btn = { textContent: '복사' as string | null };

    flash(btn, '복사', true);
    expect(btn.textContent).toBe('복사 실패');
    vi.advanceTimersByTime(0);
    expect(status.textContent).toBe('복사하지 못했어요. 직접 선택해 복사해 주세요');
    vi.advanceTimersByTime(2999);
    expect(btn.textContent).toBe('복사 실패');
    vi.advanceTimersByTime(1);
    expect(btn.textContent).toBe('복사');
    expect(status.textContent).toBe('');
  });
});
