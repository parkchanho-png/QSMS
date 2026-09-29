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
        const formData = await request.formData();
        const imageFile = formData.get("image");

        if (!imageFile) {
          return new Response(
            JSON.stringify({ error: "이미지 파일이 누락되었습니다." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // R2 저장 없이 메모리에서 바이너리로 바로 변환
        const imageArrayBuffer = await imageFile.arrayBuffer();
        const imageBytes = [...new Uint8Array(imageArrayBuffer)];

        const prompt = `
        당신은 대한민국 식약처 및 화장품/식품 법령 표시사항 검수 전문가입니다.
        제공된 이미지에서 한글표시사항 텍스트와 디자인을 분석하세요.

        [필수 검수 기준]
        1. 필수 포함 항목 체크: 제품명, 내용량, 전성분, 영업자의 상호 및 주소, 사용기한/유통기한
        2. 부당한 표시·광고 위반 체크: '완치', '특효', '의약품 오인 문구', '부작용 없음' 등 단정적/과대 표현

        [응답 형식 - 반드시 유효한 JSON으로만 작성]
        {
          "is_compliant": false,
          "extracted_text": "추출된 전체 텍스트",
          "required_fields": [
            {"name": "제품명", "status": "pass"},
            {"name": "내용량", "status": "pass"},
            {"name": "전성분", "status": "pass"},
            {"name": "영업자의 상호 및 주소", "status": "fail"},
            {"name": "사용기한", "status": "pass"}
          ],
          "violations": [
            {
              "word": "검출 문구",
              "issue": "위반 사유",
              "law": "관련 법령 조항",
              "guide": "수정 가이드"
            }
          ]
        }
        `;

        // Vision AI 실행
        let aiResultRaw;
        try {
          aiResultRaw = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
            prompt: prompt,
            image: imageBytes,
          });
        } catch (aiErr) {
          console.error("AI 실행 오류:", aiErr);
        }

        return new Response(JSON.stringify({
          success: true,
          result: aiResultRaw ? aiResultRaw.response : null
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });

      } catch (err) {
        return new Response(
          JSON.stringify({ error: "서버 처리 중 오류가 발생했습니다.", details: err.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }
};
