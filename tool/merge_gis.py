# GIS건물통합정보(국토부, EPSG:5186) 층수·높이를 저게뭐야 정적 타일(data/t, data/tall)에 합친다
# 사용: python3 merge_gis.py <shp 경로(확장자 없이)> <data 폴더>
import sys, json, glob, os, math, collections
import shapefile, numpy as np
from pyproj import Transformer
from shapely.geometry import Polygon, Point
from shapely.strtree import STRtree

SHP, DATA = sys.argv[1], sys.argv[2]
tr = Transformer.from_crs(5186, 4326, always_xy=True)
r = shapefile.Reader(SHP, encoding='cp949')
F = [f[0] for f in r.fields[1:]]
iH, iLV, iNM, iUSE = F.index('A16'), F.index('A26'), F.index('A24'), F.index('A9')

polys, info = [], []
for sr in r.iterShapeRecords():
    s, rec = sr.shape, sr.record
    if not s.points: continue
    ring = s.points[:s.parts[1]] if len(s.parts) > 1 else s.points
    xs, ys = zip(*ring); lo, la = tr.transform(np.array(xs), np.array(ys))
    try: p = Polygon(zip(lo, la))
    except Exception: continue
    if not p.is_valid: p = p.buffer(0)
    if p.is_empty or p.geom_type != 'Polygon': continue
    lv = int(rec[iLV] or 0); h = float(rec[iH] or 0)
    if h > 0 and lv > 0 and h > lv * 8: h = 0           # 높이 값이 층수와 안 맞으면(오타) 버린다
    polys.append(p); info.append((lv, round(h, 1), (rec[iNM] or '').strip(), 1 if rec[iUSE] == '공동주택' else 0))
print('GIS 건물', len(polys))
tree = STRtree(polys)
cent = [p.representative_point() for p in polys]
used = np.zeros(len(polys), bool)
minx = min(p.bounds[0] for p in polys); maxx = max(p.bounds[2] for p in polys)
miny = min(p.bounds[1] for p in polys); maxy = max(p.bounds[3] for p in polys)

stat = collections.Counter()
for path in sorted(glob.glob(f'{DATA}/t/*.json')):
    a, o = map(int, os.path.basename(path)[:-5].split('_'))
    la0, lo0 = a / 100, o / 100
    if la0 + 0.01 < miny or la0 > maxy or lo0 + 0.01 < minx or lo0 > maxx: continue
    c = json.load(open(path, encoding='utf-8')); changed = False
    for b in c['b']:
        n, lv, h, apt, f = b
        pts = [(lo0 + f[i + 1] / 1e5, la0 + f[i] / 1e5) for i in range(0, len(f), 2)]
        if len(pts) < 3: continue
        op = Polygon(pts)
        if not op.is_valid: op = op.buffer(0)
        if op.is_empty: continue
        oc = op.representative_point()
        hit = [i for i in tree.query(op) if op.contains(cent[i]) or polys[i].contains(oc)]
        for i in hit: used[i] = True
        if not hit: stat['OSM 짝 없음'] += 1; continue
        glv = max(info[i][0] for i in hit); gh = max(info[i][1] for i in hit)
        if not lv and glv: b[1] = glv; changed = True; stat['층수 채움'] += 1
        if not h and gh: b[2] = gh; changed = True; stat['높이 채움'] += 1
        if not n:
            nm = next((info[i][2] for i in hit if info[i][2]), '')
            if nm: b[0] = nm; changed = True; stat['이름 채움'] += 1
    # OSM 에 없는 3층 이상 건물은 새로 넣는다(가림 계산용)
    box = Polygon([(lo0, la0), (lo0 + .01, la0), (lo0 + .01, la0 + .01), (lo0, la0 + .01)])
    for i in tree.query(box):
        if used[i] or not box.contains(cent[i]): continue
        lv, h, nm, apt = info[i]
        if lv < 3 and h < 10: continue
        used[i] = True
        xy = list(polys[i].simplify(0.000005).exterior.coords)[:-1]
        f = []
        for lo, la in xy: f += [round((la - la0) * 1e5), round((lo - lo0) * 1e5)]
        c['b'].append([nm, lv, h, apt, f]); changed = True; stat['새 건물'] += 1
    if changed:
        json.dump(c, open(path, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':')); stat['고친 타일'] += 1

# 먼 고층(tall/, 0.1° 칸): 60 m 또는 20층 이상인데 없는 것 추가
tall = collections.defaultdict(list)
for path in glob.glob(f'{DATA}/tall/*.json'):
    tall[os.path.basename(path)[:-5]] = json.load(open(path, encoding='utf-8'))
have = collections.defaultdict(list)
for k, L in tall.items():
    for b in L: have[k].append(b[4][0])
for i, p in enumerate(polys):
    lv, h, nm, apt = info[i]
    if not (h >= 60 or lv >= 20): continue
    c = cent[i]; k = f'{math.floor(c.y * 10)}_{math.floor(c.x * 10)}'
    if any(abs(q[0] - c.y) < 0.0003 and abs(q[1] - c.x) < 0.0004 for q in have[k]):
        continue
    xy = list(p.simplify(0.00001).exterior.coords)[:-1]
    tall[k].append([nm, lv, h or lv * 3.3, apt, [[round(la, 6), round(lo, 6)] for lo, la in xy]]); stat['고층 추가'] += 1
for k, L in tall.items():
    json.dump(L, open(f'{DATA}/tall/{k}.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(dict(stat))
