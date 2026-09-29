export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method === "POST") {
      try {
        if (!env.AI) {
          return new Response(
            JSON.stringify({ success: false, error: "Cloudflare 대시보드에서 'AI' 바인딩 설정이 필요합니다." }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const formData = await request.formData();
        const imageFile = formData.get("image");

        if (!imageFile) {
          return new Response(
            JSON.stringify({ success: false, error: "이미지가 전송되지 않았습니다." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
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

        const aiResponse = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
          prompt: prompt,
          image: imageBytes,
        });

        return new Response(
          JSON.stringify({ success: true, result: aiResponse.response || aiResponse }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );

      } catch (err) {
        return new Response(
          JSON.stringify({ success: false, error: err.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    return new Response("LabelGuard AI 백엔드 서버가 정상 작동 중입니다.", {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" }
    });
  }
};
