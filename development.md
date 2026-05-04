# Development Guide

## Overview

`tefleming.com` is a personal book tracking site backed by this GitHub repo (`teddyballgm/TBR`). It displays a reading queue (TBR) and a ratings log, both sourced from markdown files in the repo. Visitors can submit new books or ratings via a form, which opens a GitHub PR for manual triage.

---

## Architecture

- **Hosting:** Vercel (static site + serverless function, auto-deploys on push to `main`)
- **Frontend:** Single file — `index.html`. Vanilla JS, no build tooling, no frameworks, no npm.
- **Backend:** Single serverless function — `api/submit.js`. Runs on Vercel, never touches the browser.
- **Data:** Two markdown files — `tbr.md` and `ratings.md`. These are the source of truth.
- **Domain:** `tefleming.com` (naked domain is primary; `www` redirects to it)

---

## File Map

```
index.html        — entire frontend: HTML, CSS, JS in one file
api/submit.js     — Vercel serverless function for write operations
tbr.md            — TBR queue data
ratings.md        — ratings log data
CONSTITUTION.md   — taste profile, rating scale, triage workflow
DEVELOPMENT.md    — this file
CNAME             — legacy GitHub Pages artifact, can be ignored
```

---

## How Reads Work

`index.html` fetches `tbr.md` and `ratings.md` directly from the GitHub API (unauthenticated — repo is public), parses the markdown client-side, and renders the result. No server involvement.

```
Browser → GitHub API (unauthenticated) → markdown → parsed + rendered in browser
```

## How Writes Work

Form submissions POST to `/api/submit` (the Vercel serverless function). The function holds a GitHub PAT as the `GH_PAT` environment variable (set in Vercel project settings — never in code). It creates a branch, commits a stub entry to the appropriate markdown file, and opens a PR.

```
Browser form → POST /api/submit → Vercel function → GitHub API (authenticated) → PR opened
```

PRs are reviewed and merged manually. The enrichment GitHub Action fires on PR open to fill in predicted ratings and triage fields.

**Never put the PAT in `index.html` or any client-side code.**

---

## Markdown Schemas

### tbr.md

Top-level structure:
```markdown
## Tier 1 — [description]
## Tier 2 — [description]  
## Tier 3 — [description]
## Already Read / Removed
```

Individual book entry:
```markdown
### Title — Author *(rec from Source)*

**Kindle:** [Track on eReaderIQ](https://www.ereaderiq.com/search/?q=Title+Author) | Price: $X.XX ~~$Y.YY~~ 🔔 alert set @ $Z.ZZ

**Status:** Purchased

**Predicted rating:** X/10

**Why it's here:** Reason this book made the list.

**The caveat:** The main risk or reservation.
```

Field notes:
- `*(rec from Source)*` on the title line is optional
- `**Status:** Purchased` is optional — present only for bought books; suppresses price tracking in the UI
- `**Kindle:**` price fields are optional — if no price data, renders as "price not yet tracked"
- eReaderIQ URL format: `https://www.ereaderiq.com/search/?q=Title+Author` (URL-encoded)
- Alert threshold is set at $0.01 below current price

### ratings.md

Top-level structure:
```markdown
## [Section heading — loose grouping by score range]
## Did Not Finish
```

Individual rated book entry:
```markdown
### Title — Author · X/10 *(Format)*

Notes and thoughts about the book.
```

Field notes:
- Score is on a 1–10 scale in 0.5 increments
- `*(Format)*` is optional — e.g. `*(Kindle)*, *(Audible)*, *(Whispersync)*`
- Notes are freeform prose, can be multiple paragraphs separated by blank lines
- DNF entries live in the "Did Not Finish" section and may omit the score

---

## Deploy Process

1. Push to `main` → Vercel auto-deploys in ~10 seconds
2. No build step, no CI required
3. Preview deployments are created for PRs (including book submission PRs — this is expected and harmless)

---

## Environment Variables

| Variable | Where | Purpose |
|---|---|---|
| `GH_PAT` | Vercel project settings | GitHub fine-grained PAT for `teddyballgm/TBR` with `contents: write` and `pull-requests: write` |

---

## CORS

`api/submit.js` currently allows `Access-Control-Allow-Origin: https://tefleming.com`. Do not change this to `*`.

---

## Key Constraints

- **No build tooling.** Do not introduce npm, webpack, vite, or any build step.
- **No frameworks.** Do not introduce React, Vue, or any JS framework.
- **Single HTML file.** Keep all frontend code in `index.html` — do not split into separate CSS or JS files.
- **No client-side secrets.** All GitHub API writes go through `api/submit.js`.
- **Markdown is the data layer.** Do not introduce a database or external data store.
