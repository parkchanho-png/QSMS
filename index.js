// ArrayBuffer -> Base64 변환 도우미
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// 📌 백엔드 강제 정밀 검증
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
      const cleanLabel = labelVal.replace(/\s+/g, ""); const cleanDoc = docVal.replace(/\s+/g, "");
      if (cleanLabel !== cleanDoc) {
        item.status = "mismatch";
        item.note = cleanDoc.length > cleanLabel.length ? "사업자등록증 상세주소가 라벨에서 누락됨" : "라벨 표기 주소와 사업자등록증 주소 불일치";
      } else {
        item.status = "match"; item.note = "일치함";
      }
    }
  });
  return data;
}

// 📌 텍스트 역파서 (JSON 파싱 실패 대비용)
function regexExtractLLMJSON(raw) {
  if (!raw || typeof raw !== "string") return null;

  let summary = "데이터 구조 정제가 완료되었습니다.";
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

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    if (request.method === "GET") {
      return new Response("🎉 LabelGuard AI v3.2.0 모델 자동 전환(Fallback) 엔진 가동 중!", {
        headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    if (request.method === "POST") {
      try {
        const geminiApiKey = env.GEMINI_API_KEY;
        if (!geminiApiKey) {
          throw new Error("서버 환경 변수(GEMINI_API_KEY)가 없습니다. Cloudflare를 확인하세요.");
        }

        const formData = await request.formData();
        const labelFile = formData.get("image");
        const docFile = formData.get("doc");

        if (!labelFile) {
          return new Response(
            JSON.stringify({ success: false, error: "라벨 이미지가 전송되지 않았습니다." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const labelBuffer = await labelFile.arrayBuffer();
        const labelBase64 = arrayBufferToBase64(labelBuffer);
        const labelMimeType = labelFile.type || "image/jpeg";

        const contentsParts = [
          { inline_data: { mime_type: labelMimeType, data: labelBase64 } }
        ];

        if (docFile && typeof docFile === "object" && docFile.arrayBuffer) {
          try {
            const docBuffer = await docFile.arrayBuffer();
            if (docBuffer && docBuffer.byteLength > 0) {
              const docBase64 = arrayBufferToBase64(docBuffer);
              const docMimeType = docFile.type || "image/jpeg";
              contentsParts.push({ inline_data: { mime_type: docMimeType, data: docBase64 } });
            }
          } catch (e) {}
        }

        const promptText = `당신은 대한민국 식약처(MFDS) 표시사항 법령 단속 최고 권위관입니다.
제출된 라벨 이미지와 증빙 서류를 식약처 '식품등의 표시기준' 및 '식품공전' 고시에 따라 분석하세요.

[JSON 응답 규격 - 반드시 아래 형식을 지킬 것]
{
  "summary": "검수 결과 총평",
  "analyzed_summary": {
    "product_name": "제품명",
    "food_type": "식품유형(공식명칭)",
    "detected_items_count": 0
  },
  "passed_items": [
    { "name": "항목명", "detail": "적합 사유" }
  ],
  "optional_items": [
    { "name": "항목명", "detail": "내용" }
  ],
  "failed_items": [
    { "item_name": "항목명", "found_text": "표기 없음", "issue_reason": "누락/위반 사유", "law": "법령명", "how_to_improve": "가이드" }
  ],
  "cross_check": [
    { "item": "영업소 소재지", "status": "mismatch", "label_value": "라벨주소", "doc_value": "증빙주소", "note": "비고" }
  ]
}`;

        contentsParts.unshift({ text: promptText });

        // 📌 다중 모델 자동 전환 (Fallback) 리스트 - 가능한 모든 버전을 순서대로 찔러봅니다.
        const modelsToTry = [
          "gemini-1.5-flash-latest",
          "gemini-1.5-flash",
          "gemini-1.5-pro-latest",
          "gemini-1.5-pro",
          "gemini-pro-vision"
        ];

        let geminiData = null;
        let lastError = "";
        let jsonString = "";

        for (const modelName of modelsToTry) {
          const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey}`;
          
          let requestBody = { contents: [{ parts: contentsParts }] };
          
          // 구형 모델(pro-vision)은 response_mime_type을 지원하지 않으므로 예외 처리
          if (modelName.includes("1.5")) {
            requestBody.generationConfig = { response_mime_type: "application/json", temperature: 0.1 };
          } else {
            requestBody.generationConfig = { temperature: 0.1 };
          }

          const geminiRes = await fetch(geminiEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody)
          });

          if (geminiRes.ok) {
            geminiData = await geminiRes.json();
            jsonString = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
            if (jsonString) break; // 성공하면 즉시 루프 탈출
          } else {
            lastError = await geminiRes.text();
          }
        }

        if (!jsonString) {
          throw new Error(`모든 제미나이 모델 연결 실패. 마지막 에러: ${lastError}`);
        }

        let parsedResult = null;
        try {
          parsedResult = JSON.parse(jsonString);
        } catch (e) {
          parsedResult = regexExtractLLMJSON(jsonString);
        }

        if (!parsedResult) throw new Error("결과 해석 실패");
        parsedResult = enforceStrictValidation(parsedResult);

        return new Response(
          JSON.stringify({ success: true, result: parsedResult }),
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
