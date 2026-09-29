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

    // 1) 주소창 접속(GET) 시 Meta 약관 'agree' 자동 제출
    if (request.method === "GET") {
      try {
        await env.AI.run(modelName, { prompt: "agree" });
        return new Response("🎉 Meta AI 약관 동의가 완벽하게 완료되었습니다!\n\n이제 원래 웹사이트로 돌아가서 라벨 분석을 진행해 주세요.", {
          headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" }
        });
      } catch (err) {
        return new Response("동의 처리 중 메시지: " + err.message, {
          headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" }
        });
      }
    }

    // 2) 웹사이트 이미지 분석 요청(POST) 처리
    if (request.method === "POST") {
      try {
        if (!env.AI) {
          return new Response(JSON.stringify({ success: false, error: "Workers AI 바인딩('AI')이 비어있습니다." }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const formData = await request.formData();
        const imageFile = formData.get("image");

        if (!imageFile) {
          return new Response(JSON.stringify({ success: false, error: "이미지 파일이 전달되지 않았습니다." }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const arrayBuffer = await imageFile.arrayBuffer();
        const imageBytes = Array.from(new Uint8Array(arrayBuffer));

        const prompt = `당신은 대한민국 식약처 한글표시사항 및 표시·광고 법령 전문가입니다.
제공된 이미지의 한글표시사항 텍스트를 분석하여 다음 규칙을 검토하세요.

[검토 항목]
1. 필수 한글표시사항 항목 (제품명, 내용량, 전성분/원재료명, 영업자의 상호 및 주소, 유통기한/사용기한)
2. 부당한 표시·광고 위반 및 과대광고 문구

[응답 형식 - 반드시 아래 JSON 구조로만 답변하세요]
{
  "is_compliant": false,
  "required_fields": [
    {"name": "제품명", "status": "pass"},
    {"name": "내용량", "status": "pass"},
    {"name": "전성분/원재료명", "status": "pass"},
    {"name": "영업자의 상호 및 주소", "status": "pass"},
    {"name": "유통기한/사용기한", "status": "fail"}
  ],
  "violations": [
    {
      "word": "검출 문구",
      "issue": "위반 또는 주의 사유",
      "law": "관련 법령 조항",
      "guide": "수정 가이드라인"
    }
  ]
}`;

        // 안전망: 분석 요청 직전에도 'agree' 사전 호출 실행
        try { await env.AI.run(modelName, { prompt: "agree" }); } catch (e) {}

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
