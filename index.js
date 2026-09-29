// ArrayBuffer -> Base64 변환
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// 백엔드 강제 정밀 검증
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

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    const geminiApiKey = (env.GEMINI_API_KEY || "").trim();

    // 🔍 1. 진단 모드 (웹 브라우저로 백엔드 URL 직접 접속 시 작동)
    if (request.method === "GET") {
      if (!geminiApiKey) {
        return new Response(
          JSON.stringify({ status: "ERROR", message: "Cloudflare 환경변수 GEMINI_API_KEY가 설정되어 있지 않습니다." }, null, 2),
          { headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } }
        );
      }

      try {
        const listModelsUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${geminiApiKey}`;
        const res = await fetch(listModelsUrl);
        const resText = await res.text();
        
        let modelsData = null;
        try { modelsData = JSON.parse(resText); } catch (e) {}

        const isKeyFormatValid = geminiApiKey.startsWith("AIzaSy");

        const diagnosticReport = {
          system: "LabelGuard AI v3.4.0 실시간 진단 리포트",
          api_key_check: {
            starts_with_AIzaSy: isKeyFormatValid,
            note: isKeyFormatValid ? "정상적인 구글 API 키 규격입니다." : "⚠️ 구글 AI 스튜디오 API 키는 보통 'AIzaSy'로 시작합니다. 등록된 키 값을 다시 확인해보세요."
          },
          google_api_http_status: res.status,
          available_models_for_this_key: modelsData?.models
            ? modelsData.models
                .filter(m => m.supportedGenerationMethods?.includes("generateContent"))
                .map(m => m.name.replace("models/", ""))
            : "모델 목록 조회 불가",
          raw_google_response: modelsData || resText
        };

        return new Response(JSON.stringify(diagnosticReport, null, 2), {
          headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ status: "DIAGNOSTIC_FAILED", error: err.message }, null, 2), {
          headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
        });
      }
    }

    // 📌 2. 라벨 검수 모드 (POST)
    if (request.method === "POST") {
      const logs = [];
      try {
        if (!geminiApiKey) throw new Error("서버 환경 변수(GEMINI_API_KEY)가 설정되지 않았습니다.");

        const formData = await request.formData();
        const labelFile = formData.get("image");
        const docFile = formData.get("doc");

        if (!labelFile) {
          return new Response(
            JSON.stringify({ success: false, error: "라벨 이미지가 전송되지 않았습니다." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // 1단계: 구글 API에서 사용 가능한 모델 목록 실시간 수집
        let candidateModels = ["gemini-1.5-flash", "gemini-1.5-pro"];
        try {
          const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${geminiApiKey}`);
          if (listRes.ok) {
            const listData = await listRes.json();
            if (listData.models && Array.isArray(listData.models)) {
              const fetched = listData.models
                .filter(m => m.supportedGenerationMethods?.includes("generateContent"))
                .map(m => m.name.replace("models/", ""));
              if (fetched.length > 0) {
                candidateModels = fetched;
                logs.push(`[자동 탐색 완료] 이 API 키로 즉시 사용 가능한 ${fetched.length}개 모델 감지: ${fetched.join(", ")}`);
              }
            }
          } else {
            const errText = await listRes.text();
            logs.push(`[경고] 모델 자동 탐색 실패 (Status ${listRes.status}): ${errText}`);
          }
        } catch (e) {
          logs.push(`[경고] 모델 탐색 중 예외 발생: ${e.message}`);
        }

        // 2단계: 이미지 바이너리 Base64 변환
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

        let jsonString = "";

        // 3단계: 실시간 탐지된 모델 순차 호출
        for (const modelName of candidateModels) {
          const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${geminiApiKey}`;
          const requestBody = {
            contents: [{ parts: contentsParts }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
          };

          logs.push(`[시도] 모델 '${modelName}' 호출 시작...`);
          const geminiRes = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody)
          });

          if (geminiRes.ok) {
            const data = await geminiRes.json();
            jsonString = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (jsonString) {
              logs.push(`[성공] 모델 '${modelName}' 분석 응답 수신 완료!`);
              break;
            }
          } else {
            const errBody = await geminiRes.text();
            logs.push(`[실패] 모델 '${modelName}' (HTTP ${geminiRes.status}): ${errBody}`);
          }
        }

        if (!jsonString) {
          return new Response(
            JSON.stringify({ success: false, error: "모든 Gemini 모델 연동에 실패했습니다.", debug_logs: logs }, null, 2),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } }
          );
        }

        let parsedResult = null;
        try { parsedResult = JSON.parse(jsonString); } catch (e) {}
        if (!parsedResult) throw new Error("AI 응답 JSON 파싱 실패");

        parsedResult = enforceStrictValidation(parsedResult);

        return new Response(
          JSON.stringify({ success: true, result: parsedResult, debug_logs: logs }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } }
        );

      } catch (err) {
        return new Response(
          JSON.stringify({ success: false, error: err.message || String(err), debug_logs: logs }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" } }
        );
      }
    }
  }
};
