/**
 * ==============================================================================
 * 파일명: api/parse-receipt.js
 * 설명: 결제 내역 영수증 이미지 또는 텍스트를 받아 OpenRouter API를 통해
 *       정형화된 구독 지출 데이터(JSON)로 추출하는 Vercel 서버리스 함수
 * ==============================================================================
 */

// Node.js 환경에서 .env.local 자동 로드 (로컬 개발 환경 호환성 보장)
try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile('.env.local');
  }
} catch (e) {
  // 배포 환경이거나 파일이 없을 경우 무시
}

export default async function handler(req, res) {
  // CORS 및 HTTP 메소드 검증 (POST 요청만 허용)
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      message: '허용되지 않는 HTTP 메소드입니다. POST 요청을 사용해 주세요.'
    });
  }

  try {
    // 1. 요청 바디에서 텍스트 또는 이미지 데이터 추출
    const { text, imageBase64, mimeType = 'image/jpeg' } = req.body || {};

    if (!text && !imageBase64) {
      return res.status(400).json({
        success: false,
        message: '분석할 결제 텍스트 또는 영수증 이미지가 제공되지 않았습니다.'
      });
    }

    // 2. 환경 변수 확인 (OpenRouter API 키 및 모델)
    const apiKey = process.env.OPENROUTER_API_KEY;
    const model = process.env.OPENROUTER_MODEL || 'google/gemma-4-26b-a4b-it:free';

    if (!apiKey) {
      return res.status(500).json({
        success: false,
        message: '서버 환경 변수(OPENROUTER_API_KEY)가 설정되지 않았습니다. .env.local을 확인해 주세요.'
      });
    }

    // 3. OpenRouter API 프롬프트 구성 (Vision 멀티모달 & 텍스트 통합)
    const systemPrompt = `
당신은 대한민국 대학생의 금융 결제 영수증 및 카드 승인 문자를 전문적으로 분석하는 '스마트 핀테크 OCR 파서'입니다.
제공된 이미지 또는 텍스트에서 정기 구독 및 고정 지출 항목을 식별하여 반드시 아래 JSON 규격으로만 응답하세요.

[추출 규칙]
1. service_name: 서비스 공식 명칭을 한글/영문 표준명으로 통일 (예: 넷플릭스, 유튜브 프리미엄, 쿠팡 와우, ChatGPT Plus 등)
2. category: [OTT, 음원, 생산성/AI, 쇼핑/멤버십, 통신/클라우드, 생활/주거, 기타] 중 하나 선택
3. amount: 결제된 순수 원화(KRW) 금액을 정수형 숫자(Number)로 추출. (콤마 제거, 외화 결제는 원화 환산 표기 우선)
4. billing_cycle: [월간, 연간, 주간, 1회성] 중 판별 (정기 결제 패턴은 기본 '월간')
5. billing_date: 결제일의 일자(1~31) 숫자(Number) 추출 (파악 불가 시 오늘 일자)
6. confidence_score: 0.0 ~ 1.0 사이의 파싱 신뢰도 점수

[응답 필수 조건]
- 마크다운 블록(\`\`\`json 등)이나 서두/결문 설명 없이 '순수한 JSON 문자열'만 출력하세요.
- 카드번호, 승인번호 등 개인정보는 일절 추출하지 마세요.
- 형식이 맞지 않거나 여러 건이면 items 배열에 모두 담으세요.

[출력 JSON 예시]
{
  "items": [
    {
      "service_name": "유튜브 프리미엄",
      "category": "음원",
      "amount": 14900,
      "billing_cycle": "월간",
      "billing_date": 15,
      "confidence_score": 0.95
    }
  ]
}
`.trim();

    // 4. 메시지 페이로드 생성 (이미지 첨부 여부에 따른 분기)
    const userContent = [];

    if (text) {
      userContent.push({
        type: 'text',
        text: `[결제 텍스트 내역]:\n${text}`
      });
    }

    if (imageBase64) {
      // Data URL 형식 정규화
      const imageUrl = imageBase64.startsWith('data:')
        ? imageBase64
        : `data:${mimeType};base64,${imageBase64}`;

      userContent.push({
        type: 'text',
        text: '첨부된 결제 영수증/카드 승인 문자 이미지에서 구독 지출 항목을 추출해 주세요.'
      });
      userContent.push({
        type: 'image_url',
        image_url: {
          url: imageUrl
        }
      });
    }

    // 5. OpenRouter API 호출 (무료 모델 429 한도 초과 시 Fallback 자동 전환)
    const primaryModel = process.env.OPENROUTER_MODEL || 'google/gemma-4-26b-a4b-it:free';
    const fallbackModels = [
      primaryModel,
      'google/gemini-2.0-flash-exp:free',
      'meta-llama/llama-3.2-11b-vision-instruct:free',
      'openrouter/free'
    ];

    let lastError = null;
    let successfulData = null;
    let usedModel = primaryModel;

    for (const currentModel of fallbackModels) {
      try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://localhost:3000',
            'X-Title': 'Campus-Sub-Rebalancer'
          },
          body: JSON.stringify({
            model: currentModel,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userContent }
            ],
            temperature: 0.1,
            max_tokens: 1500
          })
        });

        if (response.ok) {
          successfulData = await response.json();
          usedModel = currentModel;
          break; // 성공 시 루프 종료
        } else {
          const errorText = await response.text();
          console.warn(`[모델 ${currentModel} 실패 (${response.status})]:`, errorText);
          lastError = { status: response.status, text: errorText };
          // 429(Rate Limit) 또는 503인 경우 다음 백업 모델로 계속 시도
          continue;
        }
      } catch (reqErr) {
        lastError = { status: 500, text: reqErr.message };
      }
    }

    if (!successfulData) {
      return res.status(lastError?.status || 500).json({
        success: false,
        message: 'OpenRouter 무료 모델 일시적 요청 한도(429) 초과. 잠시 후 다시 시도해 주세요.',
        error: lastError?.text
      });
    }

    const rawContent = successfulData.choices?.[0]?.message?.content || '{}';

    // 6. JSON 응답 정제 (마크다운 코드 블록 제거 및 안전한 파싱)
    let cleanedContent = rawContent.trim();
    if (cleanedContent.startsWith('```json')) {
      cleanedContent = cleanedContent.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleanedContent.startsWith('```')) {
      cleanedContent = cleanedContent.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    let parsedResult;
    try {
      parsedResult = JSON.parse(cleanedContent);
    } catch (parseErr) {
      // 정규식으로 JSON 객체 부분만 재추출 시도
      const jsonMatch = cleanedContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsedResult = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('AI 모델의 응답을 JSON으로 변환할 수 없습니다.');
      }
    }

    // items 배열 유효성 보장
    const items = Array.isArray(parsedResult.items) ? parsedResult.items : [parsedResult];

    // 7. 성공 응답 반환
    return res.status(200).json({
      success: true,
      modelUsed: model,
      items: items
    });

  } catch (error) {
    console.error('[Server Error in parse-receipt]:', error);
    return res.status(500).json({
      success: false,
      message: '서버 내부 처리 중 오류가 발생했습니다.',
      error: error.message
    });
  }
}
