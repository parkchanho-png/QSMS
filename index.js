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

        const prompt = `당신은 대한민국 식약처(MFDS) 한글표시사항 및 품목제조보고서 검수관입니다.
라벨 이미지와 제출된 증빙서류를 대조 검수하세요.

${docCheckPrompt}

[중요: 마크다운 헤더(###)나 기타 인사말을 절대 포함하지 말고, 오직 아래 JSON 형식으로만 답변하세요.]
{
  "is_compliant": false,
  "summary": "법령 및 증빙서류 교차 검수 종합 결과 한 줄 요약",
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
      "issue": "법령 위반 사유 및 오인 가능성",
      "law": "식품등의 표시·광고에 관한 법률 제8조",
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

        // 텍스트에서 JSON 부분만 안전하게 정제 추출하는 로직
        if (typeof rawText === "string") {
          rawText = rawText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
          const jsonMatch = rawText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            rawText = jsonMatch[0];
          }
        }

        return new Response(
          JSON.stringify({ success: true, result: rawText }),
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
