/* Decorative background stars and the home-page animation (from the prototype). */
(function(){var $=function(i){return document.getElementById(i)};
function rng(s){return function(){s|=0;s=s+0x6D2B79F5|0;var t=Math.imul(s^s>>>15,1|s);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
(function(){var c=$("bg"),x=c.getContext("2d");function d(){c.width=innerWidth;c.height=innerHeight;var r=rng(5);for(var i=0;i<400;i++){x.fillStyle="rgba(215,220,255,"+(.2+r()*.6)+")";x.beginPath();x.arc(r()*c.width,r()*c.height,r()<.06?1.5:.7,0,7);x.fill()}}d();addEventListener("resize",d)})();
})();
(function(){
var c=document.getElementById("anim"),x=c.getContext("2d"),W,H,st=[],sh=null,raf=0,last=0,nextSh=0,
rm=matchMedia("(prefers-reduced-motion:reduce)").matches;
function home(){var h=location.hash.slice(1);return["explore","sphere","analytics"].indexOf(h)<0&&h.indexOf("a-")!==0}
function size(){var d=Math.min(2,devicePixelRatio||1);W=innerWidth;H=innerHeight;c.width=W*d;c.height=H*d;x.setTransform(d,0,0,d,0,0);
  var n=Math.max(80,Math.min(220,Math.round(W*H/9000)));st=[];for(var i=0;i<n;i++)st.push({x:Math.random()*W,y:Math.random()*H,z:.25+Math.random()*.75,p:Math.random()*6.28,s:.6+Math.random()*1.4,c:Math.random()<.3?"170,200,255":"225,235,255"});if(rm)draw(0)}
function draw(t){x.clearRect(0,0,W,H);
  st.forEach(function(s){var a=.35+.55*(.5+.5*Math.sin(t/1000*s.s+s.p));x.fillStyle="rgba("+s.c+","+(a*s.z+.1).toFixed(2)+")";x.beginPath();x.arc(s.x,s.y,.4+s.z*1.3,0,7);x.fill()});
  if(sh){var g=x.createLinearGradient(sh.x,sh.y,sh.x-sh.vx*9,sh.y-sh.vy*9);g.addColorStop(0,"rgba(190,225,255,"+sh.a+")");g.addColorStop(1,"rgba(98,208,255,0)");x.strokeStyle=g;x.lineWidth=1.6;x.beginPath();x.moveTo(sh.x,sh.y);x.lineTo(sh.x-sh.vx*9,sh.y-sh.vy*9);x.stroke()}}
function frame(t){raf=0;if(!home())return;var dt=Math.min(50,t-last||16);last=t;
  st.forEach(function(s){s.x-=s.z*.012*dt;s.y+=s.z*.004*dt;if(s.x<-3)s.x=W+3;if(s.y>H+3)s.y=-3});
  if(!sh&&t>nextSh){sh={x:W*(.35+Math.random()*.6),y:Math.random()*H*.4,vx:-7-Math.random()*3,vy:3+Math.random()*2,a:1}}
  if(sh){sh.x+=sh.vx*dt/16;sh.y+=sh.vy*dt/16;sh.a-=.012*dt/16;if(sh.a<=0||sh.x<-60||sh.y>H+60){sh=null;nextSh=t+4000+Math.random()*4000}}
  draw(t);raf=requestAnimationFrame(frame)}
function start(){if(rm){size();return}if(!raf&&home()){last=0;raf=requestAnimationFrame(frame)}}
size();nextSh=3000;addEventListener("resize",size);addEventListener("hashchange",function(){setTimeout(start,0)});start();
})();
