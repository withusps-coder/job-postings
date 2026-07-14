import { renderDocument } from "./_includes/render/document.js";

export const data = { permalink: "/admin/index.html" };

/** @param {string} name @param {string} label @param {string} [hint] @param {boolean} [required] */
const textArea = (name, label, hint = "", required = false) =>
  `<label class="admin-field admin-field--wide"><span>${label}${required ? " *" : ""}</span>${hint ? `<small>${hint}</small>` : ""}<textarea name="${name}" rows="5"${required ? " required" : ""}></textarea></label>`;

/** @param {{ site: import("./_includes/render/types.js").Site }} input */
export function render({ site }) {
  return renderDocument({
    site,
    title: `관리자 | ${site.identity.name} ${site.identity.role}`,
    description: "채용 공고와 회사 초안을 관리하고 공개합니다.",
    path: "/admin/",
    robots: "noindex, nofollow, noarchive",
    bodyClass: "admin-page",
    script: '<script src="/assets/scripts/job-admin.js" defer></script>',
    content: `<section class="admin-workspace shell" aria-labelledby="admin-title">
  <header class="admin-intro">
    <p class="eyebrow">Protected admin</p>
    <h1 id="admin-title">채용 공고 관리</h1>
    <p>회사와 공고 초안은 저장 후에만 공개 준비가 됩니다. 공개, 마감, 복원은 별도의 확인 작업이며 현재 공개 페이지는 변경 전까지 유지됩니다.</p>
  </header>

  <div class="admin-directory" role="group" aria-label="회사와 공고 선택">
    <div class="admin-directory__group">
      <label class="admin-field"><span>회사 선택</span><select id="admin-company" data-admin-company><option value="">회사를 불러오는 중입니다.</option></select></label>
      <button class="action action--secondary" type="button" data-admin-company-new>새 회사</button>
      <button class="action action--secondary" type="button" data-admin-company-save>회사 정보 저장</button>
    </div>
    <div class="admin-directory__group">
      <label class="admin-field"><span>공고 선택</span><select id="admin-job" data-admin-job><option value="">공고를 불러오는 중입니다.</option></select></label>
      <button class="action action--secondary" type="button" data-admin-job-new>새 공고</button>
      <button class="action action--secondary" type="button" data-admin-reload>현재 상태 새로고침</button>
    </div>
    <p class="admin-identity" data-admin-identity aria-live="polite">관리자 세션을 확인하고 있습니다.</p>
  </div>

  <p class="admin-status" role="status" data-admin-status>관리 화면을 준비하고 있습니다.</p>
  <div class="admin-error" role="alert" data-admin-error hidden></div>
  <div class="admin-retry" data-admin-retry hidden>
    <p data-admin-retry-message></p>
    <button class="action action--secondary" type="button" data-admin-retry-reload>현재 상태 불러오기</button>
    <button class="action action--secondary" type="button" data-admin-retry-submit hidden>현재 입력으로 다시 제출</button>
  </div>

  <div class="admin-layout">
    <form class="admin-form" data-admin-form novalidate>
      <fieldset>
        <legend>기본 정보</legend>
        <div class="admin-form__grid">
          <label class="admin-field"><span>공고 주소용 영문 ID *</span><small>영문 소문자, 숫자, 하이픈만 사용합니다. 생성 후에는 바꿀 수 없습니다.</small><input type="text" name="slug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required autocomplete="off"></label>
          <label class="admin-field"><span>현재 공개 상태</span><select name="status" disabled><option value="open">채용 중</option><option value="closed">마감</option></select><small>마감은 아래 공개 작업에서 처리합니다.</small></label>
          <label class="admin-field admin-field--wide"><span>공고 제목 *</span><input type="text" name="title" required></label>
          <label class="admin-field"><span>직군 *</span><input type="text" name="category" required></label>
          <label class="admin-field"><span>경력사항 *</span><input type="text" name="experience" required></label>
          <label class="admin-field"><span>고용형태 *</span><input type="text" name="employment" required></label>
          <label class="admin-field"><span>근무방식 *</span><select name="remote" required><option value="onsite">출근 근무</option><option value="hybrid">하이브리드</option><option value="remote">원격 근무</option></select></label>
          <label class="admin-field admin-field--wide"><span>근무지 *</span><input type="text" name="location" required></label>
          <label class="admin-field"><span>게시일 *</span><input type="date" name="datePosted" required></label>
          <label class="admin-field"><span>마감 안내</span><input type="text" name="closedState"><small>공개 중인 공고를 마감할 때 사용합니다.</small></label>
        </div>
      </fieldset>

      <fieldset>
        <legend>회사와 지원 경로</legend>
        <div class="admin-form__grid">
          <label class="admin-field"><span>회사명 *</span><input type="text" name="companyName" required></label>
          <label class="admin-field"><span>회사 홈페이지 *</span><input type="url" name="companyWebsite" required></label>
          <label class="admin-field admin-field--wide"><span>회사 한 줄 소개 *</span><textarea name="companySummary" rows="3" required></textarea></label>
          <label class="admin-field"><span>지도 위치</span><small>위도·경도 또는 주소</small><input type="text" name="mapQuery"></label>
          <label class="admin-field"><span>지원 경로 *</span><select name="applicationKind" required><option value="url">공식 HTTPS 지원 URL</option><option value="email">지원 이메일</option></select></label>
          <label class="admin-field admin-field--wide"><span data-admin-application-label>공식 지원 URL *</span><input type="url" name="applicationValue" required><small data-admin-application-hint>https://로 시작하는 공식 지원 페이지를 입력합니다.</small></label>
          <label class="admin-field admin-field--wide"><span>지원 경로 출처 *</span><input type="text" name="applicationProvenance" required><small>공식 URL 또는 확인한 이메일의 출처를 기록합니다.</small></label>
          <label class="admin-field admin-field--wide"><span>검색 태그 *</span><small>쉼표 또는 줄바꿈으로 구분합니다.</small><textarea name="tags" rows="3" required></textarea></label>
        </div>
      </fieldset>

      <fieldset>
        <legend>상세 내용</legend>
        <p class="admin-fieldset-hint">목록형 항목은 한 줄에 하나씩 입력합니다. <code>제목: 설명</code> 또는 <code>제목 | 링크</code> 형식은 미리보기에서 구조화해 보여 줍니다.</p>
        <div class="admin-form__stack">
          ${textArea("company", "회사 소개", "회사 특징과 사실을 한 줄에 하나씩 입력합니다.")}
          ${textArea("stats", "성과 지표", "지표명 | 값 형식으로 입력합니다.")}
          ${textArea("news", "관련 소식", "기사 제목 | https://원문주소 형식입니다.")}
          ${textArea("responsibilities", "포지션 소개 및 주요 업무", "포지션 개요: 설명을 첫 줄에 쓰고, 주요 업무를 이어서 입력합니다.", true)}
          ${textArea("qualifications", "지원 자격", "필수 자격을 한 줄에 하나씩 입력합니다.", true)}
          ${textArea("preferred", "우대 사항", "선택 항목입니다.")}
          ${textArea("benefits", "복지 및 혜택", "혜택명: 설명 형식으로 입력합니다.")}
          ${textArea("conditions", "근무 조건", "예: 근무 시간: 주 5일 오전 10시-오후 7시")}
          ${textArea("process", "채용 절차", "예: 서류 전형 또는 대면 인터뷰: 상세 설명")}
          ${textArea("notes", "지원 안내", "제출 서류와 유의사항을 입력합니다.")}
          ${textArea("documents", "첨부 문서 링크", "문서명 | https://문서주소 형식입니다. 업로드한 비공개 자산은 아래 자산 관리에서 연결합니다.")}
        </div>
      </fieldset>

      <fieldset>
        <legend>초안 저장</legend>
        <label class="admin-consent"><input type="checkbox" name="publisherApproved" required><span>기업과 공고를 공개할 권한이 있음을 확인했습니다. *</span></label>
        <p class="admin-fieldset-hint">저장은 초안만 바꾸며 공개 페이지는 바꾸지 않습니다.</p>
        <div class="admin-actions"><button class="action action--primary" type="submit" data-admin-save>초안 저장</button><button class="action action--secondary" type="button" data-admin-preview-check>서버 미리보기 확인</button></div>
      </fieldset>

      <fieldset class="admin-assets" data-admin-assets-section hidden>
        <legend>자산 관리</legend>
        <p class="admin-fieldset-hint">PNG, JPEG, WebP(최대 5MB) 또는 PDF(최대 20MB)만 업로드합니다. 새 파일은 별도 자산으로 추가되며, 교체는 기존 연결을 먼저 해제합니다.</p>
        <div class="admin-form__grid">
          <label class="admin-field"><span>자산 역할 *</span><select name="assetRole"><option value="company-logo">회사 로고</option><option value="company-hero">대표 이미지</option><option value="company-map">지도 이미지</option><option value="document">첨부 문서</option></select></label>
          <label class="admin-field"><span>파일 *</span><input type="file" name="assetFile" accept="image/png,image/jpeg,image/webp,application/pdf,.png,.jpg,.jpeg,.webp,.pdf"></label>
        </div>
        <div class="admin-actions"><button class="action action--secondary" type="button" data-admin-asset-upload>자산 업로드</button></div>
        <div class="admin-asset-list" data-admin-asset-list aria-live="polite"></div>
      </fieldset>

      <fieldset class="admin-publish" data-admin-publish-section hidden>
        <legend>공개 작업</legend>
        <p class="admin-fieldset-hint">각 작업은 현재 상태를 기준으로 한 번만 적용됩니다. 처리 중 오류가 나면 현재 상태를 불러온 뒤 해당 작업만 다시 제출합니다.</p>
        <dl class="admin-publish__state" data-admin-publish-state></dl>
        <div class="admin-actions"><button class="action action--primary" type="button" data-admin-publish>초안 공개</button><button class="action action--secondary" type="button" data-admin-close>공고 마감</button></div>
        <label class="admin-field admin-field--wide"><span>복원할 공개본 ID</span><input type="text" name="rollbackRevisionId" autocomplete="off"><small>이전에 공개·마감·복원 작업에서 반환된 공개본 ID를 입력합니다.</small></label>
        <div class="admin-actions"><button class="action action--secondary" type="button" data-admin-rollback>입력한 공개본으로 복원</button></div>
      </fieldset>
    </form>

    <aside class="admin-preview" aria-labelledby="preview-title">
      <div class="admin-preview__heading"><div><p class="eyebrow">Live preview</p><h2 id="preview-title">출력 미리보기</h2></div><span data-admin-preview-state>초안</span></div>
      <article class="admin-preview__paper" data-admin-preview tabindex="0" aria-label="공고 출력 미리보기 내용"></article>
    </aside>
  </div>
</section>`,
  });
}
