// 저게뭐야 «찍고 확인»·«찰칵 → 드라이브» 중계 Worker — Cloudflare 편집기에 통째로 붙여 넣는다. 설명은 AI_HANDOFF.md 4절
const ALLOWED_ORIGIN = "https://taehunha-gmail.github.io";
const MAX_BODY_BYTES = 3 * 1024 * 1024; // 3 MB
const MODEL_RE = /^gemini-[a-z0-9.\-]{1,40}$/i;   // 점검·시험 때 넘겨받는 모델 이름은 이 꼴만
const SKIP_MS = 5 * 60 * 1000;   // ★11 기본 모델이 붐빔·무응답이면 5분 동안은 묻지 않고 바로 예비 모델로(11-17~19 3.6 Flash 가 반나절 넘게 503)
let primaryDownUntil = 0;        //     Worker 안에서 잠깐 기억하는 값(Cloudflare 가 Worker 를 새로 띄우면 잊는다 — 그러면 한 번 더 물어보고 다시 기억)
// ★12 답 형식을 정해 둔다 — 가벼운 모델이 위치(box_2d)를 자주 빠뜨렸다(11-19 시험 5번 중 2번)
const SCHEMA = { type: "OBJECT", required: ["view", "labels"], properties: {
  view: { type: "STRING", enum: ["open", "blocked", "dark"] },
  labels: { type: "ARRAY", items: { type: "OBJECT", required: ["key", "name", "box_2d", "conf"], properties: {
    key: { type: "STRING" }, name: { type: "STRING" }, box_2d: { type: "ARRAY", items: { type: "INTEGER" } }, conf: { type: "NUMBER" } } } } } };

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-App-Token",
        "Access-Control-Max-Age": "86400" } });
    }
    const H = { "Access-Control-Allow-Origin": ALLOWED_ORIGIN, "Content-Type": "application/json; charset=utf-8" };
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: H });

    if (request.method !== "POST") return reply({ error: "Method Not Allowed" }, 405);
    if (!env.APP_TOKEN || request.headers.get("X-App-Token") !== env.APP_TOKEN) return reply({ error: "Unauthorized" }, 401);
    if (parseInt(request.headers.get("Content-Length") || "0", 10) > MAX_BODY_BYTES) return reply({ error: "Payload Too Large" }, 413);
    const raw = await request.arrayBuffer();
    if (raw.byteLength > MAX_BODY_BYTES) return reply({ error: "Payload Too Large" }, 413);
    let p; try { p = JSON.parse(new TextDecoder().decode(raw)); } catch { return reply({ error: "Invalid JSON" }, 400); }

    // ★8 찰칵 사진 → 내 구글 드라이브: {"shot":true,"name":…,"data":base64} 를 Apps Script 웹 앱(DRIVE_URL, Secret)으로 넘긴다.
    //    Apps Script 코드 = 저장소 tool/drive_save.gs. 드라이브 «저게뭐야 사진» 폴더에 들어간다
    if (p.shot) {
      if (!env.DRIVE_URL) return reply({ ok: false, error: "DRIVE_URL 미설정" });
      const data = String(p.data || "").replace(/^data:[^,]*,/, "");
      if (!data) return reply({ ok: false, error: "사진이 비었음" });
      const name = String(p.name || "저게뭐야.jpg").replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
      try {
        const r = await fetch(env.DRIVE_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({ name, data }), redirect: "follow", signal: AbortSignal.timeout(30000) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
        if (!j) return reply({ ok: false, error: /accounts\.google|ServiceLogin|signin/i.test(t)
          ? "드라이브 저장 주소가 로그인을 요구함 — Apps Script 배포의 액세스를 «모든 사용자»로" : `드라이브 저장 응답이 이상함(${r.status})` });
        return reply(j.ok ? { ok: true, id: j.id, name: j.name } : { ok: false, error: "드라이브 저장 실패: " + String(j.error || "").slice(0, 120) });
      } catch (e) { return reply({ ok: false, error: "드라이브 저장 주소에 닿지 않음: " + String(e).slice(0, 80) }); }
    }
    // 사진 없는 빈 요청 = 암호 확인(앱 ⚙︎ 의 ✅). 드라이브 저장이 준비됐는지도 알려 준다
    if (!p.diag && !p.image) return reply({ labels: [], drive: !!env.DRIVE_URL });

    // ★1 모델 이름을 코드에 박지 않는다 — 옛 이름(1.5)은 이미 내려간 모델일 수 있음. 비어 있으면 원인을 알려 준다
    if (!env.GEMINI_MODEL) return reply({ labels: [], error: "GEMINI_MODEL 미설정 — AI Studio 에서 보이는 최신 Flash 이름을 넣으세요" });
    if (!env.GEMINI_API_KEY) return reply({ labels: [], error: "GEMINI_API_KEY 미설정" });

    // ★7 점검: {"diag":true} 를 보내면 사진 없이 두 모델에 짧게 물어 상태·걸린 시간만 알려 준다. {"diag":true,"models":[…]} 면 그 모델들을(예비 모델 고르기)
    const callG = async (model, body, ms) => { const t0 = Date.now();
      try { const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
        if (r.ok) return { ok: true, model, ms: Date.now() - t0, g: await r.json() };
        const t = await r.text(); let msg = t; try { msg = JSON.parse(t).error.message; } catch {}
        return { ok: false, model, ms: Date.now() - t0, status: r.status, msg: String(msg).slice(0, 120) };
      } catch (e) { return { ok: false, model, ms: Date.now() - t0, status: "timeout", msg: String(e).slice(0, 80) }; } };
    if (p.diag) {
      const q = { contents: [{ role: "user", parts: [{ text: "ok 라고만 답해" }] }], generationConfig: { thinkingConfig: { thinkingLevel: "low" } } };
      const list = Array.isArray(p.models) && p.models.length ? p.models.filter(m => MODEL_RE.test(String(m))).slice(0, 6) : [env.GEMINI_MODEL, env.GEMINI_FALLBACK].filter(Boolean);
      const res = await Promise.all(list.map(m => callG(m, q, 25000)));
      return reply({ diag: res.map(({ g, ...x }) => x) });
    }

    const { image, w = 1, h = 1, candidates = [] } = p;
    if (!image) return reply({ labels: [] });
    let data = image, mime = "image/jpeg";
    const m = image.match(/^data:([^;]+);base64,(.+)$/); if (m) { mime = m[1]; data = m[2]; }

    const cands = candidates.map(c => ({ key: c.key, name: c.name, sub: c.sub,
      x: typeof c.x === "number" ? Math.round(c.x / w * 1000) : undefined,
      y: typeof c.y === "number" ? Math.round(c.y / h * 1000) : undefined }));

    // ★2 지시문 좌표 표현을 0~1000 으로 통일(원래 «픽셀»과 섞여 있었음)
    const prompt = `사진은 서울에서 폰 카메라로 찍은 풍경이다. 아래 후보는 GPS·나침반·지도로 계산한 «화면 안에 있을 수 있는 건물» 목록이고, x·y는 계산상 사진 속 위치다(0~1000 정규화, 오차 있음). 먼저 사진 전체를 보고 view 를 정하라: 바깥 풍경(건물·하늘·먼 경치)이 보이면 "open", 실내 벽·천장·가구·사람·바로 앞 물건만 보이거나 창이 막혀 바깥이 거의 안 보이면 "blocked", 너무 어둡거나 흔들려 무엇인지 알아볼 수 없으면 "dark". 그다음 사진에 실제로 보이는 후보만 골라라. 가려졌거나 안 보이면 빼라. 보이는 것은 하나도 빠짐없이 사진 속 실제 위치를 box_2d [ymin, xmin, ymax, xmax](0~1000)로 적어라(box_2d 없는 항목은 쓰지 마라). 후보에 없는 건물은 지어내지 마라. 확신도 conf(0~1)를 붙여라. 같은 단지의 비슷한 동처럼 구별이 안 되면 단지 이름 하나만 남겨라. 출력은 JSON 하나만: {"view":"open|blocked|dark","labels":[{"key":…,"name":…,"box_2d":[ymin,xmin,ymax,xmax],"conf":…}]}

[후보 건물 목록]
${JSON.stringify(cands)}`;

    const body = { contents: [{ role: "user", parts: [{ text: prompt }, { inline_data: { mime_type: mime, data } }] }],
                   generationConfig: { response_mime_type: "application/json", response_schema: SCHEMA, thinkingConfig: { thinkingLevel: "low" } } };   // ★6 생각은 짧게 — 오래 생각하면 수십 초
    const noSchema = () => { const b = JSON.parse(JSON.stringify(body)); delete b.generationConfig.response_schema; return b; };
    // 형식을 못 받아들이는 모델이면(400) 형식 없이 한 번 더
    const ask = async (model, ms) => { let R = await callG(model, body, ms); tries.push(R); if (!R.ok && R.status === 400) { R = await callG(model, noSchema(), ms); tries.push(R); } return R; };
    const tries = [];
    try {
      // ★3 키는 헤더로. ★9 붐비면(503·429·500, 대개 잠깐) 1.2초 쉬고 같은 모델로 한 번 더(11-17 저녁 내내 503) → ★5 그래도 안 되거나 늦으면 예비 모델(GEMINI_FALLBACK)
      const t0 = Date.now(), test = typeof p.model === "string" && MODEL_RE.test(p.model), first = test ? p.model : env.GEMINI_MODEL;   // p.model = 시험용(앱은 안 보냄)
      const busy = R => [429, 500, 503].includes(R.status), fb = env.GEMINI_FALLBACK && env.GEMINI_FALLBACK !== first ? env.GEMINI_FALLBACK : "";
      let R;
      if (!test && fb && Date.now() < primaryDownUntil) {   // ★11 최근에 기본 모델이 막혔다 → 바로 예비 모델(그래도 안 되면 기본 모델에 한 번)
        R = await ask(fb, 20000); if (!R.ok) { R = await ask(first, 14000); if (R.ok) primaryDownUntil = 0; } }
      else {
        R = await ask(first, 14000);
        if (!R.ok && busy(R) && R.ms < 6000) { await new Promise(z => setTimeout(z, 1200)); R = await ask(first, 14000); }
        if (!R.ok && (busy(R) || R.status === "timeout")) { if (!test) primaryDownUntil = Date.now() + SKIP_MS; if (fb) R = await ask(fb, 20000); }
        else if (R.ok && !test) primaryDownUntil = 0;
      }
      const how = tries.map(x => `${x.model} ${x.ok ? "OK" : x.status} ${(x.ms / 1000).toFixed(1)}초`).join(" → ");
      // ★4 실패 이유를 앱에 돌려준다
      if (!R.ok) { const hint = R.status === 503 ? "Gemini 가 붐빔" : R.status === 429 ? "사용 한도 초과" : R.status === "timeout" ? "너무 늦음" : "";
        return reply({ labels: [], how, error: `${hint} [${how}] ${R.msg || ""}`.trim().slice(0, 200) }); }
      const g = R.g;
      const text = (g?.candidates?.[0]?.content?.parts || []).filter(x => x.text && !x.thought).map(x => x.text).join("");
      if (!text) return reply({ labels: [], error: "모델 응답이 비었음" });
      let parsed; try { parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return reply({ labels: [], error: "모델 응답이 JSON 아님" }); }
      const labels = (Array.isArray(parsed?.labels) ? parsed.labels : []).map(it => {
        const o = { key: it.key, name: it.name, conf: it.conf ?? 1 };
        if (Array.isArray(it.box_2d) && it.box_2d.length === 4) { const [ymin, xmin, , xmax] = it.box_2d;
          o.x = Math.round((xmin + xmax) / 2 / 1000 * w); o.y = Math.round(ymin / 1000 * h); }
        return o; });
      const view = ["open", "blocked", "dark"].includes(parsed?.view) ? parsed.view : undefined;   // ★10 바깥이 보이나 — 앱은 «blocked» 면 그 방향 이름표를 치운다
      return reply({ labels, view, how, ms: Date.now() - t0 });
    } catch (e) { return reply({ labels: [], error: "중계 오류: " + String(e).slice(0, 120) }); }
  },
};
