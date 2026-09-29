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

    // 1) 주소창 접속 (GET): 약관 동의 및 서버 상태 확인
    if (request.method === "GET") {
      try {
        if (env.AI) {
          await env.AI.run(modelName, { prompt: "agree" }).catch(() => {});
        }
        return new Response("🎉 Meta AI 약관 동의 및 식약처 법령 검증 엔진 준비 완료!", {
          headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" }
        });
      } catch (err) {
        return new Response("서버 가동 중: " + err.message, {
          headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" }
        });
      }
    }

    // 2) 분석 요청 (POST)
    if (request.method === "POST") {
      try {
        if (!env.AI) {
          return new Response(
            JSON.stringify({ success: false, error: "Workers AI 바인딩('AI')이 필요합니다." }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const formData = await request.formData();
        const imageFile = formData.get("image");

        if (!imageFile) {
          return new Response(
            JSON.stringify({ success: false, error: "이미지 파일이 전달되지 않았습니다." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const arrayBuffer = await imageFile.arrayBuffer();
        const imageBytes = Array.from(new Uint8Array(arrayBuffer));

        // [법령 DB 강화] 식약처 기준 정밀 검토 프롬프트
        const prompt = `당신은 대한민국 식품의약품안전처(MFDS) 한글표시사항 및 표시·광고 법령 전문 단속관입니다.
제공된 상품 라벨 이미지를 분석하여 '식품등의 표시·광고에 관한 법률' 및 '식품등의 표시기준' 고시에 따라 적합성을 정밀 검토하세요.

[필수 검토 9대 표시항목]
1. 제품명
2. 식품유형
3. 업소명 및 소재지 (제조원/판매원)
4. 소비기한 (또는 유통기한)
5. 내용량 및 열량
6. 원재료명
7. 영양성분 표시
8. 용기·포장 재질
9. 품목보고번호

[부당한 표시·광고 금지 기준 (법률 제8조)]
- 질병의 예방·치료에 효능이 있는 것으로 오인·혼동할 수 있는 표시 (예: 암, 당뇨, 면역력 개선, 피로회복 등)
- 의약품으로 오인·혼동할 수 있는 표시 (예: 치료제, 약, 디톡스 등)
- 건강기능식품이 아닌 일반식품을 건강기능식품으로 오인하게 하는 표시
- 거짓·과장된 표시 또는 소비자를 기만하는 표시
- 다른 업체 또는 제품을 비방하거나 인용/체험기를 이용한 표시

[응답 형식 - 반드시 아래 JSON 구조로만 정확히 답변하세요]
{
  "is_compliant": false,
  "summary": "법령 검토 총평 한 줄 요약",
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
      "word": "검출된 문제 문구",
      "issue": "위반 원인 및 오인 가능성 상세 설명",
      "law": "식품등의 표시·광고에 관한 법률 제8조 제1항",
      "guide": "식약처 권장 수정 문구안"
    }
  ]
}`;

        // 사전 약관 동의 확인 실행
        try { await env.AI.run(modelName, { prompt: "agree" }); } catch (e) {}

        // AI Vision 분석 실행
        const aiResponse = await env.AI.run(modelName, {
          prompt: prompt,
          image: imageBytes,
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
