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
  const jsonCandidate = str.slice(start, end + 1);
  try { return JSON.parse(jsonCandidate); } 
  catch (e) {
    try {
      const cleaned = jsonCandidate.replace(/[\u0000-\u001F]+/g, " ").replace(/,\s*([\}\]])/g, "$1");
      return JSON.parse(cleaned);
    } catch (e2) { return null; }
  }
}

// 📌 2단계: 고정 사전(Dictionary) 대조 테이블 - 절대로 바뀌지 않는 절대 기준
const AD_RULES_DICTIONARY = [
  {
    id: "RULE_INGREDIENT_PERCENT",
    keywords: ["등심", "통등심", "찹쌀", "안심", "삼겹살", "한우", "국산", "특제", "새우", "치즈"],
    exclude_keywords: ["%", "퍼센트", "함유", "g"], // 함량이 표기되어 있으면 통과
    level: "HIGH",
    issue: "특정 원재료명 강조 시 함량 미표기",
    reason: "상세페이지 전면 카피에서 특정 원재료를 강조하여 표기하였으나, 해당 원재료의 배합 비율(%)을 명시하지 않아 표시·광고 기준 위반 위험이 있습니다.",
    action: "강조된 원재료명 부근 또는 관련 이미지 주변에 '돼지고기(등심) 00%'와 같이 정확한 함량을 명확히 표기하세요."
  },
  {
    id: "RULE_BEST_PUFFING",
    keywords: ["깨끗한", "최상", "최고", "1위", "특허", "시그니처", "가장 많은", "전문점의 맛"],
    level: "MEDIUM",
    issue: "객관적 실증이 필요한 품질 우수성 표현 사용",
    reason: "객관적 실증 자료(산가 측정치, 설문조사 데이터 등) 없이 최상급 또는 우수성을 암시하는 표현을 사용 시 식약처 실증자료 제출 명령 대상이 될 수 있습니다.",
    action: "실증 자료(시험성적서 등)를 사전 확보하거나, '깔끔하게 튀겨낸', '인기 메뉴' 등으로 문구를 완화하세요."
  },
  {
    id: "RULE_COOKING_EXAMPLE",
    keywords: ["조리예", "연출된", "이미지"],
    level: "LOW",
    issue: "조리예 및 연출컷 문구 표기 상태",
    reason: "소비자 오인 방지를 위한 연출 문구가 정상 표기되어 있으나 시각적 식별성을 높이는 것을 권장합니다.",
    action: "사진 하단 연출 문구의 글자 크기를 조금 더 잘 보이도록 조정 권장합니다."
  }
];

// 📌 3단계: 한글표시사항 규칙 엔진
function processLabelRulesEngine(aiData) {
  if (!aiData) return null;

  const category = aiData.category || "FOOD";
  const label = aiData.label_data || {};
  const doc = aiData.doc_data || {};

  let passedItems = [];
  let failedItems = [];
  let optionalItems = [];
  let crossCheck = [];

  if (category === "CONTAINER") {
    const containerRules = [
      { key: "food_safe_mark", name: "식품용 문구/마크" },
      { key: "material", name: "재질명" },
      { key: "business_name", name: "영업소 명칭(제조원/판매원)" },
      { key: "address", name: "영업소 소재지(주소)" },
      { key: "caution", name: "보관 및 취급상 주의사항" }
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
          law: "기구 및 용기·포장 표시기준",
          how_to_improve: `${rule.name} 정보를 라벨에 명확히 표기해야 합니다.`
        });
      }
    });
  } else {
    const foodRules = [
      { key: "product_name", name: "제품명" },
      { key: "food_type", name: "식품유형" },
      { key: "business_name", name: "영업소 명칭(제조원/판매원)" },
      { key: "address", name: "영업소 소재지(주소)" },
      { key: "expiration_date", name: "소비기한(유통기한)" },
      { key: "net_weight", name: "내용량 및 열량" },
      { key: "ingredients", name: "원재료명" },
      { key: "nutrition", name: "영양성분" },
      { key: "package_material", name: "용기·포장재질" },
      { key: "caution", name: "보관방법 및 주의사항" }
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
          law: "식품등의 표시기준",
          how_to_improve: `${rule.name} 정보를 라벨에 명확히 표기해야 합니다.`
        });
      }
    });
  }

  if (label.optional_info && !label.optional_info.includes("없음")) {
    optionalItems.push({ name: "권장 표기사항", detail: label.optional_info });
  }

  const labelAddr = (label.address || "").replace(/\s+/g, "");
  const docAddr = (doc.address || "").replace(/\s+/g, "");

  if (!docAddr || docAddr.includes("없음") || docAddr.includes("미제출")) {
    crossCheck.push({ item: "영업소 소재지", status: "mismatch", label_value: label.address || "라벨 표기값", doc_value: "증빙서류 미제출", note: "자료확인불가" });
  } else if (labelAddr === docAddr) {
    crossCheck.push({ item: "영업소 소재지", status: "match", label_value: label.address, doc_value: doc.address, note: "일치함" });
  } else {
    crossCheck.push({ item: "영업소 소재지", status: "mismatch", label_value: label.address, doc_value: doc.address, note: "주소 불일치" });
  }

  return {
    inspect_mode: "LABEL",
    summary: category === "CONTAINER" ? "기구 및 용기·포장류 5대 필수 항목 검수 완료" : "가공식품 10대 필수 항목 검수 완료",
    analyzed_summary: { product_name: aiData.product_name || "판독 완료", food_type: aiData.food_type || "분류 완료", detected_items_count: passedItems.length + failedItems.length },
    passed_items: passedItems,
    optional_items: optionalItems,
    failed_items: failedItems,
    cross_check: crossCheck
  };
}

// 📌 4단계: 고정 사전에 의한 무변동 광고 정밀 검수 엔진
function processAdRulesEngine(aiData) {
  if (!aiData) return null;

  const detectedPhrases = aiData.detected_phrases || [];
  let formattedRisks = [];
  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;

  // AI가 뽑아온 문구들을 백엔드 고정 사전과 1:1 확정 대조
  detectedPhrases.forEach((item, index) => {
    const text = item.text || "";
    const box = (Array.isArray(item.box_2d) && item.box_2d.length === 4) ? item.box_2d : [100, 100, 300, 900];

    // 매칭되는 고정 규칙 찾기
    let matchedRule = null;
    for (const rule of AD_RULES_DICTIONARY) {
      const hasKeyword = rule.keywords.some(kw => text.includes(kw));
      const hasExcluded = rule.exclude_keywords ? rule.exclude_keywords.some(ex => text.includes(ex)) : false;
      
      if (hasKeyword && !hasExcluded) {
        matchedRule = rule;
        break; // 가장 높은 우선순위 매칭
      }
    }

    if (matchedRule) {
      if (matchedRule.level === "HIGH") highCount++;
      else if (matchedRule.level === "MEDIUM") mediumCount++;
      else lowCount++;

      formattedRisks.push({
        level: matchedRule.level,
        level_kr: matchedRule.level === "HIGH" ? "상 (무조건 수정)" : (matchedRule.level === "MEDIUM" ? "중 (수정 강력 권장)" : "하 (선택 참고)"),
        box_2d: box,
        target_text: text,
        issue: matchedRule.issue,
        reason: matchedRule.reason,
        action: matchedRule.action
      });
    }
  });

  return {
    inspect_mode: "AD",
    product_info: {
      product_name: aiData.product_name || "판독 완료",
      detected_category: aiData.detected_category || "상세페이지 광고"
    },
    risk_summary: {
      total_issues: formattedRisks.length,
      high_count: highCount,
      medium_count: mediumCount,
      low_count: lowCount
    },
    risk_details: formattedRisks
  };
}

export default {
  async fetch(request, env) {
    const corsHeaders = { 
      "Access-Control-Allow-Origin": "*", 
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS", 
      "Access-Control-Allow-Headers": "Content-Type" 
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    
    const geminiApiKey = (env.GEMINI_API_KEY || "").trim();

    if (request.method === "GET") {
      if (!geminiApiKey) return new Response(JSON.stringify({ status: "ERROR", message: "GEMINI_API_KEY 없음" }), { headers: corsHeaders });
      return new Response(JSON.stringify({ system: "LabelGuard AI v9.0.0 (고정 사전 대조형 무변동 엔진)" }), { headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });
    }

    if (request.method === "POST") {
      try {
        if (!geminiApiKey) throw new Error("[v9.0.0 오류] 서버 GEMINI_API_KEY가 없습니다.");

        const formData = await request.formData();
        const labelFile = formData.get("image");
        const docFile = formData.get("doc");
        const inspectMode = (formData.get("mode") || "LABEL").toUpperCase();

        if (!labelFile) throw new Error("분석할 이미지가 전송되지 않았습니다.");

        const labelBuffer = await labelFile.arrayBuffer();
        const contentsParts = [{ inlineData: { mimeType: labelFile.type || "image/jpeg", data: arrayBufferToBase64(labelBuffer) } }];
        
        if (docFile && typeof docFile === "object" && docFile.arrayBuffer) {
          try { 
            const docBuffer = await docFile.arrayBuffer(); 
            if (docBuffer.byteLength > 0) {
              contentsParts.push({ inlineData: { mimeType: docFile.type || "image/jpeg", data: arrayBufferToBase64(docBuffer) } }); 
            }
          } catch (e) {}
        }

        let promptText = "";

        if (inspectMode === "LABEL") {
          promptText = `이미지에서 표기 문구를 추출하여 JSON으로 응답하세요.
[응답 규격]
{
  "category": "CONTAINER" 또는 "FOOD",
  "product_name": "제품명",
  "food_type": "식품유형",
  "label_data": {
    "product_name": "제품명", "food_type": "식품유형", "food_safe_mark": "식품용마크",
    "material": "재질명", "business_name": "제조/판매원", "address": "주소",
    "caution": "주의사항", "expiration_date": "소비기한", "net_weight": "내용량",
    "ingredients": "원재료명", "nutrition": "영양성분", "package_material": "포장재질",
    "optional_info": "기타"
  },
  "doc_data": { "address": "서류주소" }
}`;
        } else {
          promptText = `제출된 광고/상세페이지 이미지에서 눈에 보이는 모든 '홍보성 텍스트 문구'를 원문 그대로 추출하고, 해당 텍스트 글자 영역의 정밀 좌표를 JSON으로 반환하세요.

[🚨 절대 규칙 - 좌표 지정 수칙]
1. box_2d는 [ymin, xmin, ymax, xmax] (0~1000 정수) 좌표입니다.
2. ⚠️ 경고: 탕수육, 고기, 음식 사진이나 배경 이미지를 절대로 박스로 치지 마세요! 오직 텍스트 글자 픽셀 테두리만 아주 좁고 타이트하게 감싸야 합니다!

[응답 JSON 규격]
{
  "product_name": "제품명",
  "detected_category": "제품 분류",
  "detected_phrases": [
    {
      "text": "도톰한 등심과 쫄깃한 튀김옷이 어우러진 새콤달콤한 탕수육",
      "box_2d": [ymin, xmin, ymax, xmax] // 오직 글자 픽셀 테두리만 지정할 것!
    }
  ]
}`;
        }

        contentsParts.unshift({ text: promptText });

        const targetModel = "gemini-3.6-flash";
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${geminiApiKey}`;
        
        // 🚨 temperature: 0.0 으로 설정하여 생성형 무작위성을 완전 차단
        const requestBody = { 
          contents: [{ parts: contentsParts }], 
          generationConfig: { 
            responseMimeType: "application/json", 
            temperature: 0.0 
          } 
        };

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

        if (!rawResponseText) throw new Error(`[v9.0.0 서버 오류] ${targetModel} 요청 실패: ${lastErrorLog.substring(0, 100)}`);

        const aiExtractedData = parseAIJSON(rawResponseText);
        if (!aiExtractedData) throw new Error("[v9.0.0 서버 오류] AI 추출 데이터 파싱 실패");

        const finalReport = (inspectMode === "AD") 
          ? processAdRulesEngine(aiExtractedData) 
          : processLabelRulesEngine(aiExtractedData);

        return new Response(JSON.stringify({ success: true, result: finalReport }), { 
          status: 200, 
          headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } 
        });

      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { 
          status: 500, 
          headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } 
        });
      }
    }
  }
};
