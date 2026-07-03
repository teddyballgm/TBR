# Operations Runbook

Operational guide for keeping `tefleming.com` (repo `teddyballgm/TBR`) running.
For architecture and data schemas, see `development.md`.

---

## Secrets inventory

| Secret | Where it lives | Used by | Purpose |
|---|---|---|---|
| `GH_PAT` | **Vercel** → Project Settings → Environment Variables | `api/submit.js` | Authenticated GitHub writes (create branch, commit stub, open PR) |
| `GH_PAT` | **GitHub** → repo Settings → Secrets and variables → Actions | `.github/workflows/enrich-submission.yml` → `enrich.mjs` | Push the enriched / reconciled commit to the PR branch and post the PR comment |
| `ANTHROPIC_API_KEY` | **GitHub** → Actions secrets | `enrich.mjs` | Call Claude to enrich book submissions ("Why it's here" / "The caveat") and reconcile the queue on rating submissions |

> **Important:** the **same `GH_PAT` is stored in two independent places** (Vercel *and* GitHub Actions). Rotating it means updating **both** — miss one and half the system stays broken.

The PAT is a **fine-grained** token scoped to `teddyballgm/TBR` with:
- **Contents:** Read and write
- **Pull requests:** Read and write

---

## Runbook: rotate the `GH_PAT` (expired or compromised)

This is the most common maintenance task. GitHub emails you before a fine-grained PAT expires.

1. **Create the new token**
   - GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → *Generate new token*.
   - **Resource owner:** the account that owns `teddyballgm/TBR`.
   - **Repository access:** Only select repositories → `teddyballgm/TBR`.
   - **Permissions:** Contents = *Read and write*, Pull requests = *Read and write*.
   - Set an expiry (e.g. 90 days) and copy the token value.

2. **Update Vercel** (fixes the submission form)
   - Vercel → the TBR project → Settings → Environment Variables → edit `GH_PAT` → paste the new value → Save.
   - Redeploy: Deployments → latest → **Redeploy** (env changes only take effect on a new deployment).

3. **Update GitHub Actions** (fixes enrichment)
   - GitHub → repo Settings → Secrets and variables → **Actions** → update `GH_PAT` with the new value.

4. **Verify** (see the checklist below).

5. **Revoke the old token** in GitHub Developer settings once the new one is confirmed working.

---

## What breaks when the `GH_PAT` expires

| Path | Symptom | Where |
|---|---|---|
| Submission form | Form shows *"GitHub authentication failed — the access token is likely expired."* | `api/submit.js` now detects the 401 and returns this message (HTTP 502) |
| Enrichment Action | Action run fails; PR gets a **"⚠️ Automatic enrichment failed"** comment | `enrich.mjs` posts a failure comment before exiting non-zero |

If the PAT dies, the enrichment failure-comment step may *also* fail to post (it needs the same token). In that case you'll only see the red ✗ in the **Actions** tab — that alone is a strong signal the PAT expired.

---

## Troubleshooting matrix

| Symptom | Likely cause | Fix |
|---|---|---|
| Form: "GitHub authentication failed… token is likely expired" | `GH_PAT` expired/revoked in Vercel | Rotate the PAT (both places) |
| Form: "GH_PAT not configured" | Env var missing in Vercel | Add `GH_PAT` in Vercel, redeploy |
| Form: "A title is required." / "Score must be…" | Invalid submission input | Expected — user needs to fix the form fields |
| Action ✗ with a "⚠️ Automatic enrichment failed" comment | Read the error in the comment / Actions logs | Usually expired `ANTHROPIC_API_KEY` or `GH_PAT`, or malformed Claude output |
| Action ✗ with **no** comment | The PAT itself is dead (comment couldn't post) | Rotate the PAT (both places), then re-run the workflow |
| Enrichment: "Placeholder not found… stub may already be enriched" | The `[To be filled during triage]` stub was edited/removed before the Action ran | Re-add the stub, or triage the entry manually |
| Enrichment: "Claude did not return valid JSON" | Model returned prose/fenced output | Re-run the workflow; if persistent, check the prompt / model in `enrich.mjs` |
| Site shows stale data after a merge | Vercel deploy lag or cache | Wait ~10s; check Vercel Deployments for a successful build on `main` |
| Site fails to load any books | GitHub API read blip, or `tbr.md`/`ratings.md` markdown broke the parser | Check the raw markdown formatting against the schemas in `development.md` |

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
