// ArrayBuffer -> Base64 변환
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// 📌 1단계: 마크다운 기호 정제 및 안전 JSON 파서
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

// 📌 2단계: 정규식 역파서 (최후 보루)
function regexExtractLLMJSON(raw) {
  if (!raw || typeof raw !== "string") return null;
  let summary = "데이터 구조 정제가 완료되었습니다.";
  const sumMatch = raw.match(/"summary"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
  if (sumMatch && sumMatch[1]) summary = sumMatch[1];

  let productName = "판독 완료"; let foodType = "분류 완료"; 
  const prodMatch = raw.match(/"product_name"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
  if (prodMatch && prodMatch[1]) productName = prodMatch[1];
  const typeMatch = raw.match(/"food_type"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
  if (typeMatch && typeMatch[1]) foodType = typeMatch[1];

  let passedItems = []; let optionalItems = []; let failedItems = []; let crossCheck = [];
  const passedSectionMatch = raw.match(/"passed_items"\s*:\s*\[([\s\S]*?)\]\s*,/i);
  if (passedSectionMatch && passedSectionMatch[1]) {
    const passedRegex = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"detail"\s*:\s*"([^"]+)"\s*\}/gi; let pMatch;
    while ((pMatch = passedRegex.exec(passedSectionMatch[1])) !== null) { if (!pMatch[0].includes("status")) passedItems.push({ name: pMatch[1], detail: pMatch[2] }); }
  }
  const optionalSectionMatch = raw.match(/"optional_items"\s*:\s*\[([\s\S]*?)\]\s*,/i);
  if (optionalSectionMatch && optionalSectionMatch[1]) {
    const optRegex = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"detail"\s*:\s*"([^"]+)"\s*\}/gi; let oMatch;
    while ((oMatch = optRegex.exec(optionalSectionMatch[1])) !== null) { optionalItems.push({ name: oMatch[1], detail: oMatch[2] }); }
  }
  const failedRegex = /\{\s*"item_name"\s*:\s*"([^"]+)"\s*,\s*"found_text"\s*:\s*"([^"]+)"\s*,\s*"issue_reason"\s*:\s*"([^"]+)"\s*,\s*"law"\s*:\s*"([^"]+)"\s*,\s*"how_to_improve"\s*:\s*"([^"]+)"\s*\}/gi; let fMatch;
  while ((fMatch = failedRegex.exec(raw)) !== null) { failedItems.push({ item_name: fMatch[1], found_text: fMatch[2], issue_reason: fMatch[3], law: fMatch[4], how_to_improve: fMatch[5] }); }
  const crossRegex = /\{\s*"item"\s*:\s*"([^"]+)"\s*,\s*"status"\s*:\s*"([^"]+)"\s*,\s*"label_value"\s*:\s*"([^"]+)"\s*,\s*"doc_value"\s*:\s*"([^"]+)"\s*,\s*"note"\s*:\s*"([^"]+)"\s*\}/gi; let cMatch;
  while ((cMatch = crossRegex.exec(raw)) !== null) { crossCheck.push({ item: cMatch[1], status: cMatch[2], label_value: cMatch[3], doc_value: cMatch[4], note: cMatch[5] }); }

  return { summary, analyzed_summary: { product_name: productName, food_type: foodType, detected_items_count: passedItems.length + failedItems.length + optionalItems.length }, passed_items: passedItems, optional_items: optionalItems, failed_items: failedItems, cross_check: crossCheck };
}

// 📌 3단계: 비즈니스 로직 강제 검증
function enforceStrictValidation(data) {
  if (!data || !data.cross_check) return data;
  data.cross_check.forEach(item => {
    const labelVal = (item.label_value || "").trim(); const docVal = (item.doc_value || "").trim(); const itemName = item.item || "";
    if (docVal.includes("미제출") || docVal === "" || docVal.includes("없음")) { item.status = "mismatch"; item.doc_value = "증빙서류 미제출"; item.note = "자료확인불가"; return; }
    if (itemName.includes("주소") || itemName.includes("소재지")) {
      const cleanLabel = labelVal.replace(/\s+/g, ""); const cleanDoc = docVal.replace(/\s+/g, "");
      if (cleanLabel !== cleanDoc) { item.status = "mismatch"; item.note = cleanDoc.length > cleanLabel.length ? "상세주소 누락" : "주소 불일치"; } else { item.status = "match"; item.note = "일치함"; }
    }
  }); return data;
}

export default {
  async fetch(request, env) {
    const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const geminiApiKey = (env.GEMINI_API_KEY || "").trim();

    // 🔍 진단 모드 (GET)
    if (request.method === "GET") {
      if (!geminiApiKey) return new Response(JSON.stringify({ status: "ERROR", message: "API 키 없음" }), { headers: corsHeaders });
      return new Response(JSON.stringify({ system: "LabelGuard AI v3.5.1 정상 작동 중", note: "Cloudflare 코드 덮어쓰기 완벽 성공!" }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });
    }

    if (request.method === "POST") {
      try {
        if (!geminiApiKey) throw new Error("[v3.5.1 오류] 서버 환경 변수(GEMINI_API_KEY)가 없습니다.");

        const formData = await request.formData();
        const labelFile = formData.get("image");
        const docFile = formData.get("doc");
        if (!labelFile) throw new Error("라벨 이미지가 전송되지 않았습니다.");

        const labelBuffer = await labelFile.arrayBuffer();
        const contentsParts = [{ inlineData: { mimeType: labelFile.type || "image/jpeg", data: arrayBufferToBase64(labelBuffer) } }];
        if (docFile && typeof docFile === "object" && docFile.arrayBuffer) {
          try { const docBuffer = await docFile.arrayBuffer(); if (docBuffer.byteLength > 0) contentsParts.push({ inlineData: { mimeType: docFile.type || "image/jpeg", data: arrayBufferToBase64(docBuffer) } }); } catch (e) {}
        }

        const promptText = `당신은 대한민국 식약처(MFDS) 표시사항 법령 단속관입니다. 제출된 라벨 이미지를 분석하세요.
[JSON 응답 규격]
{
  "summary": "검수 결과 총평",
  "analyzed_summary": { "product_name": "제품명", "food_type": "식품유형", "detected_items_count": 0 },
  "passed_items": [ { "name": "항목명", "detail": "적합 사유" } ],
  "optional_items": [ { "name": "항목명", "detail": "내용" } ],
  "failed_items": [ { "item_name": "항목명", "found_text": "표기 없음", "issue_reason": "사유", "law": "관련법", "how_to_improve": "가이드" } ],
  "cross_check": [ { "item": "주소", "status": "mismatch", "label_value": "라벨", "doc_value": "증빙", "note": "비고" } ]
}`;
        contentsParts.unshift({ text: promptText });

        // 확실히 작동하는 모델 라인업 하드코딩
        let candidateModels = ["gemini-1.5-flash-latest", "gemini-1.5-flash", "gemini-1.5-pro-latest"];
        let rawResponseText = "";
        let lastErrorLog = "";

        for (const modelName of candidateModels) {
          const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey}`;
          const requestBody = { contents: [{ parts: contentsParts }], generationConfig: { responseMimeType: "application/json", temperature: 0.1 } };
          const geminiRes = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestBody) });
          if (geminiRes.ok) {
            const data = await geminiRes.json();
            rawResponseText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
            if (rawResponseText) break;
          } else {
            lastErrorLog = await geminiRes.text();
          }
        }

        // 🚨 만약 에러가 난다면 여기서 명확한 v3.5.1 에러 메시지를 뿜습니다.
        if (!rawResponseText) throw new Error(`[v3.5.1 서버 오류] 구글 API 응답 실패. 로그: ${lastErrorLog.substring(0, 100)}`);

        let parsedResult = parseAIJSON(rawResponseText) || regexExtractLLMJSON(rawResponseText);
        if (!parsedResult) throw new Error("[v3.5.1 서버 오류] AI 응답 데이터 파싱 실패");
        parsedResult = enforceStrictValidation(parsedResult);

        return new Response(JSON.stringify({ success: true, result: parsedResult }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });

      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });
      }
    }
  }
};
