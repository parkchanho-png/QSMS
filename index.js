// =====================================================================
// LabelGuard AI - Cloudflare Worker (v21)
// 구조: OCR(클라이언트) → 규칙 엔진(무료) → 필요한 줄만 AI → 그룹핑 → 캐시
//
// 엔드포인트
//   POST /              검수 (mode: LABEL | AD | PAGE)
//   GET  /collect?url=  상품 페이지에서 상세 이미지 주소 수집
//   GET  /img?url=      허용된 도메인의 이미지를 CORS 허용 상태로 대신 가져오기
//
// [선택 설정]
//  - env.GEMINI_API_KEY      (필수) 시크릿
//  - env.LAW_API_KEY         (선택) 국가법령정보센터 OC 값
//  - env.CACHE               (선택) KV 네임스페이스 바인딩 → 결과/법령 캐시
//  - env.ALLOWED_ORIGIN      (선택) 허용 출처, 쉼표 구분. 미설정 시 전체 허용(*)
//  - env.GEMINI_MODELS       (선택) 쉼표 구분 모델 목록
//  - env.ALLOWED_IMAGE_HOSTS (선택) 수집/프록시 허용 도메인, 쉼표 구분
//                            기본값: thebornmall.com, theborn.speedgabia.com
// =====================================================================

const RULES_VERSION = "2026-10-v2";
const CONF_TRUST = 75;
const CONF_DEEP = 60;
const MAX_AI_LINES = 40;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PROXY_BYTES = 20 * 1024 * 1024;
const MAX_OCR_LINES = 3000;
const LAW_TTL_MS = 6 * 60 * 60 * 1000;
const RESULT_TTL_SEC = 7 * 24 * 60 * 60;
const DEFAULT_MODELS = ["gemini-2.5-flash", "gemini-flash-latest"];
const DEFAULT_LAW_TEXT = "[기본 모드] 식약처 고시 『식품등의 표시기준』 적용";
const DEFAULT_IMAGE_HOSTS = ["thebornmall.com", "theborn.speedgabia.com"];
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

let lawMemCache = null; // { value, at }

// ---------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const squash = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, "")
    .replace(/[·•・,.\-_~'"“”‘’()\[\]{}:;!?]/g, "");

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseAIJSON(raw) {
  if (!raw) return null;
  let str = typeof raw === "string" ? raw : JSON.stringify(raw);
  str = str.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const start = str.indexOf("{");
  const end = str.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(str.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

function buildCors(request, env) {
  const allowed = (env.ALLOWED_ORIGIN || "*").trim();
  const origin = request.headers.get("Origin") || "";
  let allowOrigin = "*";
  let ok = true;
  if (allowed !== "*") {
    const list = allowed.split(",").map((s) => s.trim());
    ok = list.includes(origin);
    allowOrigin = ok ? origin : list[0];
  }
  return {
    ok,
    headers: {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    },
  };
}

function jsonResponse(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------
// 법령 정보
// ---------------------------------------------------------------------
function xmlTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
  return m ? m[1].trim() : "";
}

async function getLawInfo(env) {
  const apiKey = (env.LAW_API_KEY || "").trim();
  if (!apiKey) return { text: DEFAULT_LAW_TEXT + " (API 키 미설정)", version: "none" };

  const now = Date.now();
  if (lawMemCache && now - lawMemCache.at < LAW_TTL_MS) return lawMemCache.value;

  if (env.CACHE) {
    try {
      const c = await env.CACHE.get("law:food-label", { type: "json" });
      if (c && now - c.at < LAW_TTL_MS) {
        lawMemCache = c;
        return c.value;
      }
    } catch (e) {}
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const url = `https://www.law.go.kr/DRF/lawSearch.do?OC=${encodeURIComponent(apiKey)}&target=admrul&query=${encodeURIComponent("식품등의 표시기준")}&type=XML`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error("law api " + res.status);

    const xml = await res.text();
    const blocks = [...xml.matchAll(/<admrul[^>]*>([\s\S]*?)<\/admrul>/g)].map((m) => m[1]);
    const cands = blocks
      .map((b) => ({
        name: xmlTag(b, "행정규칙명"),
        date: xmlTag(b, "시행일자"),
        num: xmlTag(b, "발령번호"),
      }))
      .filter((c) => c.name.replace(/\s/g, "") === "식품등의표시기준");
    if (cands.length === 0) throw new Error("law not found");
    cands.sort((a, b) => b.date.localeCompare(a.date));
    const top = cands[0];

    const value = {
      text: `[국가법령정보센터 조회] 식약처 고시 『식품등의 표시기준』 (시행일자: ${top.date || "확인불가"}${top.num ? `, 제${top.num}호` : ""})`,
      version: `${top.date}-${top.num}`,
    };
    lawMemCache = { value, at: now };
    if (env.CACHE) {
      try {
        await env.CACHE.put("law:food-label", JSON.stringify(lawMemCache), { expirationTtl: 86400 });
      } catch (e) {}
    }
    return value;
  } catch (e) {
    if (lawMemCache) {
      return { text: lawMemCache.value.text + " (최근 조회값 유지)", version: lawMemCache.value.version };
    }
    return { text: DEFAULT_LAW_TEXT, version: "default" };
  }
}

// ---------------------------------------------------------------------
// Gemini 호출
// ---------------------------------------------------------------------
async function callGeminiJSON(env, parts) {
  const apiKey = (env.GEMINI_API_KEY || "").trim();
  if (!apiKey) throw new Error("서버 GEMINI_API_KEY가 설정되지 않았습니다.");
  const models = env.GEMINI_MODELS ? env.GEMINI_MODELS.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_MODELS;
  let lastError = "";

  for (const model of models) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const body = JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
    });

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body,
        });
        if (res.ok) {
          const data = await res.json();
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
          const parsed = parseAIJSON(text);
          if (parsed) return parsed;
          lastError = "AI 응답 JSON 파싱 실패";
          await delay(800);
          continue;
        }
        lastError = `${model} ${res.status}`;
        if (res.status === 404) break;
        if ((res.status === 503 || res.status === 429) && attempt < 2) {
          await delay(1500 * (attempt + 1));
          continue;
        }
        break;
      } catch (e) {
        lastError = e.message;
        await delay(1000 * (attempt + 1));
      }
    }
  }
  throw new Error(`[AI 오류] ${lastError}`);
}

// ---------------------------------------------------------------------
// 광고 규칙 사전
// ---------------------------------------------------------------------
const PERCENT_RE = /\d+(\.\d+)?\s*%|퍼센트|함량/;

const AD_RULES = [
  {
    id: "RULE_INGREDIENT_PERCENT",
    keywords: ["등심", "통등심", "안심", "찹쌀", "한우", "돼지고기", "삼겹살", "새우", "치즈", "소고기", "닭가슴살"],
    exclude: PERCENT_RE,
    level: "HIGH",
    issue: "원재료명 강조 표기 시 함량(%) 누락",
    reason: "특정 원재료를 강조하면서 함량(%)이 같은 문구에 없습니다. 표시광고법상 강조 원재료는 함량 표시가 필요할 수 있습니다. (다른 문구에 함량이 표기돼 있는지 확인하세요)",
    getAction: (t) => {
      const s = squash(t);
      let m = "원재료";
      if (s.includes("등심")) m = "돼지고기(등심)";
      else if (s.includes("찹쌀")) m = "찹쌀";
      else if (s.includes("새우")) m = "새우";
      else if (s.includes("치즈")) m = "치즈";
      return `강조 문구 주변에 '${m} 00%'처럼 정확한 함량을 표기하세요.`;
    },
  },
  {
    id: "RULE_DISEASE_CLAIM",
    keywords: ["치료", "질병예방", "암예방", "항암", "당뇨", "혈당", "혈압", "콜레스테롤", "탈모", "디톡스", "해독", "면역력"],
    level: "HIGH",
    issue: "질병 예방·치료 / 의약품 오인 표현",
    reason: "일반식품에서 질병의 예방·치료 효능이나 의약품으로 오인할 수 있는 표현은 식품표시광고법 위반 소지가 큽니다.",
    getAction: () => "해당 표현을 삭제하고, 객관적으로 입증된 영양성분 정보 중심으로 수정하세요.",
  },
  {
    id: "RULE_HEALTH_FUNC",
    keywords: ["다이어트", "체지방", "항산화", "노화방지", "피부미용", "장건강", "숙면", "피로회복", "기억력"],
    level: "MEDIUM",
    issue: "건강기능식품 오인 우려 표현",
    reason: "일반식품이 특정 기능성을 가진 것처럼 보이면 건강기능식품으로 오인시킬 수 있습니다.",
    getAction: () => "기능성 표현을 삭제하거나 맛·식감 등 일반적 표현으로 바꾸세요.",
  },
  {
    id: "RULE_BEST_PROOF",
    keywords: ["특제", "깨끗한", "최상", "최고", "1위", "특허", "시그니처", "가장많은", "원물그대로", "풍부한", "노하우", "비법", "전문점의맛"],
    level: "MEDIUM",
    issue: "객관적 실증이 필요한 최상급/우수성 표현",
    reason: "객관적 실증 자료 없이 최상급·우수성을 주장하면 실증자료 제출 요구 대상이 될 수 있습니다.",
    getAction: () => "시험성적서 등 실증자료를 확보하거나, 일반적 표현으로 완화하세요.",
  },
  {
    id: "RULE_COOKING_EXAMPLE",
    keywords: ["조리예", "연출된", "연출"],
    level: "LOW",
    issue: "조리예/연출 문구 확인",
    reason: "'조리예/연출' 문구가 확인되었습니다. 글자 크기와 위치(소비자가 쉽게 읽을 수 있는지)는 원본에서 육안으로 확인이 필요합니다.",
    getAction: () => "이미지 인근에 '조리예' 문구가 충분히 크고 잘 보이는지 확인하세요.",
  },
];

const LEVEL_KR = { HIGH: "상 (무조건 수정)", MEDIUM: "중 (수정 권장)", LOW: "하 (참고)" };
const LEVEL_ORDER = { HIGH: 1, MEDIUM: 2, LOW: 3 };

function matchRules(text) {
  const sq = squash(text);
  if (!sq) return [];
  return AD_RULES.filter(
    (r) => r.keywords.some((k) => sq.includes(squash(k))) && !(r.exclude && r.exclude.test(text))
  );
}

// 같은 규칙 + 같은 문구 → 1건, 위치는 {img, y} 배열로 보관, 같은 규칙은 한 카드로
function groupRisks(lines) {
  const groups = new Map();
  for (const line of lines) {
    for (const rule of matchRules(line.text)) {
      if (!groups.has(rule.id)) groups.set(rule.id, { rule, phrases: new Map() });
      const g = groups.get(rule.id);
      const key = squash(line.text);
      if (!g.phrases.has(key)) g.phrases.set(key, { text: line.text, count: 0, positions: [] });
      const p = g.phrases.get(key);
      p.count++;
      const pos = { img: line.img || 0, y: Math.round(line.y) };
      if (!p.positions.some((q) => q.img === pos.img && q.y === pos.y)) p.positions.push(pos);
    }
  }

  const byPos = (a, b) => a.img - b.img || a.y - b.y;
  const risks = [...groups.values()].map(({ rule, phrases }) => {
    const list = [...phrases.values()].map((p) => ({ ...p, positions: p.positions.sort(byPos) }));
    list.sort((a, b) => byPos(a.positions[0], b.positions[0]));
    return {
      rule_id: rule.id,
      level: rule.level,
      level_kr: LEVEL_KR[rule.level],
      issue: rule.issue,
      reason: rule.reason,
      action: rule.getAction(list[0].text),
      occurrence_count: list.reduce((s, p) => s + p.count, 0),
      phrases: list,
    };
  });
  risks.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  return risks;
}

// ---------------------------------------------------------------------
// OCR 입력 파싱
// ---------------------------------------------------------------------
function parseOcr(raw) {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x.text === "string")
      .slice(0, MAX_OCR_LINES)
      .map((x, i) => ({
        id: i,
        text: x.text.slice(0, 300),
        y: clamp(Number(x.y_percent) || 10, 1, 99),
        conf: Number(x.conf) || 0,
        img: Math.max(0, Math.floor(Number(x.img) || 0)),
        kind: x.kind === "LABEL" ? "LABEL" : "AD",
      }));
  } catch (e) {
    return [];
  }
}

function ocrStats(lines) {
  const n = lines.length || 1;
  const avg = Math.round(lines.reduce((s, l) => s + l.conf, 0) / n);
  const low = lines.filter((l) => l.conf < CONF_TRUST).length;
  return { line_count: lines.length, avg_conf: avg, low_conf_lines: low };
}

// ---------------------------------------------------------------------
// 광고 모드
// ---------------------------------------------------------------------
async function handleAd({ lines, deep, env, getImagePart, law }) {
  const notes = [];
  let aiCalls = 0;

  let targets = lines.filter((l) => matchRules(l.text).length > 0 && l.conf < CONF_TRUST);
  if (deep) {
    const extra = lines.filter((l) => matchRules(l.text).length === 0 && l.conf < CONF_DEEP);
    targets = targets.concat(extra);
  }
  targets = targets.slice(0, MAX_AI_LINES);

  if (targets.length > 0) {
    try {
      const prompt = `당신은 한국어 식품 광고 문구 교정자입니다.
아래는 OCR이 읽은 문구입니다(오타 가능). 각 항목의 id는 그대로 유지하고, 한국어 문맥에 맞게 오타만 교정하세요. 의미를 바꾸거나 문구를 합치거나 쪼개지 마세요.${deep ? "\n첨부된 원본 이미지를 참고해도 됩니다." : ""}
[입력]
${JSON.stringify(targets.map((t) => ({ id: t.id, text: t.text })))}
[응답 JSON]
{ "items": [ { "id": 숫자, "text": "교정된 문구" } ] }`;
      const parts = [{ text: prompt }];
      if (deep && getImagePart) parts.push(await getImagePart());
      const out = await callGeminiJSON(env, parts);
      aiCalls++;
      const byId = new Map(lines.map((l) => [l.id, l]));
      for (const it of out.items || []) {
        const target = byId.get(it.id);
        if (target && typeof it.text === "string" && it.text.length >= 2 && it.text.length <= 300) {
          target.text = it.text;
        }
      }
    } catch (e) {
      notes.push("AI 교정에 실패하여 OCR 원문 기준으로 판정했습니다. (" + e.message + ")");
    }
  }

  const stats = ocrStats(lines);
  if (lines.length > 0 && stats.avg_conf < 60) {
    notes.push("OCR 평균 신뢰도가 낮습니다. 누락 가능성이 있으니 원본과 함께 확인하세요.");
  }

  const risks = groupRisks(lines);
  const count = (lv) => risks.filter((r) => r.level === lv).length;
  return {
    inspect_mode: "AD",
    law_status: law.text,
    risk_summary: {
      total_issues: risks.length,
      total_occurrences: risks.reduce((s, r) => s + r.occurrence_count, 0),
      high_count: count("HIGH"),
      medium_count: count("MEDIUM"),
      low_count: count("LOW"),
    },
    risk_details: risks,
    meta: { ai_used: aiCalls > 0, ai_calls: aiCalls, ai_lines: targets.length, ...stats, notes },
  };
}

// ---------------------------------------------------------------------
// 라벨 모드
// ---------------------------------------------------------------------
const fz = (w) => w.split("").join("\\s*");

function pickField(text, words, maxLen = 120) {
  const re = new RegExp("(?:" + words.map(fz).join("|") + ")\\s*[:：]?\\s*([^\\n]{1," + maxLen + "})");
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

function pickBlock(text, startWords, stopWords, maxLen = 300) {
  const startRe = new RegExp("(?:" + startWords.map(fz).join("|") + ")\\s*[:：]?\\s*");
  const m = startRe.exec(text);
  if (!m) return "";
  let rest = text.slice(m.index + m[0].length, m.index + m[0].length + maxLen);
  const stopRe = new RegExp("(?:" + stopWords.map(fz).join("|") + ")");
  const s = stopRe.exec(rest);
  if (s && s.index > 0) rest = rest.slice(0, s.index);
  return rest.replace(/\s+/g, " ").trim();
}

const LABEL_FIELDS = [
  { key: "product_name", name: "제품명" },
  { key: "food_type", name: "식품유형" },
  { key: "business_name", name: "영업소 명칭" },
  { key: "address", name: "소재지 주소" },
  { key: "expiration_date", name: "소비기한" },
  { key: "net_weight", name: "내용량" },
  { key: "ingredients", name: "원재료명" },
  { key: "nutrition", name: "영양성분" },
  { key: "package_material", name: "용기포장재질" },
  { key: "caution", name: "주의사항" },
];

const STOP_WORDS = ["영양성분", "영양정보", "포장재질", "보관방법", "주의사항", "반품", "소비기한", "내용량", "식품유형", "제조원", "소재지"];

function extractLabelByRules(text) {
  const out = {};
  out.product_name = pickField(text, ["제품명", "품명"]);
  out.food_type = pickField(text, ["식품유형", "식품의유형"]);
  out.business_name = pickField(text, ["제조원", "판매원", "영업소명칭", "수입원", "제조업소", "제조업체"]);
  out.address = pickField(text, ["소재지", "주소"], 150);
  out.expiration_date = pickField(text, ["소비기한", "유통기한", "품질유지기한"]);
  out.net_weight = pickField(text, ["내용량", "중량"], 40);
  if (!out.net_weight) {
    const m = text.match(/\d[\d,.]*\s*(?:kg|g|ml|mL|L|㎖|ℓ)\b/);
    if (m) out.net_weight = m[0];
  }
  out.ingredients = pickBlock(text, ["원재료명", "원재료"], STOP_WORDS.filter((w) => w !== "원재료"), 400);
  out.nutrition = pickBlock(text, ["영양성분", "영양정보"], ["원재료", "포장재질", "주의사항", "보관방법"], 250);
  out.package_material = pickField(text, ["용기포장재질", "포장재질", "포장재"], 60);
  out.caution = pickBlock(text, ["주의사항", "보관방법", "부정불량식품"], ["제조원", "판매원"], 200);
  return out;
}

const ALLERGENS = ["우유", "대두", "밀", "계란", "난류", "땅콩", "새우", "게", "고등어", "돼지고기", "닭고기", "쇠고기", "복숭아", "토마토", "오징어", "조개류", "호두", "잣", "아황산"];

function validateLabelContent(label, fullText) {
  const warnings = [];
  if (label.net_weight && !/\d/.test(label.net_weight)) {
    warnings.push({ item: "내용량", message: "내용량에 숫자 단위(g, ml 등)가 확인되지 않습니다." });
  }
  if (label.expiration_date && !/\d|까지|제조일|표시/.test(label.expiration_date)) {
    warnings.push({ item: "소비기한", message: "소비기한 날짜 또는 표기 방식이 불명확합니다." });
  }
  if (label.ingredients) {
    const sq = squash(label.ingredients);
    const hit = ALLERGENS.filter((a) => sq.includes(a));
    if (hit.length > 0 && !/알레르기|알러지|함유/.test(fullText)) {
      warnings.push({
        item: "알레르기 표시",
        message: `원재료에 알레르기 유발 가능 성분(${hit.slice(0, 5).join(", ")})이 있으나 알레르기 표시 문구가 확인되지 않습니다.`,
      });
    }
  }
  return warnings;
}

function normForCompare(s) {
  return (s || "").replace(/[\s()\[\]·,.\-]/g, "").replace(/㈜|\(주\)|주식회사/g, "").toLowerCase();
}
function looselyMatches(a, b) {
  const x = normForCompare(a);
  const y = normForCompare(b);
  if (!x || !y) return null;
  if (x.includes(y) || y.includes(x)) return true;
  const setY = new Set(y.split(""));
  const common = x.split("").filter((c) => setY.has(c)).length;
  return common / Math.max(x.length, y.length) >= 0.8;
}

async function handleLabel({ lines, deep, docFile, env, getImagePart, law }) {
  const notes = [];
  let aiCalls = 0;
  const fullText = lines.map((l) => l.text).join("\n");
  const label = extractLabelByRules(fullText);
  const stats = ocrStats(lines);

  let missing = LABEL_FIELDS.filter((f) => !label[f.key]);

  const mergeAI = (out) => {
    const data = out.label_data || out;
    for (const f of LABEL_FIELDS) {
      const v = typeof data[f.key] === "string" ? data[f.key].trim() : "";
      if (!label[f.key] && v && !/^(없음|누락|해당없음)$/.test(v)) label[f.key] = v;
    }
  };
  const buildPrompt = (withImage) => `당신은 식약처 식품표시사항 심사 AI입니다.
아래 OCR 텍스트에서 다음 항목만 찾아 정확히 교정해 채우세요: ${missing.map((m) => m.key).join(", ")}
라벨에 실제로 없는 항목은 반드시 빈 문자열("")로 두세요. 추측하지 마세요.${withImage ? "\n첨부된 원본 이미지를 직접 대조하세요." : ""}
[OCR 텍스트]
${fullText.slice(0, 6000)}
[응답 JSON]
{ "label_data": { ${missing.map((m) => `"${m.key}": ""`).join(", ")} } }`;

  if (missing.length > 0) {
    try {
      mergeAI(await callGeminiJSON(env, [{ text: buildPrompt(false) }]));
      aiCalls++;
    } catch (e) {
      notes.push("AI 보완에 실패했습니다. (" + e.message + ")");
    }
    missing = LABEL_FIELDS.filter((f) => !label[f.key]);
    if (deep && getImagePart && missing.length > 0) {
      try {
        mergeAI(await callGeminiJSON(env, [{ text: buildPrompt(true) }, await getImagePart()]));
        aiCalls++;
      } catch (e) {
        notes.push("이미지 기반 AI 재판독에 실패했습니다. (" + e.message + ")");
      }
    }
  }

  if (stats.avg_conf < 65) notes.push("OCR 신뢰도가 낮아 추출값에 오류가 있을 수 있습니다. 원본과 대조하세요.");

  const passed = [];
  const failed = [];
  for (const f of LABEL_FIELDS) {
    if (label[f.key]) passed.push({ name: f.name, detail: label[f.key] });
    else failed.push({ item_name: f.name, issue_reason: `${f.name} 항목을 확인하지 못했습니다.`, how_to_improve: `${f.name}을(를) 라벨에 명시하거나, 이미지 해상도를 높여 다시 검수하세요.` });
  }

  const warnings = validateLabelContent(label, fullText);

  let docCheck = null;
  if (docFile) {
    try {
      const buf = await docFile.arrayBuffer();
      const out = await callGeminiJSON(env, [
        { text: `사업자등록증 등 증빙서류 이미지에서 상호(법인명)와 사업장 소재지를 추출하세요.\n[응답 JSON]\n{ "business_name": "", "address": "" }` },
        { inlineData: { mimeType: docFile.type || "image/jpeg", data: toBase64(buf) } },
      ]);
      aiCalls++;
      docCheck = {
        doc_business_name: out.business_name || "",
        doc_address: out.address || "",
        business_match: looselyMatches(label.business_name, out.business_name),
        address_match: looselyMatches(label.address, out.address),
      };
    } catch (e) {
      notes.push("증빙서류 판독에 실패했습니다. (" + e.message + ")");
    }
  }

  return {
    inspect_mode: "LABEL",
    law_status: law.text,
    summary: `필수 10개 항목 중 ${passed.length}개 확인, ${failed.length}개 미확인, 내용 경고 ${warnings.length}건`,
    analyzed_summary: { product_name: label.product_name || "미확인", food_type: label.food_type || "미확인" },
    passed_items: passed,
    failed_items: failed,
    warnings,
    doc_check: docCheck,
    meta: { ai_used: aiCalls > 0, ai_calls: aiCalls, ...stats, notes },
  };
}

// ---------------------------------------------------------------------
// URL 일괄 검수 (PAGE): 광고 줄 / 라벨 줄을 나눠서 각각 검수
// ---------------------------------------------------------------------
async function handlePage({ lines, env, law }) {
  const adLines = lines.filter((l) => l.kind !== "LABEL");
  const labelLines = lines.filter((l) => l.kind === "LABEL");

  const ad = await handleAd({ lines: adLines, deep: false, env, getImagePart: null, law });
  const label =
    labelLines.length > 0
      ? await handleLabel({ lines: labelLines, deep: false, docFile: null, env, getImagePart: null, law })
      : null;

  const aiCalls = (ad.meta.ai_calls || 0) + (label ? label.meta.ai_calls || 0 : 0);
  return {
    inspect_mode: "PAGE",
    law_status: law.text,
    ad,
    label,
    meta: { ai_used: aiCalls > 0, ai_calls: aiCalls, line_count: lines.length },
  };
}

// ---------------------------------------------------------------------
// 이미지 수집 / 프록시
// ---------------------------------------------------------------------
function allowedHosts(env) {
  return env.ALLOWED_IMAGE_HOSTS
    ? env.ALLOWED_IMAGE_HOSTS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_IMAGE_HOSTS;
}

function isAllowedUrl(u, env) {
  try {
    const x = new URL(u);
    if (x.protocol !== "https:" && x.protocol !== "http:") return false;
    const h = x.hostname.toLowerCase();
    if (/^[\d.]+$/.test(h) || h.includes(":")) return false; // IP 직접 접근 차단
    return allowedHosts(env).some((a) => h === a || h.endsWith("." + a));
  } catch (e) {
    return false;
  }
}

// 파일명이 UTF-8 hex로 인코딩된 경우(예: ED9598EB8BA8_...) 한글로 풀어서 반환
function decodeHexFileName(url) {
  try {
    const file = decodeURIComponent(new URL(url).pathname.split("/").pop() || "").replace(/\.[a-z0-9]+$/i, "");
    return file
      .split("_")
      .map((part) => {
        if (part.length >= 6 && part.length % 2 === 0 && /^[0-9a-f]+$/i.test(part)) {
          try {
            const bytes = new Uint8Array(part.match(/../g).map((h) => parseInt(h, 16)));
            return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch (e) {
            return part;
          }
        }
        return part;
      })
      .join("_");
  } catch (e) {
    return "";
  }
}

const EXCLUDE_PATH_RE = /\.(svg|gif)(\?|$)|\/design\/|\/web\/upload\/img\/|\/web\/product\/(tiny|small|medium|big|extra)\/|\/web\/upload\/custom_|logo/i;
const EXCLUDE_NOTICE_RE = /배송|취소|교환|반품|환불/;

function keepDetailImage(url, env) {
  if (!isAllowedUrl(url, env)) return false;
  if (EXCLUDE_PATH_RE.test(url)) return false;
  if (EXCLUDE_NOTICE_RE.test(decodeHexFileName(url))) return false;
  return true;
}

const IMG_ATTRS = ["src", "data-src", "ec-data-src", "data-original", "data-lazy-src", "ec-data-original"];

function extractImageUrls(html, baseUrl, env) {
  const found = [];
  const seen = new Set();
  let excluded = 0;
  const add = (raw) => {
    if (!raw || raw.startsWith("data:")) return;
    let abs;
    try {
      abs = new URL(raw.trim().replace(/&amp;/g, "&"), baseUrl).href;
    } catch (e) {
      return;
    }
    if (seen.has(abs)) return;
    seen.add(abs);
    if (keepDetailImage(abs, env)) found.push(abs);
    else excluded++;
  };

  // 1) <img> 태그 (DOM 순서 유지)
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    for (const attr of IMG_ATTRS) {
      const am = tag.match(new RegExp("[\\s]" + attr + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')", "i"));
      if (am) add(am[1] || am[2]);
    }
  }
  // 2) 스크립트/JSON 안에 들어 있는 이미지 주소
  for (const m of html.matchAll(/(?:https?:)?\/\/[^\s"'<>)\\]+?\.(?:jpe?g|png|webp)(?:\?[^\s"'<>)\\]*)?/gi)) {
    add(m[0]);
  }
  return { images: found, excluded };
}

async function handleCollect(url, cors, env) {
  const target = (url.searchParams.get("url") || "").trim();
  if (!isAllowedUrl(target, env)) {
    return jsonResponse({ success: false, error: `지원하지 않는 사이트입니다. (허용: ${allowedHosts(env).join(", ")})` }, 400, cors.headers);
  }
  try {
    const res = await fetch(target, {
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": "ko-KR,ko;q=0.9", Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`페이지 응답 오류 (HTTP ${res.status})`);
    if (!isAllowedUrl(res.url, env)) throw new Error("허용되지 않은 주소로 이동되었습니다.");
    const html = await res.text();
    const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "";
    const { images, excluded } = extractImageUrls(html, res.url || target, env);

    const notes = [];
    if (images.length === 0) {
      notes.push("상세 이미지를 찾지 못했습니다. 페이지가 자바스크립트로 이미지를 불러오는 구조일 수 있습니다. 브라우저에서 확인한 이미지 주소를 직접 입력해 주세요.");
    }
    return jsonResponse({ success: true, title: title.trim(), images, excluded_count: excluded, notes }, 200, cors.headers);
  } catch (e) {
    return jsonResponse({ success: false, error: "페이지 수집 실패: " + e.message }, 502, cors.headers);
  }
}

async function handleImg(url, cors, env) {
  const target = (url.searchParams.get("url") || "").trim();
  if (!isAllowedUrl(target, env)) return jsonResponse({ success: false, error: "허용되지 않은 도메인입니다." }, 400, cors.headers);
  try {
    const res = await fetch(target, {
      headers: { "User-Agent": BROWSER_UA, Referer: "https://thebornmall.com/", Accept: "image/*" },
      redirect: "follow",
    });
    if (!res.ok) return jsonResponse({ success: false, error: `이미지 응답 오류 (HTTP ${res.status})` }, 502, cors.headers);
    if (!isAllowedUrl(res.url, env)) return jsonResponse({ success: false, error: "허용되지 않은 주소로 이동되었습니다." }, 400, cors.headers);
    const type = res.headers.get("content-type") || "";
    if (!type.startsWith("image/")) return jsonResponse({ success: false, error: "이미지가 아닙니다." }, 415, cors.headers);
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_PROXY_BYTES) return jsonResponse({ success: false, error: "이미지 용량이 너무 큽니다." }, 413, cors.headers);
    return new Response(res.body, {
      status: 200,
      headers: { ...cors.headers, "Content-Type": type, "Cache-Control": "public, max-age=3600" },
    });
  } catch (e) {
    return jsonResponse({ success: false, error: "이미지 가져오기 실패: " + e.message }, 502, cors.headers);
  }
}

// ---------------------------------------------------------------------
// 엔트리
// ---------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const cors = buildCors(request, env);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors.headers });
    if (!cors.ok) return jsonResponse({ success: false, error: "허용되지 않은 출처입니다." }, 403, cors.headers);

    const url = new URL(request.url);

    if (request.method === "GET") {
      if (url.pathname === "/collect") return handleCollect(url, cors, env);
      if (url.pathname === "/img") return handleImg(url, cors, env);
      return jsonResponse({ success: false, error: "알 수 없는 경로입니다." }, 404, cors.headers);
    }
    if (request.method !== "POST") return jsonResponse({ success: false, error: "지원하지 않는 요청입니다." }, 405, cors.headers);

    try {
      const formData = await request.formData();
      const modeRaw = String(formData.get("mode") || "LABEL").toUpperCase();
      const mode = modeRaw === "AD" || modeRaw === "PAGE" ? modeRaw : "LABEL";
      const deep = mode !== "PAGE" && formData.get("deep") === "1";
      const imageFile = formData.get("image");
      const docFile = mode === "LABEL" ? formData.get("doc") : null;
      const lines = parseOcr(String(formData.get("tesseract_ocr") || "[]"));

      if (imageFile && imageFile.size > MAX_IMAGE_BYTES) throw new Error("이미지 용량이 너무 큽니다. (최대 10MB)");
      if (lines.length === 0 && !deep) {
        throw new Error("OCR로 읽어낸 텍스트가 없습니다. 이미지 해상도를 확인하거나 '정밀 모드'로 다시 시도하세요.");
      }
      if (lines.length === 0 && deep && !imageFile) throw new Error("분석할 이미지가 전송되지 않았습니다.");

      const law = await getLawInfo(env);

      let imagePart = null;
      const getImagePart = async () => {
        if (!imageFile) throw new Error("이미지가 전송되지 않았습니다.");
        if (!imagePart) {
          imagePart = { inlineData: { mimeType: imageFile.type || "image/jpeg", data: toBase64(await imageFile.arrayBuffer()) } };
        }
        return imagePart;
      };

      let cacheKey = null;
      if (env.CACHE && !docFile) {
        const sig = JSON.stringify({
          mode, deep, v: RULES_VERSION, law: law.version,
          l: lines.map((l) => [squash(l.text), Math.round(l.y), l.img, l.kind]),
        });
        cacheKey = "res:" + (await sha256(sig));
        try {
          const hit = await env.CACHE.get(cacheKey, { type: "json" });
          if (hit) {
            hit.meta = { ...(hit.meta || {}), cache_hit: true, ai_used: false, ai_calls: 0 };
            return jsonResponse({ success: true, result: hit }, 200, cors.headers);
          }
        } catch (e) {}
      }

      let result;
      if (mode === "AD") result = await handleAd({ lines, deep, env, getImagePart, law });
      else if (mode === "PAGE") result = await handlePage({ lines, env, law });
      else result = await handleLabel({ lines, deep, docFile, env, getImagePart, law });

      if (cacheKey) {
        try {
          await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: RESULT_TTL_SEC });
        } catch (e) {}
      }
      return jsonResponse({ success: true, result }, 200, cors.headers);
    } catch (err) {
      return jsonResponse({ success: false, error: err.message }, 500, cors.headers);
    }
  },
};
