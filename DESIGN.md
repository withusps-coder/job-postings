# 금문섭 헤드헌터 Design System

## 1. Identity, intent, and runtime provenance

The public listing remains a personal recruiter surface. Each job detail is a
content-first Greeting-style posting: company and role information lead, a
single blue action anchors the page, and dense Korean copy is presented in a
plain editorial column with a compact factual rail.

The detail-page contract was re-extracted on 2026-07-11 from the live Greeting
posting `https://www.doodlin.co.kr/ko/o/206794` in real Chrome at 375 and 1280
CSS pixels. Runtime anchors include Pretendard; a 72px desktop header; 32px
posting title; 20px/35px section headings; 16px/28px body copy; a 741px content
column paired with a 368px information rail; 4px controls; `#1890FF` actions;
and a mobile order of title, information rail, apply action, hero media, then
long-form content. Captures live in
`.omo/evidence/greeting-reference-206794/`.

## 2. Color

| Role                          | Token                                                                         | Value                           | Runtime basis and use                                                         |
| ----------------------------- | ----------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------- |
| Canvas                        | `--color-canvas`                                                              | `#FFFFFF`                       | Greeting detail page ground                                                   |
| Surface                       | `--color-surface`                                                             | `#FFFFFF`                       | header, cards, inputs                                                         |
| Ink                           | `--color-ink`                                                                 | `#222222`                       | Greeting posting text                                                         |
| Muted                         | `--color-muted`                                                               | `#5F6B7A`                       | accessible adaptation of Greeting secondary metadata                          |
| Border                        | `--color-border`                                                              | `#F0F0F0`                       | information rows and quiet dividers                                           |
| Footer                        | `--color-footer`                                                              | `#FAFAFA`                       | Greeting-style tall closing surface                                           |
| Accent                        | `--color-accent`                                                              | `#1890FF`                       | verified primary action background                                            |
| Detail hero                   | `--color-detail-hero-start`, `--color-detail-hero-end`, `--color-detail-glow` | `#453BC7`, `#1B2F8F`, `#776EE8` | Ablearn-owned brand media in the Greeting hero slot                           |
| Accent hover                  | `--color-accent-hover`                                                        | `#0F57B7`                       | derived accessible hover ramp; corrected to preserve AA control-text contrast |
| Accent active                 | `--color-accent-active`                                                       | `#0F57B7`                       | derived press ramp                                                            |
| Accent soft                   | `--color-accent-soft`                                                         | `#EAF3FF`                       | derived selected/filter state                                                 |
| Success                       | `--color-success`                                                             | `#16794A`                       | personal site open-role status                                                |
| Warning                       | `--color-warning`                                                             | `#A65A00`                       | closing-soon status                                                           |
| Error                         | `--color-error`                                                               | `#C33434`                       | invalid input or unavailable asset                                            |
| Disabled                      | `--color-disabled`                                                            | `#A7B1C2`                       | unavailable controls                                                          |
| Focus                         | `--color-focus`                                                               | `#0F57B7`                       | 3px keyboard indicator on light surfaces                                      |
| Control hover                 | `--color-control-hover`                                                       | `#B7C7E1`                       | input hover border                                                            |
| Disabled surface              | `--color-disabled-surface`                                                    | `#F4F6F9`                       | disabled field/action background                                              |
| Success/closed/error surfaces | `--color-success-soft`, `--color-closed-soft`, `--color-error-surface`        | `#ECF8F1`, `#F0F3F7`, `#FFF7F7` | non-color-only state support                                                  |

Accent communicates an action only, never decoration. This is a light-only
contract: the reference extraction did not establish a dark-mode runtime
contract, so dark mode is intentionally absent.

## 3. Typography

**Stack:** `"Pretendard Variable", Pretendard, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif`.
This exact runtime stack was observed on every sampled reference element.

| Token                   | Size / line-height                | Weight | Use                               |
| ----------------------- | --------------------------------- | ------ | --------------------------------- |
| `--type-detail-display` | `clamp(30px, 3.2vw, 40px) / 1.32` | 700    | job title                         |
| `--type-detail-heading` | `20px / 28px`                     | 600    | detail section heading            |
| `--type-card-title`     | `20px / 28px`                     | 700    | job-card title                    |
| `--type-detail-body`    | `16px / 28px`                     | 400    | Greeting long-form body baseline  |
| `--type-label`          | `14px / 20px`                     | 600    | navigation, labels, card metadata |
| `--type-meta`           | `13px / 19.5px`                   | 600    | compact status and form controls  |
| `--type-caption`        | `12px / 16px`                     | 500    | secondary metadata                |

Korean text uses `word-break: keep-all` for titles and concise labels; a title
that becomes more than three lines at 375px is shortened in content rather than
shrunk below this scale.

## 4. Space, layout, and responsive deltas

The base unit is 4px: `--space-1` 4, `--space-2` 8, `--space-3` 12,
`--space-4` 16, `--space-5` 20, `--space-6` 24, `--space-8` 32,
`--space-10` 40, `--space-12` 48, `--space-16` 64. Content uses a 1200px
maximum and 16/24/32px page gutters at mobile/tablet/desktop.

| Width | Observed reference delta                                            | Personal recruiter application                                               |
| ----- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 375   | 20px gutter; 324px content; title → facts → apply → media → content | one-column detail with full-width action and horizontally scrollable process |
| 768   | one-column detail with full factual rail before content             | readable tablet flow without a narrow body column                            |
| 1280  | ~40px gutter; 741–760px content and 368px sticky factual rail       | two-column Greeting detail composition                                       |

Do not import the reference’s marketing sections, pricing architecture, or
corporate footer. Personal pages lead with the recruiter, then roles, then a
direct contact route.

## 5. Reusable primitives and states

### Affiliation header

- **Structure:** `<header><a><img wordmark></a><nav>…</nav><button menu>`.
- **Spacing:** 57px runtime header, `--space-4` mobile inset.
- **States:** default; link hover/active/focus; mobile open; missing-wordmark
  error exposes a text fallback with `role="status"`, never a collapsed header.
- **Accessibility:** labelled menu button, visible focus ring, wordmark alt
  describes the affiliation rather than pretending it is the site owner.

### Primary and secondary action

- **Structure:** semantic `<a>` or `<button>`, never a clickable `div`.
- **Variants:** primary, secondary, quiet, disabled, loading.
- **Runtime anatomy:** primary is 16px/24px/600, 10px radius, 28px horizontal
  padding, `#1A7CFF`, and the observed blue `18px 60px -20px` shadow. The
  personal site uses ink label text on that blue rather than the reference’s
  white label because the latter measured below the AA contrast floor.
- **States:** default; hover raises 1px and darkens; active returns to baseline;
  focus has a 3px `--color-focus` ring (deep accessible blue, not the soft
  fill); disabled has no pointer action; loading keeps
  label width and announces `aria-busy`; error exposes inline recovery text.

### Job card and status

- **Structure:** linked role title, company/meta, status badge, concise summary.
- **Runtime anatomy:** white surface, 14px radius, `16px 16px 0` padding,
  quiet border. It is content-led, not a product feature tile.
- **States:** default, hover border/translation, active, focus-visible,
  loading skeleton, empty list with reset link, error with retry link, and
  open/closed status. Closed cards remain readable but suppress application CTA.

### Input and filter

- **Structure:** explicit `<label>`, `<input>`, hint/error text.
- **Runtime anatomy:** 13px/19.5px, 8px radius, 14px horizontal padding,
  `#E3E8F1` border.
- **States:** default, hover, focus, active typing, disabled, loading,
  empty, and error. Error text is associated with `aria-describedby`; a missing
  token renders the documented error color through a safe CSS fallback.

### Feedback regions

- **Structure:** status badge and `role="status"`/`role="alert"` message.
- **States:** loading, empty, error, retry. Feedback does not replace job
  information or mask a broken asset.

### Job detail hero and fact rail

- **Structure:** title and long-form company/role content form the 741–760px
  primary column. Desktop uses a 368px sticky fact/action rail with 4px corners.
  Mobile returns to normal flow and uses a full-width action.
- **Content order:** title/company, facts, primary action, hero media, metrics,
  company, role, qualifications, preferences, benefits, conditions, process,
  and notes. Recruiter messaging is omitted when it would interrupt this flow.
- **States:** long Korean title and address, missing logo, open/closed action,
  and print layout. The fact rail must never overlap the closing CTA.

### Long-form job section

- **Structure:** semantic section heading followed by the content form that best
  communicates the source: prose for background/overview, bullets for duties,
  grouped tonal panels for benefits, definition rows for conditions, numbered
  steps for process, and underlined text links for source material.
- **Rhythm:** section titles use the verified blue left rule. Sections rely on
  56px whitespace rather than cards or repeated dividers. Body copy uses
  16px/28px and keeps Korean words intact.
- **Optional content:** absent data removes the whole section and its heading;
  no empty or placeholder surface is rendered.

### Job authoring workspace

- **Purpose:** a Cloudflare Access-protected operational surface on the exact canonical admin host. The authenticated administrator edits a mutable D1 draft, reviews a server-rendered protected preview, then publishes, closes, or rolls back through D1/R2 operations. It has no local JSON import/export, browser-local recovery, credential storage, or static/Git publishing authority.
- **Structure:** compact page introduction, grouped fieldsets in the left column, and a sticky paper-like preview in the right column. Repeating content uses one line per item so source text can be pasted without adding controls for every row. Asset upload verifies bytes before a create-only write to a new immutable private R2 key.
- **States:** new private draft, saved draft, invalid required field, protected preview, publishing, published immutable revision, closed revision, rollback selection, operation conflict, and stored terminal result. Saving a draft never changes a public page; publishing atomically creates a revision and advances the active pointer. Close and rollback create new immutable revisions, and no state removes an R2 object, asset row, or retained revision.
- **Recovery:** every mutation has a current version/generation and operation-specific idempotency key. A same-key replay returns only its stored terminal result; a conflict requires reloading the current state before submitting the relevant protected operation. The workspace never retries arbitrary old input, mutates a retained revision, or uses raw D1/R2 repair.
- **Responsive behavior:** two columns from 1024px, one column below it. At mobile widths actions remain full-width and the preview follows the editor in normal document flow.
- **Accessibility:** every control has a visible label and optional helper text; placeholder text is never the only label; keyboard operation covers draft saving, protected preview inspection, publish, close, rollback, and recovery-state inspection. Status text uses `role="status"`; validation failures use `role="alert"` and move focus to the first invalid control.

## 6. Motion and interaction

| Token               | Value                           | Basis / use                                                |
| ------------------- | ------------------------------- | ---------------------------------------------------------- |
| `--motion-fast`     | `150ms cubic-bezier(.4,0,.2,1)` | verified navigation/card transition language               |
| `--motion-standard` | `200ms ease`                    | verified primary action transition language                |
| `--motion-shimmer`  | `1.8s ease-in-out`              | verified loading input animation; only for genuine loading |

Only `transform`, `opacity`, `color`, `background-color`, `border-color`, and
`box-shadow` may transition. Hover means an actual affordance change; the only
signature movement is an action’s 1px lift. `prefers-reduced-motion: reduce`
removes lift, shimmer, and nonessential transitions while retaining focus and
state clarity.

## 7. Depth, accessibility, and accepted debt

**Depth strategy:** mixed but restrained: white surfaces on the verified pale
canvas, thin borders, and a single blue action shadow. Cards do not gain
prominent shadows on hover. Radius is 8px for inputs, 10px for actions, and
14px for cards.

**Accessibility contract:** WCAG 2.2 AA target; 4.5:1 body contrast; semantic
landmarks; keyboard-reachable links/buttons; visible 3px focus ring; labelled
controls; status/error messages; no color-only job state; natural Korean line
breaking; and reduced-motion support. Missing assets and tokens must be obvious,
announced, and layout-stable.

**Accepted debt:** none. The native available font fallback can differ slightly
before Pretendard is loaded; it must not create clipping or change semantics.
The standalone showcase intentionally uses no external font request so it can
exercise its fallback path offline.
