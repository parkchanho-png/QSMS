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
        const labelFile = formData.get("image"); // 라벨/광고 이미지
        const docFile = formData.get("doc");     // 관련 증빙 서류 (선택/필수)

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
[증빙 자료 교차 대조(Cross-Check) 지침]
제공된 이미지 중 첫 번째는 '한글표시사항 라벨/광고'이고, 두 번째는 '품목제조보고서/시험성적서/원재료 스펙시트' 등 증빙 문서입니다.
다음 항목들이 증빙 문서와 라벨 상에서 서로 일치하는지 엄격히 대조하세요:
1. 제품명 및 식품유형 일치 여부
2. 원재료명 및 함량(%) 표기 일치 여부
3. 제조원/업소명 및 소재지 일치 여부
4. 유통기한/소비기한 설정 사유 및 표기 일치 여부
`;
        }

        const prompt = `당신은 대한민국 식약처(MFDS) 전문 표시·광고 및 품목제조보고서 교차 검수관입니다.
제공된 라벨/광고 이미지를 식약처 관련 법령과 대조 분석하고, 증빙 문서가 함께 제출된 경우 교차 검수를 수행하세요.

${docCheckPrompt}

[식약처 필수 검토 9대 항목]
제품명, 식품유형, 업소명 및 소재지, 소비기한/유통기한, 내용량 및 열량, 원재료명, 영양성분, 용기·포장재질, 품목보고번호

[응답 형식 - 반드시 아래 JSON 구조로만 정확히 답변하세요]
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

        return new Response(
          JSON.stringify({ success: true, result: aiResponse.response || aiResponse }),
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
