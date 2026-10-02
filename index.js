// ArrayBuffer -> Base64 변환
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
  const jsonCandidate = str.slice(start, end + 1);
  try { return JSON.parse(jsonCandidate); } 
  catch (e) {
    try {
      const cleaned = jsonCandidate.replace(/[\u0000-\u001F]+/g, " ").replace(/,\s*([\}\]])/g, "$1");
      return JSON.parse(cleaned);
    } catch (e2) { return null; }
  }
}

// 📌 소스/특제 오탐 완벽 수정 및 동적 가이드 사전
const AD_RULES_DICTIONARY = [
  {
    id: "RULE_INGREDIENT_PERCENT",
    // 🚨 '특제' 키워드 제거 (원재료 명칭만 포함)
    keywords: ["등심", "통등심", "안심", "찹쌀", "한우", "돼지고기", "삼겹살", "새우", "치즈", "국산", "국내산"],
    exclude_keywords: ["%", "퍼센트", "g", "함유량"],
    level: "HIGH",
    issue: "원재료명 강조 표기 시 함량(%) 누락",
    reason: "상세페이지 카피에서 특정 원재료를 전면에 강조하고 있으나, 배합 비율(%)이 명시되지 않아 식품표시광고법 위반 위험이 있습니다.",
    // 동적 가이드 생성 함수
    getAction: (text) => {
      let matchedIng = "원재료";
      if (text.includes("등심")) matchedIng = "돼지고기(등심)";
      else if (text.includes("찹쌀")) matchedIng = "찹쌀";
      else if (text.includes("새우")) matchedIng = "새우";
      else if (text.includes("한우")) matchedIng = "한우";
      return `강조된 문구 주변 또는 메인 강조 영역에 '${matchedIng} 00%'와 같이 정확한 함량을 명확히 표기하세요.`;
    }
  },
  {
    id: "RULE_BEST_PROOF_REQUIRED",
    // 🚨 '특제', '특제 소스'를 실증 필요 표현(중)으로 이동
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

function processAdRulesEngine(aiData) {
  if (!aiData) return null;

  const detectedPhrases = aiData.detected_phrases || [];
  let formattedRisks = [];
  let highCount = 0; let mediumCount = 0; let lowCount = 0;

  detectedPhrases.forEach((item) => {
    const text = item.text || "";
    const box = (Array.isArray(item.box_2d) && item.box_2d.length === 4) ? item.box_2d : [100, 100, 300, 900];

    AD_RULES_DICTIONARY.forEach(rule => {
      const hasKeyword = rule.keywords.some(kw => text.includes(kw));
      const hasExcluded = rule.exclude_keywords ? rule.exclude_keywords.some(ex => text.includes(ex)) : false;
      
      if (hasKeyword && !hasExcluded) {
        if (rule.level === "HIGH") highCount++;
        else if (rule.level === "MEDIUM") mediumCount++;
        else lowCount++;

        formattedRisks.push({
          level: rule.level,
          level_kr: rule.level === "HIGH" ? "상 (무조건 수정)" : (rule.level === "MEDIUM" ? "중 (수정 강력 권장)" : "하 (선택 참고)"),
          box_2d: box,
          target_text: text,
          issue: rule.issue,
          reason: rule.reason,
          action: rule.getAction(text) // 동적 가이드 적용
        });
      }
    });
  });

  return {
    inspect_mode: "AD",
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

    if (request.method === "POST") {
      try {
        if (!geminiApiKey) throw new Error("서버 GEMINI_API_KEY가 없습니다.");

        const formData = await request.formData();
        const labelFile = formData.get("image");
        const inspectMode = (formData.get("mode") || "LABEL").toUpperCase();

        if (!labelFile) throw new Error("분석할 이미지가 전송되지 않았습니다.");

        const labelBuffer = await labelFile.arrayBuffer();
        const contentsParts = [{ inlineData: { mimeType: labelFile.type || "image/jpeg", data: arrayBufferToBase64(labelBuffer) } }];

        let promptText = `제출된 이미지에서 모든 '홍보성 텍스트 문구'를 추출하고 글자 테두리 정밀 좌표 [ymin, xmin, ymax, xmax] (0~1000 범위)를 반환하세요.
* ⚠️ 사진/음식 배경을 박스로 치지 말고, 오직 글자 테두리만 좁게 지정할 것!

[JSON 응답 규격]
{
  "product_name": "제품명",
  "detected_category": "분류",
  "detected_phrases": [ { "text": "추출문구", "box_2d": [ymin, xmin, ymax, xmax] } ]
}`;

        contentsParts.unshift({ text: promptText });

        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${geminiApiKey}`;
        const geminiRes = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: contentsParts }], generationConfig: { responseMimeType: "application/json", temperature: 0.0 } })
        });

        if (!geminiRes.ok) throw new Error("Gemini API 호출 실패");
        const data = await geminiRes.json();
        const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        const aiExtractedData = parseAIJSON(rawText);

        const finalReport = processAdRulesEngine(aiExtractedData);
        return new Response(JSON.stringify({ success: true, result: finalReport }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });

      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });
      }
    }
  }
};
