'use strict';
/* 저게뭐야? v3.13 — 실시간 카메라에 보이는 건물·산 이름표
   데이터: OpenStreetMap(수도권은 정적 타일 data/, 밖은 Overpass) · 국토교통부 GIS건물통합정보(서울 층수·높이, v3.8) · AWS terrain tiles · 카카오 지도 SDK(건물명) */
const VER='3.13';
const KAKAO_JS='a4bfdb25e1f0c9bf07c07032b4457773';
const DECL=-8.8;               // 서울 자편각(°, 서쪽) — iOS 나침반은 자북 기준
const $=id=>document.getElementById(id);
const S={lat:null,lon:null,acc:null,ground:0,eye:0,floor:1,blds:[],peaks:[],areas:[],
  M:null,alphaOff:null,cmpOff:null,cmpAcc:null,hold:false,userOff:+(localStorage.hdgOff||0),
  fov:+(localStorage.fov2||67),maxLabels:+(localStorage.maxLabels||14),showPeaks:true,loading:false,loadedAt:null,labels:[],dots:[],shown:new Set(),pop:null,simple:localStorage.simple!=='0',names:new Map()};

/* ---------- 기하 ---------- */
const R=6371000, D2R=Math.PI/180;
function bd(lat0,lon0,lat,lon){const y=(lat-lat0)*111320,x=(lon-lon0)*111320*Math.cos(lat0*D2R);return [((Math.atan2(x,y)/D2R)+360)%360,Math.hypot(x,y)];}
function elev(dh,d){return Math.atan2(dh-d*d*(1-0.13)/(2*R),d)/D2R;}
const wrap=x=>((x%360)+540)%360-180;   // 각도 차이를 −180~180°로
function eulerM(al,be,ga){ // deviceorientation(α·β·γ) → 기기 오른쪽·위·카메라 앞 벡터 9칸(세계: x동 y북 z위, 방위 기준은 아직 임의)
  const A=al*D2R,B=be*D2R,G=ga*D2R,cA=Math.cos(A),sA=Math.sin(A),cB=Math.cos(B),sB=Math.sin(B),cG=Math.cos(G),sG=Math.sin(G);
  return [cA*cG-sA*sB*sG, sA*cG+cA*sB*sG, -cB*sG,  -sA*cB, cA*cB, sB,  -(cA*sG+sA*sB*cG), -(sA*sG-cA*sB*cG), -cB*cG];
}
function ortho(M){ // 평활로 살짝 틀어진 세 축을 다시 직각·길이 1로
  const n=i=>{const l=Math.hypot(M[i],M[i+1],M[i+2])||1; M[i]/=l; M[i+1]/=l; M[i+2]/=l;};
  n(6); const d=M[0]*M[6]+M[1]*M[7]+M[2]*M[8]; M[0]-=d*M[6]; M[1]-=d*M[7]; M[2]-=d*M[8]; n(0);
  M[3]=M[1]*M[8]-M[2]*M[7]; M[4]=M[2]*M[6]-M[0]*M[8]; M[5]=M[0]*M[7]-M[1]*M[6];   // 위 = 오른쪽 × 앞
}
function camBasis(){ // 기기 자세(S.M) → 카메라 앞·화면 오른쪽·화면 위 벡터(세계: x동 y북 z위)
  if(!S.M){ if(!S.manual) return null; const h=((S.userOff%360)+360)%360*D2R; // 센서 없음: 수평으로 든 폰, 방향 = 보정값
    return {v:[Math.sin(h),Math.cos(h),0], r:[Math.cos(h),-Math.sin(h),0], u:[0,0,1]}; }
  const t=((S.alphaOff||0)-S.userOff)*D2R, c0=Math.cos(t), s0=Math.sin(t), M=S.M;   // 방위 맞춤: 수직축으로 돌린다(시계 방향 보정 = 반시계 회전 감소)
  const z=i=>[M[i]*c0-M[i+1]*s0, M[i]*s0+M[i+1]*c0, M[i+2]], r=z(0), u=z(3), v=z(6);
  const th=scrAngle()*D2R; if(!th) return {r,u,v};   // 가로로 들면 화면 오른쪽·위가 기기 축과 90° 돈다
  const c=Math.cos(th),s=Math.sin(th);
  return {r:r.map((x,i)=>x*c-u[i]*s), u:r.map((x,i)=>x*s+u[i]*c), v};
}
function scrAngle(){const a=(screen.orientation&&typeof screen.orientation.angle==='number')?screen.orientation.angle:(+window.orientation||0);return ((a%360)+360)%360;}
function headingOf(v){return ((Math.atan2(v[0],v[1])/D2R)+360)%360;}
function rawHeading(){ return headingOf([S.M[6],S.M[7]]); }   // 방위 맞춤(alphaOff) 전의 카메라 방향
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
  for(const [n,lv,h,apt,p] of tall){ const dd=bd(lat,lon,p[0][0],p[0][1])[1]; if(dd>9000||dd<600||(n&&dd<1500)) continue;   // v3.8 가까운 건 t/ 타일에 이미 있다(겹침 방지)
  const g=p.map(([la,lo])=>({lat:la,lon:lo})); els.push({type:'way',id:kid(g),tags:tg(n,lv,h,apt),geometry:g});}
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
const NAMEFIX={'더서울라이티움':'갤러리아 포레'};   // 지도(OSM) 이름이 틀린 곳 — 라이티움은 갤러리아 포레 지하 전시장인데 45층 건물 이름으로 올라 있다
function labelOf(b){
  let n=(b.t.name||'').trim(); n=NAMEFIX[n]||n;
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
  const vis=[...cnt.entries()].filter(([k,n])=>n>=3).sort((a,b)=>b[1]-a[1]);   // 새로 뜨려면 6칸, 떠 있던 것은 3칸까지 봐준다(아래) — 멀고 가는 탑(롯데타워)이 손떨림에 깜빡이지 않게(v3.10)
  // v3.5 간단 모드 — 같은 단지는 한 이름표, 기본 5개(고층·가운데 우선)·나머지는 점(톡 누르면 이름)
  const cand=new Map();
  for(const [k,n] of vis){
    const b=shapes.get(k); if(b.d<40) continue;
    const name=labelOf(b); if(!name) continue;
    const grp=name.replace(/\s*(\d+|[A-Z])동?$/,'')||name;   // «서울숲한신더휴 101동»·«아크로서울포레스트 B» → 단지 이름
    if(n<6&&!S.shown.has(grp)) continue;
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
  // v3.10 한 덩어리로 보이는 것은 이름표 하나 — 화면에서 28 px 안에 붙어 있고 거리도 비슷하면(±25%) 센 쪽만 남기고 나머지는 점으로.
  //  (11-15 사진: 갤러리아 포레 한 단지에 «한화 갤러리아 포레스트 타워»·«더서울라이티움» 이름표가 겹쳐 쌓였다.) 이미 떠 있던 것은 16 px 까지 봐준다(깜빡임 방지)
  const DUP=[]; { const keep=[], pass=(sh,lim)=>{ for(const c of C){ if(S.shown.has(c.grp)!==sh) continue;
        if(keep.some(k=>Math.abs(k.x-c.x)<lim&&Math.abs(k.d-c.d)<0.25*Math.max(k.d,c.d))) DUP.push(c); else keep.push(c); } };
    pass(true,16); pass(false,28);                 // 떠 있던 것이 먼저 자리를 지키고, 새로 뜨려는 것은 28 px 떨어져야 한다
    C.length=0; C.push(...keep.sort((a,b)=>b.score-a.score)); }
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
  for(const c of chosen) if(!S.stick.has(c.grp)) S.stick.set(c.grp,{t0:now,seen:now,lab:{x:c.x,y:c.y,name:c.name,sub:c.sub,peak:false,key:c.grp}});   // v3.10 lab 을 비워 두면 바로 다음 계산에서 빠질 때 null 이 이름표 목록에 섞여 계산이 멈췄다
  const L=chosen.map(c=>({x:c.x,y:c.y,name:c.name,sub:c.sub,peak:false,key:c.grp})).concat(grace.filter(Boolean)), dots=[];
  for(const c of DUP){ if(popOn&&S.pop.key===c.grp&&!L.some(l=>l.key===c.grp)) L.push({x:c.x,y:c.y,name:c.name,sub:c.sub,peak:false,key:c.grp}); }   // 겹쳐서 점이 된 것도 톡 하면 이름이 뜬다
  for(const c of C.concat(DUP)){ if(dots.length>=12) break; if(!L.some(l=>l.key===c.grp)) dots.push({x:c.x,y:c.y,name:c.name,sub:c.sub,peak:false,key:c.grp}); }   // 점도 다음 12개까지만
  if(S.showPeaks){ const P=[], seen=new Set();
    for(const p of S.peaks){
      const q=project(B,p.az,elev(p.top-S.eye,p.d)); if(!q) continue; const [x,y]=q; if(x<0||x>VIEW.W||y<0||y>VIEW.H) continue;
      const ox=Math.floor(x*sc),oy=Math.floor(y*sc),i=(oy*w+ox)*4, pk='⛰'+p.name; S.pkT=S.pkT||new Map();
      if(data[i+3]>0){ if(!(now-(S.pkT.get(pk)||0)<1500)) continue; } else S.pkT.set(pk,now);   // v3.10 건물 모서리에 걸린 봉우리가 깜빡이지 않게 — 가려져도 1.5초는 둔다
      P.push({x,y,name:p.name,sub:`${(p.d/1000).toFixed(1)} km · 해발 ${Math.round(p.top)} m`,peak:true,key:'⛰'+p.name,top:p.top});
    }
    P.sort((a,b)=>b.top-a.top); const PU0=P.filter(p=>!seen.has(p.name)&&seen.add(p.name)), PU=[];   // 같은 이름 봉우리는 높은 쪽만
    const sh=p=>S.shown.has(p.key)?1:0;
    for(const p of [...PU0].sort((a,b)=>sh(b)-sh(a))){ const lim=sh(p)?20:34, j=PU.findIndex(q=>Math.abs(q.x-p.x)<lim&&Math.abs(q.y-p.y)<lim);   // v3.10 같은 산의 두 이름(청계산·망경대)은 하나만 — «…산»을 먼저. 떠 있던 것이 자리를 지킨다(깜빡임 방지)
      if(j<0) PU.push(p); else if(/산$/.test(p.name)&&!/산$/.test(PU[j].name)) PU[j]=p; }
    PU.sort((a,b)=>b.top-a.top);
    PU.forEach((p,i)=>{ if(!S.simple||i<2) L.push(p); });   // 간단: 높은 산 2개
  }
  S.labels=L; S.dots=S.simple?dots:[]; S.shown=new Set(L.map(l=>l.key));
  if(!S.hinted&&L.some(l=>!l.peak)){ S.hinted=1; if(!S.hold&&!autoOn()) status('이름표가 건물과 어긋나 있으면 화면을 좌우로 끌어 맞추세요'); }   // v3.10 처음 한 번 알려 준다(자동 맞춤이 켜져 있으면 그쪽이 알린다)
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
// v3.10 자리 잡기 — 상자를 점 바로 위 가운데뿐 아니라 왼쪽·오른쪽으로도 비켜 놓는다(선은 늘 점에서 곧게 위로).
//  예전에는 가운데만 써서 건물 서넛이 모이면 이름표가 탑처럼 쌓이고, 선이 남의 글씨를 가로지르고, 화면 가장자리에서 잘렸다(11-15 사진)
function drawLabels(g,L,scale=1,avoid=[]){
  g.textBaseline='top'; S.lift=S.lift||new Map();
  const W=VIEW.W, H=VIEW.H, boxes=avoid.map(r=>[r[0],r[1],r[2],r[3],-1]), dots=[], lines=[], P=[];   // boxes = 이미 놓인 상자·단추(절대 안 겹침) · dots = 남의 점 · lines = 남의 선(되도록 안 겹침)
  L.forEach((l,i)=>dots.push([l.x-6*scale,l.y-6*scale,l.x+6*scale,l.y+6*scale,i]));
  const over=(Q,x0,y0,x1,y1,me,m=2)=>Q.some(q=>q[4]!==me&&!(x1+m<q[0]||x0-m>q[2]||y1+m<q[1]||y0-m>q[3]));   // m = 띄울 틈(px). 음수면 그만큼 겹쳐도 봐준다
  const ups=[],downs=[]; for(let v=26;v<480;v+=18) ups.push(v); for(let v=26;v<420;v+=18) downs.push(-v);
  L.forEach((l,i)=>{
    const f1=15*scale,f2=11*scale; g.font=`700 ${f1}px -apple-system,"Apple SD Gothic Neo",sans-serif`; const w1=g.measureText(l.name).width; g.font=`${f2}px -apple-system,sans-serif`; const w2=g.measureText(l.sub).width;
    const bw=Math.max(w1,w2)+16*scale, bh=f1+f2+14*scale, s=Math.max(0,bw/2-14*scale);   // s = 옆으로 비킬 때 상자가 움직이는 거리(선이 상자 끝에서 14 px 안쪽에 닿는다)
    let nl=1e9,nr=1e9; for(const o of L){ if(o===l||Math.abs(o.y-l.y)>140*scale) continue; const d=o.x-l.x; if(d>=0) nr=Math.min(nr,d); else nl=Math.min(nl,-d); }
    const near=bw*0.7, sides=nr<near&&nl>=near?[-1,0,1]:nl<near&&nr>=near?[1,0,-1]:[0,-1,1];   // 옆 이름표가 붙어 있는 쪽의 반대편으로 먼저 비킨다
    const yOf=lift=>lift>0?l.y-lift*scale-bh:l.y-lift*scale;      // lift>0 = 점 위로, lift<0 = 점 아래로(건물 꼭대기가 화면 위로 나가 위에 자리가 없을 때)
    // 까다롭기 2 = 남의 점·선을 덮지 않고 내 선도 남의 상자를 지나지 않음 · 1 = 남의 점·선은 덮지 않음(내 선은 남의 상자 뒤로 지나도 됨) · 0 = 상자끼리만 안 겹침
    const fit=(lift,sg,lv,m=2)=>{ const by=yOf(lift), e=m<0?0:4; if(by<e||by+bh>H-e) return null;
      const bx=Math.max(2,Math.min(W-bw-2,l.x-bw/2+sg*s)); if(l.x<bx+8*scale||l.x>bx+bw-8*scale) return null;   // 화면 안으로 당기되, 선은 상자 변 안에 닿아야 한다
      if(over(boxes,bx,by,bx+bw,by+bh,i,m)) return null;
      if(lv>=1&&(over(dots,bx,by,bx+bw,by+bh,i)||over(lines,bx,by,bx+bw,by+bh,i))) return null;
      if(lv>=2){ const y0=lift>0?by+bh+3:l.y+9*scale, y1=lift>0?l.y-9*scale:by-3; if(y1>y0&&over(boxes,l.x-1,y0,l.x+1,y1,i)) return null; }
      return [bx,by]; };
    const prev=S.lift.get(l.key); let pos=null, ch=null;
    if(prev){ pos=fit(prev[0],prev[1],0,-6); if(pos) ch=prev; }                         // v3.7 지난번 자리를 먼저 — 이름표가 튀지 않게(6 px 까지 겹쳐도 그대로 둔다)
    for(const [lv,list] of [[2,ups],[1,ups],[2,downs],[0,ups],[0,downs]]){ if(pos) break;  // 위쪽 깔끔한 자리 → 위쪽(선이 남의 상자 뒤로 지나도 됨) → 아래쪽 → 그래도 없으면 점을 덮더라도
      for(const lift of list){ for(const sg of sides){ pos=fit(lift,sg,lv); if(pos){ ch=[lift,sg]; break; } } if(pos) break; } }
    if(!pos&&prev){ ch=prev; pos=[Math.max(2,Math.min(W-bw-2,l.x-bw/2+prev[1]*s)),Math.max(4,yOf(prev[0]))]; }   // 자리가 없어도 떠 있던 것은 숨기지 않는다(겹침 허용)
    if(!pos) return; boxes.push([pos[0],pos[1],pos[0]+bw,pos[1]+bh,i]); lines.push([l.x-1,Math.min(l.y,pos[1]),l.x+1,Math.max(l.y,pos[1]+bh),i]); if(scale===1) S.lift.set(l.key,ch);
    P.push({l,bx:pos[0],by:pos[1],bw,bh,f1,f2});
  });
  for(const {l,by,bh} of P){ g.globalAlpha=l.a==null?1:l.a;      // 선·점을 먼저 다 그리고
    g.strokeStyle='rgba(255,255,255,.85)'; g.lineWidth=2*scale; g.beginPath(); g.moveTo(l.x,l.y); g.lineTo(l.x,by+bh<l.y?by+bh:by); g.stroke();
    g.fillStyle=l.peak?'#ffd60a':'#fff'; g.beginPath(); g.arc(l.x,l.y,4*scale,0,7); g.fill(); }
  for(const {l,bx,by,bw,bh,f1,f2} of P){ g.globalAlpha=l.a==null?1:l.a;   // 상자·글씨는 그 위에 — 남의 선이 글씨를 가로지르지 않는다
    g.fillStyle='rgba(0,0,0,.6)'; g.beginPath(); g.roundRect(bx,by,bw,bh,9*scale); g.fill();
    g.fillStyle=l.peak?'#ffd60a':'#fff'; g.font=`700 ${f1}px -apple-system,"Apple SD Gothic Neo",sans-serif`; g.fillText(l.name,bx+8*scale,by+5*scale);
    g.fillStyle='#ddd'; g.font=`${f2}px -apple-system,sans-serif`; g.fillText(l.sub,bx+8*scale,by+9*scale+f1); }
  g.globalAlpha=1;
}
// v3.7 화면 이름표 = 목표 위치로 부드럽게 따라가고(30%/프레임), 새로 뜨면 서서히 나타나고, 빠지면 서서히 사라진다
const DISP=new Map();
function frame(){
  try{ frame1(); }catch(e){ if(!S.frameErr){ S.frameErr=1; status('그리기 오류 — '+String(e.message||e).slice(0,60)); } }   // v3.7.5 한 번 틀려도 그리기를 멈추지 않는다
  requestAnimationFrame(frame);
}
function frame1(){
  { const v=$('cam'); if(v.videoWidth&&(v.videoWidth!==VIEW.vw||v.videoHeight!==VIEW.vh||innerWidth!==VIEW.W||innerHeight!==VIEW.H)) updateView(); }   // v3.8.1 가로·세로 영상 크기가 어긋난 채 남지 않게 매 프레임 확인
  const g=$('overlay').getContext('2d'); g.clearRect(0,0,VIEW.W,VIEW.H); drawDots(g);
  const live=new Set();
  for(const l of S.labels){ live.add(l.key); let d=DISP.get(l.key);
    if(!d){ d={...l,a:0}; DISP.set(l.key,d); }
    d.x+=(l.x-d.x)*0.3; d.y+=(l.y-d.y)*0.3; d.name=l.name; d.sub=l.sub; d.peak=l.peak; d.a=Math.min(1,d.a+0.12); }
  for(const [k,d] of DISP) if(!live.has(k)){ d.a-=0.08; if(d.a<=0){ DISP.delete(k); S.lift&&S.lift.delete(k); } }
  const now=performance.now(); if(!S.avoid||now-S.avoidT>400){ S.avoidT=now;   // 위쪽 알림 줄과 아래 단추는 피해서 놓는다(0.4초마다 자리 확인)
    S.avoid=[$('status'),...document.querySelectorAll('#bar button:not([hidden])')].map(el=>el.getBoundingClientRect()).filter(r=>r.width).map(r=>[r.left-4,r.top-4,r.right+4,r.bottom+4]); }
  drawLabels(g,[...DISP.values()].sort((a,b)=>b.a-a.a),1,S.avoid);
}

/* ---------- 센서 ---------- */
function status(s){S.msg=s; drawStatus();}
function drawStatus(){
  const gps=S.lat==null?'📍✗':`📍±${Math.round(S.acc)}m`;
  // 🧭 방향 ±나침반 스스로 매긴 오차 (보정값) 🔒붙드는 중 · ↕ 위로 든 각도 — 찰칵 사진만 보고도 원인을 가릴 수 있게(v3.10)
  const cb=camBasis()||{v:[0,1,0]}; const ori=!S.M?'🧭✗':`🧭${Math.round(headingOf(cb.v))}°`+(S.cmpAcc>0?`±${Math.round(S.cmpAcc)}`:'')+(Math.abs(S.userOff)>=0.5?`(${S.userOff>0?'+':'−'}${Math.abs(Math.round(S.userOff))})`:'')+(S.hold?'🔒':'')+` ↕${Math.round(Math.asin(Math.max(-1,Math.min(1,cb.v[2])))/D2R)}°`;
  const data=S.blds.length?`🏢${S.blds.length}`:(S.loading?'🏢…':'🏢✗');
  const kk=geocoder?'K✓':'K…';
  const diag=`${gps} ${ori} ${data} ${kk} 🏷${S.labels.length}`; S.stat=diag+(S.msg?` · ${S.msg}`:'');
  const el=$('status'); if(el.dataset.t!==S.stat){ el.dataset.t=S.stat; el.textContent=diag; if(S.msg){ const b=document.createElement('b'); b.textContent=S.msg; el.appendChild(b); } }   // 알림은 둘째 줄(세로 화면에서 잘리지 않게)
}
setInterval(()=>{ if(!$('hud').hidden) drawStatus(); },500);
const HOLD_TAU=120;   // 방향을 맞춘 뒤 나침반을 다시 따라가는 빠르기(초) — 자이로는 1분에 1~2°쯤 흐르므로 아주 놓지는 않는다
function onOri(e){
  if(e.alpha==null) return;
  const ios=typeof e.webkitCompassHeading==='number';
  if(e.absolute) S.absSeen=true; else if(S.absSeen&&!ios) return;   // 안드로이드: 절대·상대 두 이벤트가 같이 온다 → 절대만 쓴다
  const now=performance.now(), gap=S.oriT?(now-S.oriT)/1000:0; S.oriT=now;
  if(gap>2){ S.M=null; S.alphaOff=S.cmpOff=null; S.hold=false; S.ep=(S.ep||0)+1; }   // 센서가 끊겼다 다시 오면(앱 전환 등) 기준이 바뀌었을 수 있다 → 나침반부터 다시
  // v3.10 센서 평활은 «회전 행렬»에 건다 — 각도(α·β·γ)를 따로 평활하면 폰을 가로로 들고 지평선 위를 볼 때 β가 +180°↔−180°를 넘나들며
  //  그 사이 0.3초쯤 방향이 ±10°, 기울기가 십수 도 튄다(2026-11-15 모의 실험). 행렬은 그런 끊김이 없다. 세기는 예전과 같다(약 0.2초)
  const N=eulerM(e.alpha,e.beta,e.gamma), M=S.M;
  if(!M||N[6]*M[6]+N[7]*M[7]+N[8]*M[8]<0.9||N[0]*M[0]+N[1]*M[1]+N[2]*M[2]<0.9) S.M=N;   // 처음이거나 한 번에 25° 넘게 돌았으면 그대로 받는다
  else { for(let i=0;i<9;i++) M[i]+=0.25*(N[i]-M[i]); ortho(M); }
  if(ios){ // iOS: 나침반으로 방위 기준을 맞춘다(자북→진북)
    // iOS 나침반은 세로 기준 «기기 위쪽» 방향이다 — 가로로 들면 카메라와 90° 어긋나므로 화면 회전각을 더한다(v3.4)
    const want=(e.webkitCompassHeading+scrAngle()+DECL+720)%360, off=-wrap(want-rawHeading());   // 시계 방향 차이 → 반시계 회전 감소
    if(typeof e.webkitCompassAccuracy==='number') S.cmpAcc=e.webkitCompassAccuracy;
    S.cmpOff = S.cmpOff==null?off:S.cmpOff+0.05*wrap(off-S.cmpOff);            // 나침반이 말하는 값(바로 따라감)
    // v3.10 붙들기 — 방향을 한 번 맞춘 뒤(S.hold)에는 자이로(폰이 실제로 돈 만큼)를 믿고, 나침반은 2분에 걸쳐 천천히만 반영한다.
    //  실내·창가에서는 같은 자리·같은 방향인데도 나침반이 +6°·+9°·+20° 로 날마다 달랐다(11-07·08·15 사진)
    if(S.hold&&Math.abs(wrap(S.cmpOff-S.alphaOff))>40){ S.divT=S.divT||now; if(now-S.divT>3000){ S.hold=false; S.divT=0; } } else S.divT=0;   // 나침반과 40° 넘게 3초 벌어지면 자이로 기준이 바뀐 것 → 놓는다
    const g=S.hold?Math.min(0.05,gap/HOLD_TAU):0.05;
    S.alphaOff = S.alphaOff==null?off:S.alphaOff+g*wrap(off-S.alphaOff);
  } else if(e.absolute){ S.alphaOff=0; }
}
// v3.10 방향을 맞춘 직후(끌기·🔍·🧭)에 부른다 — 보정값을 «지금 나침반 기준»으로 다시 적어 저장하고(장소와 함께), 붙들기를 켠다
function logAdj(o){ (S.adj=S.adj||[]).push({t:Math.round(performance.now()/1000),...o}); if(S.adj.length>12) S.adj.shift(); }   // v3.13 누가(자동·AI·끌기·목록·막대) 얼마나 돌렸나 — 찰칵 진단 기록에 들어간다
function calibrated(src){
  if(src!=='auto'&&typeof AUTO!=='undefined'){ AUTO.refine=false; AUTO.done=true; }   // 손으로(끌기·🔍·🧭) 맞추면 자동 맞춤은 거기서 끝 — 손이 이긴다
  if(S.cmpOff!=null&&S.alphaOff!=null){ S.userOff+=wrap(S.cmpOff-S.alphaOff); S.alphaOff=S.cmpOff; }   // 화면은 그대로, 숫자만 옮겨 적는다
  S.userOff=wrap(S.userOff); S.hold=S.cmpOff!=null; S.away=false;
  localStorage.hdgOff=S.userOff; if(S.lat!=null) localStorage.hdgAt=S.lat.toFixed(5)+','+S.lon.toFixed(5);
  $('hdg').value=S.userOff; $('hdgV').textContent=S.userOff.toFixed(1)+'°';
}
document.addEventListener('visibilitychange',()=>{ if(!document.hidden){ S.M=null; S.alphaOff=S.cmpOff=null; S.hold=false; S.oriT=0; S.ep=(S.ep||0)+1; } });   // 다른 앱에 갔다 오면 자이로 기준이 바뀔 수 있다
function placeCheck(){ // v3.10 나침반 오차는 장소마다 다르다 → 보정한 곳에서 300 m 넘게 벗어나 있으면 보정을 쓰지 않고(0), 돌아오면 다시 쓴다
  const at=(localStorage.hdgAt||'').split(',').map(Number); if(at.length!==2||!isFinite(at[0])||!isFinite(at[1])||S.lat==null) return;
  const far=bd(at[0],at[1],S.lat,S.lon)[1]>300; if(far===!!S.away) return;
  S.away=far; S.hold=false; S.userOff=far?0:+(localStorage.hdgOff||0); logAdj({k:far?'away':'back',off:+S.userOff.toFixed(1)}); $('hdg').value=S.userOff; $('hdgV').textContent=S.userOff.toFixed(1)+'°';
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
  setTimeout(()=>{ if(!S.M) $('sensor').hidden=false; },1500);
  $('start').hidden=true; $('hud').hidden=false;
  addEventListener('deviceorientationabsolute',onOri,true); addEventListener('deviceorientation',onOri,true);
  $('cam').addEventListener('loadedmetadata',updateView); $('cam').addEventListener('resize',updateView); addEventListener('resize',updateView); updateView();   // v3.8.1 영상 크기가 바뀔 때도(폰을 돌린 뒤 늦게 바뀜)
  navigator.geolocation.watchPosition(p=>{
    S.lat=p.coords.latitude; S.lon=p.coords.longitude; S.acc=p.coords.accuracy;
    placeCheck();
    if(!S.loadedAt||bd(S.loadedAt[0],S.loadedAt[1],S.lat,S.lon)[1]>400) loadArea();
  },e=>status('위치 권한이 필요합니다'),{enableHighAccuracy:true,maximumAge:5000});
  initKakao(); setInterval(compute,180); setInterval(autoTick,500); frame(); if(localStorage.aiUrl) aiPing();   // v3.12 켤 때 암호·드라이브 저장 준비를 조용히 확인
}

/* ---------- 찰칵 ---------- */
async function shot(){
  if(S.shareNext>Date.now()&&S.lastShot){ S.shareNext=0; shareFile(S.lastShot); status('📤 저장 못 한 사진을 공유 창으로 보냅니다'); return; }   // v3.12 드라이브 저장이 실패한 직후의 📸 = 그 사진을 공유 창으로
  const meta=shotMeta(), v=$('cam'),W=VIEW.W,H=VIEW.H,k=Math.min(3,v.videoWidth/W*1.0||2);
  const c=document.createElement('canvas'); c.width=W*k; c.height=H*k; const g=c.getContext('2d');
  const s=Math.max(c.width/v.videoWidth,c.height/v.videoHeight), dw=v.videoWidth*s, dh=v.videoHeight*s;
  g.drawImage(v,(c.width-dw)/2,(c.height-dh)/2,dw,dh);
  g.save(); g.scale(k,k); drawLabels(g,S.labels); g.restore();
  g.font=`600 ${14*k}px sans-serif`; g.fillStyle='rgba(255,255,255,.8)'; g.textAlign='right'; g.fillText('저게뭐야?',c.width-12*k,c.height-12*k);
  g.font=`${10*k}px sans-serif`; g.textAlign='left'; g.fillStyle='rgba(255,255,255,.6)'; g.fillText(('v'+VER+' '+(S.stat||'')).slice(0,110),10*k,c.height-12*k);
  const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',0.9));
  const f=new File([blob],shotName(),{type:'image/jpeg'});
  if(driveOn()){ S.lastShot=f; saveDrive(blob,f.name,meta); return; }   // v3.12 드라이브 저장이 켜져 있으면 공유 창 없이 바로 올린다
  shareFile(f);
}
async function shareFile(f){   // 공유 창 — «이미지 저장»을 누르면 폰 사진첩에 들어간다(웹앱은 사진첩에 직접 못 넣는다: 애플 규칙)
  if(navigator.canShare&&navigator.canShare({files:[f]})){ try{await navigator.share({files:[f]});return;}catch(e){ if(e.name==='AbortError') return; } }   // v3.12.1 공유 창을 닫았으면 끝 — 예전엔 이어서 «다운로드» 창이 또 떴다
  const a=document.createElement('a'); a.href=URL.createObjectURL(f); a.download=f.name; a.click();
}
function shotName(){ const d=new Date(), p=n=>String(n).padStart(2,'0');   // 폰 시각(한국 시각)으로 — 예전엔 UTC 라 아침 7시 사진이 «22시»로 찍혔다
  return `저게뭐야_${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.jpg`; }

/* ---------- v3.12 찰칵 → 내 구글 드라이브 «저게뭐야 사진» 폴더 ----------
   앱 → Worker({shot:true,name,data}) → Apps Script 웹 앱(tool/drive_save.gs, Worker 의 DRIVE_URL) → 드라이브.
   Worker 가 DRIVE_URL 을 갖고 있으면 암호 확인 답에 drive:true 가 오고, 그때만 ⚙︎ 에 «찰칵 사진 드라이브에 저장»이 보인다(기본 켬).
   드라이브로 가는 사진에는 진단용 기록(JPEG 설명 칸 COM: 판·시각·위치·방향·보정값·화각·이름표 자리)을 넣는다 — 공유 창으로 내보내는 사진에는 넣지 않는다 */
const driveOn=()=>!!localStorage.aiUrl&&localStorage.drive==='1'&&localStorage.driveSave!=='0';
function shotMeta(){ const B=camBasis()||{v:[0,1,0],r:[1,0,0]}, as=x=>+(Math.asin(Math.max(-1,Math.min(1,x)))/D2R).toFixed(1);
  return {app:'저게뭐야',v:VER,t:new Date().toISOString(),lat:S.lat==null?null:+S.lat.toFixed(6),lon:S.lon==null?null:+S.lon.toFixed(6),acc:Math.round(S.acc||0),
    floor:S.floor,eye:Math.round(S.eye),hdg:+headingOf(B.v).toFixed(1),pitch:as(B.v[2]),roll:as(B.r[2]),off:+S.userOff.toFixed(2),hold:S.hold,cmpAcc:S.cmpAcc,
    auto:{n:AUTO.n,done:AUTO.done},adj:S.adj||[],scr:scrAngle(),fov:S.fov,W:VIEW.W,H:VIEW.H,f:+(VIEW.f||0).toFixed(1),vw:VIEW.vw,vh:VIEW.vh,simple:S.simple,msg:S.msg||'',
    labels:S.labels.slice(0,40).map(l=>[l.name,Math.round(l.x),Math.round(l.y)])}; }
function jpegNote(buf,text){ // JPEG 안에 설명(COM) 칸을 끼워 넣는다 — 그림은 그대로, 사진 보기 앱에는 안 보인다
  const b=new Uint8Array(buf), t=new TextEncoder().encode(text); if(t.length>65000||b[0]!==0xFF||b[1]!==0xD8) return new Blob([b],{type:'image/jpeg'});
  let i=2; while(i+4<b.length&&b[i]===0xFF&&b[i+1]>=0xE0&&b[i+1]<=0xEF) i+=2+(b[i+2]<<8|b[i+3]);   // 맨 앞(SOI) 뒤 APPn 칸들은 건너뛰고
  const seg=new Uint8Array(4+t.length); seg[0]=0xFF; seg[1]=0xFE; seg[2]=(t.length+2)>>8; seg[3]=(t.length+2)&255; seg.set(t,4);
  return new Blob([b.subarray(0,i),seg,b.subarray(i)],{type:'image/jpeg'});
}
const b64=blob=>new Promise((ok,no)=>{ const r=new FileReader(); r.onload=()=>ok(String(r.result).replace(/^data:[^,]*,/,'')); r.onerror=()=>no(r.error); r.readAsDataURL(blob); });
async function saveDrive(blob,name,meta){
  status('☁️ 드라이브에 저장 중…'); const ac=new AbortController(), kill=setTimeout(()=>ac.abort(),45000);
  try{ const data=await b64(jpegNote(await blob.arrayBuffer(),JSON.stringify(meta)));
    const r=await fetch(localStorage.aiUrl,{signal:ac.signal,method:'POST',headers:{'Content-Type':'application/json','X-App-Token':localStorage.aiToken||''},body:JSON.stringify({shot:true,name,data})});
    const j=await r.json().catch(()=>({}));
    if(r.status===401) throw new Error('암호가 달라요');
    if(!r.ok||!j.ok) throw new Error(j.error||('오류 '+r.status));
    status('☁️ 드라이브 «저게뭐야 사진» 폴더에 저장했어요'); }
  catch(e){ S.shareNext=Date.now()+30000; status('☁️ 드라이브 저장 실패('+(e.name==='AbortError'?'45초 안에 답이 없음':String(e.message).slice(0,60))+') — 📸를 한 번 더 누르면 공유 창으로 보냅니다'); }
  finally{ clearTimeout(kill); }
}

/* ---------- 보정·설정 ---------- */
function openCalib(){
  $('calibPanel').hidden=false; $('cross').hidden=false; $('setPanel').hidden=true;
  const list=$('calibList'); list.innerHTML='';
  const cands=S.blds.filter(b=>b.t.name&&!BAD.test(b.t.name)&&b.h>=60).sort((a,b)=>b.h-a.h).slice(0,24);
  for(const b of cands){const bt=document.createElement('button'); bt.textContent=b.t.name; bt.onclick=()=>{
      const B=camBasis(); if(!B) return; const cur=headingOf(B.v); const d=((b.az-cur+540)%360)-180; S.userOff+=d; calibrated(); logAdj({k:'list',v:+d.toFixed(1),name:b.t.name}); status(`🧭 «${b.t.name}»에 맞췄어요`); };
    list.appendChild(bt);}
}
$('go').onclick=start;
$('sensor').onclick=async()=>{ try{ const r=await DeviceOrientationEvent.requestPermission(); S.oriPerm=r; if(r==='granted'){ $('sensor').hidden=true; return; } }catch(e){ S.oriPerm='error'; }
  S.manual=true; $('sensor').hidden=true; status('센서 없이: 🧭에서 방향을 맞추세요'); }; $('shot').onclick=shot; $('calib').onclick=openCalib;
$('calibDone').onclick=()=>{$('calibPanel').hidden=true;$('cross').hidden=true;};
$('hdg').value=S.userOff; $('hdgV').textContent=S.userOff.toFixed(1)+'°'; $('hdg').oninput=e=>{S.userOff=+e.target.value;$('hdgV').textContent=S.userOff+'°';localStorage.hdgOff=S.userOff;}; $('hdg').onchange=()=>{ calibrated(); logAdj({k:'slider',off:+S.userOff.toFixed(1)}); };
$('calibReset').onclick=()=>{ logAdj({k:'reset'}); S.userOff=0; S.hold=false; localStorage.removeItem('hdgOff'); localStorage.removeItem('hdgAt'); $('hdg').value=0; $('hdgV').textContent='0°'; status('🧭 보정을 지웠어요 — 나침반 그대로'); };
$('fov').value=S.fov; $('fovV').textContent=S.fov+'°'; $('fov').oninput=e=>{S.fov=+e.target.value;$('fovV').textContent=S.fov+'°';localStorage.fov2=S.fov;updateView();};
$('settings').onclick=()=>{$('setPanel').hidden=false;$('calibPanel').hidden=true;$('cross').hidden=true; aiPing();};
$('setDone').onclick=()=>{$('setPanel').hidden=true;};
$('floor2').onchange=e=>{S.floor=+e.target.value||1; S.eye=S.ground+(S.floor-1)*2.8+1.5;};
$('showPeaks').onchange=e=>{S.showPeaks=e.target.checked;};
$('maxLabels').value=S.maxLabels; $('maxV').textContent=S.maxLabels; $('maxLabels').oninput=e=>{S.maxLabels=+e.target.value;$('maxV').textContent=S.maxLabels;localStorage.maxLabels=S.maxLabels;};
function modeBtn(){ $('mode').textContent=S.simple?'간단':'전부'; }
$('mode').onclick=()=>{ S.simple=!S.simple; localStorage.simple=S.simple?'1':'0'; modeBtn(); status(S.simple?'이름표 간단 — 점을 누르면 이름':`이름표 전부(최대 ${S.maxLabels}개)`); compute(); };
modeBtn();
// 점 톡 → 4초간 그 이름표를 띄운다
document.addEventListener('click',e=>{
  if($('hud').hidden||Date.now()<(S.noClick||0)||e.target.closest('button,input,label,#setPanel,#calibPanel')) return;
  let best=null,bd2=44*44; for(const l of S.dots){const d2=(l.x-e.clientX)**2+(l.y-e.clientY)**2; if(d2<bd2){bd2=d2;best=l;}}
  if(best){ S.pop={key:best.key,until:Date.now()+4000}; compute(); }
});
$('reload').onclick=()=>{S.loadedAt=null; if(S.lat) loadArea(); $('setPanel').hidden=true;};

/* ---------- v3.10 끌어서 맞추기 — 이름표가 옆으로 밀려 있으면 화면을 좌우로 끌어 건물 위에 놓는다(나침반 오차를 눈으로 바로잡기) ---------- */
let drag=null;
const fmtD=d=>(d>=0?'+':'−')+Math.abs(d).toFixed(1)+'°';
function turnLabels(d){ // 방향을 d° 돌린 만큼 화면 속 이름표를 바로 옮긴다 — 다음 계산(0.2초 뒤)을 기다리지 않고 손가락을 따라오게
  const cx=VIEW.W/2, f=VIEW.f, mv=o=>{ o.x=cx+f*Math.tan(Math.max(-1.5,Math.min(1.5,Math.atan((o.x-cx)/f)+d*D2R))); };
  S.labels.forEach(mv); S.dots.forEach(mv); DISP.forEach(mv);
}
addEventListener('pointerdown',e=>{
  if($('hud').hidden||!e.isPrimary||!camBasis()||!e.target.closest||e.target.closest('button,input,label,#setPanel,#calibPanel,#aiView,#err')) return;
  if(e.clientX<16||e.clientX>innerWidth-16) return;   // 화면 가장자리(폰을 쥔 손·뒤로 가기 쓸기)는 뺀다
  drag={x0:e.clientX,y0:e.clientY,x:e.clientX,on:false,from:S.userOff};
});
addEventListener('pointermove',e=>{
  if(!drag||!e.isPrimary) return;
  if(!drag.on){ const dx=Math.abs(e.clientX-drag.x0), dy=Math.abs(e.clientY-drag.y0);
    if(dy>30&&dy>dx){ drag=null; return; }          // 위아래로 쓸면 끌기가 아니다
    if(dx<12||dx<1.5*dy) return; drag.on=true; }                    // 여기까지 온 12 px 도 버리지 않는다(이름표가 손가락에 붙어 온다)
  const cx=VIEW.W/2, a=x=>Math.atan((x-cx)/VIEW.f)/D2R, d=a(e.clientX)-a(drag.x); drag.x=e.clientX; if(!d) return;
  S.userOff-=d; turnLabels(d); status(`🧭 끌어서 맞추는 중 ${fmtD(wrap(S.userOff-drag.from))}`);   // 오른쪽으로 끌면 이름표가 오른쪽으로 = 방향값은 줄어든다
});
function dragEnd(e){ if(!drag||!e.isPrimary) return; const d=drag; drag=null; if(!d.on) return;
  S.noClick=Date.now()+400; const t=wrap(S.userOff-d.from); calibrated(); logAdj({k:'drag',v:+t.toFixed(1)}); compute(); status(`🧭 방향을 ${fmtD(t)} 맞췄어요`); }
addEventListener('pointerup',dragEnd); addEventListener('pointercancel',dragEnd);

/* ---------- v3.7 «찍고 확인»(B) 자리 — AI 판정은 앱 밖(하박사님 개인 중계 주소)이 한다 ----------
   설정 ⚙︎ 의 «AI 확인 주소»를 채우면 🔍 버튼이 나타난다. 비워 두면 아무것도 밖으로 나가지 않는다.
   보내는 것(JSON): {image:'data:image/jpeg;base64,…', w, h, heading, pitch, fov, lat, lon,
                     candidates:[{key,name,x,y,d,h}]}   ← 지도로 뽑은 «화면 안 후보» 최대 20개, x·y는 사진 픽셀
   받는 것(JSON):  {labels:[{key|name, x?, y?, conf?}]} ← 사진에 실제로 보이는 것만. x·y 없으면 후보 위치를 쓴다
   자세한 약속·프롬프트 = AI_HANDOFF.md */
function aiOn(){ $('aiUrl').value=localStorage.aiUrl||''; $('aiToken').value=localStorage.aiToken||''; aiUI(); }
function aiUI(){ const on=!!localStorage.aiUrl, auto=on&&localStorage.autoCal!=='0';   // 입력 칸은 건드리지 않는다(쓰는 중에 지워지지 않게)
  $('ai').hidden=!on; $('autoCalRow').hidden=!on; $('autoCal').checked=localStorage.autoCal!=='0';
  $('driveRow').hidden=!(on&&localStorage.drive==='1'); $('driveSave').checked=localStorage.driveSave!=='0';
  $('privacy').textContent=(!on?'사진은 폰 밖으로 나가지 않습니다.':auto?'켤 때(방향 맞춤, 최대 3장)와 🔍를 누를 때 사진을 AI로 보냅니다.':'🔍를 누를 때만 사진을 AI로 보냅니다.')   // v3.7.4 · v3.11 보내는 때를 있는 그대로 적는다
    +(driveOn()?' 찰칵 사진은 내 구글 드라이브에 저장합니다.':''); }
$('autoCal').onchange=e=>{ localStorage.autoCal=e.target.checked?'1':'0'; aiUI(); };
$('driveSave').onchange=e=>{ localStorage.driveSave=e.target.checked?'1':'0'; aiUI(); };
$('aiToken').onchange=e=>{ const v=e.target.value.trim(); if(v) localStorage.aiToken=v; else localStorage.removeItem('aiToken'); aiPing(); };
$('aiUrl').onchange=e=>{ const v=e.target.value.trim(); if(v) localStorage.aiUrl=v; else localStorage.removeItem('aiUrl'); aiUI(); aiPing(); };
aiOn();
// v3.10 암호 확인 — 사진 없는 빈 요청을 보낸다(Worker 는 AI 를 부르지 않고 바로 답한다). 🔍를 눌러 보고서야 401 을 알던 문제(11-15)
async function aiPing(){
  const url=localStorage.aiUrl, el=$('aiOk'); if(!url){ el.textContent=''; return; }
  el.textContent='확인 중…'; const ac=new AbortController(), kill=setTimeout(()=>ac.abort(),8000);
  try{ const r=await fetch(url,{signal:ac.signal,method:'POST',headers:{'Content-Type':'application/json','X-App-Token':localStorage.aiToken||''},body:'{}'});
    el.textContent=r.ok?'✅ 연결됨':(r.status===401?'❌ 암호가 달라요':'❌ 오류 '+r.status);
    if(r.ok){ const j=await r.json().catch(()=>({})); localStorage.drive=j.drive?'1':'0'; aiUI(); } }   // v3.12 Worker 에 드라이브 저장이 준비됐는지
  catch(e){ el.textContent='❌ 주소에 닿지 않아요'; }
  clearTimeout(kill);
}
// 사진 한 장 + 후보 목록을 Worker 로 보내고 답을 받는다 — 🔍 버튼과 «켤 때 방향 자동 맞춤»이 같이 쓴다(v3.11)
async function aiAsk(onSec,limit){
  const v=$('cam'), W=VIEW.W, H=VIEW.H, k=Math.min(1024/Math.max(W,H),2);
  const c=document.createElement('canvas'); c.width=Math.round(W*k); c.height=Math.round(H*k); const g=c.getContext('2d');
  const s=Math.max(c.width/v.videoWidth,c.height/v.videoHeight), dw=v.videoWidth*s, dh=v.videoHeight*s;
  g.drawImage(v,(c.width-dw)/2,(c.height-dh)/2,dw,dh);
  const B=camBasis()||{v:[0,1,0]}, snap={off0:S.userOff,aOff0:S.alphaOff,ep:S.ep,f:VIEW.f};   // 사진 찍는 순간의 보정값·나침반·센서 번호·초점거리
  const cands=[...S.labels.filter(l=>!l.peak),...S.dots].slice(0,20).map(l=>({key:l.key,name:l.name,x:Math.round(l.x*k),y:Math.round(l.y*k),sub:l.sub}));
  for(const l of wideCands(new Set(cands.map(x=>x.key)))) cands.push({key:l.key,name:l.name,x:Math.round(l.x*k),y:Math.round(l.y*k),sub:l.sub,out:true});
  const body={image:c.toDataURL('image/jpeg',0.85),w:c.width,h:c.height,heading:Math.round(headingOf(B.v)),
    pitch:Math.round(Math.asin(Math.max(-1,Math.min(1,B.v[2])))/D2R),fov:S.fov,lat:S.lat,lon:S.lon,
    candidates:cands.map(x=>x.out?{key:x.key,name:x.name,sub:x.sub}:x)};   // 화면 밖 후보는 위치 없이 이름만 — «계산상 사진 밖» 숫자를 주면 AI가 찾아보지도 않는다
  const t0=Date.now(), ac=new AbortController(), tick=setInterval(()=>onSec&&onSec(Math.round((Date.now()-t0)/1000)),1000), kill=setTimeout(()=>ac.abort(),limit*1000);
  try{ const r=await fetch(localStorage.aiUrl,{signal:ac.signal,method:'POST',headers:{'Content-Type':'application/json','X-App-Token':localStorage.aiToken||''},body:JSON.stringify(body)}), res=await r.json().catch(()=>({}));
    if(r.status===401) throw new Error('암호가 달라요. ⚙︎에서 «AI 암호»를 다시 넣어 주세요');   // v3.10 숫자(401) 대신 할 일을 알려 준다
    if(!r.ok) throw new Error(r.status+(res.error?' '+res.error:''));                          // v3.7.4 413 등도 이유를 보이게
    return {...snap,res,k,c,W,H,sec:Math.round((Date.now()-t0)/1000),byKey:new Map(cands.map(x=>[x.key,x])),byName:new Map(cands.map(x=>[x.name,x]))}; }
  catch(e){ throw new Error(e.name==='AbortError'?`${limit}초 안에 답이 없음`:e.message); }
  finally{ clearInterval(tick); clearTimeout(kill); }
}
function wideCands(have){ // v3.11 화면 바로 밖(좌우 30°)의 높은 건물 — 나침반이 20° 넘게 틀리면 정작 보이는 건물이 «화면 안 후보»에 없다. AI가 알아볼 표지를 더 건넨다
  const B=camBasis(); if(!B) return []; const W=VIEW.W, hd=headingOf(B.v), half=Math.atan(W/2/VIEW.f)/D2R, out=[];
  for(const b of S.blds){ if(b.h<80||b.d<400) continue; const da=Math.abs(wrap(b.az-hd)); if(da<half-2||da>half+30) continue;
    const top=elev(b.ground+b.h-S.eye,b.d); if(top<0.3) continue;                 // 꼭대기가 지평선 위로 솟아야 눈에 띈다
    const p=project(B,b.az,top); if(!p||(p[0]>=0&&p[0]<=W)) continue;
    const name=labelOf(b); if(!name) continue; const grp=name.replace(/\s*(\d+|[A-Z])동?$/,'')||name; if(have.has(grp)) continue;
    have.add(grp); const lv=parseInt(b.t['building:levels']); out.push({key:grp,name:grp,x:p[0],y:p[1]+6,sub:`${(b.d/1000).toFixed(1)} km`+(lv?` · ${lv}층`:''),top}); }
  return out.sort((a,b)=>b.top-a.top).slice(0,6);
}
async function aiCheck(){
  if(!localStorage.aiUrl) return;
  if(S.aiBusy){ status('🔍 잠깐만요 — 먼저 보낸 사진의 답을 기다리는 중'); return; }
  S.aiBusy=true; status('🔍 AI에게 묻는 중…'); let a;
  try{ a=await aiAsk(s=>status(`🔍 AI에게 묻는 중… ${s}초`),50); }   // 50초 넘으면 포기(Worker 는 15+25초 안에 끝냄)
  catch(e){ status('🔍 AI 확인 실패 — '+e.message); return; }
  finally{ S.aiBusy=false; }
  const {res,k,c,W,H,byKey,byName}=a;
  status(`🔍 답 받음 ${a.sec}초`);
  if(res&&res.error&&!(res.labels||[]).length){ status('🔍 AI 오류 — '+String(res.error).slice(0,80)); return; }   // v3.7.3 Worker 가 알려 준 원인을 그대로 보여 준다
  const L=(res.labels||[]).map(r=>{ const cd=byKey.get(r.key)||byName.get(r.name)||{}; const x=(r.x??cd.x), y=(r.y??cd.y);
    return x==null?null:{x:x/k,y:y/k,name:r.name||cd.name,sub:(cd.sub||'')+(r.conf!=null?` · ${Math.round(r.conf*100)}%`:''),key:'ai'+(r.key||r.name),peak:false}; }).filter(Boolean);
  // v3.9 자동 보정 — AI가 찍은 실제 위치와 지도로 계산한 위치의 각도 차이만큼 나침반을 돌린다
  const fix=aiFix(a); if(fix) status(fix);
  // 멈춘 사진 위에 이름표 — 톡 하면 닫힘
  const view=document.createElement('canvas'), dpr=devicePixelRatio||1; view.width=W*dpr; view.height=H*dpr; view.id='aiView';
  Object.assign(view.style,{position:'fixed',inset:'0',width:W+'px',height:H+'px',zIndex:50,background:'#000'});
  const vg=view.getContext('2d'); vg.setTransform(dpr,0,0,dpr,0,0); vg.drawImage(c,0,0,W,H); drawLabels(vg,L);
  vg.font='600 13px sans-serif'; vg.fillStyle='rgba(255,255,255,.85)'; vg.fillText(`🔍 AI 확인 ${L.length}개 · 톡 하면 닫기`,12,H-16);
  view.onclick=()=>view.remove(); document.body.appendChild(view); status(`🔍 AI 확인 ${L.length}개`+(fix?` · ${fix}`:'')+(res.how?` · ${res.how.replace(/gemini-/g,'')}`:''));
}
$('ai').onclick=aiCheck;
function aiFix(q,auto){
  if(S.ep!==q.ep||S.userOff!==q.off0) return null;   // v3.11 기다리는 사이 센서가 끊겼거나(자이로 기준이 바뀜) 손으로 맞췄다 → 손으로 맞춘 쪽을 따른다
  const {k,byKey,byName}=q, cx=q.W/2, ang=x=>Math.atan((x-cx)/q.f)/D2R, D=[];   // 사진 찍은 순간의 화면 폭·초점거리로 잰다(그사이 폰을 돌려 세웠어도)
  for(const r of q.res.labels||[]){ const cd=byKey.get(r.key)||byName.get(r.name); if(!cd||r.x==null||cd.x==null||(r.conf??1)<(auto?0.7:0.6)) continue;
    const d=ang(r.x/k)-ang(cd.x/k); if(Math.abs(d)<45) D.push(d); }
  if(!D.length){ logAdj({k:auto?'auto':'ai',r:'none',how:q.res.how}); return null; }
  // v3.10 가운데값에서 4° 안에 드는 건물이 과반(둘 이상)이면 그 평균으로 맞춘다 — 예전 «최대−최소 6° 이내»는 한 동만 옆 동으로 잘못 짚혀도 포기했다(11-15 사진: 16~22°, 폭 5.6°로 아슬아슬)
  D.sort((a,b)=>a-b); const med=D.length%2?D[D.length>>1]:(D[D.length/2-1]+D[D.length/2])/2;
  const In=D.filter(d=>Math.abs(d-med)<=4), m=In.reduce((a,b)=>a+b,0)/In.length;
  const rec={k:auto?'auto':'ai',d:D.map(d=>+d.toFixed(1)),how:q.res.how};
  if(auto&&In.length<2){ logAdj({...rec,r:'few'}); return null; }        // 저절로 맞출 때는 건물 하나만 보고는 움직이지 않는다
  if(D.length>=2&&In.length<Math.max(2,Math.ceil(D.length*0.6))){ logAdj({...rec,r:'spread'}); return `🧭 자동 보정 안 함 — 건물마다 어긋남이 달라요(${(D[D.length-1]-D[0]).toFixed(0)}°)`; }
  S.userOff+=wrap((S.alphaOff??0)-(q.aOff0??0));   // v3.11 답을 기다리는 동안 나침반이 움직인 만큼은 되돌린다 — 사진을 찍은 순간을 기준으로 맞춘다
  S.lastFix=Math.abs(m)<0.7?0:m; logAdj({...rec,r:'ok',v:+(-S.lastFix).toFixed(1)});
  if(Math.abs(m)<0.7){ calibrated(auto?'auto':'ai'); return auto?'🧭 방향 확인 — 정확해요':`🧭 방향 정확(${fmtD(m)})`; }
  S.userOff-=m; calibrated(auto?'auto':'ai');
  return auto?`🧭 방향을 자동으로 맞췄어요 (${fmtD(-m)} · 건물 ${In.length}개)`:`🧭 자동 보정 ${fmtD(-m)} (건물 ${In.length}개 기준)`;
}

/* ---------- v3.11 켤 때 방향 자동 맞춤 — 🔍를 누르지 않아도 처음에 AI에게 한 번 물어 나침반 오차를 잡는다 ----------
   AI 주소가 있고 ⚙︎ «켤 때 방향 자동 맞춤»이 켜져 있을 때만(시작 화면에 «사진을 보낸다»고 적는다). 화면은 멈추지 않는다.
   · 폰이 1초쯤 가만히 지평선 근처를 보고, 건물 후보가 둘 이상일 때 묻는다.
   · 건물 둘 이상이 같은 만큼 어긋나 있어야만 맞춘다(하나만 보고는 움직이지 않는다).
   · 못 맞추면 다른 쪽을 볼 때 두 번까지 더 해 보고 그만둔다(한 번 켤 때 최대 3장). 손으로 끌어 맞췄으면 하지 않는다. */
const AUTO={n:0,last:0,hdg:0,done:false,st:[],t0:0,err:false,refine:false};   // refine = 크게 돌린 뒤 «한 번 더 확인» 기다리는 중(v3.13)
const autoOn=()=>!!localStorage.aiUrl&&localStorage.autoCal!=='0';
function autoTick(){
  if(AUTO.done||S.aiBusy||drag||!autoOn()||$('hud').hidden||document.hidden) return;
  if(AUTO.n>=3||(S.hold&&!AUTO.refine)){ AUTO.done=true; AUTO.refine=false; return; }   // 이미 맞췄거나(끌기·🔍) 세 번 해 봤다
  const B=camBasis(); if(!B||!S.M||S.cmpOff==null||!$('cam').videoWidth||!S.blds.length){ AUTO.st.length=0; return; }
  const h=headingOf(B.v), p=Math.asin(Math.max(-1,Math.min(1,B.v[2])))/D2R, now=Date.now();
  AUTO.st.push([h,p]); if(AUTO.st.length>3) AUTO.st.shift();
  if(AUTO.st.length<3||AUTO.st.some(s=>Math.abs(wrap(s[0]-h))>2.5||Math.abs(s[1]-p)>2.5)||p<-20||p>35) return;   // 1초쯤 가만히, 땅·하늘만 보고 있지 않을 때
  if(S.labels.filter(l=>!l.peak).length+S.dots.length<2) return;         // 건물 후보가 둘은 있어야 한다
  AUTO.t0=AUTO.t0||now; if((kq.length||kBusy)&&now-AUTO.t0<6000) return;  // 건물 이름(카카오)을 받는 중이면 6초까지 기다린다
  if(AUTO.n&&(AUTO.refine?now-AUTO.last<2500:AUTO.err?now-AUTO.last<5000:(now-AUTO.last<12000||(Math.abs(wrap(h-AUTO.hdg))<15&&now-AUTO.last<40000)))) return;   // 다시 확인은 2.5초 뒤   // 다시 물을 때: AI 서버가 바빴으면 5초 뒤, 건물을 못 알아봤으면 12초 뒤 다른 쪽(15°)을 볼 때나 40초 뒤
  autoCal(h);
}
async function autoCal(h){
  S.aiBusy=true; AUTO.n++; AUTO.last=Date.now(); AUTO.hdg=h; AUTO.err=false; const off0=S.userOff, giveUp='🧭 방향 자동 맞춤을 못 했어요 — 화면을 좌우로 끌어 맞추세요', busy='🧭 방향 자동 맞춤: AI가 바빠요 — 잠시 뒤 다시 해 봅니다';
  status('🧭 방향을 자동으로 맞추는 중…'); let a;
  try{ a=await aiAsk(s=>{ if(!S.hold&&!drag) status(`🧭 방향을 자동으로 맞추는 중… ${s}초`); },45); }   // Worker 가 예비 모델까지 가면 15+25초
  catch(e){ if(AUTO.refine){ AUTO.refine=false; AUTO.done=true; return; }   // 다시 확인이 안 되면 첫 결과를 그대로 둔다
    if(/암호/.test(e.message)){ AUTO.done=true; status('🧭 방향 자동 맞춤 못 함 — '+e.message); } else { AUTO.err=true; status(AUTO.n>=3?giveUp:busy); } return; }
  finally{ S.aiBusy=false; AUTO.last=Date.now(); }
  const was=AUTO.refine;
  if((S.hold&&!was)||drag||S.userOff!==off0){ AUTO.done=true; AUTO.refine=false; return; }   // 기다리는 사이 손으로 맞췄다 → 그쪽을 따른다
  if(a.res.error&&!(a.res.labels||[]).length){ if(was){ AUTO.refine=false; AUTO.done=true; return; } AUTO.err=true; status(AUTO.n>=3?giveUp:busy); return; }   // Worker 가 «Gemini 붐빔·너무 늦음»을 알려 왔다
  S.lastFix=null; const fix=aiFix(a,true), m=S.lastFix;
  // v3.13 크게(3°↑) 돌렸으면 한 번 더 확인한다 — AI 는 건넨 «계산상 자리»에 끌려 덜 돌리는 일이 있다(11-17 광화문: 자동 −8° 뒤 손으로 −5° 더). 최대 3장 안에서
  if(m!=null&&Math.abs(m)>=3&&AUTO.n<3){ AUTO.refine=true; status(fix+' · 한 번 더 확인할게요'); return; }
  if(m!=null){ AUTO.done=true; AUTO.refine=false; status(was?(Math.abs(m)<0.7?'🧭 다시 확인 — 방향이 맞아요':`🧭 다시 확인 — ${fmtD(-m)} 더 맞췄어요`):fix); return; }
  if(was){ AUTO.done=true; AUTO.refine=false; status('🧭 방향을 자동으로 맞췄어요'); return; }   // 다시 확인이 애매하면 첫 결과를 그대로 둔다
  status(AUTO.n>=3?giveUp:'🧭 방향 자동 맞춤: 건물을 확실히 못 알아봤어요 — 트인 쪽을 비추면 다시 해 봅니다');
}
