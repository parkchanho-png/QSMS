// ArrayBuffer -> Base64 변환 도우미 함수
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// 📌 백엔드 강제 정밀 검증 알고리즘 (주소 누락 / 미제출 서류 100% 통제)
function enforceStrictValidation(data) {
  if (!data || !data.cross_check) return data;

  data.cross_check.forEach(item => {
    const labelVal = (item.label_value || "").trim();
    const docVal = (item.doc_value || "").trim();
    const itemName = item.item || "";

    // 1. 증빙서류 미제출 강제 불일치 & 비고 '자료확인불가' 고정
    if (docVal.includes("미제출") || docVal === "" || docVal.includes("없음")) {
      item.status = "mismatch";
      item.doc_value = "증빙서류 미제출";
      item.note = "자료확인불가";
      return;
    }

    // 2. 영업소 소재지 주소 정밀 검증
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
        item.status = "match";
        item.note = "일치함";
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

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 구글 제미나이 API 키 및 엔드포인트 세팅
    const geminiApiKey = env.GEMINI_API_KEY || "AQ.Ab8RN6JtDy4b7PvPQy1VW-ASRc6knPEkw60dSVDnbyCb6elKHw";
    const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;

    if (request.method === "GET") {
      return new Response("🎉 LabelGuard AI v3.0.0 구글 제미나이 네이티브 비전 엔진 가동 중!", {
        headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" }
      });
    }

    if (request.method === "POST") {
      try {
        const formData = await request.formData();
        const labelFile = formData.get("image");
        const docFile = formData.get("doc");

        if (!labelFile) {
          return new Response(
            JSON.stringify({ success: false, error: "라벨 이미지가 전송되지 않았습니다." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // 라벨 원본 이미지 Base64 변환
        const labelBuffer = await labelFile.arrayBuffer();
        const labelBase64 = arrayBufferToBase64(labelBuffer);
        const labelMimeType = labelFile.type || "image/jpeg";

        const contentsParts = [
          {
            inline_data: {
              mime_type: labelMimeType,
              data: labelBase64
            }
          }
        ];

        // 증빙서류 이미지 업로드 시 Base64 변환 추가
        if (docFile && typeof docFile === "object" && docFile.arrayBuffer) {
          try {
            const docBuffer = await docFile.arrayBuffer();
            if (docBuffer && docBuffer.byteLength > 0) {
              const docBase64 = arrayBufferToBase64(docBuffer);
              const docMimeType = docFile.type || "image/jpeg";
              contentsParts.push({
                inline_data: {
                  mime_type: docMimeType,
                  data: docBase64
                }
              });
            }
          } catch (e) {}
        }

        const promptText = `당신은 대한민국 식약처(MFDS) 표시사항 법령 단속 최고 권위관입니다.
제출된 라벨 원본 이미지(첫 번째 이미지)와 증빙 서류(두 번째 이미지, 있을 경우)를 식약처 '식품등의 표시기준' 및 '식품공전' 고시에 따라 정밀 분석하세요.

[검수 및 매핑 지침]
1. [정확한 OCR 및 교정]: 라벨 속 한글 글자를 사람처럼 정밀하게 인지하세요. (예: 제품명은 'TBK 얼큰해장국'입니다).
2. [식품유형 동적 매핑]: 라벨에 적힌 식품유형을 파악하세요. (예: '즉석조리식품(비살균제품/가열하여 섭취하는 냉동식품)'). 절대로 '해장국'이나 '일반식품' 같은 모호한 요리명을 적지 마세요.
3. [법정 필수 표시항목 전수 대조]: 해당 식품유형에 법적으로 요구되는 필수 표기사항(제품명, 식품유형, 영업소 명칭 및 소재지, 소비기한, 내용량, 원재료명, 영양성분, 용기·포장 재질, 품목보고번호, 보관방법, 주의사항 등)을 대조하세요.
   - 라벨에 올바르게 적힌 필수 항목은 'passed_items'에 수록하세요.
   - 라벨에서 누락되었거나 표시기준을 위반한 필수 항목은 반드시 'failed_items'에 넣으세요.
4. [선택/추가 표기 항목 분리]: 법적 의무가 아닌 정보(고객상담실, 반품 및 교환장소, 조리방법, 바코드 등)는 무조건 'optional_items' 배열로 분리하세요.
5. [증빙서류 교차 대조]: 
   - 라벨에 적힌 제조원 주소와 사업자등록증 주소를 대조할 때, 건물명/동/층/호(예: '나동 1층 우측면') 상세주소가 라벨에서 누락되었다면 status: "mismatch", note: "사업자등록증상의 상세주소가 라벨 표기에서 누락되어 불일치함"으로 평가하세요.
   - 판매원 서류가 제출되지 않았다면 doc_value: "증빙서류 미제출", status: "mismatch", note: "자료확인불가"로 평가하세요.`;

        contentsParts.unshift({ text: promptText });

        const geminiRequestBody = {
          contents: [{ parts: contentsParts }],
          generationConfig: {
            response_mime_type: "application/json",
            temperature: 0.1
          }
        };

        const geminiRes = await fetch(geminiEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(geminiRequestBody)
        });

        if (!geminiRes.ok) {
          const errText = await geminiRes.text();
          throw new Error(`Google Gemini API 오류 (${geminiRes.status}): ${errText}`);
        }

        const geminiData = await geminiRes.json();
        const jsonString = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!jsonString) {
          throw new Error("구글 제미나이 응답에서 JSON 결과를 추출하지 못했습니다.");
        }

        let parsedResult = JSON.parse(jsonString);

        // 강제 검증 알고리즘 적용
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
