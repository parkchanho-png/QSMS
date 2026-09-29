// ArrayBuffer -> Base64 변환
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 📌 1단계: 국가법령정보센터(open.law.go.kr) 실시간 최신 법령 수집
async function fetchLatestLawInfo(lawApiKey) {
  if (!lawApiKey) return "국가법령 API 키가 설정되지 않아 기본 '식품등의 표시기준' 고시를 적용합니다.";
  
  try {
    const lawUrl = `https://www.law.go.kr/DRF/lawSearch.do?OC=${lawApiKey}&target=admrul&query=${encodeURIComponent("식품등의 표시기준")}&type=XML`;
    const res = await fetch(lawUrl);
    if (!res.ok) return "최신 법령 조회 지연 (기본 고시 기준 적용)";
    
    const xmlText = await res.text();
    const titleMatch = xmlText.match(/<행정규칙명>(.*?)<\/행정규칙명>/);
    const dateMatch = xmlText.match(/<시행일자>(.*?)<\/시행일자>/);
    const numMatch = xmlText.match(/<발령번호>(.*?)<\/발령번호>/);

    const title = titleMatch ? titleMatch[1] : "식품등의 표시기준";
    const date = dateMatch ? dateMatch[1] : "최신";
    const num = numMatch ? numMatch[1] : "";

    return `[국가법령정보센터 실시간 동기화 완료]\n- 고시명: ${title}\n- 시행일자: ${date}\n- 고시번호: 제${num}호\n본 검수는 위 식약처 최신 고시 기준을 철저히 준수합니다.`;
  } catch (e) {
    return "국가법령 동기화 지연 (기본 고시 기준 적용)";
  }
}

// 📌 2단계: 마크다운 기호 정제 및 안전 JSON 파서
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

// 📌 3단계: 정규식 역파서 (최후 보루)
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

// 📌 4단계: 비즈니스 로직 강제 검증
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
    const lawApiKey = (env.LAW_API_KEY || "").trim();

    // 🔍 진단 모드 (GET)
    if (request.method === "GET") {
      if (!geminiApiKey) return new Response(JSON.stringify({ status: "ERROR", message: "GEMINI_API_KEY 없음" }), { headers: corsHeaders });
      return new Response(JSON.stringify({ system: "LabelGuard AI v4.1.0 (503 점진적 재시도 강화 및 실시간 법령 연동)" }), { headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });
    }

    if (request.method === "POST") {
      try {
        if (!geminiApiKey) throw new Error("[v4.1.0 오류] 서버 환경 변수(GEMINI_API_KEY)가 없습니다.");

        const formData = await request.formData();
        const labelFile = formData.get("image");
        const docFile = formData.get("doc");
        if (!labelFile) throw new Error("라벨 이미지가 전송되지 않았습니다.");

        const lawContext = await fetchLatestLawInfo(lawApiKey);

        const labelBuffer = await labelFile.arrayBuffer();
        const contentsParts = [{ inlineData: { mimeType: labelFile.type || "image/jpeg", data: arrayBufferToBase64(labelBuffer) } }];
        if (docFile && typeof docFile === "object" && docFile.arrayBuffer) {
          try { const docBuffer = await docFile.arrayBuffer(); if (docBuffer.byteLength > 0) contentsParts.push({ inlineData: { mimeType: docFile.type || "image/jpeg", data: arrayBufferToBase64(docBuffer) } }); } catch (e) {}
        }

        const promptText = `당신은 대한민국 식약처(MFDS) 표시사항 법령 단속 최고 권위관입니다.
다음은 국가법령정보센터에서 실시간 수집된 최신 법령 고시 기준입니다:
${lawContext}

[엄격 검수 지침]
1. 이미지 속 제품의 식약처 공식 식품유형을 판독하세요.
2. 아래 10대 법정 필수 항목을 원자 단위(Atomic) 기준표로 세우고, 항목을 절대로 두 개 이상 묶거나 합치지 마세요.
   - 제품명
   - 식품유형
   - 영업소 명칭(제조원/판매원)
   - 영업소 소재지(주소)
   - 소비기한 (또는 유통기한)
   - 내용량 및 내용량에 해당하는 열량
   - 원재료명
   - 영양성분
   - 용기·포장재질
   - 보관방법 및 주의사항
3. 라벨 이미지에서 시각적으로 확인할 수 없는 필수 항목은 사유를 불문하고 'failed_items'에 넣고 found_text를 '표기 없음(누락)'으로 적으세요.
4. 법적 의무가 아닌 정보(고객상담실, 반품처 등)만 'optional_items'에 넣으세요.

[JSON 응답 규격]
{
  "summary": "검수 결과 총평",
  "analyzed_summary": { "product_name": "제품명", "food_type": "식품유형", "detected_items_count": 0 },
  "passed_items": [ { "name": "항목명", "detail": "적합 사유" } ],
  "optional_items": [ { "name": "항목명", "detail": "내용" } ],
  "failed_items": [ { "item_name": "항목명", "found_text": "표기 없음(누락)", "issue_reason": "누락 사유", "law": "식품등의 표시기준", "how_to_improve": "가이드" } ],
  "cross_check": [ { "item": "영업소 소재지", "status": "mismatch", "label_value": "라벨주소", "doc_value": "증빙주소", "note": "비고" } ]
}`;
        contentsParts.unshift({ text: promptText });

        const targetModel = "gemini-3.6-flash";
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${geminiApiKey}`;
        const requestBody = { contents: [{ parts: contentsParts }], generationConfig: { responseMimeType: "application/json", temperature: 0.1 } };

        let rawResponseText = "";
        let lastErrorLog = "";
        
        // 503 순간 과부하를 기다려주는 대기 시간을 늘려 재시도 (2초, 3.5초, 5초)
        const retryDelays = [2000, 3500, 5000];

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

        if (!rawResponseText) throw new Error(`[v4.1.0 서버 오류] ${targetModel} 서버 일시 과부하(503). 몇 초 뒤 다시 버튼을 눌러주세요. 상세: ${lastErrorLog.substring(0, 100)}`);

        let parsedResult = parseAIJSON(rawResponseText) || regexExtractLLMJSON(rawResponseText);
        if (!parsedResult) throw new Error("[v4.1.0 서버 오류] AI 응답 데이터 파싱 실패");
        parsedResult = enforceStrictValidation(parsedResult);

        return new Response(JSON.stringify({ success: true, result: parsedResult }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });

      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } });
      }
    }
  }
};
