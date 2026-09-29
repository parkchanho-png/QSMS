// ArrayBuffer -> Base64 변환
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
        item.note = cleanDoc.length > cleanLabel.length ? "상세주소 누락" : "주소 불일치";
      } else {
        item.status = "match"; item.note = "일치함";
      }
    }
  });
  return data;
}

// 📌 정규식 역파서 (혹시 모를 JSON 에러 대비)
function regexExtractLLMJSON(raw) {
  if (!raw || typeof raw !== "string") return null;

  let summary = "데이터 구조 정제가 완료되었습니다.";
  const sumMatch = raw.match(/"summary"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i);
  if (sumMatch && sumMatch[1]) summary = sumMatch[1];

  let productName = "판독 불가"; let foodType = "분류 불가"; 
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
    failedItems.push({ item_name: fMatch[1], found_text: fMatch[2], issue_reason: fMatch[3], law: fMatch[4], how_to_improve: fMatch[5] });
  }

  let crossCheck = [];
  const crossRegex = /\{\s*"item"\s*:\s*"([^"]+)"\s*,\s*"status"\s*:\s*"([^"]+)"\s*,\s*"label_value"\s*:\s*"([^"]+)"\s*,\s*"doc_value"\s*:\s*"([^"]+)"\s*,\s*"note"\s*:\s*"([^"]+)"\s*\}/gi;
  let cMatch;
  while ((cMatch = crossRegex.exec(raw)) !== null) {
    crossCheck.push({ item: cMatch[1], status: cMatch[2], label_value: cMatch[3], doc_value: cMatch[4], note: cMatch[5] });
  }

  return {
    summary,
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

    if (request.method === "POST") {
      try {
        const geminiApiKey = env.GEMINI_API_KEY;
        if (!geminiApiKey) {
          throw new Error("서버 환경 변수(GEMINI_API_KEY)가 설정되지 않았습니다.");
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

        // 📌 구글 REST API 표준 형식 (inlineData, mimeType) 적용
        const labelBuffer = await labelFile.arrayBuffer();
        const labelBase64 = arrayBufferToBase64(labelBuffer);
        const contentsParts = [
          { inlineData: { mimeType: labelFile.type || "image/jpeg", data: labelBase64 } }
        ];

        if (docFile && typeof docFile === "object" && docFile.arrayBuffer) {
          try {
            const docBuffer = await docFile.arrayBuffer();
            if (docBuffer && docBuffer.byteLength > 0) {
              const docBase64 = arrayBufferToBase64(docBuffer);
              contentsParts.push({ inlineData: { mimeType: docFile.type || "image/jpeg", data: docBase64 } });
            }
          } catch (e) {}
        }

        const promptText = `당신은 대한민국 식약처(MFDS) 표시사항 법령 단속 최고 권위관입니다.
제출된 라벨 이미지 원본과 증빙 서류를 식약처 '식품등의 표시기준' 및 '식품공전' 고시에 따라 정밀 분석하세요.

[검수 및 매핑 지침]
1. 라벨 속 한글을 정밀하게 판독하고 식약처 공식 식품유형(예: 즉석조리식품)으로 동적 분류하세요.
2. 해당 식품유형에 법적으로 요구되는 필수 표기사항(제품명, 식품유형, 영업소 명칭 및 소재지, 소비기한, 내용량, 원재료명, 영양성분, 포장재질, 보관방법 등)을 전수 대조하세요.
3. 누락되었거나 표시기준을 위반한 필수 항목은 'failed_items'에, 적합한 항목은 'passed_items'에 넣으세요.
4. 법적 의무가 아닌 추가 정보(고객상담실, 반품처, 조리방법 등)는 'optional_items'에 분리하세요.

[JSON 응답 규격]
{
  "summary": "검수 결과 총평",
  "analyzed_summary": { "product_name": "제품명", "food_type": "식품유형(공식명칭)", "detected_items_count": 0 },
  "passed_items": [ { "name": "항목명", "detail": "적합 사유" } ],
  "optional_items": [ { "name": "항목명", "detail": "내용" } ],
  "failed_items": [ { "item_name": "항목명", "found_text": "표기 없음", "issue_reason": "누락 사유", "law": "식품등의 표시기준", "how_to_improve": "가이드" } ],
  "cross_check": [ { "item": "영업소 소재지", "status": "mismatch", "label_value": "라벨주소", "doc_value": "증빙주소", "note": "비고" } ]
}`;
        contentsParts.unshift({ text: promptText });

        // 📌 단종 모델 완전 삭제 및 최신 1.5 모델만 배열에 남김
        const modelsToTry = ["gemini-1.5-flash", "gemini-1.5-pro"];
        let jsonString = "";
        let lastError = "";

        for (const modelName of modelsToTry) {
          const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey}`;
          
          const requestBody = {
            contents: [{ parts: contentsParts }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
          };

          const geminiRes = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody)
          });

          if (geminiRes.ok) {
            const data = await geminiRes.json();
            jsonString = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (jsonString) break;
          } else {
            lastError = await geminiRes.text();
          }
        }

        if (!jsonString) {
          throw new Error(`제미나이 API 연동 실패: ${lastError}`);
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
