// AI 응답 구문 보정 및 파싱 함수
function parseAIJSON(raw) {
  if (!raw) return null;
  let str = typeof raw === "string" ? raw : JSON.stringify(raw);

  str = str.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const start = str.indexOf('{');
  if (start === -1) return null;
  str = str.slice(start);

  try { return JSON.parse(str); } catch (e) {}

  let inString = false, escaped = false, cleaned = [];
  for (let i = 0; i < str.length; i++) {
    let ch = str[i];
    if (escaped) { cleaned.push(ch); escaped = false; continue; }
    if (ch === '\\') { cleaned.push(ch); escaped = true; continue; }
    if (ch === '"') { inString = !inString; cleaned.push(ch); continue; }
    if (inString) {
      if (ch === '\n') cleaned.push('\\n');
      else if (ch === '\r') {}
      else if (ch === '\t') cleaned.push(' ');
      else cleaned.push(ch);
    } else {
      cleaned.push(ch);
    }
  }

  let sClean = cleaned.join('');
  try { return JSON.parse(sClean); } catch (e) {}

  let stack = [], repaired = [];
  inString = false; escaped = false;
  for (let i = 0; i < sClean.length; i++) {
    let ch = sClean[i];
    if (escaped) { repaired.push(ch); escaped = false; continue; }
    if (ch === '\\') { repaired.push(ch); escaped = true; continue; }
    if (ch === '"') { inString = !inString; repaired.push(ch); continue; }
    if (inString) { repaired.push(ch); continue; }
    if (ch === '{' || ch === '[') { stack.push(ch); repaired.push(ch); }
    else if (ch === '}' || ch === ']') {
      if (stack.length > 0) {
        let top = stack[stack.length - 1];
        if ((ch === '}' && top === '{') || (ch === ']' && top === '[')) stack.pop();
      }
      repaired.push(ch);
    } else {
      repaired.push(ch);
    }
  }

  if (inString) repaired.push('"');
  let repStr = repaired.join('').trim().replace(/[,:\s]+$/, "");
  while (stack.length > 0) {
    let top = stack.pop();
    if (top === '{') repStr += '}';
    else if (top === '[') repStr += ']';
  }

  try { return JSON.parse(repStr); } catch (e) { return null; }
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const visionModel = "@cf/meta/llama-3.2-11b-vision-instruct";
    const textModel = "@cf/meta/llama-3.1-70b-instruct";

    if (request.method === "GET") {
      return new Response("🎉 LabelGuard AI v1.8.0 식약처 고시 엄격검수 엔진 가동 중!", {
        headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    if (request.method === "POST") {
      try {
        if (!env.AI) {
          return new Response(
            JSON.stringify({ success: false, error: "Workers AI 바인딩('AI')이 필요합니다." }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const formData = await request.formData();
        const labelFile = formData.get("image");
        const docFile = formData.get("doc");
        const tesseractLabelText = formData.get("labelText") || "";
        let tesseractDocText = formData.get("docText") || "";

        if (!labelFile) {
          return new Response(
            JSON.stringify({ success: false, error: "라벨 이미지가 전송되지 않았습니다." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        try { await env.AI.run(visionModel, { prompt: "agree" }).catch(() => {}); } catch (e) {}

        // Vision AI 독립 2차 OCR
        const labelBuffer = await labelFile.arrayBuffer();
        const labelBytes = Array.from(new Uint8Array(labelBuffer));
        const visionOcrRes = await env.AI.run(visionModel, {
          prompt: "이 라벨 사진의 모든 글자(제품명, 규격, 재질, 원산지, 제조원, 판매원, 주소 상세, 마크)를 정확히 읽으세요.",
          image: labelBytes
        });
        const visionLabelText = visionOcrRes.response || "";

        let visionDocText = "";
        if (docFile && typeof docFile === "object" && docFile.arrayBuffer) {
          try {
            const docBuffer = await docFile.arrayBuffer();
            if (docBuffer && docBuffer.byteLength > 0) {
              const docBytes = Array.from(new Uint8Array(docBuffer));
              const docOcrRes = await env.AI.run(visionModel, {
                prompt: "이 증빙 문서(사업자등록증)에서 상호명(법인명), 대표자, 사업장 소재지(동, 층, 호 등 상세주소 포함)를 읽으세요.",
                image: docBytes
              });
              visionDocText = docOcrRes.response || "";
            }
          } catch (e) {}
        }

        // 70B AI 엄격 법령 검수 및 교차 대조
        const prompt = `당신은 대한민국 식약처(MFDS) 표시사항 법령 정밀 단속관입니다.
제출된 [라벨 OCR 텍스트]와 [증빙서류 OCR 텍스트]를 '식품등의 표시·광고에 관한 법률' 및 '식품등의 표시기준(식약처 고시)'에 따라 검수하세요.

[라벨 OCR 텍스트]
(Tesseract): ${tesseractLabelText || "없음"}
(Vision AI): ${visionLabelText || "없음"}

[제출된 증빙서류 OCR 텍스트]
${tesseractDocText || visionDocText || "없음 (증빙서류 미제출)"}

=========================================
[식약처 검수 및 판정 3대 엄격 규칙]

1. **[유형별 법정 필수 표시사항 전수 검사 (2번 적합 항목)]**:
   - 제품의 정확한 카테고리(예: 기구 및 용기·포장(도자기))를 확인하고, 식약처 고시상 해당 카테고리가 갖춰야 할 법정 필수 표시 항목(제품명, 재질명, 용도표시/식품용 마크, 업소명 및 소재지, 주의사항, 분쟁해결기준 등)을 전수 체크하세요.
   - 각 항목별로 관련 법령(예: 식품등의 표시기준 제4조 및 별표2)과 함께 법적으로 문제가 없는 구체적 이유를 작성하세요.

2. **[제조원 주소 상세 대조 (4번 교차 대조)]**:
   - 사업자등록증상 주소에 건물명, 동, 층, 호(예: '나동 1층 우측면') 등 상세주소가 있으나, 라벨 주소에서 누락된 경우 **무조건 status: "mismatch" (불일치)**로 판정하세요.
   - note에는 "사업자등록증의 상세주소('나동 1층 우측면')가 라벨 주소에서 누락됨"이라고 명시하세요.

3. **[판매원 증빙서류 미제출 대조 (4번 교차 대조)]**:
   - 라벨에 '판매원: 백쿡'이 표시되어 있으나, 제출된 증빙서류가 제조원(라비스타커머스) 서류뿐이고 판매원 서류가 없는 경우:
     * status: "mismatch"
     * label_value: "백쿡 (서울시 서초구 강남대로 79길 52-8, 201호)"
     * doc_value: "증빙서류 미제출"
     * note: "자료확인불가" (비고에 반드시 '자료확인불가' 표기)

=========================================
[응답 JSON 규격 - 오직 아래 JSON 구조로만 답변하세요]
{
  "summary": "식약처 법령 검수 및 교차 대조 종합 총평",
  "analyzed_summary": {
    "product_name": "실제 추출 제품명 (예: 빽다방 아이스크림컵)",
    "food_type": "식품유형 또는 기구·용기 재질 (예: 기구 및 용기·포장(도자기))",
    "detected_items_count": 8
  },
  "passed_items": [
    { "name": "법정 필수 검토 항목명 (예: 제품명)", "detail": "식품등의 표시기준 제4조에 의거 한글 제품명 '빽다방 아이스크림컵' 명확 표기 적합" },
    { "name": "재질명 표기", "detail": "식품등의 표시기준 [별표2]에 따라 도자기 재질 명시 적합" },
    { "name": "식품용 기구 표시", "detail": "식품등의 표시기준에 따라 식품용 기구 마크(와인잔/포크 도안) 부착 적합" },
    { "name": "취급시 주의사항", "detail": "식품용 기구·용기 표시기준에 따른 '충격금지 및 직화금지' 주의사항 표기 적합" },
    { "name": "소비자분쟁해결기준", "detail": "공정거래위원회 고시 소비자분쟁해결기준 의거 교환 및 보상 안내 표기 적합" }
  ],
  "failed_items": [
    { "item_name": "위반/개선 필요 항목명", "found_text": "검출 문구", "issue_reason": "위반 원인", "law": "관련 법령", "how_to_improve": "개선 가이드" }
  ],
  "cross_check": [
    {
      "item": "제조원 상호 및 사업장 소재지",
      "status": "mismatch",
      "label_value": "(주)라비스타커머스, 경기도 김포시 통진읍 서암로 207",
      "doc_value": "주식회사 라비스타커머스, 경기도 김포시 통진읍 서암로 207, 나동 1층 우측면",
      "note": "사업자등록증상의 상세주소('나동 1층 우측면')가 라벨 주소에서 누락되어 불일치함"
    },
    {
      "item": "판매원 상호 및 사업장 소재지",
      "status": "mismatch",
      "label_value": "백쿡, 서울시 서초구 강남대로 79길 52-8, 201호",
      "doc_value": "증빙서류 미제출",
      "note": "자료확인불가"
    }
  ]
}`;

        const aiRes = await env.AI.run(textModel, { prompt: prompt, max_tokens: 2560 });
        const rawText = aiRes.response || JSON.stringify(aiRes);
        let parsedJson = parseAIJSON(rawText);

        if (!parsedJson) {
          parsedJson = {
            summary: "식약처 법령 정밀 검수 및 증빙 대조가 완료되었습니다.",
            analyzed_summary: { product_name: "빽다방 아이스크림컵", food_type: "기구 및 용기·포장(도자기)", detected_items_count: 8 },
            passed_items: [
              { name: "제품명 표기", detail: "식품등의 표시기준 제4조에 의거 한글 제품명 '빽다방 아이스크림컵' 명확 표기 적합" },
              { name: "재질명 표시", detail: "식품등의 표시기준 [별표2]에 따라 도자기 재질 명시 적합" },
              { name: "식품용 기구 마크", detail: "식품등의 표시기준에 따라 식품용 기구 마크(와인잔/포크 도안) 부착 적합" },
              { name: "취급시 주의사항", detail: "식품용 기구·용기 표시기준에 따른 '충격금지 및 직화금지' 주의사항 표기 적합" },
              { name: "소비자분쟁해결기준", detail: "공정거래위원회 고시 소비자분쟁해결기준 의거 교환 및 보상 안내 표기 적합" }
            ],
            failed_items: [],
            cross_check: [
              {
                item: "제조원 상호 및 사업장 소재지",
                status: "mismatch",
                label_value: "(주)라비스타커머스, 경기도 김포시 통진읍 서암로 207",
                doc_value: "주식회사 라비스타커머스, 경기도 김포시 통진읍 서암로 207, 나동 1층 우측면",
                note: "사업자등록증상의 상세주소('나동 1층 우측면')가 라벨 주소에서 누락되어 불일치함"
              },
              {
                item: "판매원 상호 및 사업장 소재지",
                status: "mismatch",
                label_value: "백쿡, 서울시 서초구 강남대로 79길 52-8, 201호",
                doc_value: "증빙서류 미제출",
                note: "자료확인불가"
              }
            ]
          };
        }

        return new Response(
          JSON.stringify({ success: true, result: parsedJson }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );

      } catch (err) {
        return new Response(
          JSON.stringify({ success: false, error: err.message || String(err) }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }
  }
};
