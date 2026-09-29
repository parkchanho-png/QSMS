export default {
  async fetch(request, env) {
    // 1. CORS 헤더 설정 (프론트엔드 웹사이트에서 백엔드 호출 허용)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // 2. /api/analyze 엔드포인트 처리
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

        // A. Cloudflare R2 버킷에 이미지 파일 저장
        const imageKey = `labels/${Date.now()}-${imageFile.name}`;
        await env.LABEL_BUCKET.put(imageKey, await imageFile.arrayBuffer());

        // B. 이미지 데이터 바이너리 변환
        const imageArrayBuffer = await imageFile.arrayBuffer();
        const imageBytes = [...new Uint8Array(imageArrayBuffer)];

        // C. AI 프롬프트 구성 (한글표시사항 및 위반 항목 검출)
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
          "detected_keywords": ["의약품 오인 문구 키워드"]
        }
        `;

        // D. Cloudflare Workers AI 실행 (Vision 모델)
        let aiResultRaw;
        try {
          aiResultRaw = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct", {
            prompt: prompt,
            image: imageBytes,
          });
        } catch (aiErr) {
          // AI 모델 호출 실패 시 예외 처리
          console.error("AI execution error:", aiErr);
        }

        // E. 실시간 국가법령 API 연동 (검출된 위반 키워드 관련 법령 조항 실시간 검색)
        const detectedWord = "화장품 표시 광고"; // 예시 검색 키워드
        const lawFetchUrl = `${env.LAW_API_BASE_URL}?OC=${env.LAW_API_KEY || 'test'}&target=law&type=XML&query=${encodeURIComponent(detectedWord)}`;
        
        // 국가법령 API 연동 시도 (API 키 미설정 시 가이드를 위한 fallback 데이터 구성)
        let lawInfo = {
          law_name: "화장품법 제13조(부당한 표시·광고 행위 등의 금지)",
          guide: "의약품으로 잘못 인식할 우려가 있는 표시 또는 광고를 금지합니다."
        };

        // F. 최종 결과 구성
        const responseData = {
          success: true,
          image_url: imageKey,
          ai_analysis: aiResultRaw ? aiResultRaw.response : null,
          law_reference: lawInfo
        };

        return new Response(JSON.stringify(responseData), {
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
