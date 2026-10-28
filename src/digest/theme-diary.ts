/**
 * 영상 요약과 읽기 렌즈가 같이 쓰는 다이어리 테마. 본문을 줄 노트 한 장으로 그리고 제목은 손글씨로 쓴다.
 * render-html이 body에 is-diary를 붙여 모든 요약에 건다. 렌즈 전용 칸(한눈에 보기, 의심 표시)은 영상에 없어서 같이 둬도 영향이 없다.
 * 템플릿 리터럴 안이라 백틱과 달러 중괄호를 쓰지 않는다. 바깥 값은 문자열 연결로 끼운다.
 * 폴라로이드(--polaroid)는 다크에서도 흰 종이라 캡션 색을 고정값으로 두고 다크 팔레트에서 다시 정하지 않는다
 */

/** 손글씨 제목 글꼴. 오프라인이면 받지 못하고 --hand의 다음 글꼴로 보인다. 서버 CSP가 이 두 주소를 연다 */
export const DIARY_FONT_LINK =
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nanum+Pen+Script&display=swap">\n';

/** 다크 팔레트. OS 설정을 따를 때와 다크를 고른 때가 같은 값을 쓴다 */
const DARK_PALETTE =
  '--bg:#29292a;--page:#333334;--rule:rgba(255,255,255,.07);--margin:rgba(255,130,130,.35);--fg:#ededed;--muted:#adadad;--line:#4a4a4b;--card:#3c3c3d;--chip:#444445;--accent:#6fd3cf;--warn:#ff8a7a;--hl:rgba(255,226,80,.3);--on-accent:#29292a;--sticky:#5a5130;--tape:rgba(255,170,200,.22);--ink-red:#ff8a7a;--ink-blue:#8db7ff;--ink-green:#7fd6a0;--ink-orange:#ffb35c';

export const DIARY_CSS =
  `
.is-diary{--bg:#e9e1d1;--page:#fffdf7;--rule:rgba(70,110,170,.14);--margin:rgba(214,72,72,.42);--fg:#2d2a26;--muted:#7b7368;--line:#e4d9c6;--card:#fffaf0;--chip:#f2e9d6;--accent:#1f7a7a;--warn:#c4362b;--hl:#fff08a;--on-accent:#fff;--sticky:#fff3a6;--tape:rgba(240,150,170,.45);--ink-red:#c4362b;--ink-blue:#2f5d9e;--ink-green:#2e8a57;--ink-orange:#d0700e;--hand:"Nanum Pen Script","Gaegu","AppleMyungjo",serif;--polaroid:#fdfdfb;--polaroid-ink:#555;--polaroid-accent:#1f7a7a;--sans:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard",sans-serif}
` +
  '@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .is-diary{' +
  DARK_PALETTE +
  '}}\n:root[data-theme="dark"] .is-diary{' +
  DARK_PALETTE +
  `}
.is-diary .main{--lh:1.85em;--mx:60px;max-width:52rem;margin:20px 0 40px;padding:32px 44px 96px calc(var(--mx) + 24px);font-size:1.0625rem;line-height:1.85;letter-spacing:-.005em;word-break:keep-all;overflow-wrap:break-word;background-color:var(--page);background-image:radial-gradient(circle at 26px 36px,var(--bg) 0 8px,transparent 9px),linear-gradient(90deg,transparent var(--mx),var(--margin) var(--mx),var(--margin) calc(var(--mx) + 1px),transparent calc(var(--mx) + 1px),transparent calc(var(--mx) + 4px),var(--margin) calc(var(--mx) + 4px),var(--margin) calc(var(--mx) + 5px),transparent calc(var(--mx) + 5px)),repeating-linear-gradient(transparent 0,transparent calc(var(--lh) - 1px),var(--rule) calc(var(--lh) - 1px),var(--rule) var(--lh));background-size:52px 72px,100% 100%,100% var(--lh);background-repeat:repeat-y,no-repeat,repeat;border-radius:3px 10px 10px 3px;box-shadow:0 1px 2px rgba(0,0,0,.08),0 12px 32px rgba(60,40,10,.12)}
.is-diary .head{padding-bottom:18px;border-bottom:2px dashed var(--line)}
.is-diary .head h1{font-family:var(--hand);font-weight:400;font-size:2.7em;line-height:1.15;letter-spacing:0;margin-top:8px}
.is-diary .head h1::before{display:block;width:max-content;margin-bottom:12px;padding:1px 10px;border:2px solid var(--warn);border-radius:6px;color:var(--warn);font-family:var(--sans);font-size:.26em;font-weight:800;letter-spacing:.2em;line-height:1.6;transform:rotate(-3deg)}
.is-diary .tools button,.is-diary .report-bar button:not([aria-pressed="true"]){background:none}
.is-diary .lead{border-left:0;padding:0;margin:30px 0 40px}
.is-diary .lead .q{font-family:var(--hand);font-size:1.55em;font-weight:400;line-height:1.3;color:var(--accent);margin:0 0 10px}
.is-diary .lead .q::before{content:"Q. "}
.is-diary .lead .q+p{font-size:1.08em;line-height:1.85;font-weight:500;margin:0 0 22px}
.is-diary .lead .takeaway{position:relative;margin:8px 4px 0;padding:18px 20px 14px;background:var(--sticky);color:var(--fg);font-family:var(--hand);font-size:1.45em;line-height:1.4;transform:rotate(-1deg);box-shadow:0 6px 14px rgba(0,0,0,.12)}
.is-diary .lead .takeaway::before{content:"";position:absolute;top:-11px;left:50%;width:96px;height:22px;margin-left:-48px;background:var(--tape);transform:rotate(2deg)}
.is-diary .coverage{margin-top:22px;padding:0;background:none;font-size:.8em}
.is-diary .glance{border:0;border-radius:0;background:none;padding:0;margin:0 0 40px}
.is-diary .glance h2,.is-diary .toc h2,.is-diary .extra h2{display:inline-block;font-family:var(--hand);font-size:1.7em;font-weight:400;letter-spacing:0;color:var(--fg);margin:0 0 6px;background:linear-gradient(transparent 58%,var(--hl) 58%,var(--hl) 92%,transparent 92%)}
.is-diary .glance dl{display:block;margin:0;border-top:0}
.is-diary .glance dl>div{display:grid;grid-template-columns:4.5em minmax(0,1fr);gap:12px;border-top:0;border-bottom:1px dashed var(--line);padding:8px 0}
.is-diary .glance dt{font-family:var(--hand);font-size:1.45em;font-weight:400;line-height:1.2;color:var(--accent)}
.is-diary .glance .glance-problem dt,.is-diary .glance .glance-claim dt{color:var(--ink-red)}
.is-diary .glance .glance-method dt,.is-diary .glance .glance-evidence dt{color:var(--ink-blue)}
.is-diary .glance .glance-result dt,.is-diary .glance .glance-topic dt{color:var(--ink-green)}
.is-diary .glance .glance-limit dt{color:var(--ink-orange)}
.is-diary .glance dd{margin:0}
.is-diary .glance .glance-limit dd{color:var(--muted)}
.is-diary .toc{border:0;background:none;padding:0;margin:0 0 48px}
.is-diary .toc ol{margin:0}
.is-diary .toc>ol>li{font-family:var(--hand);font-size:1.4em;line-height:1.45}
.is-diary .toc ol ol{padding-left:1.2em;margin-bottom:6px;font-family:var(--sans);font-size:.62em;line-height:1.9}
.is-diary .toc ol ol a{color:var(--muted)}
.is-diary .toc a:hover{color:var(--accent)}
.is-diary .sec{padding-top:30px;margin-top:24px;border-top:2px dashed var(--line)}
.is-diary .sec h2{font-family:var(--hand);font-size:2.3em;font-weight:400;line-height:1.2;letter-spacing:0;border-bottom:0;padding-bottom:0;margin:4px 0 12px}
.is-diary .sec h2 .num{display:inline-flex;align-items:center;justify-content:center;width:1.25em;height:1.25em;margin-right:.2em;border:2px solid var(--accent);border-radius:50%;color:var(--accent);font-size:.7em;vertical-align:.12em}
.is-diary .sub h3{font-family:var(--hand);font-size:1.65em;font-weight:400;line-height:1.25;margin:30px 0 4px}
.is-diary .sub h3 .num{color:var(--accent)}
.is-diary h2 .loc,.is-diary h3 .loc{font-family:var(--sans);font-size:.68rem;font-weight:500;vertical-align:.3em;margin-left:4px}
.is-diary .sec-intro{font-size:.92em}
.is-diary .conclusion{font-size:1.05em}
.is-diary .main ul{padding-left:1.2em}
.is-diary .main li{margin:4px 0}
.is-diary .main li::marker{color:var(--accent)}
.is-diary strong{background:linear-gradient(100deg,transparent 0,var(--hl) 4%,var(--hl) 96%,transparent 100%) 0 70%/100% 46% no-repeat}
.is-diary .cite{color:var(--muted);font-size:.7em}
.is-diary .cite:hover,.is-diary .cite[aria-expanded="true"]{color:var(--accent)}
.is-diary .doubt{margin:8px 0 10px;padding:8px 12px;border:1.5px dashed var(--warn);border-radius:10px;background:none;font-size:.9em}
.is-diary .doubt-badge{border:0;padding:0;margin-right:6px;font-family:var(--hand);font-size:1.35em;font-weight:400}
.is-diary .doubt-badge::before{content:"✎ "}
.is-diary .doubt .ev-list{display:flex;margin:6px 0 0}
.is-diary .src-table,.is-diary .src-figure{position:relative;border:0;border-radius:2px;background:var(--card);padding:20px 16px 12px;margin:30px 0;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.is-diary .src-table::before,.is-diary .src-figure::before{content:"";position:absolute;top:-10px;left:22px;width:84px;height:20px;background:var(--tape);transform:rotate(-4deg)}
.is-diary .src-table figcaption,.is-diary .src-figure figcaption{color:var(--muted);font-size:.85em}
.is-diary .src-table figcaption b,.is-diary .src-figure figcaption b{font-family:var(--hand);font-size:1.45em;font-weight:400;color:var(--accent)}
.is-diary .src-grid th{font-weight:600}
.is-diary .limits{border:2px dashed var(--warn);border-radius:14px;background:none;padding:6px 18px 10px;margin:52px 0 24px}
.is-diary .limits h2{font-family:var(--hand);font-size:1.7em;font-weight:400}
.is-diary .limits h2::before{content:"✎ "}
.is-diary .ctx-card,.is-diary .kn-card{border-radius:6px}
.is-diary .extra{margin-top:44px;padding-top:12px;border-top:2px dashed var(--line);font-size:.88em;color:var(--muted)}
.is-diary .minimap a{width:8px;height:8px;border:0;background:var(--line);font-size:0}
.is-diary .minimap a.is-current{background:var(--accent);height:20px;border-radius:4px}
.is-diary .minimap{gap:8px}
.is-diary .doc-hl{background:color-mix(in srgb,var(--hl) 55%,transparent);outline:2px solid color-mix(in srgb,var(--accent) 75%,transparent)}
.is-diary .doc-hl.is-key{background:color-mix(in srgb,var(--hl) 80%,transparent)}
.is-diary .src-grid td.is-ref,.is-diary .thumb-hl{outline-color:var(--accent)}
.is-diary :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.is-lens .head h1::before{content:"읽기 렌즈";content:"읽기 렌즈" / ""}
.is-diary:not(.is-lens) .head h1::before{content:"영상 요약";content:"영상 요약" / ""}
.is-diary h2 .ts,.is-diary h3 .ts{display:inline-block;font-family:var(--sans);font-size:.68rem;font-weight:500;line-height:1.6;background:var(--chip);border-radius:4px;padding:0 5px;vertical-align:.3em;margin-left:4px}
.is-diary .ts{color:var(--accent)}
.is-diary .player{border-radius:6px;box-shadow:0 4px 14px rgba(0,0,0,.18)}
.is-diary .script{background:var(--page);border-color:var(--line);border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,.08)}
.is-diary .script h2{font-family:var(--hand);font-size:1.5em;font-weight:400;border-bottom-style:dashed}
.is-diary .script h2 small{font-family:var(--sans);font-size:.5em}
.is-diary .frame,.is-diary .shot{position:relative;background:var(--polaroid);padding:10px 10px 6px;box-shadow:0 4px 14px rgba(0,0,0,.16)}
.is-diary .frame{display:inline-block;max-width:min(100%,560px);margin:22px 0 16px;transform:rotate(-1deg)}
.is-diary .shot{transform:rotate(-.8deg)}
.is-diary .shot:nth-child(even){transform:rotate(.8deg)}
.is-diary .frame::before,.is-diary .shot::before{content:"";position:absolute;z-index:1;top:-10px;left:50%;width:84px;height:20px;margin-left:-42px;background:var(--tape);transform:rotate(3deg)}
.is-diary .frame img,.is-diary .shot img{border:0;border-radius:0;background:none;max-height:none}
.is-diary .frame figcaption,.is-diary .shot figcaption{margin-top:4px;color:var(--polaroid-ink);font-size:.9em}
.is-diary .frame figcaption{text-align:right}
.is-diary .frame figcaption :is(.ts,.cite),.is-diary .shot figcaption :is(.ts,.cite){color:var(--polaroid-accent)}
.is-diary .tabs [role="tab"]{font-family:var(--hand);font-size:1.4em;line-height:1.2}
.is-diary .ext h2{font-family:var(--hand);font-size:2.1em;font-weight:400;border-bottom:2px dashed var(--line)}
.is-diary .ext h3{font-family:var(--hand);font-size:1.55em;font-weight:400}
.is-diary .quiz-q{background:var(--card);border:1.5px dashed var(--line)}
@media (max-width:900px){
.is-diary .main{--mx:28px;max-width:none;margin:8px -8px 24px;padding-top:20px;padding-right:18px;padding-left:calc(var(--mx) + 12px);background-size:0 0,100% 100%,100% var(--lh);background-image:none,linear-gradient(90deg,transparent var(--mx),var(--margin) var(--mx),var(--margin) calc(var(--mx) + 1px),transparent calc(var(--mx) + 1px)),repeating-linear-gradient(transparent 0,transparent calc(var(--lh) - 1px),var(--rule) calc(var(--lh) - 1px),var(--rule) var(--lh))}
.is-diary .head h1{font-size:2.2em;margin-top:4px}
.is-diary .glance dl>div{grid-template-columns:3.6em minmax(0,1fr)}
.is-diary:not(.is-doc) .main{padding-bottom:calc(var(--float-w) * 9 / 16 + 32px + env(safe-area-inset-bottom, 0px))}
}
`;
