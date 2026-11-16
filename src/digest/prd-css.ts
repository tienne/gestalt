import { PRD_COPY as C } from './prd-copy.js';

export const PRD_CSS = `
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
.cell.empty::after{content:"${C.missing}";font-size:.75rem}
.blk-claim.st-open{border-left:3px solid var(--warn)}
.blk-decision .rej{color:var(--muted)}
.blk-decision .rej s{color:var(--fg)}
.blk-prose{background:var(--chip)}
.tbl{border-collapse:collapse;font-size:.9rem;width:100%}
.tbl th,.tbl td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}
.tbl thead th{background:var(--chip);font-weight:600}
.tbl td.empty{background:var(--chip)}
.blk-scope .out li{text-decoration:line-through;text-decoration-color:var(--muted)}
.blk-quote blockquote{margin:0;padding-left:12px;border-left:3px solid var(--line);font-style:italic}
.blk-quote.origin-virtual blockquote{border-left-color:var(--warn)}
.blk-quote .by{color:var(--muted);font-size:.82rem;margin-top:4px}
.flow{display:flex;flex-wrap:wrap;gap:6px;list-style:none;margin:0;padding:0;counter-reset:st}
.flow li{counter-increment:st;background:var(--chip);border-radius:999px;padding:2px 12px;font-size:.88rem}
.flow li::before{content:counter(st) ". ";color:var(--muted)}
.tl{list-style:none;margin:0;padding:0 0 0 14px;border-left:2px solid var(--line)}
.tl li{margin:6px 0}
.tl .date{display:inline-block;min-width:96px;color:var(--accent);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem}
.gl{display:grid;grid-template-columns:minmax(80px,max-content) minmax(0,1fr);gap:4px 16px;margin:0}
.gl dt{font-weight:600}
.gl dd{margin:0}
.blk-callout.tone-info{border-left:3px solid var(--accent)}
.blk-callout.tone-warn{border-left:3px solid var(--warn);background:var(--hl)}
.blk-callout.tone-danger{border-left:3px solid var(--danger)}
.gaps{border:1px solid var(--warn);border-radius:10px;padding:8px 14px;margin:0 0 24px}
.gaps h2{color:var(--warn)}
.gaps h3{font-size:.92rem;margin:12px 0 4px}
.foot{margin-top:48px;color:var(--muted);font-size:.78rem;border-top:1px solid var(--line);padding-top:12px}
.aud-filter{display:flex;flex-wrap:wrap;gap:4px;padding:0 8px}
.aud-filter .toc-h{flex-basis:100%;margin-left:0}
.aud-filter button{border:1px solid var(--line);background:none;border-radius:999px;padding:0 10px;font-size:.8rem;cursor:pointer}
.aud-filter button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.blk.aud-hide{display:none}
.overview details{border:1px solid var(--line);border-radius:10px;background:var(--card);padding:8px 14px;margin:0 0 12px}
.overview summary{cursor:pointer;font-weight:600}
.xlist{margin:8px 0 4px;padding-left:20px}
.xlist li{margin:4px 0}
.where{color:var(--muted);font-size:.8rem;margin-left:4px}
.xwrap{overflow-x:auto;margin:8px 0 4px}
.xmatrix{border-collapse:collapse;font-size:.88rem}
.xmatrix th,.xmatrix td{border:1px solid var(--line);padding:4px 10px;text-align:center}
.xmatrix th[scope="row"]{text-align:left;font-weight:500}
.xmatrix td{color:var(--accent)}
.xmatrix .orphan td{color:var(--warn)}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (max-width:860px){.layout{grid-template-columns:1fr}.toc{position:static;height:auto;padding-bottom:0}.cells{grid-template-columns:repeat(2,minmax(0,1fr))}}


:root{
  --bg:#0f0f10;--rail:#141415;--panel:#17171a;--card:#1c1c1f;--line:#2a2a2e;--line2:#34343a;
  --text:#ececee;--sub:#a1a1a8;--mute:#6b6b73;--accent:#4c8dff;--accentbg:rgba(76,141,255,.14);
  --ok:#3ecf8e;--okbg:rgba(62,207,142,.14);--warn:#f0b429;--warnbg:rgba(240,180,41,.14);
  --bad:#ff6b6b;--badbg:rgba(255,107,107,.13);--gap:#3a3a40;
}
[data-theme=light]{
  --bg:#f6f6f7;--rail:#ffffff;--panel:#fbfbfc;--card:#ffffff;--line:#e6e6ea;--line2:#d9d9de;
  --text:#18181b;--sub:#55555d;--mute:#8b8b94;--accent:#2f6fec;--accentbg:rgba(47,111,236,.09);
  --ok:#119a62;--okbg:rgba(17,154,98,.1);--warn:#b7791f;--warnbg:rgba(183,121,31,.1);
  --bad:#d64545;--badbg:rgba(214,69,69,.09);--gap:#cfcfd6;
}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--text);
  font:15px/1.7 -apple-system,BlinkMacSystemFont,"Pretendard","Apple SD Gothic Neo",sans-serif}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
.app{display:grid;grid-template-columns:64px 1fr;height:100vh}

.rail{background:var(--rail);border-right:1px solid var(--line);display:flex;flex-direction:column;align-items:center;padding:14px 0;gap:6px}
.logo{width:30px;height:30px;border-radius:8px;background:var(--text);color:var(--bg);display:grid;place-items:center;font-weight:800;font-size:13px;margin-bottom:14px}
.rail button{width:52px;overflow-wrap:anywhere;padding:8px 0;border-radius:10px;font-size:11px;color:var(--sub);display:flex;flex-direction:column;align-items:center;gap:3px}
.rail button .ic{font-size:17px;line-height:1}
.rail button.on{background:var(--accentbg);color:var(--text)}
.rail .sp{flex:1}

.main{display:grid;grid-template-rows:52px 1fr;min-width:0}
.top{display:flex;align-items:center;gap:6px;padding:0 18px;border-bottom:1px solid var(--line);background:var(--panel)}
.top .title{font-weight:700;margin-right:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:320px}
.tab{padding:6px 12px;border-radius:8px;color:var(--sub);font-size:14px;display:flex;align-items:center;gap:6px}
.tab::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--mute)}
.tab.on{background:var(--card);color:var(--text);box-shadow:inset 0 0 0 1px var(--line)}
.tab.on::before{background:var(--accent)}
.badge{font-size:11px;padding:0 6px;border-radius:9px;background:var(--warnbg);color:var(--warn);font-weight:700}
.top .sp{flex:1}
.tool{font-size:13px;color:var(--sub);padding:6px 10px;border-radius:8px;border:1px solid var(--line)}
.tool.on{color:var(--text);border-color:var(--accent)}
.body{display:grid;grid-template-columns:260px 1fr;min-height:0}
.body.split{grid-template-columns:260px 1fr}

.toc{border-right:1px solid var(--line);background:var(--panel);display:flex;flex-direction:column;min-height:0}
.toc h4{margin:0;padding:14px 18px 8px;font-size:13px;color:var(--sub);font-weight:600}
.toc .scroll{overflow:auto;flex:1;padding:4px 10px 10px}
.toc .grp{display:flex;align-items:center;gap:8px;padding:6px 8px;font-weight:600;font-size:14px;border-radius:8px}
.toc .grp .n{width:20px;height:20px;border-radius:6px;background:var(--card);border:1px solid var(--line);font-size:11px;display:grid;place-items:center;color:var(--sub)}
.toc .grp .dot{width:5px;height:5px;border-radius:50%;background:var(--sub);margin:0 6px}
.toc a{display:flex;gap:8px;padding:5px 8px 5px 30px;border-radius:8px;color:var(--sub);text-decoration:none;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.toc a .n{color:var(--mute);font-size:12px;min-width:12px}
.toc a:hover,.toc a.on{background:var(--card);color:var(--text)}
.toc a.feat{color:var(--accent)}
.toc a.feat.on{color:var(--text)}
.toc .foot{border-top:1px solid var(--line);padding:10px 14px;display:flex;gap:8px;font-size:12px;color:var(--sub)}
.toc .foot b{color:var(--text);margin-left:4px}
.chipbox{background:var(--card);border:1px solid var(--line);border-radius:7px;padding:2px 8px}

.content{overflow:auto;min-width:0}
.progress{position:sticky;top:0;z-index:2;background:var(--bg);display:flex;align-items:center;gap:14px;padding:12px 32px;border-bottom:1px solid var(--line);font-size:13px;color:var(--sub)}
.bar{width:140px;height:4px;border-radius:2px;background:var(--line2);overflow:hidden}
.bar i{display:block;height:100%;background:var(--text)}
.progress .warn{color:var(--warn)}
.progress .sp{flex:1}
.doc{max-width:820px;margin:0 auto;padding:28px 32px 120px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:30px 40px 26px;margin-bottom:22px}
.card>h2{margin:0 0 20px;padding-bottom:16px;border-bottom:1px solid var(--line);font-size:24px;letter-spacing:-.01em}
.item{margin:0 0 26px}
.item h3{display:flex;align-items:center;gap:10px;margin:0 0 8px;font-size:16px}
.item h3 .ico{width:22px;height:22px;border-radius:6px;background:var(--bg);border:1px solid var(--line);display:grid;place-items:center;font-size:12px;color:var(--sub)}
.item p{margin:0 0 6px;color:var(--text)}
.src{display:none;font-size:11px;color:var(--mute);margin-left:auto;font-weight:400}
.show-src .src{display:inline}
.chip{display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:1px 9px;border-radius:10px;background:var(--bg);border:1px solid var(--line);color:var(--sub);font-weight:500;white-space:nowrap}
.chip.ok{background:var(--okbg);color:var(--ok);border-color:transparent}
.chip.warn{background:var(--warnbg);color:var(--warn);border-color:transparent}
.chip.bad{background:var(--badbg);color:var(--bad);border-color:transparent}
.chip.acc{background:var(--accentbg);color:var(--accent);border-color:transparent}
.quote{border-left:3px solid var(--line2);padding:4px 0 4px 16px;color:var(--sub);font-style:italic}
.callout{border-radius:10px;padding:12px 16px;background:var(--accentbg)}
table{border-collapse:collapse;width:100%;font-size:14px;margin:4px 0}
th,td{border:1px solid var(--line);padding:9px 12px;text-align:left;vertical-align:top}
th{background:var(--bg);color:var(--sub);font-weight:600;white-space:nowrap}
ol.flow{margin:0;padding-left:20px}
ol.flow li{margin-bottom:6px}
ul.out{margin:0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:6px}
code{font-size:.88em;background:var(--bg);border:1px solid var(--line);padding:0 5px;border-radius:5px}
.reqrow{display:flex;align-items:center;gap:10px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px;cursor:pointer}
.reqrow:hover{border-color:var(--accent)}
.reqrow .t{font-weight:600;flex:1}

.specwrap{display:grid;grid-template-columns:1fr;min-height:0;height:100%}
.spectool{display:flex;gap:8px;align-items:center;padding:10px 24px;border-bottom:1px solid var(--line);background:var(--panel);font-size:13px}
.seg{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.seg button{padding:5px 12px;color:var(--sub)}
.seg button.on{background:var(--card);color:var(--text)}
.filter{border:1px solid var(--line);border-radius:8px;padding:5px 10px;color:var(--sub)}
.filter.on{border-color:var(--accent);color:var(--text)}
.speccol{overflow:auto;height:calc(100vh - 52px - 47px)}
.detail{max-width:860px;margin:0 auto;padding:30px 36px 120px}
.detail .lab{font-size:13px;color:var(--sub)}
.detail h1{margin:4px 0 14px;font-size:28px;letter-spacing:-.01em}
.metaline{display:flex;gap:18px;align-items:center;font-size:13px;color:var(--sub);padding-bottom:20px;border-bottom:1px solid var(--line);margin-bottom:22px;flex-wrap:wrap}
.metaline b{color:var(--text);font-weight:500;margin-left:6px}
.lead{font-size:16px;margin:0 0 24px}
.field{margin-bottom:24px}
.field h5{margin:0 0 10px;font-size:14px;color:var(--sub);font-weight:600;display:flex;gap:8px;align-items:center}
.field .box{border:1px solid var(--line);border-radius:10px;padding:12px 16px;background:var(--card)}
.ac{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin-bottom:8px;background:var(--card)}
.ac .ck{width:16px;height:16px;border:1.5px solid var(--mute);border-radius:4px;margin-top:4px;flex:none}
.empty{border:1px dashed var(--gap);border-radius:10px;padding:10px 14px;color:var(--mute);font-size:13px;display:flex;gap:10px;align-items:center}
.empty .chip{margin-left:auto}
.slots{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.slot{border:1px dashed var(--gap);border-radius:10px;padding:10px 14px}
.slot.filled{border-style:solid;border-color:var(--line);background:var(--card)}
.slot .k{font-size:12px;color:var(--sub);font-weight:600;margin-bottom:2px}
.slot .v{font-size:14px}
.slot .v.none{color:var(--mute);font-size:13px}
.bottombar{position:fixed;bottom:18px;left:50%;transform:translateX(calc(-50% + 160px));background:var(--card);border:1px solid var(--line2);border-radius:12px;padding:7px 10px;display:flex;gap:10px;align-items:center;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.25)}
.bottombar button{padding:4px 10px;border-radius:7px;border:1px solid var(--line)}

.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;padding:24px}
.fcard{border:1px solid var(--line);border-radius:12px;padding:16px 18px;background:var(--card);cursor:pointer}
.fcard:hover{border-color:var(--accent)}
.fcard .h{display:flex;gap:8px;align-items:center;margin-bottom:6px}
.fcard .h b{flex:1}
.fcard p{margin:0 0 10px;color:var(--sub);font-size:14px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.fill{display:flex;gap:4px;align-items:center;font-size:12px;color:var(--mute)}
.fill i{width:8px;height:8px;border-radius:2px;background:var(--gap)}
.fill i.on{background:var(--ok)}

.gaprow{display:flex;gap:12px;padding:12px 16px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px;background:var(--card);align-items:flex-start}
.gaprow .w{flex:1}
.gaprow .w small{display:block;color:var(--sub)}
.gaprow a{color:var(--accent);cursor:pointer;font-size:13px;white-space:nowrap}
.note{font-size:12px;color:var(--mute);margin:-6px 0 18px}
.hidden{display:none!important}
.mq{display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--line)}
.mq:last-child{border:0}
.mq .w{flex:1}

:root,:root[data-theme="dark"]{color-scheme:dark;--fg:var(--text);--muted:var(--sub);--chip:var(--panel);--hl:var(--warnbg);--on-accent:#fff;--danger:var(--bad)}
:root[data-theme="light"]{color-scheme:light;--fg:var(--text);--muted:var(--sub);--chip:var(--panel);--hl:var(--warnbg);--on-accent:#fff;--danger:var(--bad)}
[hidden],.aud-hide{display:none!important}
.main{padding:0;overflow:hidden}.body{height:100%}
.top .title{font-size:14px;margin-top:0;margin-bottom:0;max-width:200px}.tabs{display:flex;flex-shrink:0;gap:4px}
.toc{position:static;height:auto;padding:0;overflow:hidden;font-size:14px}.toc h2{font-size:13px;padding:14px 18px 8px;margin:0;color:var(--sub)}
.toc-scroll{overflow:auto;flex:1;padding:4px 10px 10px}.toc .toc-item{padding-left:38px;font-size:13px}.toc .grp{padding-left:8px;color:var(--text)}
.toc ul{padding-left:14px;list-style:none;margin:0}.toc-foot{border-top:1px solid var(--line);padding:12px;display:flex;gap:6px;flex-wrap:wrap;font-size:12px}
.sec.card{margin:0 0 22px;scroll-margin-top:18px}.sec.card>h2{font-size:24px;margin:0 0 20px;padding:0 0 16px}
.card .blk{border:0;background:none;padding:0;margin:0 0 26px}.card .blk:last-child{margin-bottom:0}.blk .tags{display:none}.show-src .blk .tags{display:flex}
.blk-requirement h3{font-size:16px;margin:0 0 8px}.lbl{grid-template-columns:90px 1fr}.src{display:none;float:none;white-space:nowrap}.show-src .src{display:inline}.show-src .tags .badge{display:inline-block}
.blk-stateMatrix .tbl tbody th{white-space:nowrap}.tbl th,.tbl td{text-align:left}.blk p{margin-bottom:6px}.tbl th .src{margin-left:8px}
.meta-row{display:grid;grid-template-columns:110px minmax(0,1fr);padding:8px 0;gap:12px;border-bottom:1px solid var(--line)}.meta-row b{color:var(--sub);font-weight:500}.src-path{margin-bottom:0}
.progress progress{width:140px;height:5px;accent-color:var(--text)}.progress .warn{margin-left:auto;text-decoration:none}.chip.warn{color:var(--warn);background:var(--warnbg);border-color:transparent}
.aud-filter{padding:0;align-items:center;flex-wrap:nowrap;font-size:12px;white-space:nowrap}.aud-filter button{padding:1px 7px}.aud-filter button[aria-pressed=true]{background:var(--accentbg);color:var(--text);border-color:var(--accent)}
#panel-spec>.content{display:flex;flex-direction:column;position:relative}.spectool{position:sticky;top:0;z-index:2;flex-wrap:wrap;flex-shrink:0}.detail{width:100%;padding-bottom:100px}.req-detail h1{font-size:28px;line-height:1.4;margin:4px 0 14px}.field h3{font-size:14px;color:var(--sub);margin:0 0 10px}.field p{margin:0 0 8px}
.bottombar{position:sticky;bottom:16px;left:auto;transform:none;align-self:center;margin-top:auto;flex-shrink:0}.bottombar button:disabled{opacity:.35;cursor:default}.empty-state{color:var(--sub);padding:20px}.empty{display:block}.empty .chip{margin-left:8px}.ac input{accent-color:var(--accent);margin-top:5px}.ac .src{margin-left:10px}.slot .chip{font-size:11px;margin-top:6px}.slot .v{overflow-wrap:anywhere}
.fcard{text-decoration:none;color:var(--text)}.fcard progress{width:100px;height:5px;accent-color:var(--ok)}.grid{align-content:start}.req-detail{scroll-margin-top:70px}.gaprow{font-size:14px}.gaprow .w{overflow-wrap:anywhere}.gaprow a{white-space:normal}.mq{flex-wrap:wrap}
button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:3px}button:disabled{cursor:default;opacity:.4}
@media(max-width:1250px){.top{flex-wrap:wrap;height:auto;min-height:52px;padding:8px 14px}.top .title{display:none}.aud-filter{margin-left:auto}.main{grid-template-rows:auto 1fr}.body{height:100%}}
@media(max-width:860px){.app{grid-template-columns:52px 1fr}.rail button{width:44px}.body{grid-template-columns:180px minmax(0,1fr)}.toc{height:auto;position:static}.doc,.detail{padding:20px 18px 90px}.card{padding:20px}.top{overflow:auto;flex-wrap:nowrap}.top .sp{display:none}.tab{white-space:nowrap;padding:5px 8px}.slots{grid-template-columns:1fr}.aud-filter{margin-left:12px}.aud-filter>span{display:none}}
@media(max-width:620px){.body{grid-template-columns:1fr}.toc{display:none}.rail{padding-top:10px}.card{padding:16px}.doc,.detail{padding:16px 12px 80px}.metaline{gap:8px}.slots{grid-template-columns:1fr}.grid{grid-template-columns:1fr;padding:16px}.tbl{min-width:500px}.src{white-space:normal}}

.item-title{display:flex;gap:10px;align-items:center;margin:0 0 8px;font-size:16px}.item-title .ico{width:22px;height:22px;border-radius:6px;background:var(--bg);border:1px solid var(--line);display:grid;place-items:center;font-size:12px;color:var(--sub)}

.metrics-doc{max-width:1100px}.metrics-doc .card{padding:24px}.metrics-table{min-width:880px;table-layout:fixed}.metrics-table th:first-child{width:25%}.metrics-table th[scope="row"]{white-space:normal}.metrics-table td{overflow-wrap:anywhere}.toc .req-folder{display:block;padding:6px 8px;color:var(--text);font-weight:600}

.gaprow .w{min-width:0}.gaprow>div:last-child{max-width:40%;min-width:0;overflow-wrap:anywhere}
#panel-decisions .blk-question .chips{display:none}
#panel-spec .spec-cards:not([hidden])+.bottombar{display:none}
`;
