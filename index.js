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
    } else { repaired.push(ch); }
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
  let summary = "AI 요원 간 합의 도출이 불분명합니다.";
  const sumMatch = raw.match(/"summary"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
  if (sumMatch && sumMatch[1]) summary = sumMatch[1];

  let productName = "판독 불가"; let foodType = "판독 불가"; 
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
  if (data.failed_items && data.failed_items.some(i => i.item_name && i.item_name.includes("판독 실패"))) {
    data.cross_check = []; return data;
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
          item.note = cleanDoc.length > cleanLabel.length ? "사업자등록증 상세주소가 라벨에서 누락됨" : "라벨 주소와 사업자등록증 주소 불일치";
        } else { item.status = "match"; item.note = "AI 만장일치 일치함"; }
      }
    });
  }
  return data;
}

export default {
  async fetch(request, env) {
    const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    
    // AI 모델 세팅 (역할 분담)
    const visionModel = "@cf/meta/llama-3.2-11b-vision-instruct";
    const agentAModel = "@cf/meta/llama-3.1-8b-instruct"; // 요원 A (초안 작성관)
    const agentBModel = "@cf/meta/llama-3.1-70b-instruct"; // 요원 B (심사관)

    if (request.method === "GET") return new Response("🎉 LabelGuard AI v2.7.0 다중 AI 토론 엔진 가동 중!", { headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" } });

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
          prompt: "이 라벨의 모든 한글 텍스트를 정확히 추출하세요. 읽을 수 없다면 '인식 불가'라고 응답하세요.", image: labelBytes
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

        // 📌 AI 요원 A (초안 작성관) 가동
        const promptA = `당신은 'AI 요원 A (데이터 매핑관)'입니다. 아래 OCR 텍스트에서 식약처 필수항목 데이터를 찾아 초안을 작성하세요.
[Tesseract OCR]: ${tesseractLabelText}
[Vision AI]: ${visionLabelText}`;
        const agentARes = await env.AI.run(agentAModel, { prompt: promptA, max_tokens: 1000 });
        const draftA = agentARes.response || "초안 작성 실패";

        // 📌 AI 요원 B (최종 심사관 및 합의관) 가동
        const promptB = `당신은 'AI 요원 B (최종 심사관)'입니다. AI 요원 A가 작성한 데이터 초안을 원문과 대조하여 이견을 조율하고 최종 JSON 리포트를 작성하세요.

[원문 OCR 텍스트] (Tesseract: ${tesseractLabelText} / Vision AI: ${visionLabelText})
[AI 요원 A의 초안] ${draftA}
[증빙서류 텍스트] (${tesseractDocText || visionDocText || "미제출"})

[AI 요원 B의 교차 검증 및 이견 조율 규칙 - 절대 엄수]
1. [환각 및 엉뚱한 매핑 적발]: 요원 A가 '소비기한'에 '폴리에틸렌'을 넣었거나, '영양성분'에 '주소'를 넣는 등 엉뚱한 값을 넣었다면 이견(Conflict)을 제기하고 해당 항목을 가차 없이 'failed_items'로 강등시키세요. (issue_reason: "AI 요원 간 이견 발생: 잘못된 데이터 매핑 감지")
2. [만장일치 항목만 통과]: 당신과 요원 A의 의견이 100% 일치하고 매핑이 상식적으로 완벽한 법정 필수 항목만 'passed_items'에 남기세요.
3. 내용량, 영양성분 등 필수 항목이 텍스트에 없다면 억지로 만들지 말고 'failed_items'에 누락으로 기록하세요.

[JSON 응답 규격 - 지정된 포맷만 출력]
{
  "summary": "AI 요원 간 교차 검증 및 합의 완료 총평",
  "analyzed_summary": { "product_name": "제품명", "food_type": "식별된 공식 식품유형", "detected_items_count": 0 },
  "passed_items": [ { "name": "항목명", "detail": "만장일치 검증 완료된 내용" } ],
  "optional_items": [ { "name": "선택항목명", "detail": "요약" } ],
  "failed_items": [ { "item_name": "위반/누락/이견 발생 항목", "found_text": "오류 텍스트", "issue_reason": "AI 요원 간 이견 발생 또는 누락", "law": "식품등의 표시기준", "how_to_improve": "명확히 재확인 요망" } ],
  "cross_check": [ { "item": "영업소 소재지 대조", "status": "mismatch", "label_value": "라벨", "doc_value": "서류", "note": "비고" } ]
}`;

        const agentBRes = await env.AI.run(agentBModel, { prompt: promptB, max_tokens: 2560 });
        const rawText = agentBRes.response || JSON.stringify(agentBRes);
        
        let parsedJson = parseAIJSON(rawText) || regexExtractLLMJSON(rawText);
        if (!parsedJson) throw new Error("AI 요원 간 합의문 해석 실패");
        parsedJson = enforceStrictValidation(parsedJson);

        return new Response(JSON.stringify({ success: true, result: parsedJson }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }
  }
};
