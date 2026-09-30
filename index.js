// ArrayBuffer -> Base64 변환
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 📌 1단계: 안전 JSON 파서
function parseAIJSON(raw) {
  if (!raw) return null;
  let str = typeof raw === "string" ? raw : JSON.stringify(raw);
  str = str.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const start = str.indexOf('{');
  const end = str.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(str.slice(start, end + 1)); } 
  catch (e) { return null; }
}

// 📌 2단계: JS 백엔드 룰 엔진 (AI 오탐 방지 및 유형별 체크리스트 강제)
function processRulesEngine(aiData) {
  if (!aiData) return null;

  const category = aiData.category || "FOOD";
  const label = aiData.label_data || {};
  const doc = aiData.doc_data || {};

  let passedItems = [];
  let failedItems = [];
  let optionalItems = [];
  let crossCheck = [];

  // [A] 용기·포장류 (도자기, 유리, 텀블러 등) 규칙 엔진
  if (category === "CONTAINER") {
    const containerRules = [
      { key: "food_safe_mark", name: "식품용 문구/마크", law: "기구 및 용기·포장 표시기준" },
      { key: "material", name: "재질명", law: "기구 및 용기·포장 표시기준" },
      { key: "business_name", name: "영업소 명칭(제조원/판매원)", law: "기구 및 용기·포장 표시기준" },
      { key: "address", name: "영업소 소재지(주소)", law: "기구 및 용기·포장 표시기준" },
      { key: "caution", name: "보관 및 취급상 주의사항", law: "기구 및 용기·포장 표시기준" }
    ];

    containerRules.forEach(rule => {
      const val = (label[rule.key] || "").trim();
      if (val && !val.includes("없음") && !val.includes("미표기") && !val.includes("누락")) {
        passedItems.push({ name: rule.name, detail: val });
      } else {
        failedItems.push({
          item_name: rule.name,
          found_text: "표기 없음(누락)",
          issue_reason: `${rule.name} 항목 누락`,
          law: rule.law,
          how_to_improve: `${rule.name} 정보를 라벨에 명확히 표기해야 합니다.`
        });
      }
    });
  } 
  // [B] 일반 가공식품 규칙 엔진 (10대 필수 항목)
  else {
    const foodRules = [
      { key: "product_name", name: "제품명", law: "식품등의 표시기준" },
      { key: "food_type", name: "식품유형", law: "식품등의 표시기준" },
      { key: "business_name", name: "영업소 명칭(제조원/판매원)", law: "식품등의 표시기준" },
      { key: "address", name: "영업소 소재지(주소)", law: "식품등의 표시기준" },
      { key: "expiration_date", name: "소비기한(유통기한)", law: "식품등의 표시기준" },
      { key: "net_weight", name: "내용량 및 열량", law: "식품등의 표시기준" },
      { key: "ingredients", name: "원재료명", law: "식품등의 표시기준" },
      { key: "nutrition", name: "영양성분", law: "식품등의 표시기준" },
      { key: "package_material", name: "용기·포장재질", law: "식품등의 표시기준" },
      { key: "caution", name: "보관방법 및 주의사항", law: "식품등의 표시기준" }
    ];

    foodRules.forEach(rule => {
      const val = (label[rule.key] || "").trim();
      if (val && !val.includes("없음") && !val.includes("미표기") && !val.includes("누락")) {
        passedItems.push({ name: rule.name, detail: val });
      } else {
        failedItems.push({
          item_name: rule.name,
          found_text: "표기 없음(누락)",
          issue_reason: `${rule.name} 항목 누락`,
          law: rule.law,
          how_to_improve: `${rule.name} 정보를 라벨에 명확히 표기해야 합니다.`
        });
      }
    });
  }

  // 선택 표기사항 분리
  if (label.optional_info) {
    optionalItems.push({ name: "권장 표기사항", detail: label.optional_info });
  }

  // [C] 백엔드 JS 교차 대조 (Cross-Check)
  const labelAddr = (label.address || "").replace(/\s+/g, "");
  const docAddr = (doc.address || "").replace(/\s+/g, "");

  if (!docAddr || docAddr.includes("없음") || docAddr.includes("미제출")) {
    crossCheck.push({
      item: "영업소 소재지",
      status: "mismatch",
      label_value: label.address || "라벨 표기값",
      doc_value: "증빙서류 미제출",
      note: "자료확인불가"
    });
  } else if (labelAddr === docAddr) {
    crossCheck.push({
      item: "영업소 소재지",
      status: "match",
      label_value: label.address,
      doc_value: doc.address,
      note: "일치함"
    });
  } else {
    crossCheck.push({
      item: "영업소 소재지",
      status: "mismatch",
      label_value: label.address,
      doc_value: doc.address,
      note: labelAddr.length < docAddr.length ? "상세주소 누락" : "주소 불일치"
    });
  }

  return {
    summary: category === "CONTAINER" 
      ? "기구 및 용기·포장류 기준에 맞춰 5대 필수 항목 정밀 검수를 완료했습니다." 
      : "가공식품 표시기준에 맞춰 10대 필수 항목 정밀 검수를 완료했습니다.",
    analyzed_summary: {
      product_name: aiData.product_name || "판독 완료",
      food_type: aiData.food_type || "분류 완료",
      detected_items_count: passedItems.length + failedItems.length + optionalItems.length
    },
    passed_items: passedItems,
    optional_items: optionalItems,
    failed_items: failedItems,
    cross_check: crossCheck
  };
}

export default {
  async fetch(request, env) {
    const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    
    const geminiApiKey = (env.GEMINI_API_KEY || "").trim();

    if (request.method === "GET") {
      if (!geminiApiKey) return new Response(JSON.stringify({ status: "ERROR", message: "GEMINI_API_KEY 없음" }), { headers: corsHeaders });
      return new Response(JSON.stringify({ system: "LabelGuard AI v5.0.0 (경량화 AI + 백엔드 JS 룰 엔진)" }), { headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });
    }

    if (request.method === "POST") {
      try {
        if (!geminiApiKey) throw new Error("[v5.0.0 오류] 서버 환경 변수(GEMINI_API_KEY)가 없습니다.");

        const formData = await request.formData();
        const labelFile = formData.get("image");
        const docFile = formData.get("doc");
        if (!labelFile) throw new Error("라벨 이미지가 전송되지 않았습니다.");

        const labelBuffer = await labelFile.arrayBuffer();
        const contentsParts = [{ inlineData: { mimeType: labelFile.type || "image/jpeg", data: arrayBufferToBase64(labelBuffer) } }];
        if (docFile && typeof docFile === "object" && docFile.arrayBuffer) {
          try { const docBuffer = await docFile.arrayBuffer(); if (docBuffer.byteLength > 0) contentsParts.push({ inlineData: { mimeType: docFile.type || "image/jpeg", data: arrayBufferToBase64(docBuffer) } }); } catch (e) {}
        }

        // 📌 AI 전용 경량화 프롬프트 (OCR 및 객체 추출만 담당)
        const promptText = `이미지에서 눈에 보이는 텍스트를 추출하고 제품 대분류를 판독하여 JSON으로 응답하세요.

[응답 JSON 규격]
{
  "category": "CONTAINER" 또는 "FOOD", // 도자기, 컵, 식기류, 텀블러는 CONTAINER / 먹는 식품은 FOOD
  "product_name": "제품명",
  "food_type": "식품유형 또는 재질명",
  "label_data": {
    "product_name": "라벨의 제품명",
    "food_type": "라벨의 식품유형",
    "food_safe_mark": "식품용 문구 표기 또는 잔/포크 마크 존재 여부",
    "material": "재질명 (예: 도자기제, 유리제)",
    "business_name": "영업소 명칭(제조원/판매원)",
    "address": "영업소 소재지 주소",
    "caution": "취급상 주의사항",
    "expiration_date": "소비기한 또는 유통기한",
    "net_weight": "내용량 및 열량",
    "ingredients": "원재료명",
    "nutrition": "영양성분",
    "package_material": "용기포장재질",
    "optional_info": "기타 표기사항(고객상담실 등)"
  },
  "doc_data": {
    "address": "두 번째 제출된 서류 이미지의 주소 (없으면 '없음')"
  }
}
* 라벨에서 해당 문구를 찾을 수 없는 필드는 "없음"으로 적으세요.`;

        contentsParts.unshift({ text: promptText });

        const targetModel = "gemini-3.6-flash";
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${geminiApiKey}`;
        const requestBody = { contents: [{ parts: contentsParts }], generationConfig: { responseMimeType: "application/json", temperature: 0.1 } };

        let rawResponseText = "";
        let lastErrorLog = "";
        const retryDelays = [1500, 3000, 4500];

        for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
          const geminiRes = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody)
          });

          if (geminiRes.ok) {
            const data = await geminiRes.json();
            rawResponseText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
            if (rawResponseText) break;
          } else {
            lastErrorLog = await geminiRes.text();
            if ((geminiRes.status === 503 || geminiRes.status === 429) && attempt < retryDelays.length) {
              await delay(retryDelays[attempt]);
            } else {
              break;
            }
          }
        }

        if (!rawResponseText) throw new Error(`[v5.0.0 서버 오류] ${targetModel} 요청 실패. 잠시 후 다시 눌러주세요. 상세: ${lastErrorLog.substring(0, 100)}`);

        const aiExtractedData = parseAIJSON(rawResponseText);
        if (!aiExtractedData) throw new Error("[v5.0.0 서버 오류] AI 추출 데이터 파싱 실패");

        // 📌 백엔드 JS 룰 엔진을 통한 검수 실행
        const finalReport = processRulesEngine(aiExtractedData);

        return new Response(JSON.stringify({ success: true, result: finalReport }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });

      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });
      }
    }
  }
};
