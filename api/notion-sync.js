/**
 * ==============================================================================
 * 파일명: api/notion-sync.js
 * 설명: 팀 노션(Notion) 데이터베이스와 연동하여 구독 목록을 조회(Query),
 *       신규 구독 저장(Create), 해지 상태 갱신(Update)을 처리하는 Vercel 서버리스 함수
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
  const apiKey = process.env.NOTION_API_KEY;
  const databaseId = process.env.NOTION_DATABASE_ID;

  if (!apiKey || !databaseId) {
    return res.status(500).json({
      success: false,
      message: 'Notion API 키(NOTION_API_KEY) 또는 데이터베이스 ID(NOTION_DATABASE_ID)가 설정되지 않았습니다.'
    });
  }

  // 공통 노션 헤더 규격
  const notionHeaders = {
    'Authorization': `Bearer ${apiKey}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json'
  };

  try {
    // --------------------------------------------------------------------------
    // 1. GET 요청: 노션 데이터베이스에서 현재 구독 목록 조회
    // --------------------------------------------------------------------------
    if (req.method === 'GET') {
      const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
        method: 'POST',
        headers: notionHeaders,
        body: JSON.stringify({
          page_size: 50
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Notion Query Error]:', errorText);
        return res.status(response.status).json({
          success: false,
          message: '노션 데이터베이스 조회에 실패했습니다.',
          error: errorText
        });
      }

      const data = await response.json();

      // 노션 페이지 객체를 직관적인 구독 아이템 배열로 매핑
      const items = (data.results || []).map((page) => {
        const props = page.properties || {};

        // Title 속성(서비스명) 추출
        let serviceName = '이름 없는 구독';
        for (const key of Object.keys(props)) {
          if (props[key].type === 'title') {
            serviceName = props[key].title?.[0]?.plain_text || serviceName;
            break;
          }
        }

        // 금액(Number) 속성 추출
        let amount = 0;
        for (const key of Object.keys(props)) {
          if (props[key].type === 'number') {
            amount = props[key].number || 0;
            break;
          }
        }

        // 카테고리(Select) 속성 추출
        let category = '기타';
        for (const key of Object.keys(props)) {
          if (props[key].type === 'select' && props[key].select) {
            category = props[key].select.name || category;
            break;
          }
        }

        // 상태(Status 또는 Select) 추출
        let status = 'Active';
        for (const key of Object.keys(props)) {
          if (props[key].type === 'status' && props[key].status) {
            status = props[key].status.name || status;
            break;
          }
        }

        return {
          notionPageId: page.id,
          service_name: serviceName,
          amount: amount,
          category: category,
          status: status,
          url: page.url
        };
      });

      return res.status(200).json({
        success: true,
        count: items.length,
        items: items
      });
    }

    // --------------------------------------------------------------------------
    // 2. POST 요청: 구독 목록을 노션 데이터베이스에 신규 등록 (Batch Create)
    // --------------------------------------------------------------------------
    if (req.method === 'POST') {
      const { subscriptions = [], reportSummary = null } = req.body || {};

      if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
        return res.status(400).json({
          success: false,
          message: '노션에 저장할 구독 데이터 목록이 없습니다.'
        });
      }

      // 먼저 데이터베이스 메타데이터를 조회하여 속성 이름(schema) 확인
      const dbMetaResponse = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
        method: 'GET',
        headers: notionHeaders
      });

      let dbSchema = {};
      if (dbMetaResponse.ok) {
        const dbMetaData = await dbMetaResponse.json();
        dbSchema = dbMetaData.properties || {};
      }

      // 적절한 프로퍼티 키 찾기
      const titleKey = Object.keys(dbSchema).find(k => dbSchema[k].type === 'title') || '이름';
      const numberKey = Object.keys(dbSchema).find(k => dbSchema[k].type === 'number') || '금액';
      const selectKey = Object.keys(dbSchema).find(k => dbSchema[k].type === 'select');

      const createdResults = [];

      for (const sub of subscriptions) {
        const pageProperties = {};

        // 1) Title (서비스명)
        pageProperties[titleKey] = {
          title: [
            {
              text: {
                content: sub.service_name || '구독 서비스'
              }
            }
          ]
        };

        // 2) Number (금액)
        if (numberKey && dbSchema[numberKey]) {
          pageProperties[numberKey] = {
            number: Number(sub.amount) || 0
          };
        }

        // 3) Select (카테고리 - DB에 존재할 경우에만)
        if (selectKey && dbSchema[selectKey] && sub.category) {
          pageProperties[selectKey] = {
            select: {
              name: sub.category
            }
          };
        }

        // Notion Page 생성 API 호출
        const createRes = await fetch('https://api.notion.com/v1/pages', {
          method: 'POST',
          headers: notionHeaders,
          body: JSON.stringify({
            parent: { database_id: databaseId },
            properties: pageProperties
          })
        });

        if (createRes.ok) {
          const createdPage = await createRes.json();
          createdResults.push({
            id: createdPage.id,
            service_name: sub.service_name,
            url: createdPage.url
          });
        } else {
          const errDetail = await createRes.text();
          console.warn(`[Notion Single Create Failed for ${sub.service_name}]:`, errDetail);
        }
      }

      return res.status(200).json({
        success: true,
        message: `${createdResults.length}개의 구독 내역이 노션 데이터베이스에 성공적으로 동기화되었습니다.`,
        createdCount: createdResults.length,
        createdItems: createdResults
      });
    }

    // --------------------------------------------------------------------------
    // 3. PATCH 요청: 구독 해지 완료 시 노션 페이지 상태 업데이트
    // --------------------------------------------------------------------------
    if (req.method === 'PATCH') {
      const { pageId, statusName = 'Cancelled' } = req.body || {};

      if (!pageId) {
        return res.status(400).json({
          success: false,
          message: '업데이트할 노션 페이지 ID가 필요합니다.'
        });
      }

      // 페이지 보관(Archive) 처리로 간편하게 해지 관리
      const updateRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH',
        headers: notionHeaders,
        body: JSON.stringify({
          archived: true // 해지된 구독은 노션에서 안전하게 아카이브 처리
        })
      });

      if (!updateRes.ok) {
        const errDetail = await updateRes.text();
        return res.status(updateRes.status).json({
          success: false,
          message: '노션 페이지 해지 업데이트 실패',
          error: errDetail
        });
      }

      return res.status(200).json({
        success: true,
        message: '노션 데이터베이스에서 구독 해지 처리가 완료되었습니다.'
      });
    }

    return res.status(405).json({
      success: false,
      message: '허용되지 않는 HTTP 메소드입니다. (GET, POST, PATCH만 지원)'
    });

  } catch (error) {
    console.error('[Server Error in notion-sync]:', error);
    return res.status(500).json({
      success: false,
      message: '노션 연동 처리 중 서버 오류가 발생했습니다.',
      error: error.message
    });
  }
}
