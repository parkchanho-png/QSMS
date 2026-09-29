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
        return new Response("🎉 식약처 법령 검증 & 증빙서류 교차 대조(Cross-Check) 엔진 가동 중!", {
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
[증빙 자료 교차 대조 지침]
제공된 이미지 중 첫 번째는 '라벨/광고'이고, 두 번째는 '품목제조보고서/증빙서류'입니다.
두 문서의 제품명, 원재료명/함량, 제조원/소비기한 정보가 일치하는지 대조하세요.
`;
        }

        const prompt = `You are a Korean Food Safety Authority (MFDS) inspector.
Analyze the images and respond ONLY with a valid JSON object.
CRITICAL RULE: DO NOT write any intro, greetings, or commentary like "위 이미지의..." or "Here is...". Start immediately with '{' and end with '}'.

${docCheckPrompt}

[REQUIRED JSON SCHEMA]
{
  "is_compliant": false,
  "summary": "식약처 법령 및 증빙서류 검수 결과 한 줄 요약",
  "required_fields": [
    {"name": "제품명", "status": "pass"},
    {"name": "식품유형", "status": "pass"},
    {"name": "업소명 및 소재지", "status": "pass"},
    {"name": "소비기한/유통기한", "status": "pass"},
    {"name": "내용량 및 열량", "status": "pass"},
    {"name": "원재료명", "status": "pass"},
    {"name": "영양성분 표시", "status": "pass"},
    {"name": "용기·포장 재질", "status": "pass"},
    {"name": "품목보고번호", "status": "fail"}
  ],
  "violations": [
    {
      "word": "검출된 표시·광고 위반 문구",
      "issue": "위반 원인 및 오인 가능성",
      "law": "관련 법령 조항",
      "guide": "식약처 권장 수정안"
    }
  ],
  "cross_check": [
    {
      "item": "원재료명 및 함량",
      "status": "mismatch",
      "label_value": "라벨 표기 내용",
      "doc_value": "증빙서류 표기 내용",
      "note": "불일치 사유 및 수정 지침"
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

        // 백엔드 자체 JSON 정제 및 안전 예외 처리 (Fallback)
        let finalJsonObj = null;
        try {
          let cleanStr = rawText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
          const jsonMatch = cleanStr.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            cleanStr = jsonMatch[0];
          }
          finalJsonObj = JSON.parse(cleanStr);
        } catch (parseError) {
          // AI가 서론 텍스트를 출력해 JSON 파싱이 실패했을 때의 안전 구조 생성
          finalJsonObj = {
            is_compliant: false,
            summary: "AI 분석 결과가 텍스트 형태로 수신되어 리포트로 정리되었습니다.",
            required_fields: [],
            violations: [
              {
                word: "AI 분석 텍스트 원문",
                issue: rawText,
                law: "식품등의 표시·광고에 관한 법률",
                guide: "상세 분석 내용을 위 설명글에서 확인해 주세요."
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
