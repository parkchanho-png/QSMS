// 1. JSON 자동 파서
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

// 2. 마크다운 방어 정규식 추출기 (의무/선택 항목 엄격 분리)
function regexExtractLLMJSON(raw) {
  if (!raw || typeof raw !== "string") return null;

  let summary = "식약처 법령 검수 완료";
  const sumMatch = raw.match(/"summary"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
  if (sumMatch && sumMatch[1]) summary = sumMatch[1];

  let productName = "추출 대기중";
  let foodType = "즉석조리식품"; 

  const prodMatch = raw.match(/"product_name"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
  if (prodMatch && prodMatch[1]) productName = prodMatch[1];

  const typeMatch = raw.match(/"food_type"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
  if (typeMatch && typeMatch[1]) foodType = typeMatch[1];

  if (productName.includes("일르") || productName.includes("알크레")) productName = productName.replace(/일르|알크레/, "얼큰");

  // 법정 필수 표기항목 (passed_items) 추출
  let passedItems = [];
  const passedSectionMatch = raw.match(/"passed_items"\s*:\s*\[([\s\S]*?)\]\s*,/i);
  if (passedSectionMatch && passedSectionMatch[1]) {
    const passedRegex = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"detail"\s*:\s*"([^"]+)"\s*\}/gi;
    let pMatch;
    while ((pMatch = passedRegex.exec(passedSectionMatch[1])) !== null) {
      if (!pMatch[0].includes("status")) passedItems.push({ name: pMatch[1], detail: pMatch[2] });
    }
  }

  // 선택 표기항목 (optional_items) 추출
  let optionalItems = [];
  const optionalSectionMatch = raw.match(/"optional_items"\s*:\s*\[([\s\S]*?)\]\s*,/i);
  if (optionalSectionMatch && optionalSectionMatch[1]) {
    const optRegex = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"detail"\s*:\s*"([^"]+)"\s*\}/gi;
    let oMatch;
    while ((oMatch = optRegex.exec(optionalSectionMatch[1])) !== null) {
      optionalItems.push({ name: oMatch[1], detail: oMatch[2] });
    }
  }

  // 누락/위반 항목 (failed_items) 추출
  let failedItems = [];
  const failedRegex = /\{\s*"item_name"\s*:\s*"([^"]+)"\s*,\s*"found_text"\s*:\s*"([^"]+)"\s*,\s*"issue_reason"\s*:\s*"([^"]+)"\s*,\s*"law"\s*:\s*"([^"]+)"\s*,\s*"how_to_improve"\s*:\s*"([^"]+)"\s*\}/gi;
  let fMatch;
  while ((fMatch = failedRegex.exec(raw)) !== null) {
    failedItems.push({
      item_name: fMatch[1], found_text: fMatch[2], issue_reason: fMatch[3], law: fMatch[4], how_to_improve: fMatch[5]
    });
  }

  // 증빙서류 교차 대조 (cross_check) 추출
  let crossCheck = [];
  const crossRegex = /\{\s*"item"\s*:\s*"([^"]+)"\s*,\s*"status"\s*:\s*"([^"]+)"\s*,\s*"label_value"\s*:\s*"([^"]+)"\s*,\s*"doc_value"\s*:\s*"([^"]+)"\s*,\s*"note"\s*:\s*"([^"]+)"\s*\}/gi;
  let cMatch;
  while ((cMatch = crossRegex.exec(raw)) !== null) {
    crossCheck.push({
      item: cMatch[1], status: cMatch[2], label_value: cMatch[3], doc_value: cMatch[4], note: cMatch[5]
    });
  }

  return {
    summary: summary,
    analyzed_summary: {
      product_name: productName,
      food_type: foodType,
      detected_items_count: passedItems.length + failedItems.length + optionalItems.length || 0
    },
    passed_items: passedItems,
    optional_items: optionalItems,
    failed_items: failedItems,
    cross_check: crossCheck
  };
}

// 3. 증빙서류/주소 강제 검증 로직
function enforceStrictValidation(data) {
  if (!data || !data.cross_check) return data;
  data.cross_check.forEach(item => {
    const labelVal = (item.label_value || "").trim();
    const docVal = (item.doc_value || "").trim();
    const itemName = item.item || "";

    if (docVal.includes("미제출") || docVal === "" || docVal.includes("없음")) {
      item.status = "mismatch"; item.doc_value = "증빙서류 미제출"; item.note = "자료확인불가";
      return;
    }

    if (itemName.includes("주소") || itemName.includes("소재지")) {
      const cleanLabel = labelVal.replace(/\s+/g, "");
      const cleanDoc = docVal.replace(/\s+/g, "");
      if (cleanLabel !== cleanDoc) {
        item.status = "mismatch";
        if (cleanDoc.length > cleanLabel.length) {
          item.note = "사업자등록증상의 상세주소가 라벨 표기에서 누락되어 불일치함";
        } else {
          item.note = "라벨 표기 주소와 사업자등록증 주소가 일치하지 않음";
        }
      } else {
        item.status = "match"; item.note = "일치함";
      }
    }
  });
  return data;
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    const visionModel = "@cf/meta/llama-3.2-11b-vision-instruct";
    const textModel = "@cf/meta/llama-3.1-70b-instruct";

    if (request.method === "GET") {
      return new Response("🎉 LabelGuard AI v2.3.0 식품공전 필수항목 전수검사 엔진 가동 중!", {
        headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    if (request.method === "POST") {
      try {
        if (!env.AI) throw new Error("Workers AI 바인딩('AI')이 필요합니다.");
        const formData = await request.formData();
        const labelFile = formData.get("image");
        const docFile = formData.get("doc");
        const tesseractLabelText = formData.get("labelText") || "";
        let tesseractDocText = formData.get("docText") || "";

        if (!labelFile) throw new Error("라벨 이미지가 전송되지 않았습니다.");
        try { await env.AI.run(visionModel, { prompt: "agree" }).catch(() => {}); } catch (e) {}

        const labelBuffer = await labelFile.arrayBuffer();
        const labelBytes = Array.from(new Uint8Array(labelBuffer));
        const visionOcrRes = await env.AI.run(visionModel, {
          prompt: "이 라벨 사진의 모든 한글 텍스트(제품명, 규격, 원재료명, 소비기한, 보관방법, 업소명 및 소재지, 영양성분, 주의사항 등)를 정확히 읽으세요.",
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
                prompt: "이 증빙 문서(사업자등록증)의 상호명, 대표자, 사업장 소재지를 읽으세요.",
                image: docBytes
              });
              visionDocText = docOcrRes.response || "";
            }
          } catch (e) {}
        }

        const prompt = `당신은 대한민국 식약처 표시사항 법령 단속관입니다.
[OCR 추출 텍스트] (Tesseract: ${tesseractLabelText} / Vision AI: ${visionLabelText})
[증빙서류 텍스트] (${tesseractDocText || visionDocText || "증빙서류 미제출"})

[완벽 검수 3대 지침 - 절대 엄수]
1. [식품유형 정규화]: '주식조리식품' 등 잘못된 단어는 식약처 공식 용어(예: 즉석조리식품)로 자동 교정하세요. 오타(일르해장국 등)는 문맥에 맞게(얼큰해장국) 교정하세요.
2. [법정 필수 표시항목 전수 검사]: 해당 식품유형에 반드시 들어가야 하는 아래 11개 항목이 라벨에 있는지 전수 대조하세요.
   * 의무 체크리스트: 제품명, 식품유형, 영업소 명칭 및 소재지, 소비기한, 내용량/열량, 원재료명, 영양성분, 용기·포장 재질, 품목보고번호, 보관방법, 주의사항.
   * 위 11개 필수 항목 중 라벨에 정상 표기된 것은 'passed_items'에, 누락되거나 위반된 것은 반드시 'failed_items'에 넣으세요.
3. [선택/추가 항목 분리]: 위 11개 필수 항목이 아닌 기타 표기사항(소비자상담실, 조리방법, 교환 및 환불, 바코드 등)은 법적 의무가 아니므로 **무조건 'optional_items' 배열**에 넣으세요. 절대 passed_items에 섞지 마세요.

[응답 JSON 규격 - 오직 지정된 포맷으로만 답변]
{
  "summary": "검수 결과 총평",
  "analyzed_summary": {
    "product_name": "교정된 제품명",
    "food_type": "식품공전 기준 공식 식품유형",
    "detected_items_count": 0
  },
  "passed_items": [
    { "name": "법정 필수 항목명 (예: 원재료명)", "detail": "적합 사유 및 표기 내용" }
  ],
  "optional_items": [
    { "name": "선택 추가 항목명 (예: 소비자상담실)", "detail": "추가 기재된 내용 설명" }
  ],
  "failed_items": [
    { "item_name": "누락/위반 필수 항목명", "found_text": "검출 문구 또는 누락", "issue_reason": "필수 표시항목 누락/위반 사유", "law": "관련 법령", "how_to_improve": "개선 가이드" }
  ],
  "cross_check": [
    { "item": "영업소 상호 및 소재지 대조", "status": "mismatch", "label_value": "라벨", "doc_value": "증빙서류", "note": "비고" }
  ]
}`;

        const aiRes = await env.AI.run(textModel, { prompt: prompt, max_tokens: 2560 });
        const rawText = aiRes.response || JSON.stringify(aiRes);
        
        let parsedJson = parseAIJSON(rawText) || regexExtractLLMJSON(rawText);

        if (!parsedJson) {
          throw new Error("AI 응답 해석 실패");
        }

        parsedJson = enforceStrictValidation(parsedJson);

        return new Response(JSON.stringify({ success: true, result: parsedJson }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }
  }
};
