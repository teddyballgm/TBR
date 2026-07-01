# TBR

Personal book management system — a to-be-read queue and ratings log powering
[tefleming.com](https://tefleming.com).

A deliberately minimal setup: a single `index.html` frontend (vanilla JS, no
build step), one Vercel serverless function (`api/submit.js`), two markdown
files as the data layer (`tbr.md`, `ratings.md`), and a GitHub Action that uses
Claude to enrich new submissions.

- **Architecture & data schemas:** [`development.md`](development.md)
- **Operations (token rotation, troubleshooting):** [`RUNBOOK.md`](RUNBOOK.md)
- **Taste profile & triage rules:** [`CONSTITUTION.md`](CONSTITUTION.md)
