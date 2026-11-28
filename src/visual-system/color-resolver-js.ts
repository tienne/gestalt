/**
 * 테마 해석 로직을 ES5 문자열 하나로 둔다. Node 쪽 해석(color.ts)과 정적 HTML에 싣는 런타임(runtime.ts)이
 * 같은 문자열을 실행하므로 해석 결과가 갈라지지 않는다. 템플릿 리터럴 안이라 백틱과 달러 중괄호를 쓰지 않는다.
 */
export const COLOR_RESOLVER_JS = `function gestaltColorSystem(catalog){
  function ch(c){return [1,3,5].map(function(o){return parseInt(c.slice(o,o+2),16);});}
  function lum(c){var w=[0.2126,0.7152,0.0722];return ch(c).map(function(v){var l=v/255;return l<=0.04045?l/12.92:Math.pow((l+0.055)/1.055,2.4);}).reduce(function(t,v,i){return t+v*w[i];},0);}
  function contrast(a,b){var x=lum(a),y=lum(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);}
  function mix(c,target,amt){var t=ch(target);return '#'+ch(c).map(function(v,i){return Math.round(v+(t[i]-v)*amt).toString(16);}).map(function(s){return s.length<2?'0'+s:s;}).join('').toUpperCase();}
  function worst(color,bg){return Math.min(contrast(color,bg.color),contrast(color,bg.panel));}
  function fit(start,bg,min){var target=bg.light?'#000000':'#FFFFFF';var out=start;for(var a=1;a<=100&&worst(out,bg)<min;a++){out=mix(start,target,a/100);}return out;}
  function onFill(fill){if(contrast('#171717',fill)>=4.5)return '#171717';return contrast('#000000',fill)>=contrast('#FFFFFF',fill)?'#000000':'#FFFFFF';}
  function find(list,id){for(var i=0;i<list.length;i++){if(list[i].id===id)return list[i];}return null;}
  function has(kind,id){return !!find(kind==='background'?catalog.backgrounds:catalog.accents,id);}
  function resolve(sel){
    sel=sel||{};
    var bgId=sel.background||catalog.defaults.background;var acId=sel.accent||catalog.defaults.accent;
    var bg=find(catalog.backgrounds,bgId);var ac=find(catalog.accents,acId);
    if(!bg)throw new RangeError('Unknown Gestalt background: '+bgId);
    if(!ac)throw new RangeError('Unknown Gestalt accent: '+acId);
    var colors={},adjust=[];
    function put(role,seed,min){var v=fit(seed,bg,min);colors[role]=v;adjust.push({role:role,seed:seed,value:v,min:min,before:worst(seed,bg),after:worst(v,bg)});return v;}
    colors.background=bg.color;colors.surface=bg.panel;colors.text=bg.ink;colors['text-muted']=bg.muted;colors.border=bg.line;
    var textSeed=bg.light?(ac.light||ac.dark):ac.dark;var fillSeed=bg.light?(ac.lightFill||ac.dark):ac.dark;
    put('accent-text',textSeed,4.5);var fill=put('accent-fill',fillSeed,3);colors['on-accent']=onFill(fill);
    colors.focus=fill;
    var hl=0.24;var h=mix(bg.color,fill,hl);while(contrast(bg.ink,h)<4.5&&hl>0.04){hl-=0.02;h=mix(bg.color,fill,hl);}colors.highlight=h;
    var names=['success','warning','danger','info'];
    for(var i=0;i<names.length;i++){var k=names[i];var p=catalog.status[k];var s=bg.light?p.light:p.dark;put(k+'-text',s,4.5);var f=put(k+'-fill',s,3);colors['on-'+k]=onFill(f);}
    var diff=catalog.diff;
    for(var d in diff){if(!Object.prototype.hasOwnProperty.call(diff,d))continue;var st=diff[d].status;colors['diff-'+d+'-text']=colors[st+'-text'];var amt=0.18;var row=mix(bg.color,colors[st+'-fill'],amt);while(contrast(bg.ink,row)<4.5&&amt>0.04){amt-=0.02;row=mix(bg.color,colors[st+'-fill'],amt);}colors['diff-'+d+'-bg']=row;}
    var seeds=bg.light?catalog.series.light:catalog.series.dark;colors['series-1']=fill;
    for(var n=0;n<seeds.length;n++){put('series-'+(n+2),seeds[n],3);}
    return {id:bg.id+'/'+ac.id,version:catalog.version,tone:bg.light?'light':'dark',background:bg.id,accent:ac.id,colors:colors,adjustments:adjust};
  }
  function cssVars(theme){var out={};for(var r in theme.colors){if(Object.prototype.hasOwnProperty.call(theme.colors,r))out['--gestalt-color-'+r]=theme.colors[r];}return out;}
  function cssText(theme){var v=cssVars(theme);var parts=[];for(var k in v){if(Object.prototype.hasOwnProperty.call(v,k))parts.push(k+':'+v[k]);}return parts.join(';');}
  function apply(el,theme){var v=cssVars(theme);for(var k in v){if(Object.prototype.hasOwnProperty.call(v,k))el.style.setProperty(k,v[k]);}el.setAttribute('data-gestalt-theme',theme.id);el.setAttribute('data-gestalt-tone',theme.tone);}
  return {resolve:resolve,has:has,contrast:contrast,mix:mix,cssVars:cssVars,cssText:cssText,apply:apply,catalog:catalog};
}`;
