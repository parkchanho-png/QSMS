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

// 2. 가짜 통과를 방지하는 마크다운 역파서
function regexExtractLLMJSON(raw) {
  if (!raw || typeof raw !== "string") return null;

  let summary = "데이터 구조 정제가 완료되었습니다.";
  const sumMatch = raw.match(/"summary"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
  if (sumMatch && sumMatch[1]) summary = sumMatch[1];

  let productName = "판독 불가";
  let foodType = "판독 불가"; 

  const prodMatch = raw.match(/"product_name"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
  if (prodMatch && prodMatch[1]) productName = prodMatch[1];

  const typeMatch = raw.match(/"food_type"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
  if (typeMatch && typeMatch[1]) foodType = typeMatch[1];

  if (productName.includes("일르") || productName.includes("알크레")) productName = productName.replace(/일르|알크레/, "얼큰");

  let passedItems = [];
  const passedSectionMatch = raw.match(/"passed_items"\s*:\s*\[([\s\S]*?)\]\s*,/i);
  if (passedSectionMatch && passedSectionMatch[1]) {
    const passedRegex = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"detail"\s*:\s*"([^"]+)"\s*\}/gi;
    let pMatch;
    while ((pMatch = passedRegex.exec(passedSectionMatch[1])) !== null) {
      if (!pMatch[0].includes("status") && pMatch[1] !== "이미지 텍스트 가독성") passedItems.push({ name: pMatch[1], detail: pMatch[2] });
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
    failedItems.push({ item_name: fMatch[1], found_text: fMatch[2], issue_reason: fMatch[3], law: fMatch[4], how_to_improve: fMatch[5] });
  }

  let crossCheck = [];
  const crossRegex = /\{\s*"item"\s*:\s*"([^"]+)"\s*,\s*"status"\s*:\s*"([^"]+)"\s*,\s*"label_value"\s*:\s*"([^"]+)"\s*,\s*"doc_value"\s*:\s*"([^"]+)"\s*,\s*"note"\s*:\s*"([^"]+)"\s*\}/gi;
  let cMatch;
  while ((cMatch = crossRegex.exec(raw)) !== null) {
    crossCheck.push({ item: cMatch[1], status: cMatch[2], label_value: cMatch[3], doc_value: cMatch[4], note: cMatch[5] });
  }

  return {
    summary: summary,
    analyzed_summary: { product_name: productName, food_type: foodType, detected_items_count: passedItems.length + failedItems.length + optionalItems.length },
    passed_items: passedItems, optional_items: optionalItems, failed_items: failedItems, cross_check: crossCheck
  };
}

function enforceStrictValidation(data) {
  if (!data) return data;
  if (data.failed_items && data.failed_items.some(i => i.item_name && i.item_name.includes("판독 불가"))) {
    data.passed_items = []; data.cross_check = []; return data;
  }
  if (data.cross_check) {
    data.cross_check.forEach(item => {
      const labelVal = (item.label_value || "").trim();
      const docVal = (item.doc_value || "").trim();
      const itemName = item.item || "";

      if (docVal.includes("미제출") || docVal === "" || docVal.includes("없음")) {
        item.status = "mismatch"; item.doc_value = "증빙서류 미제출"; item.note = "자료확인불가"; return;
      }
      if (itemName.includes("주소") || itemName.includes("소재지")) {
        const cleanLabel = labelVal.replace(/\s+/g, ""); const cleanDoc = docVal.replace(/\s+/g, "");
        if (cleanLabel !== cleanDoc) {
          item.status = "mismatch";
          item.note = cleanDoc.length > cleanLabel.length ? "상세주소 누락" : "주소 불일치";
        } else { item.status = "match"; item.note = "일치함"; }
      }
    });
  }
  return data;
}

export default {
  async fetch(request, env) {
    const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    
    const visionModel = "@cf/meta/llama-3.2-11b-vision-instruct";
    const expertModel = "@cf/meta/llama-3.1-70b-instruct"; 

    if (request.method === "GET") return new Response("🎉 LabelGuard AI v2.8.0 맞춤형 심사관 및 끈질긴 OCR 엔진 가동 중!", { headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" } });

    if (request.method === "POST") {
      try {
        if (!env.AI) throw new Error("Workers AI 바인딩('AI')이 필요합니다.");
        const formData = await request.formData();
        const labelFile = formData.get("image"); const docFile = formData.get("doc");
        const tesseractLabelText = formData.get("labelText") || ""; let tesseractDocText = formData.get("docText") || "";
        if (!labelFile) throw new Error("라벨 이미지가 전송되지 않았습니다.");
        
        try { await env.AI.run(visionModel, { prompt: "agree" }).catch(() => {}); } catch (e) {}

        const labelBuffer = await labelFile.arrayBuffer(); const labelBytes = Array.from(new Uint8Array(labelBuffer));
        const visionOcrRes = await env.AI.run(visionModel, {
          prompt: "이 라벨 사진의 모든 한글 텍스트를 가장 세밀하게 추출하세요. 읽을 수 없다면 빈 칸으로 두세요.", image: labelBytes
        });
        const visionLabelText = visionOcrRes.response || "";

        let visionDocText = "";
        if (docFile && typeof docFile === "object" && docFile.arrayBuffer) {
          try {
            const docBuffer = await docFile.arrayBuffer();
            if (docBuffer && docBuffer.byteLength > 0) {
              const docBytes = Array.from(new Uint8Array(docBuffer));
              const docOcrRes = await env.AI.run(visionModel, { prompt: "증빙 문서의 상호명, 사업장 소재지를 읽으세요.", image: docBytes });
              visionDocText = docOcrRes.response || "";
            }
          } catch (e) {}
        }

        // 📌 사전 차단(Zero-Tolerance Cut-off): OCR이 거의 안 읽혔으면 70B를 부르지 않고 즉각 에러 반환
        const totalTextLength = (tesseractLabelText + visionLabelText).replace(/\s/g, '').length;
        if (totalTextLength < 20) {
          const failJson = {
            summary: "텍스트 판독이 불가하여 검수를 진행할 수 없습니다.",
            analyzed_summary: { product_name: "판독 불가", food_type: "판독 불가", detected_items_count: 0 },
            passed_items: [], optional_items: [],
            failed_items: [{ item_name: "이미지 판독 불가", found_text: "인식된 글자 부족", issue_reason: "다중 OCR 재시도에도 불구하고 라벨 텍스트를 거의 인식하지 못했습니다.", law: "확인 불가", how_to_improve: "선명하고 해상도가 높은 원본 사진으로 다시 업로드해 주세요." }],
            cross_check: []
          };
          return new Response(JSON.stringify({ success: true, result: failJson }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        // 📌 맞춤형(Fine-Tuned) AI 심사관 프롬프트
        const prompt = `당신은 '식품의 기준 및 규격(식품공전)'과 '식품등의 표시기준'에 맞춰 완벽하게 파인튜닝(Fine-Tuned)된 단일 최고 AI 심사관입니다.
추출된 OCR 데이터를 바탕으로 식약처 법령에 따라 정밀하게 대조하고 가짜 결과(Hallucination)를 절대 생성하지 마세요.

[다중 추출 텍스트 통합본]
${tesseractLabelText}
${visionLabelText}

[증빙서류 텍스트]
${tesseractDocText || visionDocText || "증빙서류 미제출"}

[파인튜닝 심사관의 절대 지침]
1. [식품공전 매핑]: 추출된 텍스트를 분석하여, 해당 제품이 식품공전 상 어떤 공식 '식품유형'(예: 즉석조리식품, 빵류, 식육추출가공품 등)에 속하는지 정확히 판단하세요. '일반식품'이나 '해장국' 같은 모호한 단어는 금지됩니다.
2. [필수 항목 전수 점검]: 판단한 '식품유형'에 따라 식약처에서 요구하는 필수 기재사항(제품명, 원재료명, 소비기한, 내용량, 영양성분, 보관방법, 용기재질 등)이 모두 표기되어 있는지 확인하세요.
3. [가짜 통과 금지]: 텍스트에 내용량(g/ml)이나 영양성분이 표기되어 있지 않다면, 절대 '적합'으로 넘기지 말고 반드시 'failed_items'에 누락 항목으로 기재하세요.
4. [선택 항목 분리]: 법정 필수 항목 외의 추가 기재사항(고객센터, 반품처, 조리법 등)은 'optional_items'로 분리하세요.

[JSON 응답 규격]
{
  "summary": "식품공전 기반 검수 결과 총평",
  "analyzed_summary": { "product_name": "제품명", "food_type": "식품공전 공식 식품유형", "detected_items_count": 0 },
  "passed_items": [ { "name": "명확히 확인된 필수 항목", "detail": "적합 사유" } ],
  "optional_items": [ { "name": "선택 표기 항목", "detail": "내용" } ],
  "failed_items": [ { "item_name": "누락되거나 위반된 필수 항목 (예: 내용량 누락, 영양성분 누락)", "found_text": "표기 없음", "issue_reason": "위반 사유", "law": "식품등의 표시기준", "how_to_improve": "가이드" } ],
  "cross_check": [ { "item": "영업소 소재지 등 대조", "status": "mismatch", "label_value": "라벨", "doc_value": "서류", "note": "비고" } ]
}`;

        const aiRes = await env.AI.run(expertModel, { prompt: prompt, max_tokens: 2560 });
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
