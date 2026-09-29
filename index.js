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

// 2. 마크다운 방어 정규식 추출기
function regexExtractLLMJSON(raw) {
  if (!raw || typeof raw !== "string") return null;

  let summary = "분석 결과 텍스트가 불분명합니다.";
  const sumMatch = raw.match(/"summary"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
  if (sumMatch && sumMatch[1]) summary = sumMatch[1];

  let productName = "판독 불가";
  let foodType = "판독 불가"; 

  const prodMatch = raw.match(/"product_name"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
  if (prodMatch && prodMatch[1]) productName = prodMatch[1];

  const typeMatch = raw.match(/"food_type"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
  if (typeMatch && typeMatch[1]) foodType = typeMatch[1];

  let passedItems = [];
  const passedSectionMatch = raw.match(/"passed_items"\s*:\s*\[([\s\S]*?)\]\s*,/i);
  if (passedSectionMatch && passedSectionMatch[1]) {
    const passedRegex = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"detail"\s*:\s*"([^"]+)"\s*\}/gi;
    let pMatch;
    while ((pMatch = passedRegex.exec(passedSectionMatch[1])) !== null) {
      if (!pMatch[0].includes("status")) passedItems.push({ name: pMatch[1], detail: pMatch[2] });
    }
  }

  let optionalItems = [];
  const optionalSectionMatch = raw.match(/"optional_items"\s*:\s*\[([\s\S]*?)\]\s*,/i);
  if (optionalSectionMatch && optionalSectionMatch[1]) {
    const optRegex = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"detail"\s*:\s*"([^"]+)"\s*\}/gi;
    let oMatch;
    while ((oMatch = optRegex.exec(optionalSectionMatch[1])) !== null) {
      optionalItems.push({ name: oMatch[1], detail: oMatch[2] });
    }
  }

  let failedItems = [];
  const failedRegex = /\{\s*"item_name"\s*:\s*"([^"]+)"\s*,\s*"found_text"\s*:\s*"([^"]+)"\s*,\s*"issue_reason"\s*:\s*"([^"]+)"\s*,\s*"law"\s*:\s*"([^"]+)"\s*,\s*"how_to_improve"\s*:\s*"([^"]+)"\s*\}/gi;
  let fMatch;
  while ((fMatch = failedRegex.exec(raw)) !== null) {
    failedItems.push({
      item_name: fMatch[1], found_text: fMatch[2], issue_reason: fMatch[3], law: fMatch[4], how_to_improve: fMatch[5]
    });
  }

  let crossCheck = [];
  const crossRegex = /\{\s*"item"\s*:\s*"([^"]+)"\s*,\s*"status"\s*:\s*"([^"]+)"\s*,\s*"label_value"\s*:\s*"([^"]+)"\s*,\s*"doc_value"\s*:\s*"([^"]+)"\s*,\s*"note"\s*:\s*"([^"]+)"\s*\}/gi;
  let cMatch;
  while ((cMatch = crossRegex.exec(raw)) !== null) {
    crossCheck.push({
      item: cMatch[1], status: cMatch[2], label_value: cMatch[3], doc_value: cMatch[4], note: cMatch[5]
    });
  }

  if (passedItems.length === 0 && failedItems.length === 0 && optionalItems.length === 0) {
    summary = "다중 OCR 엔진이 이미지 텍스트를 제대로 인식하지 못해 검수를 진행할 수 없습니다.";
    failedItems.push({
      item_name: "다중 OCR 판독 실패",
      found_text: "인식된 데이터 없음",
      issue_reason: "이미지 해상도 및 폰트 문제로 Tesseract와 Vision AI 모두 판독에 실패했습니다.",
      law: "판독 불가",
      how_to_improve: "선명한 이미지를 다시 업로드해 주세요."
    });
  }

  return {
    summary: summary,
    analyzed_summary: {
      product_name: productName,
      food_type: foodType,
      detected_items_count: passedItems.length + failedItems.length + optionalItems.length
    },
    passed_items: passedItems,
    optional_items: optionalItems,
    failed_items: failedItems,
    cross_check: crossCheck
  };
}

// 3. 증빙서류 강제 검증 로직
function enforceStrictValidation(data) {
  if (!data) return data;
  if (data.failed_items && data.failed_items.some(i => i.item_name.includes("판독 실패"))) {
    data.cross_check = []; return data;
  }
  if (data.cross_check) {
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
  }
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
      return new Response("🎉 LabelGuard AI v2.5.0 다중 OCR 교차 검증 엔진 가동 중!", {
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
          prompt: "이 라벨 사진의 모든 한글 텍스트(제품명, 규격, 원재료명, 소비기한, 보관방법, 업소명 및 소재지, 영양성분, 주의사항 등)를 정확히 읽으세요. 읽을 수 없다면 '인식 불가'라고 응답하세요.",
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
                prompt: "이 증빙 문서의 상호명, 대표자, 사업장 소재지를 읽으세요.",
                image: docBytes
              });
              visionDocText = docOcrRes.response || "";
            }
          } catch (e) {}
        }

        // 📌 다중 OCR 앙상블 및 교차 검증 알고리즘 프롬프트
        const prompt = `당신은 대한민국 식약처 전문 표시사항 검수관이자 '다중 OCR 데이터 교차 검증(Ensemble) 전문가'입니다.
두 가지 다른 AI 엔진이 추출한 데이터를 비교 분석하여 최종 정밀 검수를 수행하세요.

[다중 OCR 추출 텍스트]
- 엔진 A (Tesseract.js): ${tesseractLabelText || "인식 실패"}
- 엔진 B (Vision AI): ${visionLabelText || "인식 실패"}

[증빙서류 텍스트]
${tesseractDocText || visionDocText || "증빙서류 미제출"}

[다중 OCR 교차 검증 및 식약처 검수 지침]
1. [데이터 앙상블 복원]: 엔진 A와 엔진 B의 결과를 글자 단위로 교차 검증하세요. 한 엔진에서 '알크레'라고 오독했더라도, 다른 엔진의 데이터나 당신의 식품 도메인 지식을 활용해 올바른 단어('얼큰')로 100% 복원해 내야 합니다.
2. [판독 불가 판단]: 두 엔진 모두에서 의미 있는 식약처 필수항목 관련 한글 텍스트를 찾을 수 없다면, 억지로 지어내지 말고 failed_items에 "다중 OCR 판독 실패" 하나만 넣고 종료하세요.
3. [식품유형 동적 매핑]: 복원된 텍스트를 바탕으로 정확한 '식품유형'을 파악하고, 대한민국 식품공전 기준 해당 유형에 반드시 표기되어야 하는 법정 필수 항목만 선별하여 누락 여부를 대조하세요.
4. [필수 vs 선택 분리]: 법정 필수 항목은 'passed_items'나 'failed_items'에, 소비자상담실/반품처 등 자율 추가 항목은 'optional_items' 배열에 분리하세요.

[JSON 응답 규격]
{
  "summary": "다중 OCR 교차 검증 결과 총평",
  "analyzed_summary": {
    "product_name": "교차 검증으로 복원된 정확한 제품명",
    "food_type": "식별된 식품유형",
    "detected_items_count": 0
  },
  "passed_items": [
    { "name": "해당 유형 법정 필수 항목", "detail": "적합 사유" }
  ],
  "optional_items": [
    { "name": "선택/추가 항목", "detail": "내용 요약" }
  ],
  "failed_items": [
    { "item_name": "위반/누락 항목명", "found_text": "검출 문구", "issue_reason": "누락 사유", "law": "관련 법령", "how_to_improve": "가이드" }
  ],
  "cross_check": [
    { "item": "대조 항목", "status": "mismatch", "label_value": "라벨", "doc_value": "서류", "note": "비고" }
  ]
}`;

        const aiRes = await env.AI.run(textModel, { prompt: prompt, max_tokens: 2560 });
        const rawText = aiRes.response || JSON.stringify(aiRes);
        
        let parsedJson = parseAIJSON(rawText) || regexExtractLLMJSON(rawText);

        if (!parsedJson) throw new Error("AI 응답 해석 실패");
        parsedJson = enforceStrictValidation(parsedJson);

        return new Response(JSON.stringify({ success: true, result: parsedJson }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }
  }
};
