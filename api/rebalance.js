/**
 * ==============================================================================
 * 파일명: api/rebalance.js
 * 설명: 사용자의 구독 목록과 월 이용 횟수를 바탕으로 1회당 단가(CPU)를 분석하고,
 *       OpenRouter API (nvidia/nemotron-3.5-lightning:free)를 호출하여
 *       대학생 맞춤형 AI 구독 리밸런싱 보고서를 생성하는 Vercel 서버리스 함수
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

/**
 * 사전 구축된 대학생 요금제 벤치마크 및 대체재 카탈로그
 */
const BENCHMARK_CATALOG = {
  OTT: [
    { name: '4인 파티(피클플러스/벗츠)', price: 4250, desc: '계정 공유 파티원으로 1/N 분담' },
    { name: '네이버플러스 멤버십(스튜던트)', price: 0, desc: '대학생 3개월 무료 체험 후 티빙 무료 연동' },
    { name: '광고형 스탠다드 요금제', price: 5500, desc: '월 5,500원으로 기본 시청 가능' }
  ],
  음원: [
    { name: '스포티파이 베이직', price: 7900, desc: '음악 감상 전용 단독 요금제' },
    { name: '우주패스 all (유튜브 프리미엄 제휴)', price: 9900, desc: '통신사 제휴로 월 9,900원에 이용' },
    { name: '애플 뮤직 학생 요금제', price: 5500, desc: '대학생 @ac.kr 인증 시 50% 할인' }
  ],
  '생산성/AI': [
    { name: 'GitHub Student Developer Pack', price: 0, desc: '대학생 무료 GitHub Copilot 지원' },
    { name: 'Notion Plus 학생 플랜', price: 0, desc: '학교 이메일 인증 시 Plus 요금제 무료' },
    { name: 'Claude Pro (방학 집중 이용)', price: 29000, desc: '학기 중에만 결제하고 방학에 동결' }
  ],
  '쇼핑/멤버십': [
    { name: '네이버플러스 스튜던트', price: 0, desc: '대학생 3개월 무료 후 월 4,900원' },
    { name: '쿠팡 와우 멤버십', price: 7890, desc: '월 2회 이상 로켓배송 이용 시 유지 권장' }
  ]
};

export default async function handler(req, res) {
  // CORS 및 HTTP 메소드 검증 (POST만 허용)
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      message: '허용되지 않는 HTTP 메소드입니다. POST 요청을 사용해 주세요.'
    });
  }

  try {
    const { subscriptions = [], academicStatus = '기말고사 집중 기간' } = req.body || {};

    if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
      return res.status(400).json({
        success: false,
        message: '분석할 구독 목록 데이터가 비어 있습니다.'
      });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    const analysisModel = process.env.OPENROUTER_ANALYSIS_MODEL || 'nvidia/nemotron-3.5-lightning:free';

    if (!apiKey) {
      return res.status(500).json({
        success: false,
        message: '서버 환경 변수(OPENROUTER_API_KEY)가 설정되지 않았습니다.'
      });
    }

    // 1. 서비스별 1회당 단가(CPU) 및 좀비 구독 점수 산출
    let currentMonthlyTotal = 0;
    const enrichedSubscriptions = subscriptions.map((sub) => {
      const cost = Number(sub.amount) || 0;
      const usage = Math.max(Number(sub.usage_count) || 0, 0);
      currentMonthlyTotal += cost;

      // 1회당 이용 단가 (분모 0 방지)
      const costPerUse = usage === 0 ? cost : Math.round(cost / usage);

      // 카테고리별 비효율 기준선
      let threshold = 3000;
      if (sub.category === '음원') threshold = 300;
      if (sub.category?.includes('AI') || sub.category?.includes('생산성')) threshold = 1500;
      if (sub.category?.includes('쇼핑')) threshold = 4000;

      // 좀비 스코어 계산 (0 ~ 100점)
      let zombieScore = Math.min(100, Math.round((costPerUse / threshold) * 25));
      if (usage === 0) zombieScore = 100;
      if (usage === 1 && cost > 10000) zombieScore = Math.max(zombieScore, 90);

      return {
        service_name: sub.service_name,
        category: sub.category || '기타',
        monthly_cost: cost,
        usage_count: usage,
        cost_per_use: costPerUse,
        zombie_score: zombieScore,
        billing_date: sub.billing_date || 1
      };
    });

    // 2. OpenRouter AI 리밸런싱 시스템 프롬프트 작성
    const systemPrompt = `
당신은 대한민국 20대 대학생의 금융 지출을 냉철하게 분석하고 다이어트해 주는 'AI 핀테크 자산관리 컨설턴트'입니다.
사용자의 구독 목록, 월간 이용 횟수, 1회당 이용 단가(CPU), 좀비 스코어, 그리고 현재 학사 주기(${academicStatus})를 종합 분석하여
아래의 엄격한 JSON 스키마로만 리밸런싱 보고서를 생성하세요.

[분석 지침]
1. kill_recommendations (해지 추천 Top 1~3):
   - 좀비 스코어가 70점 이상이거나 월 이용 횟수가 0~2회인 비효율 구독을 선정.
   - 학사 일정(시험기간에는 OTT 일시정지, 방학에는 과제도구 동결 등)에 맞춘 현실적인 해지/일시정지 사유를 제시.
2. swap_recommendations (요금제 전환 및 대체 추천):
   - 4인 계정 공유 파티원 분담, 대학생 @ac.kr 무료 혜택, 통신사 결합 요금제로 전환하여 지출을 낮추는 구체적인 방안.
3. financial_summary:
   - current_total: 현재 총 월 지출액
   - projected_total: 추천안 실행 후 예상 월 지출액
   - monthly_savings: 월간 절감액 (current_total - projected_total)
   - annual_savings: 연간 누적 절감액 (monthly_savings * 12)
   - student_impact: 대학생 체감 지표 ("매달 학식 N그릇, 연간 치킨 N마리 절약!")

[응답 규칙]
- 마크다운 블록(\`\`\`json 등)이나 서두 설명 없이 '순수한 JSON 문자열'만 출력하세요.
- 친근하면서도 팩트에 기반한 직관적인 한국어로 작성하세요.

[출력 JSON 규격]
{
  "financial_summary": {
    "current_total": 58900,
    "projected_total": 21500,
    "monthly_savings": 37400,
    "annual_savings": 448800,
    "student_impact": "매달 학식 7그릇, 연간 치킨 22마리를 절약할 수 있어요!"
  },
  "kill_recommendations": [
    {
      "rank": 1,
      "service_name": "넷플릭스",
      "monthly_cost": 17000,
      "usage_count": 1,
      "cost_per_use": 17000,
      "zombie_score": 95,
      "reason": "월 1회 이용으로 영화관 티켓보다 비쌉니다. 기말고사 기간(12월) 동안 일시 정지를 추천합니다.",
      "action_guide_keyword": "넷플릭스 멤버십 해지"
    }
  ],
  "swap_recommendations": [
    {
      "service_name": "유튜브 프리미엄",
      "current_cost": 14900,
      "suggested_plan": "우주패스 제휴 또는 스포티파이 베이직",
      "expected_cost": 9900,
      "monthly_savings": 5000,
      "how_to": "T우주패스 가입 시 유튜브 프리미엄 포함 월 9,900원으로 전환 가능합니다."
    }
  ],
  "lifecycle_advice": "현재는 기말고사 시험 기간이므로 과제용 AI 도구는 유지하되, OTT와 엔터테인먼트 구독을 종강 때까지 1달 동결하는 '학기제 온·오프 전략'이 가장 효과적입니다."
}
`.trim();

    const userPrompt = `
[사용자 현재 구독 및 이용 현황 데이터]:
${JSON.stringify(enrichedSubscriptions, null, 2)}

[참고 대체재 벤치마크 데이터]:
${JSON.stringify(BENCHMARK_CATALOG, null, 2)}

위 데이터를 바탕으로 학생 맞춤형 최적의 리밸런싱 보고서를 작성해줘.
`.trim();

    // 3. OpenRouter API 호출 (Fallback 리스트 탑재)
    const fallbackModels = [
      analysisModel,
      'nvidia/nemotron-3.5-lightning:free',
      'google/gemma-4-26b-a4b-it:free',
      'openrouter/free'
    ];

    let successfulData = null;
    let usedModel = analysisModel;
    let lastError = null;

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
              { role: 'user', content: userPrompt }
            ],
            temperature: 0.3,
            max_tokens: 2500
          })
        });

        if (response.ok) {
          successfulData = await response.json();
          usedModel = currentModel;
          break;
        } else {
          const errText = await response.text();
          console.warn(`[모델 ${currentModel} 실패]:`, errText);
          lastError = { status: response.status, text: errText };
          continue;
        }
      } catch (e) {
        lastError = { status: 500, text: e.message };
      }
    }

    // 4. Fallback 규칙 기반 기본 생성기 (모든 AI 호출 실패 시 비상 작동)
    if (!successfulData) {
      console.warn('모든 AI 모델 실패로 Rule-based 비상 생성기 가동');
      const killList = enrichedSubscriptions
        .filter((s) => s.zombie_score >= 70)
        .slice(0, 3)
        .map((s, idx) => ({
          rank: idx + 1,
          service_name: s.service_name,
          monthly_cost: s.monthly_cost,
          usage_count: s.usage_count,
          cost_per_use: s.cost_per_use,
          zombie_score: s.zombie_score,
          reason: `월 ${s.usage_count}회 이용으로 1회당 단가(${s.cost_per_use.toLocaleString()}원)가 비효율적입니다. 일시 해지를 추천합니다.`,
          action_guide_keyword: `${s.service_name} 해지`
        }));

      const monthlySavings = killList.reduce((acc, cur) => acc + cur.monthly_cost, 0);
      const meals = Math.round(monthlySavings / 5500);

      return res.status(200).json({
        success: true,
        modelUsed: 'rule-based-fallback',
        report: {
          financial_summary: {
            current_total: currentMonthlyTotal,
            projected_total: currentMonthlyTotal - monthlySavings,
            monthly_savings: monthlySavings,
            annual_savings: monthlySavings * 12,
            student_impact: `매달 학식 ${meals}그릇을 더 챙겨 드실 수 있어요!`
          },
          kill_recommendations: killList,
          swap_recommendations: [
            {
              service_name: 'OTT 구독 서비스',
              current_cost: 15000,
              suggested_plan: '4인 파티원 계정 공유',
              expected_cost: 4250,
              monthly_savings: 10750,
              how_to: '피클플러스 등 파티 공유 서비스를 이용해 1/N 분담을 신청하세요.'
            }
          ],
          lifecycle_advice: '시험기간 동안 시청 빈도가 낮은 OTT를 일시 중단하는 것만으로도 상당한 고정비를 아낄 수 있습니다.'
        }
      });
    }

    // 5. AI 응답 정제 및 파싱
    const rawContent = successfulData.choices?.[0]?.message?.content || '{}';
    console.log('[AI Raw Content]:', rawContent);

    // thought 블록 제거 (<thought>...</thought> 또는 <think>...</think>)
    let cleanedContent = rawContent.replace(/<thought>[\s\S]*?<\/thought>/gi, '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    if (cleanedContent.startsWith('```json')) {
      cleanedContent = cleanedContent.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleanedContent.startsWith('```')) {
      cleanedContent = cleanedContent.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    let parsedReport = {};
    try {
      parsedReport = JSON.parse(cleanedContent);
    } catch (parseErr) {
      // 정규식으로 가장 바깥쪽 { ... } 블록 추출
      const firstBrace = cleanedContent.indexOf('{');
      const lastBrace = cleanedContent.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const jsonSubstring = cleanedContent.substring(firstBrace, lastBrace + 1);
        try {
          parsedReport = JSON.parse(jsonSubstring);
        } catch (innerErr) {
          console.warn('JSON 서브스트링 파싱 실패, Fallback 규칙 기반 데이터 보강:', innerErr.message);
        }
      }
    }

    // 만약 파싱된 report의 핵심 필드가 비어있으면 안전하게 기본값 보강
    if (!parsedReport.financial_summary || !parsedReport.kill_recommendations) {
      const topZombies = enrichedSubscriptions.filter(s => s.zombie_score >= 70).slice(0, 3);
      const monthlySavings = topZombies.reduce((acc, cur) => acc + cur.monthly_cost, 0);

      parsedReport = {
        financial_summary: {
          current_total: currentMonthlyTotal,
          projected_total: Math.max(0, currentMonthlyTotal - monthlySavings),
          monthly_savings: monthlySavings,
          annual_savings: monthlySavings * 12,
          student_impact: `매달 학식 ${Math.round(monthlySavings / 5500)}그릇 절약 효과!`
        },
        kill_recommendations: topZombies.map((s, idx) => ({
          rank: idx + 1,
          service_name: s.service_name,
          monthly_cost: s.monthly_cost,
          usage_count: s.usage_count,
          cost_per_use: s.cost_per_use,
          zombie_score: s.zombie_score,
          reason: `월 ${s.usage_count}회 이용으로 1회당 단가가 비쌉니다. 기말고사 기간 일시 해지를 추천합니다.`,
          action_guide_keyword: `${s.service_name} 해지`
        })),
        swap_recommendations: [
          {
            service_name: 'OTT / 스트리밍',
            current_cost: 17000,
            suggested_plan: '4인 파티원 공유 (피클플러스 등)',
            expected_cost: 4250,
            monthly_savings: 12750,
            how_to: '파티원 분담을 통해 1인당 4,250원으로 이용해 보세요.'
          }
        ],
        lifecycle_advice: '현재는 기말고사 집중 기간이므로 시청 빈도가 낮은 OTT를 일시 중지하고, 과제용 AI 도구는 시험 종료 후 재검토하는 전략을 추천합니다.'
      };
    }

    return res.status(200).json({
      success: true,
      modelUsed: usedModel,
      enrichedSubscriptions: enrichedSubscriptions,
      report: parsedReport
    });

  } catch (error) {
    console.error('[Server Error in rebalance]:', error);
    return res.status(500).json({
      success: false,
      message: '리밸런싱 보고서 생성 중 오류가 발생했습니다.',
      error: error.message
    });
  }
}
