import { createHash } from 'node:crypto';
import { THEME_STORAGE_KEY } from './viewer-js.js';

/** PRD 뷰 스크립트. 테마 전환과 목차 하이라이트만 한다. 내용은 전부 서버가 HTML로 그려 둔다 */
export const PRD_VIEWER_JS = `(function(){
var KEY='${THEME_STORAGE_KEY}';
var root=document.documentElement;
var btns=document.querySelectorAll('[data-theme-set]');
function mark(v){for(var i=0;i<btns.length;i++)btns[i].setAttribute('aria-pressed',String(btns[i].getAttribute('data-theme-set')===v));}
var cur='auto';try{cur=localStorage.getItem(KEY)||'auto';}catch(e){}
mark(cur);
for(var i=0;i<btns.length;i++)btns[i].addEventListener('click',function(){
var v=this.getAttribute('data-theme-set');
if(v==='auto')root.removeAttribute('data-theme');else root.setAttribute('data-theme',v);
try{if(v==='auto')localStorage.removeItem(KEY);else localStorage.setItem(KEY,v);}catch(e){}
mark(v);});
var links=document.querySelectorAll('.toc a[href^="#"]');
if('IntersectionObserver' in window){
var io=new IntersectionObserver(function(es){es.forEach(function(en){if(!en.isIntersecting)return;
for(var k=0;k<links.length;k++)links[k].classList.toggle('on',links[k].getAttribute('href')==='#'+en.target.id);});},{rootMargin:'0px 0px -70% 0px'});
document.querySelectorAll('section.sec').forEach(function(s){io.observe(s);});}
})();`;

export const PRD_VIEWER_JS_SHA256 = createHash('sha256')
  .update(PRD_VIEWER_JS, 'utf8')
  .digest('base64');
