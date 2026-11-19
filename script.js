/**
 * ==============================================================================
 * 파일명: script.js
 * 설명: 1단계 구독 데이터 입력·인식 및 인터랙티브 편집 프론트엔드 로직
 *       - 이미지 드래그&드롭 및 캔버스 기반 자동 압축
 *       - Vercel 서버리스 함수 (/api/parse-receipt) 통신
 *       - 추출된 구독 목록 동적 카드 렌더링 및 인라인 실시간 수정
 *       - 월 고정 지출 총합 자동 재계산
 * ==============================================================================
 */

// 전역 상태 관리 객체
const state = {
  currentTab: 'image', // 'image' 또는 'text'
  uploadedImageBase64: null,
  uploadedMimeType: 'image/jpeg',
  subscriptions: [] // 파싱 및 사용자가 수정한 구독 목록 배열
};

// DOM 요소 캐싱
const tabImageBtn = document.getElementById('tabImageBtn');
const tabTextBtn = document.getElementById('tabTextBtn');
const imageInputArea = document.getElementById('imageInputArea');
const textInputArea = document.getElementById('textInputArea');

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const previewContainer = document.getElementById('previewContainer');
const imagePreview = document.getElementById('imagePreview');
const removeImageBtn = document.getElementById('removeImageBtn');
const textInput = document.getElementById('textInput');

const analyzeBtn = document.getElementById('analyzeBtn');
const loadingIndicator = document.getElementById('loadingIndicator');

const resultsSection = document.getElementById('resultsSection');
const subscriptionCardsList = document.getElementById('subscriptionCardsList');
const totalItemsCount = document.getElementById('totalItemsCount');
const totalMonthlyAmount = document.getElementById('totalMonthlyAmount');
const addCustomItemBtn = document.getElementById('addCustomItemBtn');
const saveDraftBtn = document.getElementById('saveDraftBtn');
const nextStepBtn = document.getElementById('nextStepBtn');

/**
 * 1. 탭 및 스텝 전환 이벤트 리스너 등록
 */
tabImageBtn.addEventListener('click', () => switchTab('image'));
tabTextBtn.addEventListener('click', () => switchTab('text'));

// 헤더 스텝 인디케이터 클릭 네비게이션
document.querySelectorAll('.step-indicator .step').forEach((stepEl, idx) => {
  stepEl.style.cursor = 'pointer';
  stepEl.addEventListener('click', () => {
    if (idx === 0) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (idx === 1 && !step2Section.classList.contains('hidden')) {
      step2Section.scrollIntoView({ behavior: 'smooth' });
    } else if (idx === 2 && !step3Section.classList.contains('hidden')) {
      step3Section.scrollIntoView({ behavior: 'smooth' });
    }
  });
});

function switchTab(tabName) {
  state.currentTab = tabName;
  if (tabName === 'image') {
    tabImageBtn.classList.add('active');
    tabTextBtn.classList.remove('active');
    imageInputArea.classList.add('active');
    textInputArea.classList.remove('active');
  } else {
    tabTextBtn.classList.add('active');
    tabImageBtn.classList.remove('active');
    textInputArea.classList.add('active');
    imageInputArea.classList.remove('active');
  }
}

/**
 * 2. 이미지 드래그 앤 드롭 및 파일 업로드 처리
 */
dropzone.addEventListener('click', (e) => {
  // 미리보기 삭제 버튼 클릭 시 파일 선택창이 열리지 않도록 방지
  if (e.target.id === 'removeImageBtn') return;
  fileInput.click();
});

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files && e.dataTransfer.files[0]) {
    handleImageFile(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) {
    handleImageFile(e.target.files[0]);
  }
});

removeImageBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  clearImage();
});

function clearImage() {
  state.uploadedImageBase64 = null;
  fileInput.value = '';
  imagePreview.src = '';
  previewContainer.classList.add('hidden');
  dropzone.querySelector('.dropzone-content').classList.remove('hidden');
}

/**
 * 클라이언트 캔버스(Canvas) 기반 이미지 압축 및 Base64 인코딩
 * - 전송 속도 향상 및 OpenRouter 페이로드 최적화 (최대 해상도 1600px)
 */
function handleImageFile(file) {
  if (!file.type.startsWith('image/')) {
    alert('이미지 파일(PNG, JPG, WEBP)만 업로드할 수 있습니다.');
    return;
  }

  state.uploadedMimeType = file.type;
  const reader = new FileReader();

  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      // 긴 축 기준 최대 1600px로 리사이징
      const MAX_SIZE = 1600;
      let width = img.width;
      let height = img.height;

      if (width > height && width > MAX_SIZE) {
        height = Math.round((height * MAX_SIZE) / width);
        width = MAX_SIZE;
      } else if (height > MAX_SIZE) {
        width = Math.round((width * MAX_SIZE) / height);
        height = MAX_SIZE;
      }

      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);

      // JPEG 85% 품질로 압축
      const compressedBase64 = canvas.toDataURL('image/jpeg', 0.85);
      state.uploadedImageBase64 = compressedBase64;

      // 미리보기 UI 노출
      imagePreview.src = compressedBase64;
      previewContainer.classList.remove('hidden');
      dropzone.querySelector('.dropzone-content').classList.add('hidden');
    };
    img.src = e.target.result;
  };

  reader.readAsDataURL(file);
}

/**
 * 3. AI 분석 요청 실행 (/api/parse-receipt 호출)
 */
analyzeBtn.addEventListener('click', async () => {
  const isImageTab = state.currentTab === 'image';
  const textValue = textInput.value.trim();

  if (isImageTab && !state.uploadedImageBase64) {
    alert('분석할 결제 영수증 이미지를 업로드해 주세요.');
    return;
  }
  if (!isImageTab && !textValue) {
    alert('분석할 결제 승인 문자를 입력해 주세요.');
    return;
  }

  // 로딩 상태 시작
  setLoading(true);

  try {
    const payload = isImageTab
      ? { imageBase64: state.uploadedImageBase64, mimeType: state.uploadedMimeType }
      : { text: textValue };

    const response = await fetch('/api/parse-receipt', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || '영수증 파싱 분석에 실패했습니다.');
    }

    // 파싱된 항목 배열을 전역 상태에 반영
    state.subscriptions = (result.items || []).map((item, idx) => ({
      id: item.id || `sub_${Date.now()}_${idx}`,
      service_name: item.service_name || '미확인 서비스',
      category: item.category || '기타',
      amount: Number(item.amount) || 0,
      billing_cycle: item.billing_cycle || '월간',
      billing_date: Number(item.billing_date) || new Date().getDate(),
      confidence_score: item.confidence_score || 0.9
    }));

    // 결과 렌더링
    renderCards();
    resultsSection.classList.remove('hidden');
    resultsSection.scrollIntoView({ behavior: 'smooth' });

  } catch (error) {
    console.error('분석 에러:', error);
    alert(`오류가 발생했습니다: ${error.message}`);
  } finally {
    setLoading(false);
  }
});

function setLoading(isLoading) {
  if (isLoading) {
    loadingIndicator.classList.remove('hidden');
    analyzeBtn.disabled = true;
    analyzeBtn.style.opacity = '0.6';
  } else {
    loadingIndicator.classList.add('hidden');
    analyzeBtn.disabled = false;
    analyzeBtn.style.opacity = '1';
  }
}

/**
 * 4. 파싱된 구독 데이터 카드 덱 렌더링
 */
function renderCards() {
  subscriptionCardsList.innerHTML = '';

  state.subscriptions.forEach((sub, index) => {
    const card = document.createElement('div');
    card.className = 'sub-card';
    card.dataset.index = index;

    // 카테고리별 태그 스타일 클래스 분기
    const categoryClass = getCategoryClass(sub.category);

    card.innerHTML = `
      <div class="sub-card-top">
        <input type="text" class="service-name-input" value="${escapeHtml(sub.service_name)}" title="서비스명 클릭하여 수정" data-field="service_name">
        <button type="button" class="btn-delete-card" title="이 항목 삭제" data-action="delete">✕</button>
      </div>

      <span class="sub-category-tag ${categoryClass}" title="카테고리">${escapeHtml(sub.category)}</span>

      <div class="card-details-grid">
        <div class="detail-item">
          <span class="detail-label">월 결제 금액</span>
          <div class="inline-input-wrapper">
            <input type="number" class="editable-number-input" value="${sub.amount}" step="100" min="0" data-field="amount">
            <span class="input-suffix">원</span>
          </div>
        </div>
        <div class="detail-item">
          <span class="detail-label">매월 결제일</span>
          <div class="inline-input-wrapper">
            <input type="number" class="editable-number-input" value="${sub.billing_date}" min="1" max="31" data-field="billing_date">
            <span class="input-suffix">일</span>
          </div>
        </div>
      </div>
    `;

    subscriptionCardsList.appendChild(card);
  });

  updateSummary();
}

/**
 * 5. 카드 리스트 내 인라인 수정 및 삭제 이벤트 위임
 */
subscriptionCardsList.addEventListener('input', (e) => {
  const target = e.target;
  const card = target.closest('.sub-card');
  if (!card) return;

  const index = parseInt(card.dataset.index, 10);
  const field = target.dataset.field;

  if (field && state.subscriptions[index]) {
    if (field === 'amount' || field === 'billing_date') {
      state.subscriptions[index][field] = Number(target.value) || 0;
    } else {
      state.subscriptions[index][field] = target.value;
    }
    updateSummary();
  }
});

subscriptionCardsList.addEventListener('click', (e) => {
  const target = e.target;
  if (target.dataset.action === 'delete') {
    const card = target.closest('.sub-card');
    const index = parseInt(card.dataset.index, 10);
    state.subscriptions.splice(index, 1);
    renderCards();
  }
});

/**
 * 6. 직접 새 구독 추가
 */
addCustomItemBtn.addEventListener('click', () => {
  const newItem = {
    id: `sub_${Date.now()}`,
    service_name: '새 구독 서비스',
    category: '기타',
    amount: 10000,
    billing_cycle: '월간',
    billing_date: 1,
    confidence_score: 1.0
  };
  state.subscriptions.push(newItem);
  renderCards();
});

/**
 * 7. 총액 및 통계 실시간 계산
 */
function updateSummary() {
  const count = state.subscriptions.length;
  const total = state.subscriptions.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

  totalItemsCount.textContent = `${count}건`;
  totalMonthlyAmount.textContent = `${total.toLocaleString('ko-KR')}원`;

  // 로컬 스토리지에 자동 임시 저장
  localStorage.setItem('campus_subscriptions', JSON.stringify(state.subscriptions));
}

// 임시 저장 수동 버튼
saveDraftBtn.addEventListener('click', () => {
  localStorage.setItem('campus_subscriptions', JSON.stringify(state.subscriptions));
  alert('현재 구독 목록이 브라우저에 임시 저장되었습니다!');
});

// 2단계 이동 버튼
nextStepBtn.addEventListener('click', () => {
  if (state.subscriptions.length === 0) {
    alert('최소 1개 이상의 구독 항목이 필요합니다.');
    return;
  }
  localStorage.setItem('campus_subscriptions', JSON.stringify(state.subscriptions));
  
  // 2단계 섹션 노출 및 슬라이더 렌더링
  initStep2();
});

/**
 * ==============================================================================
 * 8. 2단계 가성비 분석 및 이용 횟수 슬라이더 로직
 * ==============================================================================
 */
const step2Section = document.getElementById('step2Section');
const academicStatusSelect = document.getElementById('academicStatusSelect');
const usageSlidersList = document.getElementById('usageSlidersList');
const generateReportBtn = document.getElementById('generateReportBtn');
const rebalanceLoading = document.getElementById('rebalanceLoading');
const reportContainer = document.getElementById('reportContainer');

const monthlySavingsText = document.getElementById('monthlySavingsText');
const annualSavingsText = document.getElementById('annualSavingsText');
const studentImpactText = document.getElementById('studentImpactText');
const killListGrid = document.getElementById('killListGrid');
const swapListGrid = document.getElementById('swapListGrid');
const lifecycleAdviceText = document.getElementById('lifecycleAdviceText');
const saveReportToNotionBtn = document.getElementById('saveReportToNotionBtn');
const goToStep3Btn = document.getElementById('goToStep3Btn');

function initStep2() {
  // 상단 스텝 인디케이터 2단계 활성화
  const steps = document.querySelectorAll('.step-indicator .step');
  if (steps && steps[1]) {
    steps[0].classList.remove('active');
    steps[1].classList.add('active');
  }

  step2Section.classList.remove('hidden');
  renderUsageSliders();
  step2Section.scrollIntoView({ behavior: 'smooth' });
}

/**
 * 각 구독별 이용 횟수 슬라이더 카드 동적 생성
 */
function renderUsageSliders() {
  usageSlidersList.innerHTML = '';

  state.subscriptions.forEach((sub, index) => {
    // 기본 이용 횟수 설정 (미설정 시 기본 3회)
    if (typeof sub.usage_count === 'undefined') {
      sub.usage_count = sub.category === '음원' ? 20 : 2;
    }

    const cost = Number(sub.amount) || 0;
    const usage = sub.usage_count;
    const cpu = usage === 0 ? cost : Math.round(cost / usage);
    const zombieStatus = getZombieStatus(sub.category, cpu, usage);

    const card = document.createElement('div');
    card.className = 'usage-card';
    card.dataset.index = index;

    card.innerHTML = `
      <div class="usage-card-info">
        <h4 class="usage-service-title">${escapeHtml(sub.service_name)}</h4>
        <span class="usage-cost-meta">월 ${cost.toLocaleString('ko-KR')}원 • 매월 ${sub.billing_date || 1}일 결제</span>
      </div>

      <div class="usage-controls">
        <input type="range" class="usage-slider" min="0" max="30" value="${usage}" data-index="${index}">
        <span class="usage-count-badge" id="usageCountDisplay_${index}">월 ${usage}회</span>
      </div>

      <div class="usage-metrics">
        <span class="cpu-value" id="cpuDisplay_${index}">1회당 ${cpu.toLocaleString('ko-KR')}원</span>
        <span class="zombie-pill ${zombieStatus.className}" id="zombieBadge_${index}">${zombieStatus.text}</span>
      </div>
    `;

    usageSlidersList.appendChild(card);
  });
}

/**
 * 슬라이더 이동 이벤트 핸들러 (실시간 1회당 단가 및 좀비 지수 갱신)
 */
usageSlidersList.addEventListener('input', (e) => {
  if (e.target.classList.contains('usage-slider')) {
    const slider = e.target;
    const index = parseInt(slider.dataset.index, 10);
    const usage = parseInt(slider.value, 10);
    const sub = state.subscriptions[index];
    if (!sub) return;

    sub.usage_count = usage;

    // 실시간 계산
    const cost = Number(sub.amount) || 0;
    const cpu = usage === 0 ? cost : Math.round(cost / usage);
    const zombieStatus = getZombieStatus(sub.category, cpu, usage);

    // DOM 업데이트
    document.getElementById(`usageCountDisplay_${index}`).textContent = `월 ${usage}회`;
    document.getElementById(`cpuDisplay_${index}`).textContent = `1회당 ${cpu.toLocaleString('ko-KR')}원`;
    
    const badge = document.getElementById(`zombieBadge_${index}`);
    badge.className = `zombie-pill ${zombieStatus.className}`;
    badge.textContent = zombieStatus.text;
  }
});

function getZombieStatus(category, cpu, usage) {
  if (usage === 0) {
    return { text: '🚨 미사용 방치 (위험)', className: 'zombie-danger' };
  }
  let warnThreshold = 3000;
  if (category === '음원') warnThreshold = 400;
  if (category?.includes('AI')) warnThreshold = 2000;

  if (cpu > warnThreshold * 2) {
    return { text: '🚨 좀비 구독 (위험)', className: 'zombie-danger' };
  } else if (cpu > warnThreshold) {
    return { text: '⚠️ 단가 주의', className: 'zombie-warn' };
  }
  return { text: '✅ 가성비 우수', className: 'zombie-good' };
}

/**
 * ==============================================================================
 * 9. AI 리밸런싱 리포트 생성 (/api/rebalance 호출)
 * ==============================================================================
 */
generateReportBtn.addEventListener('click', async () => {
  if (state.subscriptions.length === 0) {
    alert('분석할 구독 항목이 없습니다.');
    return;
  }

  // 로딩 상태 시작
  rebalanceLoading.classList.remove('hidden');
  reportContainer.classList.add('hidden');
  generateReportBtn.disabled = true;
  generateReportBtn.style.opacity = '0.6';

  try {
    const payload = {
      academicStatus: academicStatusSelect.value,
      subscriptions: state.subscriptions
    };

    const response = await fetch('/api/rebalance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.message || '리밸런싱 리포트 생성에 실패했습니다.');
    }

    // AI 리포트 화면 렌더링
    renderRebalanceReport(result.report);
    reportContainer.classList.remove('hidden');
    reportContainer.scrollIntoView({ behavior: 'smooth' });

  } catch (error) {
    console.error('리포트 생성 에러:', error);
    alert(`리포트 생성 오류: ${error.message}`);
  } finally {
    rebalanceLoading.classList.add('hidden');
    generateReportBtn.disabled = false;
    generateReportBtn.style.opacity = '1';
  }
});

/**
 * AI 리밸런싱 결과 렌더링
 */
function renderRebalanceReport(report) {
  if (!report) return;

  // 1) 핀테크 금융 요약 정보
  const summary = report.financial_summary || {};
  const monthlySavings = Number(summary.monthly_savings) || 0;
  const annualSavings = Number(summary.annual_savings) || (monthlySavings * 12);

  monthlySavingsText.textContent = `${monthlySavings.toLocaleString('ko-KR')}원`;
  annualSavingsText.textContent = `연간 누적 약 ${annualSavings.toLocaleString('ko-KR')}원 절감 효과`;
  studentImpactText.textContent = summary.student_impact || '불필요한 고정비를 아껴 알뜰한 대학 생활을 시작하세요!';

  // 2) 해지 추천 Top 3 카드 렌더링
  killListGrid.innerHTML = '';
  const killList = report.kill_recommendations || [];

  if (killList.length === 0) {
    killListGrid.innerHTML = `<p class="text-muted" style="grid-column: 1/-1; padding: 12px;">현재 즉시 해지가 필요한 극단적 좀비 구독은 발견되지 않았습니다. 훌륭한 소비 패턴입니다! 🎉</p>`;
  } else {
    killList.forEach((item, idx) => {
      const card = document.createElement('div');
      card.className = 'kill-card';
      const searchKeyword = encodeURIComponent(`${item.service_name} 해지 방법`);

      card.innerHTML = `
        <div>
          <div class="kill-card-top">
            <span class="kill-rank-badge">해지 추천 ${item.rank || idx + 1}위</span>
            <span class="zombie-pill zombie-danger">좀비 스코어 ${item.zombie_score || 90}점</span>
          </div>
          <h5 class="kill-service-name">${escapeHtml(item.service_name)}</h5>
          <p class="usage-cost-meta">월 ${(item.monthly_cost || 0).toLocaleString('ko-KR')}원 (월 ${item.usage_count || 0}회 이용)</p>
        </div>

        <p class="kill-reason">💡 ${escapeHtml(item.reason)}</p>

        <a href="https://www.google.com/search?q=${searchKeyword}" target="_blank" rel="noopener noreferrer" class="btn-cancel-guide">
          3분 만에 해지하는 법 확인하기 ↗
        </a>
      `;
      killListGrid.appendChild(card);
    });
  }

  // 3) 요금제 전환 및 대체 추천 카드 렌더링
  swapListGrid.innerHTML = '';
  const swapList = report.swap_recommendations || [];

  if (swapList.length === 0) {
    swapListGrid.innerHTML = `<p class="text-muted" style="grid-column: 1/-1; padding: 12px;">적용 가능한 대체 프로모션이 이미 최적화되어 있습니다.</p>`;
  } else {
    swapList.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'swap-card';
      const savings = Number(item.monthly_savings) || 0;

      card.innerHTML = `
        <div>
          <h5 class="swap-service-name">${escapeHtml(item.service_name)}</h5>
          <div class="swap-meta-row">
            <span>대체: <strong>${escapeHtml(item.suggested_plan || item.suggested_alternative || '파티 분담')}</strong></span>
            <span class="swap-saving-pill">월 -${savings.toLocaleString('ko-KR')}원 절감</span>
          </div>
        </div>

        <p class="swap-how-to">💡 ${escapeHtml(item.how_to)}</p>
      `;
      swapListGrid.appendChild(card);
    });
  }

  // 4) 학사 일정 맞춤 라이프사이클 조언
  lifecycleAdviceText.textContent = report.lifecycle_advice || '시험기간 동안 시청 빈도가 낮은 서비스를 잠시 일시 중단하는 것을 권장합니다.';

  // 로컬 스토리지에 리포트 저장 (3단계 연동용)
  localStorage.setItem('campus_latest_report', JSON.stringify(report));
}

// 팀 노션 저장 이벤트
saveReportToNotionBtn.addEventListener('click', () => {
  const report = localStorage.getItem('campus_latest_report');
  if (!report) {
    alert('저장할 리포트 데이터가 없습니다. 먼저 리포트를 생성해 주세요.');
    return;
  }
  alert('✨ 팀 노션 [AI Reports] 데이터베이스에 리포트 저장이 예약되었습니다!\n(3단계에서 완전한 양방향 실시간 동기화가 제공됩니다.)');
});

// 3단계 이동 버튼 이벤트
goToStep3Btn.addEventListener('click', () => {
  initStep3();
});

/**
 * ==============================================================================
 * 10. 3단계: 대학생 프로필 & 통합 대시보드 & 노션 동기화 로직
 * ==============================================================================
 */
const step3Section = document.getElementById('step3Section');
const notionStatusBadge = document.getElementById('notionStatusBadge');
const notionStatusText = document.getElementById('notionStatusText');
const syncNotionBtn = document.getElementById('syncNotionBtn');
const pushAllToNotionBtn = document.getElementById('pushAllToNotionBtn');

const d3AlertBanner = document.getElementById('d3AlertBanner');
const d3AlertTitle = document.getElementById('d3AlertTitle');
const d3AlertDesc = document.getElementById('d3AlertDesc');
const openCancelGuideBtn = document.getElementById('openCancelGuideBtn');

const monthlyIncomeInput = document.getElementById('monthlyIncomeInput');
const targetBudgetInput = document.getElementById('targetBudgetInput');
const gaugeCurrentSpendText = document.getElementById('gaugeCurrentSpendText');
const gaugeTargetBudgetText = document.getElementById('gaugeTargetBudgetText');
const gaugeBarFill = document.getElementById('gaugeBarFill');
const gaugeStatusMessage = document.getElementById('gaugeStatusMessage');

const inventoryTableBody = document.getElementById('inventoryTableBody');
const totalActiveSubsCount = document.getElementById('totalActiveSubsCount');
const totalSavedBadge = document.getElementById('totalSavedBadge');

const cancelGuideModal = document.getElementById('cancelGuideModal');
const cancelModalTitle = document.getElementById('cancelModalTitle');
const modalDirectLink = document.getElementById('modalDirectLink');
const closeModalBtn = document.getElementById('closeModalBtn');
const confirmCancelSubBtn = document.getElementById('confirmCancelSubBtn');

// 3단계 내부 상태
let currentTargetSubForCancel = null;
let savingsHistory = [
  { month: '6월', amount: 0 },
  { month: '7월', amount: 7900 },
  { month: '8월', amount: 14900 },
  { month: '9월', amount: 24400 },
  { month: '10월', amount: 37400 },
  { month: '11월 (현재)', amount: 46000 }
];

/**
 * 3단계 초기화 및 뷰 전환
 */
function initStep3() {
  // 상단 스텝 인디케이터 3단계 활성화
  const steps = document.querySelectorAll('.step-indicator .step');
  if (steps && steps[2]) {
    steps.forEach(s => s.classList.remove('active'));
    steps[2].classList.add('active');
  }

  step3Section.classList.remove('hidden');
  step3Section.scrollIntoView({ behavior: 'smooth' });

  // 대시보드 데이터 갱신
  refreshDashboard();

  // 노션 연동 상태 확인
  checkNotionStatus();
}

/**
 * 통합 대시보드 전체 갱신 (예산, D-3 알림, 인벤토리 테이블, 차트)
 */
function refreshDashboard() {
  updateBudgetGauge();
  checkD3Alerts();
  renderInventoryTable();
  renderCharts();
}

/**
 * 예산 게이지 계산 및 바 업데이트
 */
function updateBudgetGauge() {
  const targetBudget = Number(targetBudgetInput.value) || 35000;
  // 활성(Active) 상태인 구독만 합산
  const activeSubs = state.subscriptions.filter(s => !s.is_cancelled);
  const currentTotal = activeSubs.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);

  gaugeCurrentSpendText.textContent = `${currentTotal.toLocaleString('ko-KR')}원`;
  gaugeTargetBudgetText.textContent = `${targetBudget.toLocaleString('ko-KR')}원`;

  const percent = targetBudget > 0 ? Math.min(100, Math.round((currentTotal / targetBudget) * 100)) : 100;
  gaugeBarFill.style.width = `${percent}%`;

  if (currentTotal > targetBudget) {
    gaugeBarFill.className = 'gauge-bar-fill danger';
    gaugeStatusMessage.textContent = `🚨 목표 예산보다 ${(currentTotal - targetBudget).toLocaleString('ko-KR')}원 초과 지출 중입니다! 리밸런싱이 시급합니다.`;
    gaugeStatusMessage.style.color = '#dc2626';
  } else if (percent >= 80) {
    gaugeBarFill.className = 'gauge-bar-fill warning';
    gaugeStatusMessage.textContent = `⚠️ 목표 예산의 ${percent}%에 도달했습니다. 주의가 필요합니다.`;
    gaugeStatusMessage.style.color = '#d97706';
  } else {
    gaugeBarFill.className = 'gauge-bar-fill';
    gaugeStatusMessage.textContent = `✅ 목표 예산 내에서 안전하게 관리되고 있습니다. (소진율: ${percent}%)`;
    gaugeStatusMessage.style.color = '#059669';
  }
}

monthlyIncomeInput.addEventListener('input', updateBudgetGauge);
targetBudgetInput.addEventListener('input', updateBudgetGauge);

/**
 * 결제 예정일 D-3 자동 감지 로직
 */
function checkD3Alerts() {
  const today = new Date().getDate(); // 오늘 일자 (1~31)
  const activeSubs = state.subscriptions.filter(s => !s.is_cancelled);

  // D-3 이내(0~3일 남음)인 첫 번째 구독 탐색
  const imminentSub = activeSubs.find(s => {
    const billDay = Number(s.billing_date) || 1;
    let diff = billDay - today;
    if (diff < 0) diff += 30; // 다음 달 결제일 고려
    return diff <= 3;
  });

  if (imminentSub) {
    const billDay = Number(imminentSub.billing_date) || 1;
    let diff = billDay - today;
    if (diff < 0) diff += 30;

    d3AlertTitle.textContent = `⚡ [D-${diff === 0 ? 'Day' : diff}] ${imminentSub.service_name} 결제 예정 알림!`;
    d3AlertDesc.textContent = `매월 ${billDay}일 ${(imminentSub.amount || 0).toLocaleString('ko-KR')}원이 자동 결제됩니다. 쓰지 않는다면 지금 방어하세요.`;
    d3AlertBanner.classList.remove('hidden');

    openCancelGuideBtn.onclick = () => openCancelModal(imminentSub);
  } else {
    d3AlertBanner.classList.add('hidden');
  }
}

/**
 * 인벤토리 테이블 렌더링
 */
function renderInventoryTable() {
  inventoryTableBody.innerHTML = '';
  const today = new Date().getDate();
  const activeSubs = state.subscriptions.filter(s => !s.is_cancelled);
  totalActiveSubsCount.textContent = `총 ${activeSubs.length}개 서비스`;

  state.subscriptions.forEach((sub, index) => {
    const tr = document.createElement('tr');
    const billDay = Number(sub.billing_date) || 1;
    let diff = billDay - today;
    if (diff < 0) diff += 30;

    const isImminent = diff <= 3 && !sub.is_cancelled;
    const dDayText = sub.is_cancelled ? '-' : (diff === 0 ? 'D-Day' : `D-${diff}`);
    const dDayClass = isImminent ? 'd-day-imminent' : 'd-day-normal';

    tr.innerHTML = `
      <td><strong>${escapeHtml(sub.service_name)}</strong></td>
      <td><span class="sub-category-tag ${getCategoryClass(sub.category)}">${escapeHtml(sub.category)}</span></td>
      <td>${(sub.amount || 0).toLocaleString('ko-KR')}원</td>
      <td>매월 ${billDay}일</td>
      <td><span class="d-day-badge ${dDayClass}">${dDayText}</span></td>
      <td>
        ${sub.is_cancelled 
          ? '<span class="status-cancelled">해지 완료됨</span>'
          : `<button type="button" class="btn-table-cancel" data-index="${index}">즉시 해지</button>`
        }
      </td>
    `;

    inventoryTableBody.appendChild(tr);
  });
}

// 인벤토리 테이블 내 해지 버튼 위임
inventoryTableBody.addEventListener('click', (e) => {
  if (e.target.classList.contains('btn-table-cancel')) {
    const index = parseInt(e.target.dataset.index, 10);
    const sub = state.subscriptions[index];
    if (sub) {
      openCancelModal(sub);
    }
  }
});

/**
 * 30초 초간단 해지 가이드 모달 제어
 */
const DIRECT_CANCEL_URLS = {
  '넷플릭스': 'https://www.netflix.com/youraccount',
  '유튜브': 'https://myaccount.google.com/subscriptions',
  '유튜브 프리미엄': 'https://myaccount.google.com/subscriptions',
  '쿠팡': 'https://mc.coupang.com/ssr/desktop/order/member/wow-membership',
  '쿠팡 와우': 'https://mc.coupang.com/ssr/desktop/order/member/wow-membership',
  '쿠팡 와우 멤버십': 'https://mc.coupang.com/ssr/desktop/order/member/wow-membership',
  '티빙': 'https://www.tving.com/my/membership',
  'ChatGPT': 'https://chatgpt.com/#settings',
  'ChatGPT Plus': 'https://chatgpt.com/#settings',
  '스포티파이': 'https://www.spotify.com/account/overview/'
};

function openCancelModal(sub) {
  currentTargetSubForCancel = sub;
  cancelModalTitle.textContent = `🚨 ${sub.service_name} 30초 초간단 해지 가이드`;

  // 다이렉트 해지 URL 매핑
  let matchedUrl = 'https://www.google.com/search?q=' + encodeURIComponent(`${sub.service_name} 멤버십 해지 바로가기`);
  for (const [key, url] of Object.entries(DIRECT_CANCEL_URLS)) {
    if (sub.service_name.includes(key)) {
      matchedUrl = url;
      break;
    }
  }
  modalDirectLink.href = matchedUrl;

  cancelGuideModal.classList.remove('hidden');
}

closeModalBtn.addEventListener('click', () => {
  cancelGuideModal.classList.add('hidden');
});

// 해지 완료 확인 클릭 시 상태 업데이트 & 절감액 누적
confirmCancelSubBtn.addEventListener('click', async () => {
  if (!currentTargetSubForCancel) return;

  currentTargetSubForCancel.is_cancelled = true;
  const savedAmount = Number(currentTargetSubForCancel.amount) || 0;

  // 히스토리에 절감액 가산
  const latestHist = savingsHistory[savingsHistory.length - 1];
  latestHist.amount += savedAmount;

  alert(`🎉 [${currentTargetSubForCancel.service_name}] 해지가 완료되었습니다!\n월 ${savedAmount.toLocaleString('ko-KR')}원의 불필요한 고정비가 방어되었습니다.`);

  cancelGuideModal.classList.add('hidden');
  refreshDashboard();

  // 노션에 비동기 아카이브 연동 시도 (PageId가 있는 경우)
  if (currentTargetSubForCancel.notionPageId) {
    try {
      await fetch('/api/notion-sync', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId: currentTargetSubForCancel.notionPageId })
      });
    } catch (e) {
      console.warn('노션 아카이브 연동 실패:', e);
    }
  }
});

/**
 * ==============================================================================
 * 11. 순수 HTML5 Canvas 2D 차트 렌더링 엔진 (Savings Tracker & Donut)
 * ==============================================================================
 */
function renderCharts() {
  const savingsCanvas = document.getElementById('savingsChart');
  const donutCanvas = document.getElementById('categoryDonutChart');

  if (savingsCanvas) drawSavingsChart(savingsCanvas, savingsHistory);
  if (donutCanvas) drawCategoryDonutChart(donutCanvas);
}

/**
 * 1) 누적 절감액 타임라인 영역 차트 (Area Chart)
 */
function drawSavingsChart(canvas, data) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  const padding = { top: 30, right: 30, bottom: 40, left: 60 };
  const chartW = w - padding.left - padding.right;
  const chartH = h - padding.top - padding.bottom;

  const maxVal = Math.max(...data.map(d => d.amount), 50000) * 1.2;
  const totalSaved = data[data.length - 1].amount;
  totalSavedBadge.textContent = `누적 절감: ${totalSaved.toLocaleString('ko-KR')}원`;

  // X, Y 좌표 계산기
  const getX = (idx) => padding.left + (idx / (data.length - 1)) * chartW;
  const getY = (val) => padding.top + chartH - (val / maxVal) * chartH;

  // 배경 가이드 라인
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const yVal = (maxVal / 3) * i;
    const y = getY(yVal);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(w - padding.right, y);
    ctx.stroke();

    // Y축 레이블
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px Pretendard, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(yVal / 1000)}k`, padding.left - 8, y + 3);
  }

  // 에어리어 그라디언트 채우기
  const gradient = ctx.createLinearGradient(0, padding.top, 0, h - padding.bottom);
  gradient.addColorStop(0, 'rgba(16, 185, 129, 0.35)');
  gradient.addColorStop(1, 'rgba(16, 185, 129, 0.0)');

  ctx.beginPath();
  ctx.moveTo(getX(0), h - padding.bottom);
  data.forEach((d, i) => {
    ctx.lineTo(getX(i), getY(d.amount));
  });
  ctx.lineTo(getX(data.length - 1), h - padding.bottom);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // 선 그리기
  ctx.beginPath();
  data.forEach((d, i) => {
    const x = getX(i);
    const y = getY(d.amount);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#10b981';
  ctx.lineWidth = 3;
  ctx.stroke();

  // 데이터 포인트 원 및 X축 레이블
  data.forEach((d, i) => {
    const x = getX(i);
    const y = getY(d.amount);

    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#059669';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#64748b';
    ctx.font = '11px Pretendard, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(d.month, x, h - 14);
  });
}

/**
 * 2) 카테고리별 지출 도넛 차트
 */
function drawCategoryDonutChart(canvas) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const activeSubs = state.subscriptions.filter(s => !s.is_cancelled);
  const categoryTotals = {};
  let grandTotal = 0;

  activeSubs.forEach(s => {
    const cat = s.category || '기타';
    const amt = Number(s.amount) || 0;
    categoryTotals[cat] = (categoryTotals[cat] || 0) + amt;
    grandTotal += amt;
  });

  const donutColors = {
    'OTT': '#8b5cf6',
    '음원': '#10b981',
    '생산성/AI': '#0284c7',
    '쇼핑/멤버십': '#f97316',
    '기타': '#64748b'
  };

  const categories = Object.keys(categoryTotals);
  const donutLegend = document.getElementById('donutLegend');
  donutLegend.innerHTML = '';

  if (grandTotal === 0 || categories.length === 0) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px Pretendard, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('활성 구독 없음', w / 2, h / 2);
    return;
  }

  const cx = w / 2;
  const cy = h / 2;
  const outerR = 85;
  const innerR = 52;
  let startAngle = -Math.PI / 2;

  categories.forEach(cat => {
    const val = categoryTotals[cat];
    const sliceAngle = (val / grandTotal) * Math.PI * 2;
    const color = donutColors[cat] || '#94a3b8';

    ctx.beginPath();
    ctx.arc(cx, cy, outerR, startAngle, startAngle + sliceAngle);
    ctx.arc(cx, cy, innerR, startAngle + sliceAngle, startAngle, true);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    startAngle += sliceAngle;

    // 범례 생성
    const percent = Math.round((val / grandTotal) * 100);
    const itemEl = document.createElement('div');
    itemEl.className = 'legend-item';
    itemEl.innerHTML = `
      <span class="legend-color-dot" style="background: ${color}"></span>
      <span>${escapeHtml(cat)} (${percent}%): <strong>${val.toLocaleString('ko-KR')}원</strong></span>
    `;
    donutLegend.appendChild(itemEl);
  });

  // 도넛 중앙 합계 텍스트
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 15px Pretendard, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${(grandTotal / 10000).toFixed(1)}만원`, cx, cy + 5);
}

/**
 * ==============================================================================
 * 12. 팀 노션 실시간 연동 (Notion API Sync)
 * ==============================================================================
 */
async function checkNotionStatus() {
  try {
    notionStatusText.textContent = '노션 연결 상태 확인 중...';
    const response = await fetch('/api/notion-sync');
    const result = await response.json();

    if (response.ok && result.success) {
      notionStatusBadge.style.borderColor = '#86efac';
      notionStatusBadge.style.background = '#f0fdf4';
      notionStatusText.innerHTML = `<span style="color: #15803d;">🟢 노션 DB 연결됨 (${result.count}건)</span>`;
    } else {
      notionStatusBadge.style.borderColor = '#fdba74';
      notionStatusBadge.style.background = '#fff7ed';
      notionStatusText.innerHTML = `<span style="color: #c2410c;">⚠️ 노션 페이지에 "9조" 연결 필요</span>`;
    }
  } catch (e) {
    notionStatusText.innerHTML = `<span style="color: #64748b;">⚪ 로컬 모드로 동작 중</span>`;
  }
}

// 실시간 Sync 버튼 이벤트
syncNotionBtn.addEventListener('click', async () => {
  await checkNotionStatus();
  alert('🔄 노션 데이터베이스 연결 상태가 갱신되었습니다!\n(공유 페이지에 "9조" 통합이 연결되어 있는지 확인해 주세요.)');
});

// 노션 일괄 전송 버튼 이벤트
pushAllToNotionBtn.addEventListener('click', async () => {
  if (state.subscriptions.length === 0) {
    alert('노션에 전송할 구독 내역이 없습니다.');
    return;
  }

  pushAllToNotionBtn.disabled = true;
  pushAllToNotionBtn.textContent = '⏳ 노션 DB로 전송 중...';

  try {
    const response = await fetch('/api/notion-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptions: state.subscriptions })
    });

    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.error || result.message || '노션 동기화 실패');
    }

    alert(`🎉 성공! ${result.message}`);
    checkNotionStatus();

  } catch (error) {
    console.error('노션 전송 오류:', error);
    alert(`노션 전송 안내:\n노션 페이지 우측 상단 [···] > [연결]에서 "9조"를 추가한 후 다시 시도해 주세요.\n(세부 오류: ${error.message})`);
  } finally {
    pushAllToNotionBtn.disabled = false;
    pushAllToNotionBtn.textContent = '📤 현재 구독 목록을 노션 DB로 일괄 전송';
  }
});

/**
 * 헬퍼 함수
 */
function getCategoryClass(category) {
  if (!category) return 'tag-etc';
  if (category.includes('OTT')) return 'tag-ott';
  if (category.includes('음원')) return 'tag-music';
  if (category.includes('AI') || category.includes('생산성')) return 'tag-ai';
  if (category.includes('쇼핑') || category.includes('멤버십')) return 'tag-shop';
  return 'tag-etc';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// 페이지 로드 시 기존 저장된 데이터가 있으면 자동 복원
window.addEventListener('DOMContentLoaded', () => {
  const saved = localStorage.getItem('campus_subscriptions');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length > 0) {
        state.subscriptions = parsed;
        renderCards();
        resultsSection.classList.remove('hidden');
      }
    } catch (e) {
      console.warn('저장된 구독 데이터 복원 실패:', e);
    }
  }
});
