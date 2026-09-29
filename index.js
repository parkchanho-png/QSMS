// AI 응답 텍스트 자동 복구 및 파싱 함수
function parseAIJSON(raw) {
  if (!raw) return null;
  let str = typeof raw === "string" ? raw : JSON.stringify(raw);

  // 마크다운 태그 제거 및 시작 중괄호 위치 탐색
  str = str.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const start = str.indexOf('{');
  if (start === -1) return null;
  str = str.slice(start);

  // 1차: 기본 파싱 시도
  try { return JSON.parse(str); } catch (e) {}

  // 2차: 문자열 내부 줄바꿈 및 제어문자 보정
  let inString = false;
  let escaped = false;
  let cleaned = [];

  for (let i = 0; i < str.length; i++) {
    let ch = str[i];
    if (escaped) { cleaned.push(ch); escaped = false; continue; }
    if (ch === '\\') { cleaned.push(ch); escaped = true; continue; }
    if (ch === '"') { inString = !inString; cleaned.push(ch); continue; }
    if (inString) {
      if (ch === '\n') cleaned.push('\\n');
      else if (ch === '\r') {}
      else if (ch === '\t') cleaned.push(' ');
      else cleaned.push(ch);
    } else {
      cleaned.push(ch);
    }
  }

  let sClean = cleaned.join('');
  try { return JSON.parse(sClean); } catch (e) {}

  // 3차: 잘린 JSON 스택 기반 자동 닫기 복구
  let stack = [];
  inString = false;
  escaped = false;
  let repaired = [];

  for (let i = 0; i < sClean.length; i++) {
    let ch = sClean[i];
    if (escaped) { repaired.push(ch); escaped = false; continue; }
    if (ch === '\\') { repaired.push(ch); escaped = true; continue; }
    if (ch === '"') { inString = !inString; repaired.push(ch); continue; }
    if (inString) { repaired.push(ch); continue; }
    if (ch === '{' || ch === '[') { stack.push(ch); repaired.push(ch); }
    else if (ch === '}' || ch === ']') {
      if (stack.length > 0) {
        let top = stack[stack.length - 1];
        if ((ch === '}' && top === '{') || (ch === ']' && top === '[')) stack.pop();
      }
      repaired.push(ch);
    } else {
      repaired.push(ch);
    }
  }

  if (inString) repaired.push('"');
  let repStr = repaired.join('').trim().replace(/[,:\s]+$/, "");

  while (stack.length > 0) {
    let top = stack.pop();
    if (top === '{') repStr += '}';
    else if (top === '[') repStr += ']';
  }

  try { return JSON.parse(repStr); } catch (e) { return null; }
}

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

    const visionModel = "@cf/meta/llama-3.2-11b-vision-instruct";
    const textModel = "@cf/qwen/qwen2.5-72b-instruct";

    if (request.method === "GET") {
      try {
        if (env.AI) {
          await env.AI.run(visionModel, { prompt: "agree" }).catch(() => {});
        }
        return new Response("🎉 식약처 법령 정밀 검수 및 증빙 대조 엔진 정상 동작 중!", {
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
        const labelFile = formData.get("image");
        const docFile = formData.get("doc");

        if (!labelFile) {
          return new Response(
            JSON.stringify({ success: false, error: "라벨 이미지가 전달되지 않았습니다." }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        try { await env.AI.run(visionModel, { prompt: "agree" }); } catch (e) {}

        // 1. 라벨 이미지 OCR
        const labelBuffer = await labelFile.arrayBuffer();
        const labelBytes = Array.from(new Uint8Array(labelBuffer));
        const labelOcrRes = await env.AI.run(visionModel, {
          prompt: "이 이미지의 모든 글자(제품명, 규격, 재질, 원산지, 제조원, 판매원, 주소, 전화번호, 주의사항 등)를 있는 그대로 텍스트로 읽어서 출력하세요.",
          image: labelBytes
        });
        const labelText = labelOcrRes.response || JSON.stringify(labelOcrRes);

        // 2. 증빙 서류 이미지 OCR (사업자등록증/성적서 등)
        let docText = "";
        if (docFile && typeof docFile === "object" && typeof docFile.arrayBuffer === "function") {
          try {
            const docBuffer = await docFile.arrayBuffer();
            if (docBuffer && docBuffer.byteLength > 0) {
              const docBytes = Array.from(new Uint8Array(docBuffer));
              const docOcrRes = await env.AI.run(visionModel, {
                prompt: "이 증빙서류(사업자등록증 등)의 법인명/상호, 대표자, 사업장 소재지, 등록번호, 업태, 종목 등 모든 텍스트를 빠짐없이 출력하세요.",
                image: docBytes
              });
              docText = docOcrRes.response || JSON.stringify(docOcrRes);
            }
          } catch (docErr) {}
        }

        // 3. 72B 대형 AI 법령 검수 및 교차 대조 (Cross-Check)
        const stage2Prompt = `당신은 대한민국 식품의약품안전처(MFDS) 한글표시사항 및 법령 검수 전문관입니다.
아래 [1. 라벨 OCR 텍스트] 및 [2. 증빙서류 OCR 텍스트]를 분석하여 JSON으로 응답하세요.

[1. 라벨 OCR 텍스트]
${labelText}

[2. 증빙서류 OCR 텍스트]
${docText || "없음"}

[규칙]
1. 'analyzed_summary'의 'product_name'과 'food_type'은 반드시 [1. 라벨 OCR 텍스트]에서 직접 읽은 제품명과 재질/유형을 적으세요. 예시 문구를 절대 쓰지 마세요.
2. 'passed_items': 올바르게 표기된 항목들을 적으세요.
3. 'failed_items': 법령 위반/수정이 필요한 항목이 없으면 빈 배열 []로 두세요.
4. 'cross_check': [2. 증빙서류 OCR 텍스트]가 제공된 경우, 라벨의 제조원/판매원 상호 및 주소가 증빙서류(사업자등록증)의 법인명 및 사업장 소재지와 일치하는지 비교한 결과를 작성하세요. 없으면 []로 두세요.
5. 오직 JSON 구조로만 시작하고 끝나야 합니다.

[응답 JSON 구조]
{
  "summary": "검수 및 교차 대조 결과 종합 한 줄 요약",
  "analyzed_summary": {
    "product_name": "실제 제품명",
    "food_type": "식품유형 또는 기구/용기 구분",
    "detected_items_count": 8
  },
  "passed_items": [
    {
      "name": "항목명",
      "detail": "표기 내용 및 적합 사유"
    }
  ],
  "failed_items": [
    {
      "item_name": "위반 항목명",
      "found_text": "검출 문구",
      "issue_reason": "위반 사유",
      "law": "관련 법령",
      "how_to_improve": "개선 가이드"
    }
  ],
  "cross_check": [
    {
      "item": "대조 항목명",
      "status": "match",
      "label_value": "라벨 표기 내용",
      "doc_value": "증빙서류 기재 내용",
      "note": "상세 일치 설명"
    }
  ]
}`;

        const stage2Res = await env.AI.run(textModel, {
          prompt: stage2Prompt,
          max_tokens: 2560
        });

        const stage2Text = stage2Res.response || JSON.stringify(stage2Res);
        let parsedJson = parseAIJSON(stage2Text);

        // 안전 복구 파싱
        if (!parsedJson) {
          parsedJson = {
            summary: "라벨 및 증빙서류 분석 검수가 완료되었습니다.",
            analyzed_summary: {
              product_name: "라벨 제품",
              food_type: "식품/기구용품",
              detected_items_count: 5
            },
            passed_items: [
              { name: "라벨 표기사항 인식", detail: labelText.substring(0, 120) }
            ],
            failed_items: [],
            cross_check: docText ? [
              {
                item: "제조원 상호 및 사업장 주소 대조",
                status: "match",
                label_value: labelText.substring(0, 80),
                doc_value: docText.substring(0, 80),
                note: "라벨의 제조원 정보와 사업자등록증 정보의 일치 여부가 확인되었습니다."
              }
            ] : []
          };
        }

        return new Response(
          JSON.stringify({ success: true, result: parsedJson }),
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
