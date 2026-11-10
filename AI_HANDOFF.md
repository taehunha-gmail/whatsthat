# 저게뭐야? — 인수인계 (v3.9 · 2026-11-10)

> 새 AI 세션은 이 문서 하나만 읽으면 이어서 일할 수 있다. 사용자 호칭은 «하박사님», 답은 한국어로 짧고 핵심만, 쉬운 말로.

## 1. 앱 한 줄
폰 카메라를 들이대면 보이는 건물·단지·산에 이름표를 실시간으로 붙여 주는 웹앱(아이폰 사파리, 홈 화면 추가).

- 주소: https://taehunha-gmail.github.io/whatsthat/
- 저장소: github.com/taehunha-gmail/whatsthat (Public · GitHub Pages = main 브랜치 루트)
- 고칠 때마다 `index.html` 의 `app.js?v=N`(지금 20)·`style.css?v=N`(지금 6) 숫자를 올려 캐시를 깬다. 아이폰은 앱을 완전히 껐다 켜야 새 판이 뜬다.

## 2. 파일
| 경로 | 내용 |
|---|---|
| `index.html` · `style.css` · `app.js` | 앱 전부(빌드 없음) |
| `manifest.webmanifest` · `icon-180.png` · `icon-512.png` | 홈 화면 아이콘 |
| `design/` | 아이콘 원본(A4판·비교안) |
| `worker.js` | «찍고 확인»(🔍) 중계 Cloudflare Worker 코드 — Cloudflare 편집기에 통째로 붙여 넣는다 |
| `data/t/` | 0.01° 칸 건물 타일 `{b:[[이름,층수,높이m,아파트?,[dlat,dlon…×1e5]]], r:[[단지명,[…]]]}` |
| `data/tall/` | 0.1° 칸 먼 고층(60 m·20층↑) `[[이름,층,높이,아파트?,[[lat,lon]…]]]` |
| `data/peaks.json` · `data/meta.json` | 봉우리 · 범위(위도 37.30~37.80, 경도 126.65~127.35) |
| `tool/merge_gis.py` | 국토부 GIS건물통합정보(SHP) 층수·높이를 타일에 합치는 스크립트 |

데이터 출처(시작 화면에 표기함): © OpenStreetMap 기여자(ODbL, Geofabrik south-korea 2026-11-01) · 국토교통부 GIS건물통합정보(서울 `AL_D010_11_20261009`, 공공누리) · AWS terrarium DEM · 카카오 지도 SDK(건물명).
OSM 원본 타일을 만든 `tiles.py` 는 남아 있지 않다. 다시 만들려면 Geofabrik pbf → pyosmium 으로 건물(way + type=building 관계: outline 우선, 없으면 가장 큰 part)·단지 멀티폴리곤을 0.01° 칸 JSON 으로 쪼개는 스크립트를 새로 짜고, 그 뒤 `merge_gis.py` 를 돌린다.

## 3. 동작 원리 (app.js)
1. **위치·방향**: GPS + deviceorientation. iOS 는 `webkitCompassHeading` + 자편각 −8.8°, 가로로 들면 화면 회전각 가산. 사용자 보정 `S.userOff`(localStorage `hdgOff`, 🧭 수동 또는 🔍 자동).
2. **화각**: `S.fov`=67°(카메라 긴 변). `updateView()` 가 영상 크기·화면 크기로 초점거리 `VIEW.f` 계산 — 폰을 돌린 뒤 영상 크기가 늦게 바뀌므로 매 프레임 확인(v3.8.1, 이전엔 1.8배 어긋났음).
3. **지형**: AWS terrarium DEM, 9×9 중앙값.
4. **가림**: 200 px 캔버스에 화가 알고리즘으로 건물을 그려 실제 보이는 면적 계산. 높이 모르는 건물 = 10 m(아파트 45 m) — 그래서 높이 데이터가 정확도의 핵심.
5. **고르기·안정화**: 점수 = log2(1+화면면적)×(1+높이/40)×(300 m 안 0.3)×가운데 가중. «간단» = 건물 5 + 산 2. 끈끈한 선택·위치 보간·페이드(v3.7).
6. **그리기**: `frame()` 이 try/catch 로 감싸져 한 번 오류가 나도 계속 그림. `#overlay` 는 z-index·translateZ 로 비디오 위(아이폰에서 안 보이던 문제, v3.7.5).
7. **🔍 찍고 확인**: 화면을 긴 변 1024 px JPEG + 후보 20개 → Worker → 이름표를 멈춘 사진 위에 그림. 50초 제한, 경과 초 표시.
8. **자동 보정(v3.9)**: 🔍 결과의 AI 위치와 지도 위치의 각도 차 중앙값만큼 `userOff` 를 돌림. 확신도 0.6 미만 제외, 건물끼리 6° 넘게 다르면 보정 안 함.
9. 하단 진단줄: 📍±m 🧭방향 ↕기울기 🏢건물수 K(카카오) 🏷이름표수 · 메시지.

## 4. 🔍 Worker (Cloudflare)
- 주소: `https://weathered-queen.taehun-ha.workers.dev` (앱 ⚙︎ «AI 확인 주소»에 넣음)
- 변수: `GEMINI_MODEL`=`gemini-3.6-flash`(Text) · `GEMINI_API_KEY`(Secret, 돕세 계정 AI Studio) · `APP_TOKEN`(Secret, 앱 ⚙︎ «AI 암호»와 같게) · `GEMINI_FALLBACK`(선택, 지금 없음)
- 동작: 토큰 확인(X-App-Token) → CORS 는 github.io 만 → 기본 모델 15초 제한 → 붐빔(429·500·503)·시간 초과면 예비 모델 25초 → `{labels:[{key,name,x,y,conf}], how, ms}`. 오류면 `{labels:[], error, how}`.
- 점검: `POST {"diag":true}` → 사진 없이 두 모델 상태·걸린 시간.
- **모델 교훈**: `gemini-3.8-flash` 는 나온 직후라 늘 503·무응답(25초+). `gemini-3.6-flash` 는 글 1초, 사진 1.6~3.4초, 위치 정확. Gemini 3.x 는 `temperature` 를 넣으면 400.
- 코드를 바꾸면 사용자가 Cloudflare **Edit code → 전부 지우고 붙여 넣기 → Deploy** 해야 한다(GitHub 연결 안 됨). 되도록 변수만 바꾸는 쪽으로.

## 5. 지금 상태
- 완료: 실시간 이름표, 서울 층수·높이 보강(층 10.9만·높이 7만 동, 누락 3층↑ 19만 동 추가), 화각 버그, 아이폰 그리기 버그, 🔍 3.6 Flash 로 2~4초, 자동 보정.
- 실기기 확인 필요: v3.9 자동 보정이 실제로 이름표를 건물 위에 앉히는지.
- 알려진 한계: 나침반 오차(철근·창틀 근처 5~15°) → 🔍 자동 보정으로 대응. 가로수·간판은 지도에 없어 가림 판단 못 함. GPS ±10~20 m. 데이터는 스냅샷.

## 6. 다음 할 일
1. v3.9 자동 보정 실기기 시험(아는 건물 2~3개 보이는 곳에서 🔍).
2. 경기·인천 GIS건물통합정보(AL_D010_41·_28)를 받아 `tool/merge_gis.py` 로 합치기.
3. 이름표 겹침 줄이기(«전부» 모드에서 위쪽 이름표가 겹침).
4. 나중에: 팔 수 있는 수준인지 냉정 평가(정확도·속도·비용·경쟁 앱·라이선스 — ODbL 표기 의무, 공공누리 출처 표시).

## 7. 일하는 방법 메모
- 사용자는 코딩을 하지 않는다. 할 일은 한 번에 하나씩, 버튼 이름까지 쉽게.
- 진단은 사용자가 찰칵(📸) 사진을 **돕세 구글 드라이브 루트**에 올리면 드라이브 도구로 받아 본다(10 MB 이하만 됨). 큰 파일은 GitHub 릴리스를 거친다.
- 클라우드 세션 환경 «whatsthat» 에 Worker 주소와 `APP_TOKEN`(헤더 X-App-Token)이 저장돼 있어 세션에서 Worker 를 직접 시험할 수 있다.
- 국내 공공데이터 사이트(브이월드·국가공간정보포털)는 세션에서 접속 안 됨 — 사용자가 받아 준다.
