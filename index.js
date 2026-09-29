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

    // 🔥 핵심 해결책: 인터넷 주소창으로 직접 접속했을 때 (GET 요청) 'agree' 자동 제출!
    if (request.method === "GET") {
      try {
        const agreeResponse = await env.AI.run(modelName, { prompt: "agree" });
        return new Response("✅ Meta AI 라이선스 동의가 완벽하게 성공했습니다!\n\n이제 돌아가서 라벨 사진을 업로드하고 분석을 시작하세요!\n(서버응답: " + JSON.stringify(agreeResponse) + ")", {
          headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" }
        });
      } catch (err) {
        return new Response("동의 시도 중 에러 발생 (새로고침 해보세요): " + err.message, {
          headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" }
        });
      }
    }

    // 기존 프론트엔드 이미지 분석 (POST 요청)
    if (request.method === "POST") {
      try {
        if (!env.AI) {
          return new Response(JSON.stringify({ success: false, error: "AI 바인딩 필요" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const formData = await request.formData();
        const imageFile = formData.get("image");

        if (!imageFile) {
          return new Response(JSON.stringify({ success: false, error: "이미지 누락" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }
  }
};
