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

    const url = new URL(request.url);

    if (url.pathname === "/api/analyze" && request.method === "POST") {
      try {
        if (!env.AI) {
          return new Response(
            JSON.stringify({ success: false, error: "Workers AI 바인딩('AI')이 설정되지 않았습니다." }),
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

        const imageArrayBuffer = await imageFile.arrayBuffer();
        const imageBytes = [...new Uint8Array(imageArrayBuffer)];

        const prompt = `
        당신은 대한민국 식약처 및 표시·광고 관련 법령 전문가입니다.
        제공된 이미지에서 한글표시사항 텍스트 및 정보를 분석하세요.

        [검토 기준]
        - 필수 표기사항: 제품명, 내용량, 원재료명/전성분, 영업자의 상호 및 주소, 유통기한/사용기한
        - 표시·광고 위반: 의약품 오인 문구, 단정적/과대 표현

        [응답 형식 - 반드시 아래 JSON으로만 응답]
        {
          "is_compliant": false,
          "required_fields": [
            {"name": "제품명", "status": "pass"},
            {"name": "내용량", "status": "pass"},
            {"name": "전성분/원재료명", "status": "pass"},
            {"name": "영업자의 상호 및 주소", "status": "pass"},
            {"name": "유통기한/사용기한", "status": "pass"}
          ],
          "violations": [
            {
              "word": "검출 문구",
              "issue": "위반 사유",
              "law": "관련 법령 조항",
              "guide": "수정 가이드라인"
            }
          ]
        }
        `;

        let aiResponse;
        try {
          aiResponse = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
            prompt: prompt,
            image: imageBytes,
          });
        } catch (aiError) {
          return new Response(
            JSON.stringify({ success: false, error: `AI 분석 타임아웃 또는 연동 오류: ${aiError.message}` }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        return new Response(
          JSON.stringify({ success: true, result: aiResponse.response || aiResponse }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );

      } catch (err) {
        return new Response(
          JSON.stringify({ success: false, error: `서버 내부 오류: ${err.message}` }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }
};
