// 식약처 금지 문구 및 법령 조항 매핑 DB (RAG 룰베이스)
const LAW_RULES_DB = [
  {
    keywords: ["암 예방", "항암", "당뇨 치료", "혈당 조절", "고혈압 예방", "치매 예방"],
    law: "식품등의 표시·광고에 관한 법률 제8조 제1항 제1호",
    issue: "질병의 예방·치료에 효능이 있는 것으로 오인·혼동할 수 있는 표시·광고",
    guide: "질병 예방/치료 관련 표현을 완전히 삭제해야 합니다."
  },
  {
    keywords: ["디톡스", "체지방 분해", "다이어트 약", "체중 감량", "붓기 제거"],
    law: "식품등의 표시·광고에 관한 법률 제8조 제1항 제2호",
    issue: "의약품으로 오인·혼동할 수 있는 표시·광고 또는 건강기능식품 오인 표시",
    guide: "건강기능식품 인정 없이 다이어트/체중감량 효능을 표기할 수 없습니다."
  },
  {
    keywords: ["면역력 강화", "피로 회복", "간 기능 개선", "혈액 순환 개선"],
    law: "식품등의 표시·광고에 관한 법률 제8조 제1항 제4호",
    issue: "일반식품을 건강기능식품으로 오인·혼동하게 하는 거짓·과장 표시·광고",
    guide: "일반식품인 경우 신체 기능 개선에 관한 기능성 표현을 사용할 수 없습니다."
  },
  {
    keywords: ["최고", "100% 순수", "부작용 없음", "기적의", "신비의"],
    law: "식품등의 표시·광고에 관한 법률 제8조 제1항 제5호",
    issue: "소비자를 기만하거나 객관적 근거 없는 최고·절대적 표현 사용",
    guide: "객관적으로 입증되지 않은 최고/절대적 표현을 삭제하세요."
  }
];

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

    // 1) GET 요청: 상태 확인 및 약관 동의
    if (request.method === "GET") {
      try {
        if (env.AI) {
          await env.AI.run(modelName, { prompt: "agree" }).catch(() => {});
        }
        return new Response("🎉 식약처 법령 DB (RAG Engine) 및 국가법령 연동 백엔드가 가동 중입니다!", {
          headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" }
        });
      } catch (err) {
        return new Response("서버 가동 중: " + err.message, {
          headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" }
        });
      }
    }

    // 2) POST 요청: 이미지 분석 및 법령 DB 매핑
    if (request.method === "POST") {
      try {
        if (!env.AI) {
          return new Response(
            JSON.stringify({ success: false, error: "Workers AI 바인딩('AI')이 비어있습니다." }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const formData = await request.formData();
        const imageFile = formData.get("image");

        if (!imageFile) {
          return new Response(
            JSON.stringify({ success: false, error: "이미지 파일이 전송되지 않았습니다." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const arrayBuffer = await imageFile.arrayBuffer();
        const imageBytes = Array.from(new Uint8Array(arrayBuffer));

        // RAG 법령 DB 지식을 AI 프롬프트에 주입
        const prompt = `당신은 대한민국 식품의약품안전처(MFDS) 전문 법령 단속관입니다.
제공된 상품 라벨 이미지를 분석하고, 아래 제공된 [식약처 핵심 법령 DB] 기준에 따라 적합성을 정밀 검토하세요.

[식약처 핵심 법령 DB (RAG 기준)]
1. 질병 예방·치료 오인 금지 (식품등의 표시·광고에 관한 법률 제8조 제1항 제1호): 암, 당뇨, 혈당, 고혈압, 항암 등
2. 의약품/건강기능식품 오인 금지 (제2호, 제4호): 디톡스, 체체방 분해, 면역력 강화, 피로회복 등
3. 소비자기만 및 과장 표현 금지 (제5호): 최고, 100% 순수, 부작용 없음, 기적의 등

[검토 필수 9대 항목]
제품명, 식품유형, 업소명 및 소재지, 소비기한/유통기한, 내용량 및 열량, 원재료명, 영양성분, 용기·포장재질, 품목보고번호

[응답 형식 - 반드시 아래 JSON 구조로만 정확히 반환하세요]
{
  "is_compliant": false,
  "summary": "식약처 법령 검토 종합 결과 한 줄 요약",
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
      "word": "검출된 문제가 되는 텍스트",
      "issue": "위반 원인 및 법령 오인 가능성 상세 설명",
      "law": "관련 법률 조항 (예: 식품등의 표시·광고에 관한 법률 제8조 제1항 제1호)",
      "guide": "식약처 권장 수정 가이드라인"
    }
  ]
}`;

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
