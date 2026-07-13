# Operations Runbook

Operational guide for keeping `tefleming.com` (repo `teddyballgm/TBR`) running.
For architecture and data schemas, see `development.md`.

---

## Secrets inventory

| Secret | Where it lives | Used by | Purpose |
|---|---|---|---|
| `GH_PAT` | **Vercel** → Project Settings → Environment Variables | `api/submit.js` | Authenticated GitHub writes (create branch, commit stub, open PR) |
| `ANTHROPIC_API_KEY` | **GitHub** → Actions secrets | `enrich.mjs` | Call Claude to enrich book submissions ("Why it's here" / "The caveat") and reconcile the queue on rating submissions |

> **`GH_PAT` lives only in Vercel.** The enrichment workflow (`.github/workflows/enrich-submission.yml`) no longer uses a stored PAT — it authenticates with the run's default `GITHUB_TOKEN` (via `permissions: contents: write, pull-requests: write` in the workflow), which GitHub issues and scopes automatically per run. There is nothing to rotate on the Actions side.

The PAT is a **fine-grained** token scoped to `teddyballgm/TBR` with:
- **Contents:** Read and write
- **Pull requests:** Read and write

Note: `enrich.mjs` still reads this token from an env var it calls `GH_PAT` — that's just the variable's internal name in the script; the workflow sets it to `${{ secrets.GITHUB_TOKEN }}`, not the Vercel secret. Don't confuse the two when reading the code.

---

## Runbook: rotate the `GH_PAT` (expired or compromised)

This is the most common maintenance task. GitHub emails you before a fine-grained PAT expires. Rotation is now a **single-place** update — `GH_PAT` only lives in Vercel.

1. **Create the new token**
   - GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → *Generate new token*.
   - **Resource owner:** the account that owns `teddyballgm/TBR`.
   - **Repository access:** Only select repositories → `teddyballgm/TBR`.
   - **Permissions:** Contents = *Read and write*, Pull requests = *Read and write*.
   - Set an expiry (e.g. 90 days) and copy the token value.

2. **Update Vercel** (fixes the submission form)
   - Vercel → the TBR project → Settings → Environment Variables → edit `GH_PAT` → paste the new value → Save.
   - Redeploy: Deployments → latest → **Redeploy** (env changes only take effect on a new deployment).

3. **Verify** (see the checklist below).

4. **Revoke the old token** in GitHub Developer settings once the new one is confirmed working.

There is no GitHub Actions step anymore — the enrichment workflow authenticates with the run's default `GITHUB_TOKEN`, which GitHub issues fresh per run and never expires or needs rotating.

---

## What breaks when the `GH_PAT` expires

| Path | Symptom | Where |
|---|---|---|
| Submission form | Form shows *"GitHub authentication failed — the access token is likely expired."* | `api/submit.js` now detects the 401 and returns this message (HTTP 502) |

The enrichment Action is unaffected by `GH_PAT` expiry — it doesn't use that secret. If the Action fails, the cause is elsewhere (see the troubleshooting matrix below); it posts a **"⚠️ Automatic enrichment failed"** comment on the PR before exiting non-zero.

---

## Troubleshooting matrix

| Symptom | Likely cause | Fix |
|---|---|---|
| Form: "GitHub authentication failed… token is likely expired" | `GH_PAT` expired/revoked in Vercel | Rotate the PAT (Vercel only — see above) |
| Form: "GH_PAT not configured" | Env var missing in Vercel | Add `GH_PAT` in Vercel, redeploy |
| Form: "A title is required." / "Score must be…" | Invalid submission input | Expected — user needs to fix the form fields |
| Form: 429 "Too many submissions…" | Per-IP rate limit hit (5/hour, best-effort per serverless instance) | Expected under abuse; a legitimate user just waits, or you widen `RATE_LIMIT_MAX` in `api/submit.js` |
| Action ✗ with a "⚠️ Automatic enrichment failed" comment | Read the error in the comment / Actions logs | Usually expired `ANTHROPIC_API_KEY`, a permissions misconfiguration, or malformed Claude output — **not** `GH_PAT`, which the Action no longer uses |
| Action ✗ with **no** comment | `GITHUB_TOKEN` couldn't post (unlikely — check `permissions:` in the workflow are still `contents: write` / `pull-requests: write`) | Fix the workflow's `permissions:` block, then re-run via `workflow_dispatch` (pass `pr_number` and `head_ref`) |
| Enrichment: "Placeholder not found… stub may already be enriched" | The `[To be filled during triage]` stub was edited/removed before the Action ran | Re-add the stub, or triage the entry manually |
| Enrichment: "Claude did not return valid JSON" | Model returned prose/fenced output | Re-run the workflow (Actions tab → Enrich Submission → Run workflow, or `workflow_dispatch` with `pr_number`/`head_ref`); if persistent, check the prompt / model in `enrich.mjs` |
| Site shows stale data after a merge | Vercel deploy lag or cache | Wait ~10s; check Vercel Deployments for a successful build on `main` |
| Site fails to load any books | GitHub API read blip, or `tbr.md`/`ratings.md` markdown broke the parser | Check the raw markdown formatting against the schemas in `development.md` |
| PR fails the "Lint Schema" check | `tbr.md` or `ratings.md` doesn't match the documented schema | Read the job's error output — it names the offending heading/entry — and fix the markdown (see schema in `development.md`) |

---

## Optional environment overrides

None are required — all have safe defaults. Set them only if you need to change behavior.

| Variable | Where | Default | Effect |
|---|---|---|---|
| `ALLOWED_ORIGIN` | Vercel | `https://tefleming.com` | CORS origin allowed to POST to `/api/submit` |
| `ANTHROPIC_MODEL` | GitHub Actions | `claude-opus-4-7` | Model used for enrichment (e.g. bump to a newer Claude model) |
| `ANTHROPIC_VERSION` | GitHub Actions | `2023-06-01` | Anthropic API version header |

---

## Verification checklist (after any secret rotation)

1. **Submit form:** on `tefleming.com`, submit a throwaway test book. You should get a PR link back (not an auth error).
2. **Enrichment:** the submission PR's Action should go green and post a **"Claude enrichment"** comment within a minute. (For a rating submission, the comment reports whether the queue was reconciled or left untouched.)
3. **Merge & deploy:** merge the PR; within ~10s Vercel redeploys `main` and the book appears on the site.
4. **Clean up:** delete the test PR/branch and remove the test entry if merged.

---

## Deploy & hosting notes

- **Hosting:** Vercel, auto-deploys on push to `main` (~10s, no build step).
- **DNS/domain:** `tefleming.com` is configured in Vercel. `CNAME` in the repo is a legacy GitHub Pages artifact and is unused.
- **Data is the repo:** `tbr.md` and `ratings.md` are the source of truth; every change is a git commit, so history *is* your backup — recover any bad edit with `git revert`.
