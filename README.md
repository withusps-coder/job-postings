# 채용 공고 | 스타팅파트너스

스타팅파트너스 소속 헤드헌터가 검토한 채용 공고를 제공하는 Cloudflare Pages 애플리케이션입니다.

## 현재 운영 모델

- 공개 목록·상세·사이트맵은 D1의 활성 immutable revision만 읽습니다.
- 관리자 화면과 API는 exact canonical host 및 Cloudflare Access로 보호됩니다.
- 이미지는 private R2에 create-only 객체로 보관하며 공개 Function은 retained revision에 연결된 자산만 제공합니다.
- 공고 작성·게시·마감·복원은 관리자 API의 durable idempotent operation으로 처리합니다.
- 저장소 JSON, 생성된 공고 HTML, GitHub Pages 및 기존 브라우저 PIN/PAT 흐름은 운영 authority나 fallback이 아닙니다.

운영 주소와 production/staging 리소스는 승인된 비공개 배포 inventory에서 관리합니다. Pages preview alias나 과거 GitHub Pages 주소를 운영 링크로 사용하지 않습니다.

## 로컬 검증

```sh
npm install
npm run check
```

로컬 Pages 실행과 D1 migration 절차, 실제 staging/production cutover 및 rollback gate는 `docs/runbooks/deployment.md`를 따릅니다. 관리자 보안·자격 증명 대응은 `docs/runbooks/security.md`를 따릅니다.
