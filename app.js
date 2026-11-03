'use strict';
/* 저게뭐야? v3.7.4 — 실시간 카메라에 보이는 건물·산 이름표
   데이터: OpenStreetMap(수도권은 정적 타일 data/, 밖은 Overpass) · AWS terrain tiles · 카카오 지도 SDK(건물명) */
const KAKAO_JS='a4bfdb25e1f0c9bf07c07032b4457773';
const DECL=-8.8;               // 서울 자편각(°, 서쪽) — iOS 나침반은 자북 기준
const $=id=>document.getElementById(id);
const S={lat:null,lon:null,acc:null,ground:0,eye:0,floor:1,blds:[],peaks:[],areas:[],
  alpha:null,beta:null,gamma:null,iosHdg:null,alphaOff:null,userOff:+(localStorage.hdgOff||0),
  fov:+(localStorage.fov2||67),maxLabels:+(localStorage.maxLabels||14),showPeaks:true,loading:false,loadedAt:null,labels:[],dots:[],shown:new Set(),pop:null,simple:localStorage.simple!=='0',names:new Map()};

/* ---------- 기하 ---------- */
const R=6371000, D2R=Math.PI/180;
function bd(lat0,lon0,lat,lon){const y=(lat-lat0)*111320,x=(lon-lon0)*111320*Math.cos(lat0*D2R);return [((Math.atan2(x,y)/D2R)+360)%360,Math.hypot(x,y)];}
function elev(dh,d){return Math.atan2(dh-d*d*(1-0.13)/(2*R),d)/D2R;}
function camBasis(){ // deviceorientation → 카메라 앞·오른쪽·위 벡터(세계: x동 y북 z위)
  if(S.beta==null){ if(!S.manual) return null; const h=((S.userOff%360)+360)%360*D2R; // 센서 없음: 수평으로 든 폰, 방향 = 보정값
    return {v:[Math.sin(h),Math.cos(h),0], r:[Math.cos(h),-Math.sin(h),0], u:[0,0,1]}; }
  let a=S.alpha; if(S.alphaOff!=null) a=a+S.alphaOff; a=a-S.userOff; // 시계 방향 보정 = alpha 감소
  const A=a*D2R,B=S.beta*D2R,G=S.gamma*D2R,cA=Math.cos(A),sA=Math.sin(A),cB=Math.cos(B),sB=Math.sin(B),cG=Math.cos(G),sG=Math.sin(G);
  const r=[cA*cG-sA*sB*sG, sA*cG+cA*sB*sG, -cB*sG];
  const u=[-sA*cB, cA*cB, sB];
  const v=[-(cA*sG+sA*sB*cG), -(sA*sG-cA*sB*cG), -cB*cG];
  const th=scrAngle()*D2R; if(!th) return {r,u,v};   // 가로로 들면 화면 오른쪽·위가 기기 축과 90° 돈다
  const c=Math.cos(th),s=Math.sin(th);
  return {r:r.map((x,i)=>x*c-u[i]*s), u:r.map((x,i)=>x*s+u[i]*c), v};
}
function scrAngle(){const a=(screen.orientation&&typeof screen.orientation.angle==='number')?screen.orientation.angle:(+window.orientation||0);return ((a%360)+360)%360;}
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
// v3.6 지형 — 30 m 격자(SRTM) 는 평지 도심에서 칸마다 ±5~10 m 출렁인다(성수중 12 m·바로 옆 성수고 21 m).
// 9×9 칸(약 130 m) 중앙값으로 고르고, 관측점과의 차이 5 m 까지는 잡음으로 보고 뺀다 — 응봉산 같은 진짜 언덕은 남는다
const demData=new Map();   // 받은 지형 칸(동기 조회용)
function eleSync(lat,lon){
  const n=2**DEMZ, fx=(lon+180)/360*n, fy=(1-Math.asinh(Math.tan(lat*D2R))/Math.PI)/2*n;
  const x=Math.floor(fx),y=Math.floor(fy), d=demData.get(x+'/'+y); if(!d) return null;
  const i=(Math.min(255,Math.floor((fy-y)*256))*256+Math.min(255,Math.floor((fx-x)*256)))*4;
  return d[i]*256+d[i+1]+d[i+2]/256-32768;
}
async function demLoad(lat0,lat1,lon0,lon1){ // 범위 안 지형 칸을 미리 받아 둔다
  const n=2**DEMZ, tx=lon=>Math.floor((lon+180)/360*n), ty=lat=>Math.floor((1-Math.asinh(Math.tan(lat*D2R))/Math.PI)/2*n), q=[];
  for(let x=tx(lon0);x<=tx(lon1);x++) for(let y=ty(lat1);y<=ty(lat0);y++) q.push(demTile(x,y).then(d=>{if(d) demData.set(x+'/'+y,d);}));
  await Promise.all(q);
}
function eleS(lat,lon){
  const st=15.2/111320, sn=15.2/(111320*Math.cos(lat*D2R)), v=[];
  for(let i=-4;i<=4;i++) for(let j=-4;j<=4;j++){ const e=eleSync(lat+i*st,lon+j*sn); if(e!=null) v.push(e); }
  if(!v.length) return null; v.sort((a,b)=>a-b); return v[v.length>>1];
}
const DEM_NOISE=5;
function relGround(g){ const dg=g-S.ground; return S.ground+Math.sign(dg)*Math.max(0,Math.abs(dg)-DEM_NOISE); }

/* ---------- 주변 데이터 ---------- */
const OVERPASS=['https://overpass-api.de/api/interpreter','https://overpass.private.coffee/api/interpreter','https://overpass.kumi.systems/api/interpreter'];
let opIdx=0;
async function overpass(q,label){
  for(let t=0;t<9;t++){
    const url=OVERPASS[(opIdx+t)%OVERPASS.length]; const ac=new AbortController(); const to=setTimeout(()=>ac.abort(),90000);
    try{const r=await fetch(url,{method:'POST',body:'data='+encodeURIComponent(q),headers:{'Content-Type':'application/x-www-form-urlencoded'},signal:ac.signal});
      clearTimeout(to); if(r.ok){const j=await r.json(); if(j.elements){opIdx=(opIdx+t)%OVERPASS.length; return j.elements;}}}catch(e){clearTimeout(to);}
    status(`${label} — 지도 서버 붐빔, 다른 서버로 재시도 ${t+1}/9`); await new Promise(z=>setTimeout(z,1500+1500*t));
  }
  throw new Error('지도 서버 응답 없음');
}
/* 정적 타일 — 수도권(37.30~37.80°N·126.65~127.35°E)은 공개 Overpass 없이 이 사이트의 data/ 에서 받는다
   (2026-11-02 행당역: 공개 서버 3곳이 모두 «at capacity»·무응답이라 이름표 0개) */
const TILE='./data/'; let META=null;
async function getJSON(u){const r=await fetch(u); if(!r.ok) throw new Error(r.status); return r.json();}
async function tileEls(lat,lon){
  S.fromTile=false;
  try{META=META||await getJSON(TILE+'meta.json');}catch(e){return null;}
  const [a0,a1,o0,o1]=META.bbox; if(lat<a0+0.015||lat>a1-0.015||lon<o0+0.02||lon>o1-0.02) return null;
  status('건물 데이터 받는 중…');
  const R=1500, dla=R/111320, dlo=R/(111320*Math.cos(lat*D2R)), keys=[];
  for(let a=Math.floor((lat-dla)*100);a<=Math.floor((lat+dla)*100);a++) for(let o=Math.floor((lon-dlo)*100);o<=Math.floor((lon+dlo)*100);o++) keys.push([a,o]);
  const els=[], kid=g=>g[0].lat.toFixed(4)+','+g[0].lon.toFixed(4);
  const tg=(n,lv,h,apt)=>{const t={building:apt?'apartments':'yes'}; if(n)t.name=n; if(lv)t['building:levels']=String(lv); if(h)t.height=String(h); return t;};
  const [cs,tall,pk]=await Promise.all([Promise.all(keys.map(([a,o])=>getJSON(`${TILE}t/${a}_${o}.json`).then(c=>[a,o,c]).catch(()=>null))),
    (async()=>{const T=[],dl=9000/111320,dn=9000/(111320*Math.cos(lat*D2R)),q=[];
      for(let a=Math.floor((lat-dl)*10);a<=Math.floor((lat+dl)*10);a++) for(let o=Math.floor((lon-dn)*10);o<=Math.floor((lon+dn)*10);o++) q.push(getJSON(`${TILE}tall/${a}_${o}.json`).then(v=>T.push(...v)).catch(()=>0));
      await Promise.all(q); return T;})(), getJSON(TILE+'peaks.json').catch(()=>[])]);
  for(const x of cs){ if(!x) continue; const [a,o,c]=x;
    const geo=f=>{const g=[];for(let i=0;i<f.length;i+=2)g.push({lat:a/100+f[i]/1e5,lon:o/100+f[i+1]/1e5});return g;};
    for(const [n,lv,h,apt,f] of c.b){const g=geo(f), d=bd(lat,lon,g[0].lat,g[0].lon)[1]; if(d>600&&!(n&&d<1500)) continue; els.push({type:'way',id:kid(g),tags:tg(n,lv,h,apt),geometry:g});}
    for(const [n,f] of c.r){const g=geo(f); els.push({type:'way',id:'r'+kid(g),tags:{landuse:'residential',name:n},geometry:g});}
  }
  for(const [n,lv,h,apt,p] of tall){ if(bd(lat,lon,p[0][0],p[0][1])[1]>9000) continue; const g=p.map(([la,lo])=>({lat:la,lon:lo})); els.push({type:'way',id:kid(g),tags:tg(n,lv,h,apt),geometry:g});}
  for(const [n,la,lo,e] of pk){ if(bd(lat,lon,la,lo)[1]<20000) els.push({type:'node',id:n+la,lat:la,lon:lo,tags:{natural:'peak',name:n,ele:String(e)}}); }
  S.fromTile=true; return els;
}
/* 폰 안 저장소(IndexedDB) — 동네 데이터 재사용 */
function idb(){return new Promise((ok,no)=>{const r=indexedDB.open('whatsthat',1);r.onupgradeneeded=()=>r.result.createObjectStore('area');r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);});}
async function cacheGet(k){try{const db=await idb();return await new Promise(ok=>{const q=db.transaction('area').objectStore('area').get(k);q.onsuccess=()=>ok(q.result);q.onerror=()=>ok(null);});}catch(e){return null;}}
async function cachePut(k,v){try{const db=await idb();db.transaction('area','readwrite').objectStore('area').put(v,k);}catch(e){}}
function ht(t,def){for(const k of ['height','building:height']){const v=parseFloat(t[k]);if(v>0)return v;} const l=parseFloat(t['building:levels']); return l>0?l*3:def;}
async function loadArea(){
  if(S.loading) return; S.loading=true;
  const {lat,lon}=S; const key=`v2:${lat.toFixed(3)},${lon.toFixed(3)}`;   // 약 100 m 칸
  try{
    let els=await tileEls(lat,lon);
    if(els) status(`우리 서버 건물 데이터 (${els.length}개)`);
    else els=await cacheGet(key);
    if(els){ if(!S.fromTile) status('저장된 동네 데이터 사용'); }
    else{
      const qs=[
        // 도심(광화문 등)은 1 km 전부·9 km 높이 있는 전부가 2~14 MB·40 초 넘게 걸려 늘 끊겼다 → 가까운 건 600 m, 먼 건 60 m·20층 이상만
        ['가까운 건물 1/3',`[out:json][timeout:80];way["building"](around:600,${lat},${lon});out geom tags;`],
        ['먼 고층 2/3',`[out:json][timeout:80];(way["building"]["name"](around:1500,${lat},${lon});way["building"]["height"~"^([6-9][0-9]|[1-9][0-9][0-9])([.][0-9]+)?( m)?$"](around:9000,${lat},${lon});way["building"]["building:levels"~"^([2-9][0-9]|1[0-9][0-9])$"](around:9000,${lat},${lon}););out geom tags;`],
        ['단지·산 3/3',`[out:json][timeout:80];(way["landuse"="residential"]["name"](around:1500,${lat},${lon});node["natural"="peak"]["name"](around:20000,${lat},${lon}););out geom tags;`]];
      els=[];
      for(const [lb,q] of qs){ status(lb+' 받는 중…'); els=els.concat(await overpass(q,lb)); }
      cachePut(key,els);
    }
    { const dl=10000/111320, dn=10000/(111320*Math.cos(lat*D2R)); await demLoad(lat-dl,lat+dl,lon-dn,lon+dn); }
    S.ground=eleS(lat,lon)??0; S.eye=S.ground+(S.floor-1)*2.8+1.5;
    const blds=[],areas=[],peaks=[]; const seen=new Set();
    for(const e of els){
      if(seen.has(e.type+e.id)) continue; seen.add(e.type+e.id);
      const t=e.tags||{};
      if(t.natural==='peak'){const top=parseFloat(t.ele); if(top>0){const [a,d]=bd(lat,lon,e.lat,e.lon);peaks.push({name:t.name,az:a,d,top});} continue;}
      const g=e.geometry; if(!g||g.length<3) continue;
      if(t.landuse==='residential'){areas.push({name:t.name,poly:g.map(p=>[p.lat,p.lon])}); continue;}
      const cl=g.reduce((s,p)=>s+p.lat,0)/g.length, cn=g.reduce((s,p)=>s+p.lon,0)/g.length;
      const [a,d]=bd(lat,lon,cl,cn);
      // v3.6 골목에서는 바로 옆 벽이 시야를 다 가린다 — 가까운 건물도 가림에 넣는다(이름표는 40 m 밖만).
      // 내가 그 건물 안이면(실내·GPS 오차) 빼고, 2층 이상 실내면 25 m 안 건물도 뺀다
      const poly=g.map(p=>[p.lat,p.lon]); if(inside(lat,lon,poly)) continue; if(S.floor>1&&d<25) continue;
      const h=ht(t,t.building==='apartments'?45:10);
      blds.push({id:e.id,t,c:[cl,cn],az:a,d,h,pts:(d<150?dense(g,3):g).map(p=>bd(lat,lon,p.lat,p.lon))});
    }
    status(`지형 높이 계산 중… (${blds.length}동)`);
    for(const b of blds){const g=eleS(b.c[0],b.c[1]); b.ground=g==null?S.ground:relGround(g);}
    blds.sort((a,b)=>b.d-a.d); blds.forEach((b,i)=>b.key=i+1);
    S.blds=blds; S.areas=areas; S.peaks=peaks; S.loadedAt=[lat,lon];
    status(`눈높이 해발 ${Math.round(S.eye)} m`);
  }catch(e){status('지도 서버가 계속 붐벼요 — 잠시 뒤 ⚙︎ → 다시 불러오기');}
  S.loading=false;
}
function dense(g,step){ // 가까운 건물은 변을 3 m 마다 쪼갠다 — 옆으로 지나가는 벽이 화면 가장자리까지 이어지게
  const o=[]; for(let i=0;i<g.length;i++){const p=g[i],q=g[(i+1)%g.length]; const L=Math.hypot((q.lat-p.lat)*111320,(q.lon-p.lon)*88300), n=Math.max(1,Math.ceil(L/step));
    for(let k=0;k<n;k++) o.push({lat:p.lat+(q.lat-p.lat)*k/n,lon:p.lon+(q.lon-p.lon)*k/n});} return o; }
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
    b.bb=[minx-1,maxx+1,miny-1,maxy+1]; shapes.set(b.key,b);
  }
  const data=og.getImageData(0,0,w,h).data; const cnt=new Map(), sx=new Map(), top=new Map();
  for(let y=0;y<h;y+=1)for(let x=0;x<w;x+=1){const i=(y*w+x)*4; if(data[i+3]<250) continue; const k=data[i]|(data[i+1]<<8)|(data[i+2]<<16); const b=shapes.get(k); if(!b) continue;
    if(x<b.bb[0]||x>b.bb[1]||y<b.bb[2]||y>b.bb[3]) continue;   // v3.6 경계 섞임 색 = 엉뚱한 건물 번호 → 제 윤곽 밖이면 버린다
    cnt.set(k,(cnt.get(k)||0)+1); (sx.get(k)||sx.set(k,[]).get(k)).push(x); if(!top.has(k)||y<top.get(k)) top.set(k,y);}
  const vis=[...cnt.entries()].filter(([k,n])=>n>=6).sort((a,b)=>b[1]-a[1]);
  // v3.5 간단 모드 — 같은 단지는 한 이름표, 기본 5개(고층·가운데 우선)·나머지는 점(톡 누르면 이름)
  const cand=new Map();
  for(const [k,n] of vis){
    const b=shapes.get(k); if(b.d<40) continue;
    const name=labelOf(b); if(!name) continue;
    const grp=name.replace(/\s*(\d+|[A-Z])동?$/,'')||name;   // «서울숲한신더휴 101동»·«아크로서울포레스트 B» → 단지 이름
    const c=cand.get(grp); if(c){ c.n++; c.area=Math.max(c.area,n); c.h=Math.max(c.h,b.h); continue; }
    const xs=sx.get(k).sort((a,b)=>a-b); const x=xs[xs.length>>1]/sc, y=top.get(k)/sc+6;
    const lv=parseInt(b.t['building:levels']);
    cand.set(grp,{grp,name,x,y,area:n,n:1,h:b.h,d:b.d,lv});
  }
  const cx=VIEW.W/2;
  const C=[...cand.values()].map(c=>{
    const center=1+1.5*Math.max(0,1-Math.abs(c.x-cx)/cx);
    c.score=Math.log2(1+c.area)*(1+c.h/40)*(c.d<300?0.3:1)*center*(S.shown.has(c.grp)?1.3:1);   // 1.3 = 깜빡임 방지
    c.name=c.grp;   // v3.7.2 동 번호는 빼고 단지 이름만(«101동»은 눈으로 보면 된다)
    c.sub=`${(c.d/1000).toFixed(1)} km`+(c.n>1?` · ${c.n}개 동`:(c.lv?` · ${c.lv}층`:(c.h>=60?` · ${Math.round(c.h)} m`:'')));
    return c;}).sort((a,b)=>b.score-a.score);
  const cap=S.simple?5:S.maxLabels, popOn=S.pop&&S.pop.until>Date.now();
  // v3.7 끈끈한 선택 — 한 번 뜬 이름표는 보이는 동안 자리를 지킨다.
  //  · 잠깐 안 보여도 0.8초는 마지막 자리에 둔다  · 다 찼을 때 교체는 «2초 넘게 떠 있던 것 중 가장 약한 것»보다 2배 강할 때만
  const now=Date.now(); S.stick=S.stick||new Map();
  const byKey=new Map(C.map(c=>[c.grp,c])), chosen=[], grace=[];
  for(const [k,st] of S.stick){ const c=byKey.get(k);
    if(c){ st.seen=now; st.lab={x:c.x,y:c.y,name:c.name,sub:c.sub,peak:false,key:k}; chosen.push(c); }
    else if(now-st.seen<800) grace.push(st.lab); else S.stick.delete(k); }
  chosen.sort((a,b)=>b.score-a.score); chosen.splice(Math.max(0,cap-grace.length));
  for(const c of C){ if(chosen.includes(c)) continue;
    if(chosen.length+grace.length<cap||(popOn&&S.pop.key===c.grp)){ chosen.push(c); continue; }
    let wi=-1,ws=1e9; chosen.forEach((x,i)=>{const st=S.stick.get(x.grp); if(st&&now-st.t0>2000&&x.score<ws){ws=x.score;wi=i;}});
    if(wi>=0&&c.score>2*ws){ S.stick.delete(chosen[wi].grp); chosen[wi]=c; } }
  for(const c of chosen) if(!S.stick.has(c.grp)) S.stick.set(c.grp,{t0:now,seen:now,lab:null});
  const L=chosen.map(c=>({x:c.x,y:c.y,name:c.name,sub:c.sub,peak:false,key:c.grp})).concat(grace), dots=[];
  for(const c of C){ if(dots.length>=12) break; if(!chosen.includes(c)) dots.push({x:c.x,y:c.y,name:c.name,sub:c.sub,peak:false,key:c.grp}); }   // 점도 다음 12개까지만
  if(S.showPeaks){ const P=[], seen=new Set();
    for(const p of S.peaks){
      const q=project(B,p.az,elev(p.top-S.eye,p.d)); if(!q) continue; const [x,y]=q; if(x<0||x>VIEW.W||y<0||y>VIEW.H) continue;
      const ox=Math.floor(x*sc),oy=Math.floor(y*sc),i=(oy*w+ox)*4; if(data[i+3]>0) continue;
      P.push({x,y,name:p.name,sub:`${(p.d/1000).toFixed(1)} km · 해발 ${Math.round(p.top)} m`,peak:true,key:'⛰'+p.name,top:p.top});
    }
    P.sort((a,b)=>b.top-a.top); const PU=P.filter(p=>!seen.has(p.name)&&seen.add(p.name));   // 같은 이름 봉우리는 높은 쪽만
    PU.forEach((p,i)=>{ if(!S.simple||i<2) L.push(p); });   // 간단: 높은 산 2개
  }
  S.labels=L; S.dots=S.simple?dots:[]; S.shown=new Set(L.map(l=>l.key));
  // v3.6 골목: 바로 옆 벽이 화면 대부분이면 «가려 있음»을 알린다(이름표 0개가 고장으로 보이지 않게)
  let near=0; for(const [k,n] of cnt) if(shapes.get(k).d<40) near+=n;
  const blocked=!L.some(l=>!l.peak)&&near>0.35*w*h, hint='가까운 건물에 가려 있어요 — 트인 쪽을 비춰 보세요';
  if(blocked&&S.msg!==hint) status(hint); else if(!blocked&&S.msg===hint) status(`눈높이 해발 ${Math.round(S.eye)} m`);
}
function drawDots(g){
  for(const l of S.dots){ g.fillStyle=l.peak?'rgba(255,214,10,.7)':'rgba(255,255,255,.7)'; g.beginPath(); g.arc(l.x,l.y,3.5,0,7); g.fill();
    g.strokeStyle='rgba(0,0,0,.5)'; g.lineWidth=1; g.stroke(); }
}

/* ---------- 그리기 ---------- */
function drawLabels(g,L,scale=1){
  const boxes=[]; g.textBaseline='top'; S.lift=S.lift||new Map();
  for(const l of L){ g.globalAlpha=l.a==null?1:l.a;
    const f1=15*scale,f2=11*scale; g.font=`700 ${f1}px -apple-system,"Apple SD Gothic Neo",sans-serif`; const w1=g.measureText(l.name).width; g.font=`${f2}px -apple-system,sans-serif`; const w2=g.measureText(l.sub).width;
    const bw=Math.max(w1,w2)+16*scale, bh=f1+f2+14*scale; let bx,by,ok=false;
    const free=()=>boxes.every(q=>bx+bw<q[0]||bx>q[2]||by+bh<q[1]||by>q[3]), prev=S.lift.get(l.key);
    if(prev!=null){ bx=l.x-bw/2; by=l.y-prev*scale-bh; ok=by>=4&&free(); }   // v3.7 지난번 높이를 먼저 — 이름표가 위아래로 튀지 않게
    if(!ok) for(let lift=26*scale;lift<480*scale;lift+=18*scale){bx=l.x-bw/2;by=l.y-lift-bh; if(by<4) break; if(free()){ok=true;break;}}
    if(!ok&&prev!=null){ bx=l.x-bw/2; by=Math.max(4,l.y-prev*scale-bh); ok=true; }   // 자리가 없어도 숨기지 않는다(겹침 허용)
    if(!ok) continue; boxes.push([bx,by,bx+bw,by+bh]); if(scale===1) S.lift.set(l.key,(l.y-by-bh));
    g.strokeStyle='rgba(255,255,255,.85)'; g.lineWidth=2*scale; g.beginPath(); g.moveTo(l.x,l.y); g.lineTo(l.x,by+bh); g.stroke();
    g.fillStyle=l.peak?'#ffd60a':'#fff'; g.beginPath(); g.arc(l.x,l.y,4*scale,0,7); g.fill();
    g.fillStyle='rgba(0,0,0,.6)'; g.beginPath(); g.roundRect(bx,by,bw,bh,9*scale); g.fill();
    g.fillStyle=l.peak?'#ffd60a':'#fff'; g.font=`700 ${f1}px -apple-system,"Apple SD Gothic Neo",sans-serif`; g.fillText(l.name,bx+8*scale,by+5*scale);
    g.fillStyle='#ddd'; g.font=`${f2}px -apple-system,sans-serif`; g.fillText(l.sub,bx+8*scale,by+9*scale+f1);
  }
  g.globalAlpha=1;
}
// v3.7 화면 이름표 = 목표 위치로 부드럽게 따라가고(30%/프레임), 새로 뜨면 서서히 나타나고, 빠지면 서서히 사라진다
const DISP=new Map();
function frame(){
  const g=$('overlay').getContext('2d'); g.clearRect(0,0,VIEW.W,VIEW.H); drawDots(g);
  const live=new Set();
  for(const l of S.labels){ live.add(l.key); let d=DISP.get(l.key);
    if(!d){ d={...l,a:0}; DISP.set(l.key,d); }
    d.x+=(l.x-d.x)*0.3; d.y+=(l.y-d.y)*0.3; d.name=l.name; d.sub=l.sub; d.peak=l.peak; d.a=Math.min(1,d.a+0.12); }
  for(const [k,d] of DISP) if(!live.has(k)){ d.a-=0.08; if(d.a<=0){ DISP.delete(k); S.lift&&S.lift.delete(k); } }
  drawLabels(g,[...DISP.values()].sort((a,b)=>b.a-a.a));
  requestAnimationFrame(frame);
}

/* ---------- 센서 ---------- */
function status(s){S.msg=s; drawStatus();}
function drawStatus(){
  const gps=S.lat==null?'📍✗':`📍±${Math.round(S.acc)}m`;
  const cb=camBasis()||{v:[0,1,0]}; const ori=S.beta==null?'🧭✗':`🧭${Math.round(headingOf(cb.v))}° ↕${Math.round(Math.asin(Math.max(-1,Math.min(1,cb.v[2])))/D2R)}°`;   // ↕ = 위로 든 각도(v3.6)
  const data=S.blds.length?`🏢${S.blds.length}`:(S.loading?'🏢…':'🏢✗');
  const kk=geocoder?'K✓':'K…';
  $('status').textContent=`${gps} ${ori} ${data} ${kk} 🏷${S.labels.length}`+(S.msg?` · ${S.msg}`:'');
}
setInterval(()=>{ if(!$('hud').hidden) drawStatus(); },500);
function onOri(e){
  if(e.alpha==null) return;
  // v3.7 센서 평활 — 손떨림이 그대로 이름표 위치·선택으로 번지지 않게(약 0.2초 지수평균)
  const k=0.25, ang=(o,n)=>o==null?n:((o+k*(((n-o+540)%360)-180))+360)%360, lin=(o,n)=>o==null?n:o+k*(n-o);
  S.alpha=ang(S.alpha,e.alpha); S.beta=lin(S.beta,e.beta); S.gamma=lin(S.gamma,e.gamma);
  if(typeof e.webkitCompassHeading==='number'){ // iOS: 나침반으로 alpha 기준을 맞춘다(자북→진북)
    // iOS 나침반은 세로 기준 «기기 위쪽» 방향이다 — 가로로 들면 카메라와 90° 어긋나므로 화면 회전각을 더한다(v3.4)
    const want=(e.webkitCompassHeading+scrAngle()+DECL+720)%360, raw=rawHeading();
    const off=-(((want-raw+540)%360)-180);      // 시계 방향 차이 → alpha 감소
    S.alphaOff = S.alphaOff==null?off:S.alphaOff+0.05*(((off-S.alphaOff+540)%360)-180);
  } else if(e.absolute){ S.alphaOff=0; }
}
function err(msg){const e=$('err'); e.innerHTML=msg; e.hidden=false;}
const INAPP=/KAKAOTALK|NAVER|Instagram|FBAN|FBAV|Line\/|DaumApps|GSA\//i.test(navigator.userAgent);
async function start(){
  S.floor=+$('floor').value||1; $('floor2').value=S.floor;
  if(!window.isSecureContext||!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    err('이 화면에서는 카메라를 쓸 수 없어요.<br><b>사파리(또는 크롬)</b>에서 열어 주세요.<br>https://taehunha-gmail.github.io/whatsthat/'); return; }
  // 동작 센서 권한(iOS)은 탭 직후에 바로 요청 — 카메라보다 먼저 띄워야 창이 뜬다
  let oriP=null; try{ if(window.DeviceOrientationEvent&&DeviceOrientationEvent.requestPermission) oriP=DeviceOrientationEvent.requestPermission(); }catch(e){ S.oriErr=e.name||'err'; }
  try{
    const st=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false});
    const v=$('cam'); v.srcObject=st; v.setAttribute('playsinline',''); v.muted=true; await v.play().catch(()=>{});
  }catch(e){ err('카메라를 켤 수 없어요: '+(e.name||'')+' '+(e.message||'')+(INAPP?'<br>카카오톡·네이버 앱 안의 브라우저에서는 막힐 수 있어요. <b>사파리로 열기</b>를 눌러 주세요.':'<br>설정 → 사파리 → 카메라 → 허용을 확인해 주세요.')); return; }
  try{ if(oriP){ const r=await oriP; S.oriPerm=r; } }catch(e){ S.oriPerm='error'; }
  setTimeout(()=>{ if(S.beta==null) $('sensor').hidden=false; },1500);
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
  g.font=`${10*k}px sans-serif`; g.textAlign='left'; g.fillStyle='rgba(255,255,255,.6)'; g.fillText($('status').textContent.slice(0,90),10*k,c.height-12*k);
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
$('go').onclick=start;
$('sensor').onclick=async()=>{ try{ const r=await DeviceOrientationEvent.requestPermission(); S.oriPerm=r; if(r==='granted'){ $('sensor').hidden=true; return; } }catch(e){ S.oriPerm='error'; }
  S.manual=true; $('sensor').hidden=true; status('센서 없이: 🧭에서 방향을 맞추세요'); }; $('shot').onclick=shot; $('calib').onclick=openCalib;
$('calibDone').onclick=()=>{$('calibPanel').hidden=true;$('cross').hidden=true;};
$('hdg').value=S.userOff; $('hdgV').textContent=S.userOff+'°'; $('hdg').oninput=e=>{S.userOff=+e.target.value;$('hdgV').textContent=S.userOff+'°';localStorage.hdgOff=S.userOff;};
$('fov').value=S.fov; $('fovV').textContent=S.fov+'°'; $('fov').oninput=e=>{S.fov=+e.target.value;$('fovV').textContent=S.fov+'°';localStorage.fov2=S.fov;updateView();};
$('settings').onclick=()=>{$('setPanel').hidden=false;$('calibPanel').hidden=true;$('cross').hidden=true;};
$('setDone').onclick=()=>{$('setPanel').hidden=true;};
$('floor2').onchange=e=>{S.floor=+e.target.value||1; S.eye=S.ground+(S.floor-1)*2.8+1.5;};
$('showPeaks').onchange=e=>{S.showPeaks=e.target.checked;};
$('maxLabels').value=S.maxLabels; $('maxV').textContent=S.maxLabels; $('maxLabels').oninput=e=>{S.maxLabels=+e.target.value;$('maxV').textContent=S.maxLabels;localStorage.maxLabels=S.maxLabels;};
function modeBtn(){ $('mode').textContent=S.simple?'간단':'전부'; }
$('mode').onclick=()=>{ S.simple=!S.simple; localStorage.simple=S.simple?'1':'0'; modeBtn(); status(S.simple?'이름표 간단 — 점을 누르면 이름':`이름표 전부(최대 ${S.maxLabels}개)`); compute(); };
modeBtn();
// 점 톡 → 4초간 그 이름표를 띄운다
document.addEventListener('click',e=>{
  if($('hud').hidden||e.target.closest('button,input,label,#setPanel,#calibPanel')) return;
  let best=null,bd2=44*44; for(const l of S.dots){const d2=(l.x-e.clientX)**2+(l.y-e.clientY)**2; if(d2<bd2){bd2=d2;best=l;}}
  if(best){ S.pop={key:best.key,until:Date.now()+4000}; compute(); }
});
$('reload').onclick=()=>{S.loadedAt=null; if(S.lat) loadArea(); $('setPanel').hidden=true;};

/* ---------- v3.7 «찍고 확인»(B) 자리 — AI 판정은 앱 밖(하박사님 개인 중계 주소)이 한다 ----------
   설정 ⚙︎ 의 «AI 확인 주소»를 채우면 🔍 버튼이 나타난다. 비워 두면 아무것도 밖으로 나가지 않는다.
   보내는 것(JSON): {image:'data:image/jpeg;base64,…', w, h, heading, pitch, fov, lat, lon,
                     candidates:[{key,name,x,y,d,h}]}   ← 지도로 뽑은 «화면 안 후보» 최대 20개, x·y는 사진 픽셀
   받는 것(JSON):  {labels:[{key|name, x?, y?, conf?}]} ← 사진에 실제로 보이는 것만. x·y 없으면 후보 위치를 쓴다
   자세한 약속·프롬프트 = AI_HANDOFF.md */
function aiOn(){ $('ai').hidden=!localStorage.aiUrl; $('privacy').textContent=localStorage.aiUrl?'🔍를 누를 때만 사진을 AI로 보냅니다.':'사진은 폰 밖으로 나가지 않습니다.';   // v3.7.4
  $('aiUrl').value=localStorage.aiUrl||''; $('aiToken').value=localStorage.aiToken||''; }
$('aiToken').onchange=e=>{ const v=e.target.value.trim(); if(v) localStorage.aiToken=v; else localStorage.removeItem('aiToken'); };
$('aiUrl').onchange=e=>{ const v=e.target.value.trim(); if(v) localStorage.aiUrl=v; else localStorage.removeItem('aiUrl'); aiOn(); };
aiOn();
async function aiCheck(){
  const url=localStorage.aiUrl; if(!url) return;
  const v=$('cam'), W=VIEW.W, H=VIEW.H, k=Math.min(1024/Math.max(W,H),2);
  const c=document.createElement('canvas'); c.width=Math.round(W*k); c.height=Math.round(H*k); const g=c.getContext('2d');
  const s=Math.max(c.width/v.videoWidth,c.height/v.videoHeight), dw=v.videoWidth*s, dh=v.videoHeight*s;
  g.drawImage(v,(c.width-dw)/2,(c.height-dh)/2,dw,dh);
  const B=camBasis()||{v:[0,1,0]};
  const cands=[...S.labels.filter(l=>!l.peak),...S.dots].slice(0,20).map(l=>({key:l.key,name:l.name,x:Math.round(l.x*k),y:Math.round(l.y*k),sub:l.sub}));
  const body={image:c.toDataURL('image/jpeg',0.85),w:c.width,h:c.height,heading:Math.round(headingOf(B.v)),
    pitch:Math.round(Math.asin(Math.max(-1,Math.min(1,B.v[2])))/D2R),fov:S.fov,lat:S.lat,lon:S.lon,candidates:cands};
  status('🔍 AI에게 묻는 중…');
  let res; try{ const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-App-Token':localStorage.aiToken||''},body:JSON.stringify(body)}); res=await r.json().catch(()=>({})); if(!r.ok) throw new Error(r.status+(res.error?' '+res.error:'')); }   // v3.7.4 401·413 도 이유를 보이게
  catch(e){ status('🔍 AI 확인 실패 — '+e.message); return; }
  if(res&&res.error&&!(res.labels||[]).length){ status('🔍 AI 오류 — '+String(res.error).slice(0,80)); return; }   // v3.7.3 Worker 가 알려 준 원인을 그대로 보여 준다
  const byKey=new Map(cands.map(x=>[x.key,x])), byName=new Map(cands.map(x=>[x.name,x]));
  const L=(res.labels||[]).map(r=>{ const cd=byKey.get(r.key)||byName.get(r.name)||{}; const x=(r.x??cd.x), y=(r.y??cd.y);
    return x==null?null:{x:x/k,y:y/k,name:r.name||cd.name,sub:(cd.sub||'')+(r.conf!=null?` · ${Math.round(r.conf*100)}%`:''),key:'ai'+(r.key||r.name),peak:false}; }).filter(Boolean);
  // 멈춘 사진 위에 이름표 — 톡 하면 닫힘
  const view=document.createElement('canvas'), dpr=devicePixelRatio||1; view.width=W*dpr; view.height=H*dpr;
  Object.assign(view.style,{position:'fixed',inset:'0',width:W+'px',height:H+'px',zIndex:50,background:'#000'});
  const vg=view.getContext('2d'); vg.setTransform(dpr,0,0,dpr,0,0); vg.drawImage(c,0,0,W,H); drawLabels(vg,L);
  vg.font='600 13px sans-serif'; vg.fillStyle='rgba(255,255,255,.85)'; vg.fillText(`🔍 AI 확인 ${L.length}개 · 톡 하면 닫기`,12,H-16);
  view.onclick=()=>view.remove(); document.body.appendChild(view); status(`🔍 AI 확인 ${L.length}개`);
}
$('ai').onclick=aiCheck;
