import { createHash } from 'node:crypto';

/** 탭, 기능 탐색, 대상별 필터를 단일 HTML 안에서 처리한다. 원문은 다시 쓰지 않는다. */
export const PRD_VIEWER_JS = `(function(){
var root=document.documentElement, tab='prd', mode='directory', phase='', audience='', selected='';
var panels=Array.from(document.querySelectorAll('[data-panel]'));
var reqs=Array.from(document.querySelectorAll('[data-req]'));
var key='gestalt-prd-view:' + document.title;
function store(name,value){try{localStorage.setItem(key+':'+name,value);}catch(e){}}
function read(name,fallback){try{return localStorage.getItem(key+':'+name)||fallback;}catch(e){return fallback;}}
function visible(el){var aud=el.getAttribute('data-aud')||'';return !audience||!aud||(' '+aud+' ').indexOf(' '+audience+' ')>=0;}
function available(){return reqs.filter(function(r){return visible(r)&&(!phase||r.getAttribute('data-phase')===phase);});}
function pressed(selector,attribute,value){document.querySelectorAll(selector).forEach(function(b){b.setAttribute('aria-pressed',String(b.getAttribute(attribute)===value));});}
function syncSpec(){
var items=available();if(!items.some(function(r){return r.getAttribute('data-req')===selected;}))selected=items.length?items[0].getAttribute('data-req'):'';
reqs.forEach(function(r){r.hidden=mode!=='directory'||r.getAttribute('data-req')!==selected;});
document.querySelectorAll('[data-feature-card]').forEach(function(c){c.hidden=!visible(c)||(!!phase&&c.getAttribute('data-phase')!==phase);});
var nodes=Array.from(document.querySelectorAll('[data-req-node]')).reverse();
nodes.forEach(function(n){var id=n.getAttribute('data-req-node');var own=items.some(function(r){return r.getAttribute('data-req')===id;});n.hidden=!own&&!Array.from(n.querySelectorAll('[data-req-node]')).some(function(c){return !c.hidden;});});
document.querySelectorAll('.req-group').forEach(function(g){g.hidden=!Array.from(g.querySelectorAll('[data-req-node]')).some(function(n){return !n.hidden;});});
document.querySelectorAll('[data-req-link]').forEach(function(a){a.classList.toggle('on',a.getAttribute('data-req-link')===selected);});
document.querySelector('.spec-directory').hidden=mode!=='directory';document.querySelector('.spec-cards').hidden=mode!=='cards';
document.querySelector('.spec-empty').hidden=items.length>0||reqs.length===0;document.querySelector('.cards-empty').hidden=items.length>0||reqs.length===0;
var index=items.findIndex(function(r){return r.getAttribute('data-req')===selected;});
document.querySelector('[data-req-count]').textContent=items.length?(index+1)+' / '+items.length:'0 / 0';
document.querySelectorAll('[data-req-step]').forEach(function(b){b.disabled=mode==='cards'||(b.getAttribute('data-req-step')==='-1'?index<=0:index<0||index>=items.length-1);});
pressed('[data-spec-mode]','data-spec-mode',mode);pressed('[data-phase-filter]','data-phase-filter',phase);
}
function filter(){
document.querySelectorAll('[data-aud]').forEach(function(b){b.classList.toggle('aud-hide',!visible(b));});
document.querySelectorAll('#panel-prd section.sec').forEach(function(s){s.hidden=!Array.from(s.querySelectorAll('.blk')).some(visible);var n=document.querySelector('[data-section-nav="'+s.id+'"]');if(n)n.hidden=s.hidden;});
document.querySelectorAll('[data-block-nav]').forEach(function(n){var b=document.getElementById(n.getAttribute('data-block-nav'));n.hidden=!!b&&!visible(b);});
document.querySelectorAll('#panel-metrics section.sec').forEach(function(s){s.hidden=!Array.from(s.querySelectorAll('tbody tr')).some(visible);var n=document.querySelector('[data-section-nav="'+s.id+'"]');if(n)n.hidden=s.hidden;});
document.querySelectorAll('#panel-decisions section.sec').forEach(function(s){s.hidden=!visible(s);});
syncSpec();
}
function show(id,save){if(!panels.some(function(p){return p.getAttribute('data-panel')===id;}))id='prd';tab=id;panels.forEach(function(p){p.hidden=p.getAttribute('data-panel')!==id;});document.querySelectorAll('[data-go]').forEach(function(b){var active=b.getAttribute('data-go')===id;b.classList.toggle('on',active);if(b.getAttribute('role')==='tab'){b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;}});if(save){store('tab',id);location.hash='tab-'+id;}}
function navigate(){var id;try{id=decodeURIComponent(location.hash.slice(1));}catch(e){return;}if(id.indexOf('tab-')===0){show(id.slice(4),false);store('tab',tab);return;}var el=document.getElementById(id);if(!el)return;var panel=el.closest('[data-panel]');if(!panel)return;show(panel.getAttribute('data-panel'),false);store('tab',tab);if(id.indexOf('f-')===0){selected=el.getAttribute('data-req');mode='directory';if(!visible(el)){audience='';pressed('[data-aud-filter]','data-aud-filter','');}if(phase&&el.getAttribute('data-phase')!==phase)phase='';filter();}else if(el.closest('[data-aud]')&&!visible(el.closest('[data-aud]'))){audience='';pressed('[data-aud-filter]','data-aud-filter','');filter();}if(el===panel){var content=panel.querySelector('.content');if(content)content.scrollTop=0;}el.scrollIntoView({block:'start'});}
function setupTheme(){var api=window.gestaltDigestTheme;if(!api)return;var auto=document.querySelector('[data-theme-set="auto"]'),bg=document.getElementById('theme-bg'),ac=document.getElementById('theme-accent');
function sync(){if(auto)auto.setAttribute('aria-pressed',api.get().background?'false':'true');if(bg)bg.value=root.getAttribute('data-gestalt-background')||'';if(ac)ac.value=root.getAttribute('data-gestalt-accent')||'';}
if(auto)auto.addEventListener('click',function(){api.set({background:null});});if(bg)bg.addEventListener('change',function(){api.set({background:bg.value});});if(ac)ac.addEventListener('change',function(){api.set({accent:ac.value});});
document.addEventListener('gestalt-theme',sync);sync();}
setupTheme();
document.querySelector('[data-source-toggle]').addEventListener('click',function(){var on=root.classList.toggle('show-src');this.setAttribute('aria-pressed',String(on));});
document.querySelectorAll('[data-go]').forEach(function(b){b.addEventListener('click',function(){show(b.getAttribute('data-go'),true);});});
document.querySelectorAll('[role=tab]').forEach(function(b){b.addEventListener('keydown',function(e){var tabs=Array.from(document.querySelectorAll('[role=tab]'));var i=tabs.indexOf(b);if(e.key==='ArrowRight')i=(i+1)%tabs.length;else if(e.key==='ArrowLeft')i=(i+tabs.length-1)%tabs.length;else if(e.key==='Home')i=0;else if(e.key==='End')i=tabs.length-1;else return;e.preventDefault();tabs[i].focus();show(tabs[i].getAttribute('data-go'),true);});});
document.querySelectorAll('[data-spec-mode]').forEach(function(b){b.addEventListener('click',function(){mode=b.getAttribute('data-spec-mode');syncSpec();});});
document.querySelectorAll('[data-phase-filter]').forEach(function(b){b.addEventListener('click',function(){phase=b.getAttribute('data-phase-filter');syncSpec();});});
document.querySelectorAll('[data-aud-filter]').forEach(function(b){b.addEventListener('click',function(){audience=b.getAttribute('data-aud-filter');pressed('[data-aud-filter]','data-aud-filter',audience);filter();});});
document.querySelectorAll('[data-req-step]').forEach(function(b){b.addEventListener('click',function(){var items=available(),i=items.findIndex(function(r){return r.getAttribute('data-req')===selected;}),next=items[i+Number(b.getAttribute('data-req-step'))];if(next)location.hash='f-'+next.getAttribute('data-req');});});
document.querySelectorAll('a[href^="#"]').forEach(function(a){a.addEventListener('click',function(){if(a.getAttribute('href')===location.hash)navigate();});});
window.addEventListener('hashchange',navigate);
show(read('tab','prd'),false);filter();navigate();
})();`;

export const PRD_VIEWER_JS_SHA256 = createHash('sha256')
  .update(PRD_VIEWER_JS, 'utf8')
  .digest('base64');
