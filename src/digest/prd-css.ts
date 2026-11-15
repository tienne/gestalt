// 색 토큰은 digest 뷰어(render-html.ts)와 같은 값을 복제해 쓴다. 테마 저장 키도 같이 써서 고른 테마가 이어진다
export const PRD_CSS = `
:root{color-scheme:light;--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--card:#fff;--accent:#2563eb;--warn:#b45309;--chip:#f5f5f4;--hl:#fef3c7;--on-accent:#fff;--ok:#15803d;--danger:#b91c1c}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--line:#292524;--card:#1c1917;--accent:#60a5fa;--warn:#fbbf24;--chip:#292524;--hl:#422006;--on-accent:#0c0a09;--ok:#4ade80;--danger:#f87171}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--line:#292524;--card:#1c1917;--accent:#60a5fa;--warn:#fbbf24;--chip:#292524;--hl:#422006;--on-accent:#0c0a09;--ok:#4ade80;--danger:#f87171}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard",sans-serif}
a{color:var(--accent)}
button{font:inherit;color:inherit}
code{background:var(--chip);border-radius:4px;padding:0 4px;font-size:.92em}
.layout{display:grid;grid-template-columns:240px minmax(0,1fr);gap:32px;max-width:1180px;margin:0 auto;padding:0 24px}
.toc{position:sticky;top:0;height:100vh;overflow:auto;padding:24px 0;font-size:.88rem}
.toc ol{list-style:none;margin:0;padding:0}
.toc li a{display:block;padding:4px 8px;border-radius:6px;color:var(--muted);text-decoration:none}
.toc li a:hover,.toc li a.on{background:var(--chip);color:var(--fg)}
.toc .toc-h{margin:16px 8px 4px;font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
main{padding:24px 0 80px;min-width:0}
.head{border-bottom:1px solid var(--line);padding-bottom:16px;margin-bottom:24px}
.head h1{margin:0 0 8px;font-size:1.6rem;line-height:1.35}
.meta{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.meta .row{background:var(--chip);border-radius:999px;padding:2px 10px;font-size:.82rem}
.meta .row b{color:var(--muted);font-weight:500;margin-right:6px}
.src-path{color:var(--muted);font-size:.78rem;word-break:break-all}
.theme-switch{display:inline-flex;gap:2px;border:1px solid var(--line);border-radius:8px;padding:2px;float:right}
.theme-switch button{border:0;background:none;padding:2px 8px;border-radius:6px;cursor:pointer;font-size:.8rem}
.theme-switch button[aria-pressed="true"]{background:var(--accent);color:var(--on-accent)}
section.sec{margin:0 0 36px;scroll-margin-top:16px}
section.sec>h2{font-size:1.2rem;margin:0 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.blk{position:relative;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:0 0 12px;scroll-margin-top:16px}
.blk[hidden]{display:none}
.blk .tags{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-bottom:6px;font-size:.72rem}
.src{color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.72rem;margin-left:auto}
.badge{display:inline-block;border-radius:4px;padding:0 6px;background:var(--chip);color:var(--muted);font-size:.72rem;line-height:1.6}
.badge.kind{color:var(--fg)}
.badge.sum{background:var(--hl);color:var(--warn)}
.badge.warn{background:var(--hl);color:var(--warn)}
.badge.ok{color:var(--ok)}
.badge.aud{border:1px solid var(--line);background:none}
.blk p{margin:0}
.blk-requirement h3{margin:0 0 8px;font-size:1.05rem}
.lbl{display:grid;grid-template-columns:72px minmax(0,1fr);gap:8px;margin:4px 0;font-size:.92rem}
.lbl>span{color:var(--muted);font-size:.82rem}
.blk ul{margin:6px 0 0;padding-left:20px}
.chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
.chip{display:inline-block;background:var(--chip);border-radius:999px;padding:0 10px;font-size:.8rem;text-decoration:none;color:var(--fg)}
.metric-name{font-weight:600;margin-bottom:8px}
.metric-name .mid{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--accent);margin-right:8px}
.cells{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
.cell{border:1px solid var(--line);border-radius:8px;padding:6px 8px;font-size:.88rem;min-height:52px}
.cell>span{display:block;color:var(--muted);font-size:.72rem}
.cell.empty{background:var(--chip);color:var(--muted)}
.cell.empty::after{content:"원문에 없음";font-size:.75rem}
.blk-claim.st-open{border-left:3px solid var(--warn)}
.blk-decision .rej{color:var(--muted)}
.blk-decision .rej s{color:var(--fg)}
.blk-prose{background:var(--chip)}
.foot{margin-top:48px;color:var(--muted);font-size:.78rem;border-top:1px solid var(--line);padding-top:12px}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (max-width:860px){.layout{grid-template-columns:1fr}.toc{position:static;height:auto;padding-bottom:0}.cells{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;
