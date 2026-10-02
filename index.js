function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseAIJSON(raw) {
  if (!raw) return null;
  let str = typeof raw === "string" ? raw : JSON.stringify(raw);
  str = str.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const start = str.indexOf('{');
  const end = str.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(str.slice(start, end + 1)); } catch (e) { return null; }
}

// 📌 국가법령 실시간 수집 (CDATA 및 명칭 파싱 보정)
async function fetchLatestLawInfo(lawApiKey) {
  if (!lawApiKey) return "[기본 모드] 식약처 고시 『식품등의 표시기준』 적용 (LAW_API_KEY 미설정)";
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const lawUrl = `https://www.law.go.kr/DRF/lawSearch.do?OC=${lawApiKey}&target=admrul&query=${encodeURIComponent("식품등의 표시기준")}&type=XML`;
    const res = await fetch(lawUrl, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!res.ok) return "[기본 모드] 법령 서버 응답 지연";
    let xmlText = await res.text();
    xmlText = xmlText.replace(/<!\[CDATA\[\vert{}\]\]>/g, ""); // CDATA 태그 제거

    const titleMatch = xmlText.match(/<행정규칙명>(.*?)<\/행정규칙명>/) || xmlText.match(/<법령명>(.*?)<\/법령명>/);
    const dateMatch = xmlText.match(/<시행일자>(.*?)<\/시행일자>/);
    const numMatch = xmlText.match(/<발령번호>(.*?)<\/발령번호>/);

    const title = titleMatch ? titleMatch[1].trim() : "식품등의 표시기준";
    const date = dateMatch ? dateMatch[1].trim() : "최신";
    const num = numMatch ? numMatch[1].trim() : "";

    return `[국가법령정보센터 실시간 동기화] 식약처 고시 『${title}』 (시행일자: ${date}${num ? `, 제${num}호` : ''})`;
  } catch (e) {
    return "[기본 모드] 식약처 고시 『식품등의 표시기준』 적용";
  }
}

const AD_RULES_DICTIONARY = [
  {
    id: "RULE_INGREDIENT_PERCENT",
    keywords: ["등심", "통등심", "안심", "찹쌀", "한우", "돼지고기", "삼겹살", "새우", "치즈", "국산", "국내산"],
    exclude_keywords: ["%", "퍼센트", "g", "함유량"],
    level: "HIGH",
    issue: "원재료명 강조 표기 시 함량(%) 누락",
    reason: "상세페이지 카피에서 특정 원재료를 전면에 강조하고 있으나, 배합 비율(%)이 명시되지 않아 식품표시광고법 위반 위험이 있습니다.",
    getAction: (text) => {
      let matched = "원재료";
      if (text.includes("등심")) matched = "돼지고기(등심)";
      else if (text.includes("찹쌀")) matched = "찹쌀";
      else if (text.includes("새우")) matched = "새우";
      return `강조된 문구 주변 또는 메인 강조 영역에 '${matched} 00%'와 같이 정확한 함량을 명확히 표기하세요.`;
    }
  },
  {
    id: "RULE_BEST_PROOF_REQUIRED",
    keywords: ["특제", "특제 소스", "깨끗한", "최상", "최고", "1위", "특허", "시그니처", "가장 많은", "원물 그대로", "풍부한", "노하우", "비법", "전문점의 맛"],
    level: "MEDIUM",
    issue: "객관적 실증이 필요한 최상급/우수성 표현",
    reason: "객관적 실증 자료(산가 측정치, 성분 분석표 등) 없이 최상급 또는 우수성을 주장할 경우 식약처 실증자료 제출 명령 대상이 될 수 있습니다.",
    getAction: () => "공인 시험성적서 등 실증 자료를 확보하거나, '깔끔하게 튀겨낸', '인기 소스' 등 일반적 표현으로 완화하세요."
  },
  {
    id: "RULE_COOKING_EXAMPLE",
    keywords: ["조리예", "연출된", "이미지"],
    level: "LOW",
    issue: "조리예 문구 표기 상태",
    reason: "소비자 오인 방지용 '조리예' 문구가 존재하나 글자 크기가 작아 식별이 어려울 수 있습니다.",
    getAction: () => "사진 하단 '상기 이미지는 조리예입니다' 문구의 시인성을 확보하세요."
  }
];

const BLOCK_Y_PERCENT_MAP = {
  1: { y_percent: 10, name: "상단 구역" },
  2: { y_percent: 30, name: "중상단 구역" },
  3: { y_percent: 50, name: "중단 구역" },
  4: { y_percent: 70, name: "중하단 구역" },
  5: { y_percent: 90, name: "하단 구역" }
};

function processLabelRulesEngine(aiData, lawStr) {
  if (!aiData) return null;
  const label = aiData.label_data || {};
  let passedItems = [];
  let failedItems = [];

  const foodRules = [
    { key: "product_name", name: "제품명" }, { key: "food_type", name: "식품유형" },
    { key: "business_name", name: "영업소 명칭" }, { key: "address", name: "소재지 주소" },
    { key: "expiration_date", name: "소비기한" }, { key: "net_weight", name: "내용량" },
    { key: "ingredients", name: "원재료명" }, { key: "nutrition", name: "영양성분" },
    { key: "package_material", name: "용기포장재질" }, { key: "caution", name: "주의사항" }
  ];

  foodRules.forEach(rule => {
    const val = (label[rule.key] || "").trim();
    if (val && !val.includes("없음") && !val.includes("누락")) passedItems.push({ name: rule.name, detail: val });
    else failedItems.push({ item_name: rule.name, found_text: "누락", issue_reason: `${rule.name} 항목 누락`, how_to_improve: `${rule.name} 명시 필요` });
  });

  return {
    inspect_mode: "LABEL",
    law_status: lawStr,
    summary: "가공식품 10대 필수 항목 검수 완료",
    analyzed_summary: { product_name: aiData.product_name || "판독 완료", food_type: aiData.food_type || "분류 완료" },
    passed_items: passedItems, failed_items: failedItems
  };
}

function processAdRulesEngine(aiData, lawStr) {
  if (!aiData) return null;
  const detectedPhrases = aiData.detected_phrases || [];
  let formattedRisks = [];
  let highCount = 0; let mediumCount = 0; let lowCount = 0;

  detectedPhrases.forEach((item) => {
    const text = item.text || "";
    const bIdx = Math.min(5, Math.max(1, parseInt(item.block_index) || 1));
    const blockInfo = BLOCK_Y_PERCENT_MAP[bIdx] || BLOCK_Y_PERCENT_MAP[1];

    AD_RULES_DICTIONARY.forEach(rule => {
      if (rule.keywords.some(kw => text.includes(kw)) && (!rule.exclude_keywords || !rule.exclude_keywords.some(ex => text.includes(ex)))) {
        if (rule.level === "HIGH") highCount++; else if (rule.level === "MEDIUM") mediumCount++; else lowCount++;
        formattedRisks.push({
          level: rule.level,
          level_kr: rule.level === "HIGH" ? "상 (무조건 수정)" : (rule.level === "MEDIUM" ? "중 (수정 권장)" : "하 (참고)"),
          y_percent: blockInfo.y_percent, block_name: blockInfo.name,
          target_text: text, issue: rule.issue, reason: rule.reason, action: rule.getAction(text)
        });
      }
    });
  });

  const priorityMap = { "HIGH": 1, "MEDIUM": 2, "LOW": 3 };
  formattedRisks.sort((a, b) => (priorityMap[a.level] || 99) - (priorityMap[b.level] || 99) || a.y_percent - b.y_percent);

  return {
    inspect_mode: "AD", law_status: lawStr,
    product_info: { product_name: aiData.product_name || "판독 완료", detected_category: aiData.detected_category || "상세페이지 광고" },
    risk_summary: { total_issues: formattedRisks.length, high_count: highCount, medium_count: mediumCount, low_count: lowCount },
    risk_details: formattedRisks
  };
}

export default {
  async fetch(request, env) {
    const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    
    const geminiApiKey = (env.GEMINI_API_KEY || "").trim();
    const lawApiKey = (env.LAW_API_KEY || "").trim();

    if (request.method === "POST") {
      try {
        if (!geminiApiKey) throw new Error("서버 GEMINI_API_KEY가 설정되지 않았습니다.");

        const formData = await request.formData();
        const inspectMode = (formData.get("mode") || "LABEL").toUpperCase();
        const labelFile = formData.get("image");

        if (!labelFile) throw new Error("분석할 이미지가 전송되지 않았습니다.");
        const labelBuffer = await labelFile.arrayBuffer();

        const lawHeaderStr = await fetchLatestLawInfo(lawApiKey);
        let contentsParts = [];

        if (inspectMode === "AD") {
          // 🚨 전수 추출 강제 프롬프트
          let promptText = `상세페이지 이미지 전체를 식약처 표시광고법 기준으로 정밀 검수하세요.
기준: ${lawHeaderStr}

[🚨 필수 지침]
- 헤더 카피, 메인 카피, 원재료 관련 홍보 문구("등심", "통등심", "새우" 등), 소스 설명 문구, 하단 조리예/연출 문구를 빠짐없이 전부 추출하세요.
- 각 문구가 이미지 상단에서부터 위치한 영역을 block_index(1~5 정수)로 지정하세요.
  * 1: 상단 (0~20% 영역)
  * 2: 중상단 (20~40% 영역)
  * 3: 중단 (40~60% 영역)
  * 4: 중하단 (60~80% 영역)
  * 5: 하단 (80~100% 영역)

[응답 JSON 규격]
{"product_name":"제품명","detected_category":"분류","detected_phrases":[{"text":"추출 문구","block_index": 1}]}`;

          contentsParts.push({ text: promptText });
          contentsParts.push({ inlineData: { mimeType: labelFile.type || "image/jpeg", data: arrayBufferToBase64(labelBuffer) } });
        } else {
          contentsParts.push({ text: `한글표시사항 라벨 텍스트를 추출해 JSON으로 응답하세요.\n기준: ${lawHeaderStr}\n{"category":"FOOD","product_name":"명","food_type":"유형","label_data":{"product_name":"","food_type":"","business_name":"","address":"","expiration_date":"","net_weight":"","ingredients":"","nutrition":"","package_material":"","caution":""},"doc_data":{"address":""}}` });
          contentsParts.push({ inlineData: { mimeType: labelFile.type || "image/jpeg", data: arrayBufferToBase64(labelBuffer) } });
        }

        const modelsToTry = ["gemini-1.5-flash", "gemini-2.0-flash", "gemini-flash-latest"];
        let rawResponseText = ""; let lastErrorLog = "";

        for (const modelName of modelsToTry) {
          const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey}`;
          const requestBody = { contents: [{ parts: contentsParts }], generationConfig: { responseMimeType: "application/json", temperature: 0.0 } };
          let is404 = false;

          for (let attempt = 0; attempt <= 2; attempt++) {
            try {
              const geminiRes = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody) });
              if (geminiRes.ok) {
                const data = await geminiRes.json();
                rawResponseText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
                if (rawResponseText) break;
              } else {
                lastErrorLog = await geminiRes.text();
                if (geminiRes.status === 404) { is404 = true; break; }
                if ((geminiRes.status === 503 || geminiRes.status === 429) && attempt < 2) await delay([1500, 3000][attempt]); else break;
              }
            } catch (e) { lastErrorLog = e.message; }
          }
          if (rawResponseText) break;
          if (is404) continue;
        }

        if (!rawResponseText) throw new Error(`[API 오류] 구글 서버 응답 실패: ${lastErrorLog.substring(0, 150)}`);
        const aiExtractedData = parseAIJSON(rawResponseText);
        if (!aiExtractedData) throw new Error("AI 결과 데이터를 파싱하지 못했습니다.");

        const finalReport = (inspectMode === "AD") ? processAdRulesEngine(aiExtractedData, lawHeaderStr) : processLabelRulesEngine(aiExtractedData, lawHeaderStr);
        return new Response(JSON.stringify({ success: true, result: finalReport }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });
      }
    }
  }
};
