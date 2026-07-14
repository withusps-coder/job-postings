# 공고 운영 방법

공개 공고의 편집·게시 권한은 D1의 관리자 초안과 불변 revision에 있습니다. 운영자는
Cloudflare Access로 보호된 `/admin/`에서만 공고를 관리합니다. 저장소의 JSON, 정적
HTML, 또는 Git 변경으로 공고를 게시하지 않습니다.

## 관리자 작업 흐름

1. `/admin/`에서 회사를 선택하거나 만들고 새 공고 초안을 만듭니다.
2. 기본 정보, 회사 스냅샷, 상세 섹션, 지원 경로를 입력합니다. 지원 경로는 HTTPS
   공식 URL 또는 이메일 중 하나여야 합니다.
3. 로고·지도·PDF를 초안 자산으로 올립니다. 서버는 바이트에서 MIME, 길이, SHA-256을
   검증한 뒤 새 불변 R2 키에 create-only로 저장합니다. 기존 자산을 바꾸거나 삭제하지
   않습니다.
4. 보호된 미리보기에서 제목, 섹션, 지도, 자료 링크, 지원 CTA를 검토합니다. 초안과
   미리보기는 공개되지 않습니다.
5. `게시`를 실행합니다. D1은 초안, 회사 스냅샷, 지원 정보, 검증된 자산 바인딩을 하나의
   불변 revision으로 만들고 active pointer를 원자적으로 전환합니다.
6. 게시 후 공개 URL, 목록, 자료 다운로드, 지원 CTA를 확인합니다. 수정은 현재 revision을
   바꾸지 않고 초안을 고친 뒤 새 revision으로 다시 게시합니다. 마감과 롤백도 관리자
   작업으로만 실행합니다.

같은 요청을 다시 전송해야 할 때는 UI가 보여 주는 현재 초안/세대 정보를 다시 읽고 새
idempotency key로 원래 작업을 재제출합니다. 동일 key의 재전송은 저장된 원래 terminal
결과를 반환합니다. 실패한 예전 입력을 자동 재생하거나 일반 retry API를 사용하지
않습니다.

## 콘텐츠 기준

- 확인되지 않은 급여, 마감일, 복지, 전형 정보는 추측해서 입력하지 않습니다.
- 공개 revision은 회사·지원 정보·섹션·자산을 함께 고정합니다. 회사나 초안을 나중에
  수정해도 기존 공개 페이지는 변하지 않습니다.
- 자산 교체는 새 업로드와 새 revision으로만 수행합니다. R2 객체, 자산 행, revision은
  물리 삭제하지 않습니다.
- 공고를 마감하면 공개 상세 페이지는 남지만 지원 CTA와 JobPosting 구조화 데이터가
  사라집니다.

## Ablearn 일회성 이전 증거

Ablearn cutover 전에는 다음의 읽기 전용 증거 검사를 실행합니다.

```sh
node scripts/audit-ablearn-migration.mjs
node --test tests/ablearn-migration.test.mjs
```

`tests/fixtures/ablearn-migration-inventory.json`은 검토된 보존 증거일 뿐이며 운영
권한이 아닙니다. 이 검사는 현재 라이브 참조인 Ablearn 로고, 지도 이미지,
회사소개서 PDF의 SHA-256/MIME/길이와 정규화된 콘텐츠·링크·렌더 제목을 확인합니다.
보관용 `ablearn-marketing-portfolio.png`는 이전 대상이 아닙니다. 지원 이메일은
`src/_data/site.json.contactEmail`에서 현재 `createApplyMailto` fallback으로 파생된
값과 provenance를 검증합니다.

실제 import는 승인된 환경별 D1/R2 binding을 가진 일회성 runner에서
`migrateAblearnToD1({ database, bucket, environment, actorSubject })`를 호출해서만
수행합니다. 이 모듈은 자격 증명·production binding·배포 조회를 자체적으로 하지
않습니다. importer는 source/R2 무결성과 렌더 결과를 active pointer 전 비교하고,
검증된 자산을 create-only 키로 저장한 뒤 정상 publish operation으로 snapshot,
revision, 자산 바인딩, pointer를 한 D1 batch에서 활성화합니다. 같은 환경과 actor로
재실행하면 저장된 원래 terminal 결과를 반환합니다.

D1 active revision이 cutover 후 유일한 공개 권한입니다. JSON 파일을 편집하거나 Git에
자산을 추가하는 방식은 이전 증거를 갱신하는 작업일 뿐, 운영 공고를 생성·수정·게시하는
방법이 아닙니다.
