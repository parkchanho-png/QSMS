// AI 응답 텍스트 구문 오류 및 줄바꿈 보정 함수
function parseAIJSON(raw) {
  let str = typeof raw === "string" ? raw : JSON.stringify(raw);

  // 마크다운 블록 및 앞뒤 공백 제거
  str = str.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

  // 최초 '{' 와 마지막 '}' 사이의 JSON 본문 데이터만 정밀 추출
  const start = str.indexOf('{');
  const end = str.lastIndexOf('}');
  if (start !== -1 && end > start) {
    str = str.slice(start, end + 1);
  }

  // 1차 시도: 기본 파싱
  try {
    return JSON.parse(str);
  } catch (e) {
    // 2차 시도: 줄바꿈, 제어문자 및 불필요 쉼표 보정 후 파싱
    try {
      let fixed = str
        .replace(/,\s*([}\]])/g, "$1") // 트레일링 코마 제거
        .replace(/[\r\n]+/g, " ")       // 문자열 내 실제 줄바꿈을 공백 처리
        .replace(/[\u0000-\u001F]+/g, " ");
      return JSON.parse(fixed);
    } catch (e2) {
      return null;
    }
  }
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

    const modelName = "@cf/meta/llama-3.2-11b-vision-instruct";

    if (request.method === "GET") {
      try {
        if (env.AI) {
          await env.AI.run(modelName, { prompt: "agree" }).catch(() => {});
        }
        return new Response("🎉 식약처 법령 정밀 검수 및 개선 가이드 엔진 가동 중!", {
          headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" }
        });
      } catch (err) {
        return new Response("서버 가동 중: " + err.message, {
          headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" }
        });
      }
    }

    if (request.method === "POST") {
      try {
        if (!env.AI) {
          return new Response(
            JSON.stringify({ success: false, error: "Workers AI 바인딩('AI')이 필요합니다." }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const formData = await request.formData();
        const labelFile = formData.get("image");
        const docFile = formData.get("doc");

        if (!labelFile) {
          return new Response(
            JSON.stringify({ success: false, error: "라벨/광고 이미지가 전송되지 않았습니다." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const labelBuffer = await labelFile.arrayBuffer();
        const labelBytes = Array.from(new Uint8Array(labelBuffer));

        let imagesPayload = [labelBytes];
        let docCheckPrompt = "";

        if (docFile) {
          const docBuffer = await docFile.arrayBuffer();
          const docBytes = Array.from(new Uint8Array(docBuffer));
          imagesPayload.push(docBytes);

          docCheckPrompt = `
[증빙 자료 대조 지침]
이미지 1: 라벨/광고 이미지, 이미지 2: 증빙 서류 (품목제조보고서/원재료명세서 등).
두 문서 간 제품명, 원재료, 제조원, 유통기한 일치 여부를 대조하세요.
`;
        }

        const prompt = `You are an official Korean Food Safety Authority (MFDS) inspector.
Analyze the images and respond strictly with valid JSON.
CRITICAL RULE: Do NOT include line breaks inside text values. Keep strings single-lined.

${docCheckPrompt}

[JSON SCHEMA]
{
  "summary": "전체 검수 결과 총평 (예: 총 9개 항목 중 7개 적합, 2개 항목 위반 검출)",
  "analyzed_summary": {
    "product_name": "이미지에서 추출된 제품명",
    "food_type": "이미지에서 추출된 식품유형",
    "detected_items_count": 9
  },
  "passed_items": [
    {
      "name": "적합 항목명",
      "detail": "인식된 내용 및 적합 사유"
    }
  ],
  "failed_items": [
    {
      "item_name": "위반 항목명",
      "found_text": "검출된 위반 문구",
      "issue_reason": "위반 원인 및 소비 오인 위험 설명",
      "law": "관련 법령 조항",
      "how_to_improve": "수정 가이드라인 및 추천 대체 문구"
    }
  ],
  "cross_check": [
    {
      "item": "검수 항목",
      "status": "match",
      "label_value": "라벨 표기 내용",
      "doc_value": "증빙서류 내용",
      "note": "비고 및 개선 가이드"
    }
  ]
}`;

        try { await env.AI.run(modelName, { prompt: "agree" }); } catch (e) {}

        const aiResponse = await env.AI.run(modelName, {
          prompt: prompt,
          image: imagesPayload.length === 1 ? imagesPayload[0] : imagesPayload,
        });

        let rawText = aiResponse.response || aiResponse;
        let parsedJson = parseAIJSON(rawText);

        if (!parsedJson) {
          parsedJson = {
            summary: "AI 분석 결과 데이터 정제 실패 (재분석 필요)",
            analyzed_summary: { product_name: "라벨 분석", food_type: "식품", detected_items_count: 1 },
            passed_items: [{ name: "이미지 수신", detail: "라벨 이미지가 성공적으로 업로드되었습니다." }],
            failed_items: [
              {
                item_name: "AI 데이터 형식 오류",
                found_text: "구문 해석 실패",
                issue_reason: "AI 응답 파싱 중 오류가 발생했습니다.",
                law: "식품등의 표시·광고에 관한 법률",
                how_to_improve: "다시 한 번 [검수 및 개선가이드 생성] 버튼을 눌러주세요."
              }
            ],
            cross_check: []
          };
        }

        return new Response(
          JSON.stringify({ success: true, result: parsedJson }),
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
