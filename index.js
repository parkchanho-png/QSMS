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
        return new Response("🎉 식약처 법령 정밀 검수 및 개선 가이드 엔진이 정상 가동 중입니다!", {
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
Analyze the label/advertisement image and return ONLY a valid JSON object matching the schema below.
CRITICAL RULE: DO NOT write any introduction or explanation text. Start immediately with '{' and end with '}'.

${docCheckPrompt}

[REQUIRED JSON SCHEMA]
{
  "summary": "전체 검수 결과 총평 (예: 총 9개 항목 중 7개 적합, 2개 항목 위반 검출)",
  "analyzed_summary": {
    "product_name": "이미지에서 추출된 제품명 (없으면 '미기재')",
    "food_type": "이미지에서 추출된 식품유형 (없으면 '미기재')",
    "detected_items_count": 9
  },
  "passed_items": [
    {
      "name": "적합 항목명 (예: 제품명)",
      "detail": "인식된 내용 및 적합 사유"
    }
  ],
  "failed_items": [
    {
      "item_name": "위반 항목명 (예: 부당한 표시·광고 / 소비기한 누락)",
      "found_text": "라벨에서 검출된 위반/문제 문구",
      "issue_reason": "무엇이 문제인지 상세 원인 및 소비 오인 위험 설명",
      "law": "관련 법령 (예: 식품등의 표시·광고에 관한 법률 제8조 제1항)",
      "how_to_improve": "어떻게 수정/개선해야 하는지 구체적인 가이드라인 및 추천 대체 문구"
    }
  ],
  "cross_check": [
    {
      "item": "검수 항목 (예: 원재료명 및 함량)",
      "status": "match",
      "label_value": "라벨 표기 내용",
      "doc_value": "증빙서류 내용",
      "note": "일치 여부 및 개선 필요사항"
    }
  ]
}`;

        try { await env.AI.run(modelName, { prompt: "agree" }); } catch (e) {}

        const aiResponse = await env.AI.run(modelName, {
          prompt: prompt,
          image: imagesPayload.length === 1 ? imagesPayload[0] : imagesPayload,
        });

        let rawText = aiResponse.response || aiResponse;
        if (typeof rawText !== "string") {
          rawText = JSON.stringify(rawText);
        }

        let finalJsonObj = null;
        try {
          let cleanStr = rawText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
          const jsonMatch = cleanStr.match(/\{[\s\S]*\}/);
          if (jsonMatch) cleanStr = jsonMatch[0];
          finalJsonObj = JSON.parse(cleanStr);
        } catch (parseError) {
          finalJsonObj = {
            summary: "AI 분석 결과를 리포트 규격으로 변환했습니다.",
            analyzed_summary: { product_name: "라벨 분석", food_type: "일반식품", detected_items_count: 1 },
            passed_items: [{ name: "이미지 텍스트 가독성", detail: "라벨 텍스트가 정상적으로 인식되었습니다." }],
            failed_items: [
              {
                item_name: "분석 내용 정제 필요",
                found_text: "AI 응답 원문 수신",
                issue_reason: rawText,
                law: "식품등의 표시·광고에 관한 법률",
                how_to_improve: "위 원문 텍스트 내용을 바탕으로 표시사항 수정 여부를 확인하세요."
              }
            ],
            cross_check: []
          };
        }

        return new Response(
          JSON.stringify({ success: true, result: finalJsonObj }),
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
