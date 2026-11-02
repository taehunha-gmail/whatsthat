'use strict';
/* 저게뭐야? v1 — 실시간 카메라에 보이는 건물·산 이름표
   데이터: OpenStreetMap(Overpass) · AWS terrain tiles · 카카오 지도 SDK(건물명) */
const KAKAO_JS='a4bfdb25e1f0c9bf07c07032b4457773';
const DECL=-8.8;               // 서울 자편각(°, 서쪽) — iOS 나침반은 자북 기준
const $=id=>document.getElementById(id);
const S={lat:null,lon:null,acc:null,ground:0,eye:0,floor:1,blds:[],peaks:[],areas:[],
  alpha:null,beta:null,gamma:null,iosHdg:null,alphaOff:null,userOff:+(localStorage.hdgOff||0),
  fov:+(localStorage.fov2||67),maxLabels:+(localStorage.maxLabels||14),showPeaks:true,loading:false,loadedAt:null,labels:[],names:new Map()};

/* ---------- 기하 ---------- */
const R=6371000, D2R=Math.PI/180;
function bd(lat0,lon0,lat,lon){const y=(lat-lat0)*111320,x=(lon-lon0)*111320*Math.cos(lat0*D2R);return [((Math.atan2(x,y)/D2R)+360)%360,Math.hypot(x,y)];}
function elev(dh,d){return Math.atan2(dh-d*d*(1-0.13)/(2*R),d)/D2R;}
function camBasis(){ // deviceorientation → 카메라 앞·오른쪽·위 벡터(세계: x동 y북 z위)
  if(S.beta==null) return null;
  let a=S.alpha; if(S.alphaOff!=null) a=a+S.alphaOff; a=a-S.userOff; // 시계 방향 보정 = alpha 감소
  const A=a*D2R,B=S.beta*D2R,G=S.gamma*D2R,cA=Math.cos(A),sA=Math.sin(A),cB=Math.cos(B),sB=Math.sin(B),cG=Math.cos(G),sG=Math.sin(G);
  const r=[cA*cG-sA*sB*sG, sA*cG+cA*sB*sG, -cB*sG];
  const u=[-sA*cB, cA*cB, sB];
  const v=[-(cA*sG+sA*sB*cG), -(sA*sG-cA*sB*cG), -cB*cG];
  return {r,u,v};
}
function headingOf(v){return ((Math.atan2(v[0],v[1])/D2R)+360)%360;}
function rawHeading(){ // alphaOff 없이
  const A=S.alpha*D2R,B=S.beta*D2R,G=S.gamma*D2R,cA=Math.cos(A),sA=Math.sin(A),cB=Math.cos(B),sB=Math.sin(B),cG=Math.cos(G),sG=Math.sin(G);
  return headingOf([-(cA*sG+sA*sB*cG), -(sA*sG-cA*sB*cG)]);
}
let VIEW={W:0,H:0,f:0};
function updateView(){
  const W=innerWidth,H=innerHeight,vid=$('cam');
  const vw=vid.videoWidth||3,vh=vid.videoHeight||4;
  const s=Math.max(W/vw,H/vh);              // object-fit:cover
  // S.fov = 카메라 긴 변 화각(아이폰 기본 광각 ≈ 67°). 세로로 들면 화면 가로 = 짧은 변
  const asp=Math.max(vw,vh)/Math.min(vw,vh); const half=vw<vh?Math.tan(S.fov/2*D2R)/asp:Math.tan(S.fov/2*D2R);
  VIEW={W,H,f:(vw*s/2)/half,vs:s,vw,vh};
  const c=$('overlay'); const dpr=devicePixelRatio||1; c.width=W*dpr; c.height=H*dpr; c.getContext('2d').setTransform(dpr,0,0,dpr,0,0);
}
function project(B,az,el){
  const t=[Math.cos(el*D2R)*Math.sin(az*D2R),Math.cos(el*D2R)*Math.cos(az*D2R),Math.sin(el*D2R)];
  const z=t[0]*B.v[0]+t[1]*B.v[1]+t[2]*B.v[2]; if(z<=0.02) return null;
  const x=t[0]*B.r[0]+t[1]*B.r[1]+t[2]*B.r[2], y=t[0]*B.u[0]+t[1]*B.u[1]+t[2]*B.u[2];
  return [VIEW.W/2+VIEW.f*x/z, VIEW.H/2-VIEW.f*y/z];
}

/* ---------- 지형(DEM) ---------- */
const DEMZ=13, demTiles=new Map();
function demTile(x,y){
  const k=x+'/'+y; if(demTiles.has(k)) return demTiles.get(k);
  const p=new Promise((ok)=>{const im=new Image(); im.crossOrigin='anonymous';
    im.onload=()=>{const c=document.createElement('canvas');c.width=c.height=256;const g=c.getContext('2d');g.drawImage(im,0,0);ok(g.getImageData(0,0,256,256).data);};
    im.onerror=()=>ok(null); im.src=`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${DEMZ}/${x}/${y}.png`;});
  demTiles.set(k,p); return p;
}
async function ele(lat,lon){
  const n=2**DEMZ, fx=(lon+180)/360*n, fy=(1-Math.asinh(Math.tan(lat*D2R))/Math.PI)/2*n;
  const x=Math.floor(fx),y=Math.floor(fy), d=await demTile(x,y); if(!d) return null;
  const px=Math.min(255,Math.floor((fx-x)*256)),py=Math.min(255,Math.floor((fy-y)*256)),i=(py*256+px)*4;
  return d[i]*256+d[i+1]+d[i+2]/256-32768;
}

/* ---------- 주변 데이터 ---------- */
const OVERPASS=['https://overpass-api.de/api/interpreter','https://overpass.private.coffee/api/interpreter','https://overpass.kumi.systems/api/interpreter'];
async function overpass(q){
  for(let t=0;t<6;t++){
    const url=OVERPASS[t%OVERPASS.length];
    try{const r=await fetch(url,{method:'POST',body:'data='+encodeURIComponent(q),headers:{'Content-Type':'application/x-www-form-urlencoded'}});
      if(r.ok){const j=await r.json(); if(j.elements) return j.elements;}}catch(e){}
    status(`지도 서버가 바빠요… 다시 시도(${t+1})`); await new Promise(z=>setTimeout(z,2000*(t+1)));
  }
  throw new Error('지도 서버 응답 없음');
}
function ht(t,def){for(const k of ['height','building:height']){const v=parseFloat(t[k]);if(v>0)return v;} const l=parseFloat(t['building:levels']); return l>0?l*3:def;}
async function loadArea(){
  if(S.loading) return; S.loading=true; status('주변 건물 불러오는 중…');
  const {lat,lon}=S;
  const q=`[out:json][timeout:60];(way["building"](around:1300,${lat},${lon});way["building"]["name"](around:5000,${lat},${lon});way["building"]["height"](around:9000,${lat},${lon});way["landuse"="residential"]["name"](around:2500,${lat},${lon});node["natural"="peak"]["name"](around:20000,${lat},${lon}););out geom tags;`;
  try{
    const els=await overpass(q);
    S.ground=(await ele(lat,lon))??0; S.eye=S.ground+(S.floor-1)*2.8+1.5;
    const blds=[],areas=[],peaks=[]; const seen=new Set();
    for(const e of els){
      if(seen.has(e.type+e.id)) continue; seen.add(e.type+e.id);
      const t=e.tags||{};
      if(t.natural==='peak'){const top=parseFloat(t.ele); if(top>0){const [a,d]=bd(lat,lon,e.lat,e.lon);peaks.push({name:t.name,az:a,d,top});} continue;}
      const g=e.geometry; if(!g||g.length<3) continue;
      if(t.landuse==='residential'){areas.push({name:t.name,poly:g.map(p=>[p.lat,p.lon])}); continue;}
      const cl=g.reduce((s,p)=>s+p.lat,0)/g.length, cn=g.reduce((s,p)=>s+p.lon,0)/g.length;
      const [a,d]=bd(lat,lon,cl,cn); if(d<35) continue;
      const h=ht(t,t.building==='apartments'?45:10);
      blds.push({id:e.id,t,c:[cl,cn],az:a,d,h,pts:g.map(p=>bd(lat,lon,p.lat,p.lon))});
    }
    status(`지형 높이 계산 중… (${blds.length}동)`);
    await Promise.all(blds.map(async b=>{b.ground=(await ele(b.c[0],b.c[1]))??S.ground;}));
    blds.sort((a,b)=>b.d-a.d);                   // 먼 것부터 그린다
    blds.forEach((b,i)=>b.key=i+1);
    S.blds=blds; S.areas=areas; S.peaks=peaks; S.loadedAt=[lat,lon];
    status(`건물 ${blds.length} · 산 ${peaks.length} · 눈높이 해발 ${Math.round(S.eye)} m`);
  }catch(e){status('불러오기 실패 — ⚙︎에서 다시 시도');}
  S.loading=false;
}
function inside(lat,lon,poly){let c=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const[yi,xi]=poly[i],[yj,xj]=poly[j];if((yi>lat)!==(yj>lat)&&lon<(xj-xi)*(lat-yi)/(yj-yi+1e-12)+xi)c=!c;}return c;}
const BAD=/^([A-Z]|\d+|제?\d+동|.*\d+동|[가-힣]?\d+[동호]?)$/;

/* ---------- 카카오 건물명 ---------- */
let geocoder=null; const kq=[]; let kBusy=false;
function initKakao(){
  const s=document.createElement('script'); s.src=`https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_JS}&libraries=services&autoload=false`;
  s.onload=()=>kakao.maps.load(()=>{geocoder=new kakao.maps.services.Geocoder();}); document.head.appendChild(s);
}
function kakaoName(b){
  if(S.names.has(b.id)) return S.names.get(b.id);
  S.names.set(b.id,undefined); kq.push(b); pumpK(); return undefined;
}
function pumpK(){
  if(kBusy||!geocoder||!kq.length) return; kBusy=true; const b=kq.shift();
  geocoder.coord2Address(b.c[1],b.c[0],(res,st)=>{
    let n=''; if(st===kakao.maps.services.Status.OK&&res[0]) n=((res[0].road_address||{}).building_name||'').trim();
    S.names.set(b.id,n); kBusy=false; setTimeout(pumpK,120);
  });
}
function labelOf(b){
  const n=(b.t.name||'').trim();
  if(n&&!BAD.test(n)) return n;
  let k=kakaoName(b);
  if(k){ if(/\d+동$/.test(k)&&n&&/^\d+동?$/.test(n)) k=k.replace(/\s*\d+동$/,''); const dong=n&&/^\d+동?$/.test(n)?(n.endsWith('동')?n:n+'동'):''; return (k+(dong&&!k.includes(dong)?' '+dong:'')).trim(); }
  if(k===undefined) return null;   // 아직 묻는 중
  for(const a of S.areas) if(inside(b.c[0],b.c[1],a.poly)) return a.name+(n?' '+n:'');
  return null;
}

/* ---------- 가림 계산(작은 캔버스에 화가 알고리즘) ---------- */
const occ=document.createElement('canvas'); const og=occ.getContext('2d',{willReadFrequently:true});
function hull(P){P.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);const cr=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);const lo=[],up=[];
  for(const p of P){while(lo.length>=2&&cr(lo[lo.length-2],lo[lo.length-1],p)<=0)lo.pop();lo.push(p);}
  for(let i=P.length-1;i>=0;i--){const p=P[i];while(up.length>=2&&cr(up[up.length-2],up[up.length-1],p)<=0)up.pop();up.push(p);}
  return lo.slice(0,-1).concat(up.slice(0,-1));}
function compute(){
  const B=camBasis(); if(!B||!S.blds.length) return;
  const sc=200/VIEW.W, w=200, h=Math.round(VIEW.H*sc); occ.width=w; occ.height=h; og.clearRect(0,0,w,h);
  const shapes=new Map();
  for(const b of S.blds){
    const P=[]; for(const [a,d] of b.pts){ for(const z of [b.ground,b.ground+b.h]){ const p=project(B,a,elev(z-S.eye,Math.max(d,1))); if(p) P.push([p[0]*sc,p[1]*sc]); } }
    if(P.length<3) continue; const H_=hull(P); if(H_.length<3) continue;
    let minx=1e9,maxx=-1e9,miny=1e9,maxy=-1e9; for(const[x,y]of H_){minx=Math.min(minx,x);maxx=Math.max(maxx,x);miny=Math.min(miny,y);maxy=Math.max(maxy,y);}
    if(maxx<0||minx>w||maxy<0||miny>h) continue;
    og.fillStyle=`rgb(${b.key&255},${(b.key>>8)&255},${(b.key>>16)&255})`; og.beginPath(); H_.forEach(([x,y],i)=>i?og.lineTo(x,y):og.moveTo(x,y)); og.closePath(); og.fill();
    shapes.set(b.key,b);
  }
  const data=og.getImageData(0,0,w,h).data; const cnt=new Map(), sx=new Map(), top=new Map();
  for(let y=0;y<h;y+=1)for(let x=0;x<w;x+=1){const i=(y*w+x)*4; if(data[i+3]<250) continue; const k=data[i]|(data[i+1]<<8)|(data[i+2]<<16); const b=shapes.get(k); if(!b) continue;
    cnt.set(k,(cnt.get(k)||0)+1); (sx.get(k)||sx.set(k,[]).get(k)).push(x); if(!top.has(k)||y<top.get(k)) top.set(k,y);}
  const vis=[...cnt.entries()].filter(([k,n])=>n>=6).sort((a,b)=>b[1]-a[1]);
  const L=[]; const used=new Set();
  for(const [k,n] of vis){
    const b=shapes.get(k); if(b.d<120) continue;
    const name=labelOf(b); if(!name||used.has(name)) continue; used.add(name);
    const xs=sx.get(k).sort((a,b)=>a-b); const x=xs[xs.length>>1]/sc, y=top.get(k)/sc+6;
    const lv=parseInt(b.t['building:levels']); L.push({x,y,name,sub:`${(b.d/1000).toFixed(1)} km`+(lv?` · ${lv}층`:(b.h>=60?` · ${Math.round(b.h)} m`:'')),peak:false});
    if(L.length>=S.maxLabels) break;
  }
  if(S.showPeaks) for(const p of S.peaks){
    const q=project(B,p.az,elev(p.top-S.eye,p.d)); if(!q) continue; const [x,y]=q; if(x<0||x>VIEW.W||y<0||y>VIEW.H) continue;
    const ox=Math.floor(x*sc),oy=Math.floor(y*sc),i=(oy*w+ox)*4; if(data[i+3]>0) continue;
    L.push({x,y,name:p.name,sub:`${(p.d/1000).toFixed(1)} km · 해발 ${Math.round(p.top)} m`,peak:true});
  }
  S.labels=L;
}

/* ---------- 그리기 ---------- */
function drawLabels(g,L,scale=1){
  const boxes=[]; g.textBaseline='top';
  for(const l of L){
    const f1=15*scale,f2=11*scale; g.font=`700 ${f1}px -apple-system,"Apple SD Gothic Neo",sans-serif`; const w1=g.measureText(l.name).width; g.font=`${f2}px -apple-system,sans-serif`; const w2=g.measureText(l.sub).width;
    const bw=Math.max(w1,w2)+16*scale, bh=f1+f2+14*scale; let bx,by,ok=false;
    for(let lift=26*scale;lift<320*scale;lift+=18*scale){bx=l.x-bw/2;by=l.y-lift-bh; if(by<4) break; if(boxes.every(q=>bx+bw<q[0]||bx>q[2]||by+bh<q[1]||by>q[3])){ok=true;break;}}
    if(!ok) continue; boxes.push([bx,by,bx+bw,by+bh]);
    g.strokeStyle='rgba(255,255,255,.85)'; g.lineWidth=2*scale; g.beginPath(); g.moveTo(l.x,l.y); g.lineTo(l.x,by+bh); g.stroke();
    g.fillStyle=l.peak?'#ffd60a':'#fff'; g.beginPath(); g.arc(l.x,l.y,4*scale,0,7); g.fill();
    g.fillStyle='rgba(0,0,0,.6)'; g.beginPath(); g.roundRect(bx,by,bw,bh,9*scale); g.fill();
    g.fillStyle=l.peak?'#ffd60a':'#fff'; g.font=`700 ${f1}px -apple-system,"Apple SD Gothic Neo",sans-serif`; g.fillText(l.name,bx+8*scale,by+5*scale);
    g.fillStyle='#ddd'; g.font=`${f2}px -apple-system,sans-serif`; g.fillText(l.sub,bx+8*scale,by+9*scale+f1);
  }
}
function frame(){
  const g=$('overlay').getContext('2d'); g.clearRect(0,0,VIEW.W,VIEW.H); drawLabels(g,S.labels);
  requestAnimationFrame(frame);
}

/* ---------- 센서 ---------- */
function status(s){$('status').textContent=s;}
function onOri(e){
  if(e.alpha==null) return;
  S.alpha=e.alpha; S.beta=e.beta; S.gamma=e.gamma;
  if(typeof e.webkitCompassHeading==='number'){ // iOS: 나침반으로 alpha 기준을 맞춘다(자북→진북)
    const want=(e.webkitCompassHeading+DECL+360)%360, raw=rawHeading();
    const off=-(((want-raw+540)%360)-180);      // 시계 방향 차이 → alpha 감소
    S.alphaOff = S.alphaOff==null?off:S.alphaOff+0.05*(((off-S.alphaOff+540)%360)-180);
  } else if(e.absolute){ S.alphaOff=0; }
}
async function start(){
  S.floor=+$('floor').value||1; $('floor2').value=S.floor;
  try{ if(window.DeviceOrientationEvent&&DeviceOrientationEvent.requestPermission) await DeviceOrientationEvent.requestPermission(); }catch(e){}
  try{
    const st=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false});
    $('cam').srcObject=st; await $('cam').play();
  }catch(e){ alert('카메라를 켤 수 없습니다: '+e.message); return; }
  $('start').hidden=true; $('hud').hidden=false;
  addEventListener('deviceorientationabsolute',onOri,true); addEventListener('deviceorientation',onOri,true);
  $('cam').addEventListener('loadedmetadata',updateView); addEventListener('resize',updateView); updateView();
  navigator.geolocation.watchPosition(p=>{
    S.lat=p.coords.latitude; S.lon=p.coords.longitude; S.acc=p.coords.accuracy;
    if(!S.loadedAt||bd(S.loadedAt[0],S.loadedAt[1],S.lat,S.lon)[1]>400) loadArea();
  },e=>status('위치 권한이 필요합니다'),{enableHighAccuracy:true,maximumAge:5000});
  initKakao(); setInterval(compute,180); frame();
}

/* ---------- 찰칵 ---------- */
async function shot(){
  const v=$('cam'),W=VIEW.W,H=VIEW.H,k=Math.min(3,v.videoWidth/W*1.0||2);
  const c=document.createElement('canvas'); c.width=W*k; c.height=H*k; const g=c.getContext('2d');
  const s=Math.max(c.width/v.videoWidth,c.height/v.videoHeight), dw=v.videoWidth*s, dh=v.videoHeight*s;
  g.drawImage(v,(c.width-dw)/2,(c.height-dh)/2,dw,dh);
  g.save(); g.scale(k,k); drawLabels(g,S.labels); g.restore();
  g.font=`600 ${14*k}px sans-serif`; g.fillStyle='rgba(255,255,255,.8)'; g.textAlign='right'; g.fillText('저게뭐야?',c.width-12*k,c.height-12*k);
  const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',0.9));
  const f=new File([blob],`저게뭐야_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'')}.jpg`,{type:'image/jpeg'});
  if(navigator.canShare&&navigator.canShare({files:[f]})){ try{await navigator.share({files:[f]});return;}catch(e){} }
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=f.name; a.click();
}

/* ---------- 보정·설정 ---------- */
function openCalib(){
  $('calibPanel').hidden=false; $('cross').hidden=false; $('setPanel').hidden=true;
  const list=$('calibList'); list.innerHTML='';
  const cands=S.blds.filter(b=>b.t.name&&!BAD.test(b.t.name)&&b.h>=60).sort((a,b)=>b.h-a.h).slice(0,24);
  for(const b of cands){const bt=document.createElement('button'); bt.textContent=b.t.name; bt.onclick=()=>{
      const B=camBasis(); if(!B) return; const cur=headingOf(B.v); const d=((b.az-cur+540)%360)-180; S.userOff+=d; $('hdg').value=S.userOff; $('hdgV').textContent=S.userOff.toFixed(1)+'°'; localStorage.hdgOff=S.userOff; };
    list.appendChild(bt);}
}
$('go').onclick=start; $('shot').onclick=shot; $('calib').onclick=openCalib;
$('calibDone').onclick=()=>{$('calibPanel').hidden=true;$('cross').hidden=true;};
$('hdg').value=S.userOff; $('hdgV').textContent=S.userOff+'°'; $('hdg').oninput=e=>{S.userOff=+e.target.value;$('hdgV').textContent=S.userOff+'°';localStorage.hdgOff=S.userOff;};
$('fov').value=S.fov; $('fovV').textContent=S.fov+'°'; $('fov').oninput=e=>{S.fov=+e.target.value;$('fovV').textContent=S.fov+'°';localStorage.fov2=S.fov;updateView();};
$('settings').onclick=()=>{$('setPanel').hidden=false;$('calibPanel').hidden=true;$('cross').hidden=true;};
$('setDone').onclick=()=>{$('setPanel').hidden=true;};
$('floor2').onchange=e=>{S.floor=+e.target.value||1; S.eye=S.ground+(S.floor-1)*2.8+1.5;};
$('showPeaks').onchange=e=>{S.showPeaks=e.target.checked;};
$('maxLabels').value=S.maxLabels; $('maxV').textContent=S.maxLabels; $('maxLabels').oninput=e=>{S.maxLabels=+e.target.value;$('maxV').textContent=S.maxLabels;localStorage.maxLabels=S.maxLabels;};
$('reload').onclick=()=>{S.loadedAt=null; if(S.lat) loadArea(); $('setPanel').hidden=true;};
