export default {
  async fetch(request, env) {
    // CORS 헤더 설정
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // 사전 요청(OPTIONS) 통과
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 주소 검사를 없애고, 무조건 POST 요청(이미지 전송)이면 AI 분석 실행
    if (request.method === "POST") {
      try {
        if (!env.AI) {
          return new Response(
            JSON.stringify({ success: false, error: "AI 바인딩이 설정되지 않았습니다." }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const formData = await request.formData();
        const imageFile = formData.get("image");

        if (!imageFile) {
          return new Response(
            JSON.stringify({ success: false, error: "이미지 파일이 전달되지 않았습니다." }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // 이미지 데이터 변환
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

        // AI 모델 실행
        const aiResponse = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
          prompt: prompt,
          image: imageBytes,
        });

        // 결과 반환
        return new Response(
          JSON.stringify({ success: true, result: aiResponse.response || aiResponse }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );

      } catch (err) {
        return new Response(
          JSON.stringify({ success: false, error: `서버 에러: ${err.message}` }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // 테스트용 문구 (웹 브라우저로 접속 시 404 대신 이 문구가 뜹니다)
    return new Response("AI 백엔드 서버가 정상 작동 중입니다. 사이트에서 이미지를 업로드해 주세요.", { 
      headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" } 
    });
  }
};
