// ArrayBuffer -> Base64 변환
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 📌 1단계: 국가법령정보센터(open.law.go.kr) 경량 메타데이터 실시간 수집 (과부하 차단)
async function fetchLatestLawInfo(lawApiKey) {
  if (!lawApiKey) {
    return "[식약처 고시 기준] 『식품등의 표시기준』 및 『식품등의 표시·광고에 관한 법률』 적용";
  }
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000); // 2초 초과 시 자동 패스

    const lawUrl = `https://www.law.go.kr/DRF/lawSearch.do?OC=${lawApiKey}&target=admrul&query=${encodeURIComponent("식품등의 표시기준")}&type=XML`;
    const res = await fetch(lawUrl, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!res.ok) return "[식약처 고시 기준] 실시간 법령 동기화 대기 (기본 표준 고시 적용)";
    
    const xmlText = await res.text();
    const titleMatch = xmlText.match(/<행정규칙명>(.*?)<\/행정규칙명>/);
    const dateMatch = xmlText.match(/<시행일자>(.*?)<\/시행일자>/);
    const numMatch = xmlText.match(/<발령번호>(.*?)<\/발령번호>/);

    const title = titleMatch ? titleMatch[1] : "식품등의 표시기준";
    const date = dateMatch ? dateMatch[1] : "최신";
    const num = numMatch ? numMatch[1] : "";

    return `[국가법령정보센터 실시간 동기화 완료] 식약처 고시 『${title}』 (시행일자: ${date}${num ? `, 제${num}호` : ''})`;
  } catch (e) {
    return "[식약처 고시 기준] 법령 동기화 타임아웃 (기본 표준 고시 적용)";
  }
}

// 📌 2단계: 안전 JSON 파서
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

// 📌 3단계: 한글표시사항 백엔드 규칙 엔진
function processLabelRulesEngine(aiData, lawHeaderStr) {
  if (!aiData) return null;

  const category = aiData.category || "FOOD";
  const label = aiData.label_data || {};
  const doc = aiData.doc_data || {};

  let passedItems = [];
  let failedItems = [];
  let optionalItems = [];
  let crossCheck = [];

  // [A] 용기·포장류 (도자기, 유리, 텀블러 등) 5대 필수 규칙
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
  // [B] 일반 가공식품 10대 필수 규칙
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

  if (label.optional_info && !label.optional_info.includes("없음")) {
    optionalItems.push({ name: "권장 표기사항", detail: label.optional_info });
  }

  // [C] 증빙서류 주소 교차 대조
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
    inspect_mode: "LABEL",
    law_status: lawHeaderStr,
    summary: `${lawHeaderStr}\n${category === "CONTAINER" ? "기구 및 용기·포장류 기준 5대 필수 항목 정밀 검수를 완료했습니다." : "가공식품 표시기준 10대 필수 항목 정밀 검수를 완료했습니다."}`,
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

// 📌 4단계: 광고/상세페이지 백엔드 규칙 엔진
function processAdRulesEngine(aiData, lawHeaderStr) {
  if (!aiData) return null;

  const rawRisks = aiData.ad_risk_items || [];
  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;

  const formattedRisks = rawRisks.map(item => {
    let level = (item.level || "MEDIUM").toUpperCase();
    
    if (level === "HIGH") highCount++;
    else if (level === "LOW") lowCount++;
    else { level = "MEDIUM"; mediumCount++; }

    let box = item.box_2d;
    if (!Array.isArray(box) || box.length !== 4) {
      box = [100, 100, 300, 900];
    }

    return {
      level: level,
      level_kr: level === "HIGH" ? "상 (무조건 수정)" : (level === "MEDIUM" ? "중 (수정 강력 권장)" : "하 (선택 참고)"),
      box_2d: box,
      target_text: item.target_text || "광고 내 관련 문구",
      issue: item.issue || "표시·광고법 검토 항목",
      reason: item.reason || "식약처 표시광고 가이드라인 기준",
      action: item.action || "문구 수정 및 증빙자료 준비"
    };
  });

  return {
    inspect_mode: "AD",
    law_status: lawHeaderStr,
    product_info: {
      product_name: aiData.product_name || "판독 완료",
      detected_category: `${aiData.detected_category || "상세페이지 광고"} (${lawHeaderStr})`
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
    const lawApiKey = (env.LAW_API_KEY || "").trim();

    if (request.method === "GET") {
      if (!geminiApiKey) return new Response(JSON.stringify({ status: "ERROR", message: "GEMINI_API_KEY 없음" }), { headers: corsHeaders });
      return new Response(JSON.stringify({ system: "LabelGuard AI v8.5.0 (경량 국가법령 API 실시간 연동 완료)" }), { headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });
    }

    if (request.method === "POST") {
      try {
        if (!geminiApiKey) throw new Error("[v8.5.0 오류] 서버 환경 변수(GEMINI_API_KEY)가 설정되지 않았습니다.");

        const formData = await request.formData();
        const labelFile = formData.get("image");
        const docFile = formData.get("doc");
        const inspectMode = (formData.get("mode") || "LABEL").toUpperCase();

        if (!labelFile) throw new Error("분석할 이미지가 전송되지 않았습니다.");

        // 1. 국가법령정보센터 경량 메타데이터 동시 수집
        const lawHeaderStr = await fetchLatestLawInfo(lawApiKey);

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
          promptText = `다음 기준을 준수하여 이미지에서 표기 문구를 추출하고 JSON으로 응답하세요.
기준: ${lawHeaderStr}

[응답 JSON 규격]
{
  "category": "CONTAINER" 또는 "FOOD", // 도자기, 컵, 용기, 텀블러는 CONTAINER / 먹는 식품은 FOOD
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
}`;
        } else {
          promptText = `다음 법령 및 식약처/공정위 표시·광고법 기준 'Zero Tolerance(무결점 엄격 단속 원칙)'로 상세페이지를 검수하여 JSON으로 응답하세요.
기준: ${lawHeaderStr}

* 각 문제 문구가 발견된 정확한 위치를 [ymin, xmin, ymax, xmax] (0~1000 상대 정수 좌표) 형태로 box_2d 필드에 구하세요.

[위험도 엄격 분류 수칙]
- HIGH (상: 무조건 수정): 특정 원재료(등심, 찹쌀 등) 강조 후 함량(%) 미표기, 라벨과 상세페이지 불일치, 허위·과대광고, 해상도 저하로 필수 정보 식별 불가.
- MEDIUM (중: 수정 강력 권장): 객관적 실증이 필요한 최상급/우수성 표현("깨끗한", "최상급", "특제", "전문점의 맛"), 조리예 미표기, 제조/판매사 미세 불일치.
- LOW (하: 선택 참고): 법적 제재 가능성이 완벽히 부재한 단순 디자인 가이드.

[응답 JSON 규격]
{
  "product_name": "제품명",
  "detected_category": "제품 분류/식품유형",
  "ad_risk_items": [
    {
      "level": "HIGH", // HIGH / MEDIUM / LOW
      "box_2d": [120, 40, 280, 960],
      "target_text": "광고 내 문제가 된 원문 문구",
      "issue": "위반/점검 항목명",
      "reason": "단속 사유 상세 설명",
      "action": "수정 가이드라인"
    }
  ]
}`;
        }

        contentsParts.unshift({ text: promptText });

        const targetModel = "gemini-3.6-flash";
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${geminiApiKey}`;
        const requestBody = { 
          contents: [{ parts: contentsParts }], 
          generationConfig: { responseMimeType: "application/json", temperature: 0.1 } 
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

        if (!rawResponseText) throw new Error(`[v8.5.0 서버 오류] ${targetModel} 요청 실패. 잠시 후 다시 시도해주세요. 상세: ${lastErrorLog.substring(0, 100)}`);

        const aiExtractedData = parseAIJSON(rawResponseText);
        if (!aiExtractedData) throw new Error("[v8.5.0 서버 오류] AI 추출 데이터 파싱 실패");

        const finalReport = (inspectMode === "AD") 
          ? processAdRulesEngine(aiExtractedData, lawHeaderStr) 
          : processLabelRulesEngine(aiExtractedData, lawHeaderStr);

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
