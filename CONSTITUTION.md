# CONSTITUTION.md
*Book Management System — teddyballgm/TBR*

---

## Purpose

This repo is a personal reading record and curation system. It is not Goodreads. It is not comprehensive. It is a opinionated, maintained list of what's worth reading and why — judged against a specific taste profile — and a queue of what's next, ranked by confidence of hitting that profile.

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

Known risks: books that are warm/cozy without satirical coherence (*Wizard's Guide to Defensive Baking*), identity-reconstruction mysteries where the payoff undershoots the structure (*Piranesi*), protagonist-forward narratives that require you to love the main character.

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

---

## ratings.md — Format

```markdown
# Book Ratings

[Preamble — taste criteria, what makes a 9/10. Update as profile sharpens.]

---

## [Tier heading — e.g. "9-10", "7-8", "6-6.5"]

### [Title] — [Author] · [Score]/10 *(optional: format note, e.g. "listened on Audible")*

[Prose notes. Free-form. Focus on: what worked, what didn't, how it maps to the taste profile, any meaningful comparisons to other rated books.]

---

Last updated: [Month Year]
```

Rules:
- Every rated book gets prose notes, however brief. A score without context is useless.
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

### [Title] — [Author] *(optional: rec from [Source])*

**Kindle:** [eReaderIQ link] | Price: [current price] ~~[original]~~ 🔔 *alert set @ [threshold]*

**Why it's here:** [Voice/tone/structure match to taste profile. Be specific — reference DCC or other rated books where relevant.]

**The caveat:** [Honest risk factors. What might cause this to underperform the prediction.]

---

## Already Read / Removed from Queue

- [Title] — [Outcome: Read/Abandoned]. [Score if rated]. [One line on why it's off the queue.]
```

Rules:
- **Required fields:** Title, Author, "Why it's here," "The caveat"
- **Optional fields:** Rec source, Kindle pricing, eReaderIQ alert
- Kindle pricing tracked via [eReaderIQ](https://www.ereaderiq.com). Set alert at $0.01 below current price. Use ~~strikethrough~~ for original price when discounted.
- Tiers (1/2/3) reflect confidence of hitting 9/10 based on the taste profile. They are a ranking tool, not a quality judgment — a Tier 3 book may be excellent, just less certain to match the specific profile.
- When a book is read, move it to "Already Read / Removed from Queue" with outcome and score. Do not delete it.

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

**Triage process (manual, Claude-assisted):**
1. Submission arrives as a PR
2. Owner invokes Claude to review the submission
3. Claude enriches the PR with: predicted rating, "Why it's here" (voice/tone/structure match), "The caveat" (honest risk factors), suggested tier placement
4. Owner reviews Claude's enrichment, edits as needed, and merges or closes

Claude should assess submissions against the taste profile defined above — not against general literary quality. A well-reviewed book that doesn't fit the profile should be tiaged into a low tier or flagged, not promoted because of external reputation.

---

## Site — tefleming.com

The site is a read-mostly interface with a submission form. It has two tabs:

- **TBR** — renders `tbr.md` as a browsable, tiered list. Submission form at the bottom opens a PR.
- **Ratings** — renders `ratings.md` as a browsable list, sorted by score descending.

The site reads directly from this repo via the GitHub API. The markdown files are the source of truth — the site reflects them, it does not replace them.

Authentication: PAT-based, entered at load time. The PAT is scoped to this repo only (contents read, pull requests write).

---

## Future / Parking Lot

- Audible pricing alongside Kindle pricing
- Whispersync delta (cost to add audio when you own the Kindle version)
- Automated Claude enrichment on PR open (GitHub Action) rather than manually invoked
- Filter/sort on the Ratings tab (by score, by genre, by year read)

---

*Last updated: April 2026*
