// 저게뭐야 «찍고 확인» 중계 Worker — Cloudflare 편집기에 통째로 붙여 넣는다. 설명은 AI_HANDOFF.md 4절
const ALLOWED_ORIGIN = "https://taehunha-gmail.github.io";
const MAX_BODY_BYTES = 3 * 1024 * 1024; // 3 MB

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
    // ★1 모델 이름을 코드에 박지 않는다 — 옛 이름(1.5)은 이미 내려간 모델일 수 있음. 비어 있으면 원인을 알려 준다
    if (!env.GEMINI_MODEL) return reply({ labels: [], error: "GEMINI_MODEL 미설정 — AI Studio 에서 보이는 최신 Flash 이름을 넣으세요" });
    if (!env.GEMINI_API_KEY) return reply({ labels: [], error: "GEMINI_API_KEY 미설정" });

    if (parseInt(request.headers.get("Content-Length") || "0", 10) > MAX_BODY_BYTES) return reply({ error: "Payload Too Large" }, 413);
    const raw = await request.arrayBuffer();
    if (raw.byteLength > MAX_BODY_BYTES) return reply({ error: "Payload Too Large" }, 413);
    let p; try { p = JSON.parse(new TextDecoder().decode(raw)); } catch { return reply({ error: "Invalid JSON" }, 400); }

    // ★7 점검: {"diag":true} 를 보내면 사진 없이 두 모델에 짧게 물어 상태·걸린 시간만 알려 준다
    const callG = async (model, body, ms) => { const t0 = Date.now();
      try { const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
        if (r.ok) return { ok: true, model, ms: Date.now() - t0, g: await r.json() };
        const t = await r.text(); let msg = t; try { msg = JSON.parse(t).error.message; } catch {}
        return { ok: false, model, ms: Date.now() - t0, status: r.status, msg: String(msg).slice(0, 120) };
      } catch (e) { return { ok: false, model, ms: Date.now() - t0, status: "timeout", msg: String(e).slice(0, 80) }; } };
    if (p.diag) {
      const q = { contents: [{ role: "user", parts: [{ text: "ok 라고만 답해" }] }], generationConfig: { thinkingConfig: { thinkingLevel: "low" } } };
      const res = await Promise.all([env.GEMINI_MODEL, env.GEMINI_FALLBACK].filter(Boolean).map(m => callG(m, q, 25000)));
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
    const prompt = `사진은 서울에서 폰 카메라로 찍은 풍경이다. 아래 후보는 GPS·나침반·지도로 계산한 «화면 안에 있을 수 있는 건물» 목록이고, x·y는 계산상 사진 속 위치다(0~1000 정규화, 오차 있음). 사진에 실제로 보이는 후보만 골라라. 가려졌거나 안 보이면 빼라. 보이는 것은 사진 속 실제 위치를 box_2d [ymin, xmin, ymax, xmax](0~1000)로 적어라. 후보에 없는 건물은 지어내지 마라. 확신도 conf(0~1)를 붙여라. 같은 단지의 비슷한 동처럼 구별이 안 되면 단지 이름 하나만 남겨라. 출력은 JSON 하나만: {"labels":[{"key":…,"name":…,"box_2d":[ymin,xmin,ymax,xmax],"conf":…}]}

[후보 건물 목록]
${JSON.stringify(cands)}`;

    const body = { contents: [{ role: "user", parts: [{ text: prompt }, { inline_data: { mime_type: mime, data } }] }],
                   generationConfig: { response_mime_type: "application/json", thinkingConfig: { thinkingLevel: "low" } } };   // ★6 생각은 짧게 — 오래 생각하면 수십 초
    try {
      // ★3 키는 헤더로. ★5 붐비면(503·429·500) 또는 늦으면 → 예비 모델(GEMINI_FALLBACK)로 바로 넘어간다(기다리며 같은 모델 재시도 안 함)
      const t0 = Date.now(), tries = [];
      let R = await callG(env.GEMINI_MODEL, body, 15000); tries.push(R);
      if (!R.ok && env.GEMINI_FALLBACK && [429, 500, 503, "timeout"].includes(R.status)) { R = await callG(env.GEMINI_FALLBACK, body, 25000); tries.push(R); }
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
      return reply({ labels, how, ms: Date.now() - t0 });
    } catch (e) { return reply({ labels: [], error: "중계 오류: " + String(e).slice(0, 120) }); }
  },
};
