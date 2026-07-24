# CONSTITUTION.md
*Book Management System — teddyballgm/TBR*

---

## Purpose

This repo is a personal reading record and curation system. It is not Goodreads. It is not comprehensive. It is an opinionated, maintained list of what's worth reading and why — judged against a specific taste profile — and a queue of what's next, ranked by confidence of hitting that profile.

The site at tefleming.com surfaces these files. The markdown files are the source of truth. The site is a reader and submission interface, not a database.

---

## Taste Profile

The benchmark everything is measured against: **Dungeon Crawler Carl** (Dinniman).

What makes a 9/10:
- Strong authorial control — the author knows exactly what they're doing and trusts the reader
- Original worldbuilding that doesn't over-explain itself — earned weirdness, not random weirdness
- Dark wit with real teeth — satire that follows its internal logic to coherent extremes
- Real emotional stakes, but not sentimentality
- Protagonist as vehicle rather than the point — distance from the protagonist is fine; trust in the author is essential
- Economy of craft — does what it needs to do without bloat

Secondary reference points: *The Rook* (O'Malley), *Emperor's Soul* (Sanderson), *He Who Fights With Monsters* (Shirtaloon — for progression systems and world density, despite structural bloat).

Known risks: books that are warm/cozy without satirical coherence (*Wizard's Guide to Defensive Baking*), identity-reconstruction mysteries where the payoff undershoots the structure (*Piranesi*), slow/thematic literary fiction that leans on reputation over voice and worldbuilding (*The Left Hand of Darkness* — predicted 8.5, actual 7), protagonist-forward narratives that require you to love the main character.

---

## Rating Scale

Ratings are on a **1–10 scale in 0.5 increments**.

| Range | Meaning |
|-------|---------|
| 9–10 | Benchmark tier. Strong authorial control, original worldbuilding, dark wit, real stakes. |
| 7–8 | Good to great. Real value, worth recommending with caveats. May have structural issues or uneven distribution of quality. |
| 6–6.5 | Appreciated more than enjoyed, or enjoyable but not the thing being chased. |
| 4–5 | Finished but no interest in continuing. Genre without craft. |
| DNF | Did not finish. May or may not carry a rating. |

The sectioning of `ratings.md` by tier range may evolve as the list grows. The scale and increment are fixed.

One constraint on that evolution: section headings are **machine-parsed**. `api/submit.js` (`parseSectionRange`) files each new rating into the section whose range contains its score, and it only recognizes two heading shapes — `X-Y` (plain ASCII hyphen) and `X and below`. Headings it can't parse are skipped, and if *no* section parses, every new rating is inserted above the first section instead. Retitling `9-10` to `9–10` (en dash) would silently misfile every subsequent submission. Rename sections freely; keep the shape.

---

## ratings.md — Format

```markdown
# Book Ratings

[Preamble — taste criteria, what makes a 9/10. Update as profile sharpens.]

---

## [Score-range heading — currently "9-10", "7-8.5", "6-6.5", "5 and below"]

### [Title] — [Author] · [Score]/10 *(optional: format note, e.g. "listened on Audible")*

[Prose notes. Free-form. Focus on: what worked, what didn't, how it maps to the taste profile, any meaningful comparisons to other rated books.]

---

## Did Not Finish

### [Title] — [Author] · [Score]/10 *(or just "· DNF" — a DNF may carry no score)*

[Prose notes.]

---

Last updated: [Month Year]
```

Rules:
- Every rated book gets prose notes, however brief. A score without context is useless.
- The `Did Not Finish` section is exempt from score filing — `api/submit.js` skips it when placing a submission, so DNFs are moved there by hand.
- Notes should be honest about *why* something landed where it did relative to the profile — not just whether it was good.
- Comparisons to other rated books are encouraged. The list is more useful as a calibrated system than as isolated reviews.
- Format note (Audible, Kindle, etc.) is optional but useful.

---

## tbr.md — Format

```markdown
# TBR — Reading Queue

[Preamble — ranking criteria]

[Kindle pricing note and eReaderIQ reference]

---

## Tier 1 — Highest Confidence
## Tier 2 — Strong Recommendation
## Tier 3 — Worth Trying
## Tier 4 — Owned Backlog ([provenance])

### [Title] — [Author] *(optional: rec from [Source])*

**Kindle:** [eReaderIQ link] | Price: [current price] ~~[original]~~ 🔔 *alert set @ [threshold]*
**Library:** [Check Fulton County OverDrive](https://fulcolibrary.overdrive.com/search?query=[Title+Author])

**Predicted rating:** [single value, 0.5 increments — e.g. 8.5/10]

**Why it's here:** [Voice/tone/structure match to taste profile. Be specific — reference DCC or other rated books where relevant.]

**The caveat:** [Honest risk factors. What might cause this to underperform the prediction.]

---

## Already Read / Removed from Queue

- [Title] — [Author]. Read ([format]). Predicted [X] → actual [Y]. [One line on how it landed.]

---

## Adding a New TBR Book (Checklist)

[Authoring checklist. Not a book section — parsers and the enrichment Action skip it.]
```

**Owned entries drop the acquisition lines.** A book you already have carries `**Status:** [Owned/Purchased, with provenance]` *instead of* the `**Kindle:**` and `**Library:**` lines — there's no price to track and no reason to borrow it. The two shapes are mutually exclusive: as of this writing all 46 queue entries carry exactly one of `**Library:**` (25, unowned) or `**Status:**` (21, owned). The site keys off this — `**Status:**` suppresses price tracking in the UI and turns on the Rate button.

Rules:
- **Required fields:** Title, Author, "Predicted rating," "Why it's here," "The caveat"
- **Optional fields:** Rec source; and exactly one acquisition shape — either `**Kindle:**` + `**Library:**` (unowned) or `**Status:**` (owned)
- The title line must use a spaced em dash: `### Title — Author`. The site's parser splits on that exact ` — ` and **silently drops** any entry it can't split — no error on the page, the book simply isn't there. A hyphen or an unspaced dash loses the book.
- `**Status:**` must contain the literal word "purchased" (any casing) — that's what the site tests to suppress price tracking and show the Rate button. `**Status:** Owned` alone renders as an unowned entry with no prices.
- Kindle pricing tracked via [eReaderIQ](https://www.ereaderiq.com). Default alert is $0.01 below current price; on a book you're in no hurry for, setting the alert at the price you'd actually pay is fine and several entries do. Use ~~strikethrough~~ for original price when discounted.
- Library links point at [Fulton County OverDrive](https://fulcolibrary.overdrive.com) and are **search** links, not confirmed availability — the catalog needs a signed-in session to report live status. The enrichment Action adds one to every book it triages.
- Tiers 1–3 reflect confidence of hitting 9/10 based on the taste profile. They are a ranking tool, not a quality judgment — a Tier 3 book may be excellent, just less certain to match the specific profile. Predicted rating is a separate axis (expected score, not confidence); the two usually move together, but if a book's own rationale argues for higher confidence than its tier implies, move it up or rewrite the rationale — don't leave the contradiction standing.
- **Tier 4 is provenance, not confidence.** It holds backlogs acquired in bulk (e.g. a Humble Bundle) rather than individually triaged picks, so its entries aren't ranked against Tiers 1–3. It is owner-assigned only: the enrichment Action clamps its own tier suggestions to 1–3 and can never file a submission into Tier 4. Tier 4 otherwise behaves like any tier — same entry schema, and it participates in rating reconciliation.
- **Series entry points.** When a queue entry is book 1 of a series, say so in the caveat as `**Series entry point — start here.**` and name the reading order. Sequels of an unread series don't get their own entries; they're consequences of book 1, not queue decisions.
- When a book is read, move it to "Already Read / Removed from Queue" and close the calibration loop: record `Predicted X → actual Y` (or an explicit "No prediction recorded" if it entered the queue without one), not just the raw score. The enrichment Action does this automatically when a rating reconciles a live queue entry. Do not delete the entry.
- On any miss of ≥ 1.5 between predicted and actual, add the lesson to Known risks above so the predictor (which reads this file on every enrichment call) stops repeating it.

---

## This File Is Also the Prompt

`.github/scripts/enrich.mjs` reads this file off disk and injects it, whole and verbatim, into every Claude enrichment call. Keeping it accurate is therefore a functional requirement, not documentation hygiene: a stale sentence here is a stale instruction to the automated predictor, and it will act on it. When the system's behavior changes, this file changes in the same commit.

Two consequences worth stating plainly:

- **Describe the system as it is, not as it was.** Every claim here about how reads work, which tiers exist, or which fields an entry carries is something the predictor treats as true.
- **Lessons belong in Known risks.** That section is the only place a calibration miss durably changes future predictions. A post-mortem written only into `ratings.md` teaches the reader; one written into Known risks teaches the pipeline.

**Machine-checked subset:** `.github/scripts/lint-schema.mjs` runs on every PR and enforces the parts of the schemas above that are mechanically checkable — allowed `##` headings, presence of the three required entry fields, predicted-rating format, ratings.md heading shape, and stray triage placeholders. It is narrower than this document: it checks the ` — ` separator on `ratings.md` headings but **not** on `tbr.md` ones, so a queue entry can pass lint and still be dropped silently by the site. Green CI means "no known schema violation," not "the site will render it."

---

## PR Triage — Submission Workflow

New book submissions arrive via the site form as GitHub PRs. The PR adds a stub entry to `tbr.md`.

**Stub format (what the site generates):**
```markdown
### [Title] — [Author] *(rec from [Source] if provided)*

**Kindle:** [eReaderIQ search link — auto-generated from title/author]

**Why it's here:** [To be filled during triage]

**The caveat:** [To be filled during triage]
```

**Triage process (automated, GitHub Action):**
1. Submission arrives as a PR, which opens/updates a stub entry in `tbr.md`
2. `.github/workflows/enrich-submission.yml` fires on PR open and runs `.github/scripts/enrich.mjs`
3. The Action calls Claude to produce: predicted rating, "Why it's here" (voice/tone/structure match), "The caveat" (honest risk factors), suggested tier placement (1–3), and the canonical title/author casing — then deterministically rewrites `tbr.md`, adds the Library search link, moves the stub into the chosen tier, and comments on the PR with the result
4. Owner reviews the enrichment, edits as needed, and merges or closes

The same Action handles the other submission type. A `rating/*` PR adds an entry to `ratings.md`; the Action then reads the live queue, decides whether the rated book is still sitting in it (matching on the underlying work — author-name variants, series suffixes, punctuation — not exact strings), and if so moves that entry into "Already Read / Removed from Queue" with `Predicted X → actual Y`. If the book was never queued, `tbr.md` is left untouched and the PR comment says so.

The division of labor is deliberate and worth preserving: **Claude supplies judgment, code performs every file mutation.** The model returns JSON — a tier, a prediction, a match — and never edits markdown directly. When a claimed match doesn't resolve to a real heading, the Action fails loudly rather than guessing.

Claude should assess submissions against the taste profile defined above — not against general literary quality. A well-reviewed book that doesn't fit the profile should be triaged into a low tier or flagged, not promoted because of external reputation.

---

## Site — tefleming.com

The site is a read-mostly interface with a submission form. It has two tabs:

- **TBR** — renders `tbr.md` as a browsable, tiered list. Submission form at the bottom opens a PR.
- **Ratings** — renders `ratings.md` as a browsable list, sorted by score descending.

The site reads `tbr.md` and `ratings.md` as **same-origin static files** — Vercel serves them alongside `index.html`, and the browser parses the markdown client-side. There is no server involved in a read and no GitHub API call. The markdown files are the source of truth; the site reflects them, it does not replace them.

Authentication: reads need none (the files are public static assets). Submissions go through `api/submit.js`, a server-side endpoint holding a repo-scoped PAT (contents read, pull requests write) — the site never asks the visitor for a token.

---

## Future / Parking Lot

- Audible pricing alongside Kindle pricing
- Whispersync delta (cost to add audio when you own the Kindle version)
- Filter/sort on the Ratings tab (by score, by genre, by year read)

---

*Last updated: July 2026 (schema/site sections reconciled against the code — Tier 4, `**Library:**`, same-origin reads).*
