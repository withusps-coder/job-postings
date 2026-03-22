# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Static HTML site hosted on GitHub Pages. No build step, no package manager, no framework. Each job posting is a self-contained `index.html` in its own folder. The root `index.html` is the main listing page.

**Live URLs:**
- Main: https://withusps-coder.github.io/job-postings/
- Individual postings: `https://withusps-coder.github.io/job-postings/<folder-name>/`

## Architecture

### Main listing page (`index.html`)
The root page is data-driven. All job cards are rendered from a `JOBS` array in the inline `<script>` block (around line 363). To add a new posting, append an object to this array:

```js
{
  id: "company-role",
  title: "[회사명] 포지션명",
  meta: ["팀명", "직무", "경력 조건", "고용형태", "회사명"],  // last item = company, shown as tag
  category: "영업",  // drives filter buttons: 영업 | 개발 | 마케팅 | 디자인 | 기획 | 경영지원
  logo: "./company-role/logo.png",
  url: "./company-role/index.html"
}
```

Filter buttons are auto-generated from unique `category` values in `JOBS`. Jobs render in **reverse array order** (newest first).

### Individual posting pages (`<folder>/index.html`)
Each is a standalone HTML file with all CSS inlined. They share a common design system but are not linked by any shared stylesheet — changes to one file's styles do not affect others.

Key shared patterns across posting pages:
- **Theme system**: CSS custom properties on `html.theme-dark` / `html.theme-light`, toggled via `localStorage` key `"viz-theme"`. Default starts `theme-dark` on posting pages, `theme-light` on the main page.
- **Logo display**: In light mode logos use `mix-blend-mode: multiply` (removes white backgrounds). In dark mode: `filter: brightness(0) invert(1); opacity: 0.75`.
- **Section structure**: Hero → gradient divider → content sections using `.card` components → footer CTA.
- **Scroll animations**: `.reveal` class + IntersectionObserver adds `.visible` to trigger CSS transitions.
- **Export feature**: `html-to-image` CDN script (`cdn.jsdelivr.net/npm/html-to-image`) enables image/PDF export on posting pages. Not present on main page.

## Deploying Changes

Push to `main` → GitHub Pages auto-deploys. No CI/CD pipeline.

```bash
git add <files>
git commit -m "message"
git push origin main
```

## Adding a New Job Posting

1. Create a new folder: `<company>-<role>/`
2. Copy the closest existing posting's `index.html` as a starting template
3. Place logo image(s) in the new folder
4. Update the `JOBS` array in root `index.html` with the new entry
5. Update `README.md` links table
