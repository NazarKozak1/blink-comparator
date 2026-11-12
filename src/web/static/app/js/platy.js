/* Tooltips and the Platy guide (from the prototype). */
(function(){
var $=function(i){return document.getElementById(i)},m=$("mas"),mb=$("mbtn"),b=$("mbub"),tx=$("mtx"),ac=$("mac");
[].forEach.call(document.querySelectorAll(".dp"),function(s){s.innerHTML=mb.firstElementChild.innerHTML});
[].forEach.call(document.querySelectorAll("dialog"),function(d){d.addEventListener("click",function(e){var r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close()})});
/* tooltips: one box, always inside the screen */
var tb=$("tipbox");
/* Tooltip text: data-t = paragraphs (one per line), optional data-list = "Title :: text ;; Title :: text"
   shown as a list with bold titles, optional data-foot = a line after the list. Built as text, never as HTML. */
function tipFill(t){tb.textContent="";var d=t.dataset,el=function(tag,txt){var e=document.createElement(tag);if(txt!=null)e.textContent=txt;return e};
  (d.t||"").split("\n").filter(Boolean).forEach(function(x){tb.appendChild(el("p",x))});
  if(d.list){var ul=el("ul");d.list.split(";;").forEach(function(it){var p=it.split("::"),li=el("li");li.appendChild(el("b",p[0].trim()));if(p[1]&&p[1].trim())li.appendChild(document.createTextNode(" "+p[1].trim()));ul.appendChild(li)});tb.appendChild(ul)}
  if(d.foot)tb.appendChild(el("p",d.foot));tb.classList.toggle("wide",!!d.list)}
function tipOn(t){var w=t.getBoundingClientRect();tipFill(t);tb.style.display="block";var r=tb.getBoundingClientRect(),x=Math.max(8,Math.min(w.left,innerWidth-r.width-8)),y=w.bottom+8;if(y+r.height>innerHeight-8)y=Math.max(8,w.top-r.height-8);tb.style.left=x+"px";tb.style.top=y+"px"}
document.addEventListener("mouseover",function(e){var t=e.target.closest&&e.target.closest(".tip");if(t)tipOn(t)});
document.addEventListener("focusin",function(e){var t=e.target.closest&&e.target.closest(".tip");if(t)tipOn(t)});
["mouseout","focusout"].forEach(function(n){document.addEventListener(n,function(e){if(e.target.closest&&e.target.closest(".tip"))tb.style.display="none"})});
addEventListener("scroll",function(){tb.style.display="none"},true);

var S=[
{v:"home",t:"Hi, I’m Platy! I’ll show you around. Don’t worry, I only punch bad data. ORA!"},
{v:"home",s:".tiles",t:"Pick a way in. Explore the sky is the easiest start."},
{v:"explore",s:".search",t:"Type a sky address here, or press Random patch for a surprise."},
{v:"explore",s:"#stage",t:"This is your sky photo. Hover a dot for a quick look. Click it to check if it’s a known object."},
{v:"explore",s:".ctrl",t:"Press play to watch the photos like a short film. Look for a dot that jumps."},
{v:"explore",s:"#mode",t:"Switch to Diff to see only what changed. White is new, black is gone."},
{v:"sphere",s:".skywrap",t:"No coordinates? Drag to spin the sky, then press Open this field."},
{v:"analytics",s:"#v-analytics .panel",t:"Here are the counts for your area: still, moving, known and unknown objects."}
];
var H={article:"Click the highlighted links in the text to open the tools.",explore:"Tip: Diff mode shows only what changed between two visits.",sphere:"Drag the sky to look around. Click a ring to open that object.","sphere-classic":"Drag the sky to look around. Click a ring to jump to a target.",analytics:"These numbers describe the field you opened in Explore."};
var G=["Hi! What’s on the map today?","Hello! Which coordinates are we exploring today?","Welcome back! Ready to catch something that moves?","Hey! Shall we compare some infrared photos?","ORA! Let’s find something new in the sky.","Good to see you! Pick a spot and press play."];
var step=-1,seen=false,spot=null,tm,pos=null;
try{seen=localStorage.getItem("platy-tour")==="1";pos=JSON.parse(localStorage.getItem("platy-pos")||"null")}catch(e){}
function view(){var h=location.hash.slice(1);return h.indexOf("a-")===0?"article":H[h]?h:"home"}
function mark(){document.body.dataset.v=view()}
function clr(){clearTimeout(tm);if(spot){spot.classList.remove("spot");spot=null}}
function fit(){b.style.transform="";if(b.hidden)return;var r=b.getBoundingClientRect(),dx=0;if(r.right>innerWidth-8)dx=innerWidth-8-r.right;if(r.left+dx<8)dx=8-r.left;b.style.transform="translateX("+dx+"px)"}
function side(){var r=m.getBoundingClientRect();m.classList.toggle("dn",r.top+36<innerHeight/2);m.classList.toggle("r",r.left+36>innerWidth/2);fit()}
function place(l,t){l=Math.max(8,Math.min(l,innerWidth-80));t=Math.max(8,Math.min(t,innerHeight-80));m.classList.add("moved");m.style.cssText="left:"+l+"px;top:"+t+"px;bottom:auto";side()}
function apply(){if(pos)place(8+pos.x*Math.max(1,innerWidth-88),8+pos.y*Math.max(1,innerHeight-88));else side()}
function save(){var r=m.getBoundingClientRect();pos={x:(r.left-8)/Math.max(1,innerWidth-88),y:(r.top-8)/Math.max(1,innerHeight-88)};try{localStorage.setItem("platy-pos",JSON.stringify(pos))}catch(e){}}
var dr=null,mv=0;
mb.onpointerdown=function(e){var r=m.getBoundingClientRect();dr={dx:e.clientX-r.left,dy:e.clientY-r.top,x:e.clientX,y:e.clientY};mv=0;mb.setPointerCapture(e.pointerId)};
mb.onpointermove=function(e){if(!dr)return;if(!mv&&Math.hypot(e.clientX-dr.x,e.clientY-dr.y)<6)return;mv=1;m.classList.add("drag");place(e.clientX-dr.dx,e.clientY-dr.dy)};
mb.onpointerup=mb.onpointercancel=function(){if(dr&&mv)save();dr=null;m.classList.remove("drag");setTimeout(function(){mv=0},0)};
mb.onkeydown=function(e){var k={ArrowLeft:[-24,0],ArrowRight:[24,0],ArrowUp:[0,-24],ArrowDown:[0,24]}[e.key];if(!k)return;e.preventDefault();var r=m.getBoundingClientRect();place(r.left+k[0],r.top+k[1]);save()};
addEventListener("resize",apply);
function hide(){clr();b.hidden=true;step=-1}
function btn(c,l,f){var x=document.createElement("button");x.className=c;x.textContent=l;x.onclick=f;ac.appendChild(x)}
function say(t){tx.textContent=t;ac.innerHTML="";b.hidden=false;side();m.classList.add("talk");setTimeout(function(){m.classList.remove("talk")},600)}
function finish(){try{localStorage.setItem("platy-tour","1")}catch(e){}seen=true;hide()}
function show(i){clr();step=i;var s=S[i];if(view()!==s.v)location.hash=s.v;mark();
  say(s.t);var d=document.createElement("div");d.className="dots";S.forEach(function(_,k){d.appendChild(document.createElement("i")).className=k===i?"on":""});ac.appendChild(d);
  if(i<S.length-1){btn("ghost","Skip",finish);btn("cta","Next",function(){show(i+1)})}else btn("cta","Done",finish);fit();
  setTimeout(function(){if(step!==i||!s.s)return;var el=document.querySelector(s.s);if(!el)return;el.classList.add("spot");spot=el;
    el.scrollIntoView({block:"center",behavior:matchMedia("(prefers-reduced-motion:reduce)").matches?"auto":"smooth"})},120)}
function hint(t,auto){clr();step=-1;say(t);btn("cta","Show me around",function(){show(0)});btn("ghost","Got it",hide);fit();if(auto)tm=setTimeout(hide,10000)}
mb.onclick=function(){if(mv)return;if(!b.hidden){hide();return}hint(H[view()]||"Need a hand? I can show you around.")};
$("binfo").onclick=function(){show(0)};$("hcont").onclick=function(){$("d-cont").showModal()};
document.addEventListener("keydown",function(e){if(e.key==="Escape"&&!b.hidden&&!document.querySelector("dialog[open]"))hide()});
addEventListener("hashchange",function(){mark();var v=view();if(step>=0)return;if(!b.hidden)hide()});
mark();apply();
function greet(){var l=-1,i;try{l=+localStorage.getItem("platy-g")}catch(e){}do{i=Math.floor(Math.random()*G.length)}while(i===l);try{localStorage.setItem("platy-g",i)}catch(e){}clr();say(G[i]);tm=setTimeout(hide,7000)}
setTimeout(function(){if(!b.hidden)return;if(!seen&&view()==="home")show(0);else greet()},900);
})();
