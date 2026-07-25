#!/usr/bin/env node
/**
 * Schema lint for tbr.md and ratings.md. No dependencies — pure string/regex
 * checks against the schemas documented in development.md. Exits non-zero
 * with readable messages on any violation; exits 0 (silently, beyond a
 * summary line) when everything matches.
 *
 * Run locally: node .github/scripts/lint-schema.mjs
 * Run in CI: .github/workflows/lint-schema.yml, on every pull_request.
 */

import fs from 'fs';

const PLACEHOLDER = '[To be filled during triage]';

const TBR_PATH      = 'tbr.md';
const RATINGS_PATH  = 'ratings.md';

const ALLOWED_TBR_TIER_RE   = /^Tier [1-4]\b/;
const ALREADY_READ_HEADING  = 'Already Read / Removed from Queue';
const CHECKLIST_HEADING     = 'Adding a New TBR Book (Checklist)';

// Predicted rating: a single value X or X.5 (1–10), or a range of two such
// values (e.g. "6.5-7.5"). Ranges are legitimate — enrich.mjs's own Claude
// prompt documents "8-9" as valid predicted_rating output — so the lint
// allows them too, rather than rejecting data the rest of the system
// already treats as correct. Both a plain hyphen and an en dash are
// accepted as the range separator since existing tbr.md entries use either.
// "X.0" is accepted as equivalent to plain "X".
const PREDICTED_RATING_SINGLE = String.raw`(?:10|[1-9])(?:\.(?:5|0))?`;
const PREDICTED_RATING_RE = new RegExp(
  `^${PREDICTED_RATING_SINGLE}(?:[-–]${PREDICTED_RATING_SINGLE})?$`,
);

// ratings.md heading score portion: X, X.5, or a range like X-Y / X.5-Y.
const SCORE_RE = /[\d.]+(?:-[\d.]+)?/;

// The title line separator, and the rec-source suffix that may follow the
// author. Both mirror index.html's parseBook, which strips the suffix before
// looking for the separator — the lint has to strip it in the same order or a
// heading like "Title — Author *(rec from X)*" would be judged against the
// wrong string.
const TITLE_SEPARATOR = ' — '; // spaced em dash (U+2014)
const REC_SUFFIX_RE   = /\s*\*\(rec from [^)]+\)\*/;

// Acquisition-line markers, anchored to the start of a line so that prose
// mentioning a field name (a caveat that quotes `**Status:**`, say) can't be
// mistaken for the field itself.
const STATUS_LINE_RE  = /^\*\*Status:\*\*/m;
const KINDLE_LINE_RE  = /^\*\*Kindle:\*\*/m;
const LIBRARY_LINE_RE = /^\*\*Library:\*\*/m;

// The site tests the whole Status line for this word, case-insensitively.
const STATUS_PURCHASED_RE = /^\*\*Status:\*\*[^\n]*purchased/im;

// ── Helpers ──────────────────────────────────────────────────────────────

function lineNumberAt(content, index) {
  return content.slice(0, index).split('\n').length;
}

// Splits `content` into sections at lines starting with the given marker
// ("##" or "###"), returning heading text, absolute start index of the
// heading line, absolute start index of the body, and the body text.
function splitSections(content, marker) {
  const re = new RegExp(`^${marker} (.*)$`, 'gm');
  const matches = [...content.matchAll(re)];
  return matches.map((m, i) => {
    const bodyStart = m.index + m[0].length;
    const bodyEnd   = i + 1 < matches.length ? matches[i + 1].index : content.length;
    return {
      heading:   m[1].trim(),
      start:     m.index,
      body:      content.slice(bodyStart, bodyEnd),
      bodyStart,
    };
  });
}

// ── tbr.md ───────────────────────────────────────────────────────────────

// The site's parseBook splits "Title — Author" on the first " — " and returns
// null when there isn't one; parseTierBooks then skips the null. The entry
// disappears from the page with no error, no console warning, and no failed
// build — the only symptom is a book that isn't there. Nothing else in the
// pipeline looks at the heading's shape, so this check is the whole safety net.
function checkTitleSeparator(title, entryLine, errors) {
  const headingBody = title.replace(REC_SUFFIX_RE, '').trim();
  if (headingBody.includes(TITLE_SEPARATOR)) return;

  // Name the near-miss when there is one — a hyphen or an unspaced dash is the
  // realistic mistake, and "add spaces around the em dash" is more useful than
  // restating the format.
  const nearMiss = headingBody.match(/\s*[-–—]\s*/);
  const hint = nearMiss
    ? ` — found "${nearMiss[0]}", which the parser doesn't split on`
    : '';

  errors.push(
    `tbr.md:${entryLine}: "### ${title}" has no "${TITLE_SEPARATOR}" separator${hint}. ` +
    `The title line must be "### Title — Author" with a spaced em dash; the site drops ` +
    `entries it can't split, silently, so this book would simply not appear.`,
  );
}

// Every queue entry carries exactly one acquisition shape: `**Kindle:**` plus
// `**Library:**` (unowned), or `**Status:**` (owned). See CONSTITUTION.md,
// "Owned entries drop the acquisition lines."
function checkAcquisitionShape(title, full, entryLine, errors) {
  const hasStatus  = STATUS_LINE_RE.test(full);
  const hasKindle  = KINDLE_LINE_RE.test(full);
  const hasLibrary = LIBRARY_LINE_RE.test(full);

  if (hasStatus && (hasKindle || hasLibrary)) {
    const also = [hasKindle && '**Kindle:**', hasLibrary && '**Library:**']
      .filter(Boolean).join(' and ');
    // Both shapes at once is what happens when a book is bought after it was
    // queued and the now-dead price line is never removed. renderTBRBook
    // branches on ownership and never renders the price for an owned book, so
    // nothing on the site reveals it — the stale price just sits in the file,
    // where it reads as a deliberate alert threshold.
    errors.push(
      `tbr.md:${entryLine}: "### ${title}" carries **Status:** and ${also} — an owned entry ` +
      `drops the acquisition lines. The site never renders them for an owned book, so a ` +
      `leftover price is invisible on the page and survives in the file as a stale alert threshold.`,
    );
    return;
  }

  if (hasStatus) {
    if (!STATUS_PURCHASED_RE.test(full)) {
      errors.push(
        `tbr.md:${entryLine}: "### ${title}" has a **Status:** line that doesn't contain the word ` +
        `"purchased" — the site tests for it literally, so the entry renders as unowned, with no ` +
        `prices and no Rate button.`,
      );
    }
    return;
  }

  if (!hasKindle && !hasLibrary) {
    errors.push(
      `tbr.md:${entryLine}: "### ${title}" carries neither **Status:** (owned) nor ` +
      `**Kindle:** + **Library:** (unowned) — every entry needs exactly one of the two shapes`,
    );
    return;
  }

  const missing = [!hasKindle && '**Kindle:**', !hasLibrary && '**Library:**'].filter(Boolean);
  if (missing.length > 0) {
    errors.push(
      `tbr.md:${entryLine}: "### ${title}" is unowned but missing ${missing.join(', ')} — ` +
      `the unowned shape is both lines together (the enrichment Action writes both)`,
    );
  }
}

function lintTBR(content, errors) {
  const sections = splitSections(content, '##');

  for (const section of sections) {
    const { heading, start } = section;
    const isTier = ALLOWED_TBR_TIER_RE.test(heading);
    const isAllowed = isTier || heading === ALREADY_READ_HEADING || heading === CHECKLIST_HEADING;

    if (!isAllowed) {
      errors.push(
        `tbr.md:${lineNumberAt(content, start)}: unexpected heading "## ${heading}" ` +
        `(only "Tier 1"–"Tier 4", "${ALREADY_READ_HEADING}", or "${CHECKLIST_HEADING}" are allowed)`,
      );
      continue;
    }

    if (!isTier) continue; // entry-level checks only apply within Tier sections

    const entries = splitSections(section.body, '###');
    for (const entry of entries) {
      const entryAbsIndex = section.bodyStart + entry.start;
      const entryLine = lineNumberAt(content, entryAbsIndex);
      const title = entry.heading;
      const full  = entry.body;

      // Checked before the stub bail-out below: a heading's shape doesn't
      // depend on whether the entry has been enriched yet, and a submission
      // that arrives with a broken separator should fail on the submission PR
      // rather than after the enrichment fills in the rest.
      checkTitleSeparator(title, entryLine, errors);

      if (full.includes(PLACEHOLDER)) continue; // valid pre-enrichment stub

      checkAcquisitionShape(title, full, entryLine, errors);

      const missing = [];
      if (!full.includes('**Predicted rating:**')) missing.push('**Predicted rating:**');
      if (!full.includes(`**Why it's here:**`))     missing.push(`**Why it's here:**`);
      if (!full.includes('**The caveat:**'))        missing.push('**The caveat:**');

      if (missing.length > 0) {
        errors.push(
          `tbr.md:${entryLine}: "### ${title}" is missing ${missing.join(', ')}`,
        );
      }

      const ratingMatch = full.match(/\*\*Predicted rating:\*\*[ \t]*([^\n]*)/);
      if (ratingMatch) {
        const raw   = ratingMatch[1].trim();
        const value = raw.replace(/\/10\s*$/, '').trim();
        if (!PREDICTED_RATING_RE.test(value)) {
          errors.push(
            `tbr.md:${entryLine}: "### ${title}" predicted rating "${raw}" doesn't match ` +
            `X or X.5 in 1–10, or a range of two such values (e.g. "8.5" or "8-9")`,
          );
        }
      }
    }
  }
}

// ── ratings.md ───────────────────────────────────────────────────────────

function lintRatings(content, errors) {
  const sections = splitSections(content, '##');

  for (const section of sections) {
    const isDNF = /not finish/i.test(section.heading);
    const entries = splitSections(section.body, '###');

    for (const entry of entries) {
      const entryAbsIndex = section.bodyStart + entry.start;
      const entryLine = lineNumberAt(content, entryAbsIndex);
      const headingLine = entry.heading;

      const pattern = isDNF
        ? new RegExp(`^.+ — .+ · (?:DNF\\b|${SCORE_RE.source}\\/10\\b)`)
        : new RegExp(`^.+ — .+ · ${SCORE_RE.source}\\/10\\b`);

      if (!pattern.test(headingLine)) {
        errors.push(
          isDNF
            ? `ratings.md:${entryLine}: "### ${headingLine}" doesn't match "### Title — Author · <score>/10" or "### Title — Author · DNF"`
            : `ratings.md:${entryLine}: "### ${headingLine}" doesn't match "### Title — Author · <score>/10"`,
        );
      }
    }
  }
}

// ── Cross-file: stray triage placeholder ──────────────────────────────────

function lintStrayPlaceholder(tbrContent, ratingsContent, errors, notes) {
  const baseRef = process.env.GITHUB_BASE_REF;
  const headRef = process.env.GITHUB_HEAD_REF;

  if (!baseRef || !headRef) {
    notes.push('(skipped stray-placeholder check — no PR context: GITHUB_BASE_REF/GITHUB_HEAD_REF not set)');
    return;
  }
  if (baseRef !== 'main') return;       // only main-targeting PRs
  if (headRef.startsWith('submit/')) return; // submission PRs legitimately carry the stub

  if (tbrContent.includes(PLACEHOLDER)) {
    errors.push(
      `tbr.md: stray "${PLACEHOLDER}" placeholder — branch "${headRef}" doesn't start with ` +
      `"submit/", so this looks like an unfinished manual edit rather than a submission stub`,
    );
  }
  if (ratingsContent.includes(PLACEHOLDER)) {
    errors.push(
      `ratings.md: stray "${PLACEHOLDER}" placeholder — branch "${headRef}" doesn't start with ` +
      `"submit/", so this looks like an unfinished manual edit rather than a submission stub`,
    );
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const tbrContent     = fs.readFileSync(TBR_PATH, 'utf8');
  const ratingsContent = fs.readFileSync(RATINGS_PATH, 'utf8');

  const errors = [];
  const notes  = [];

  lintTBR(tbrContent, errors);
  lintRatings(ratingsContent, errors);
  lintStrayPlaceholder(tbrContent, ratingsContent, errors, notes);

  for (const note of notes) console.log(note);

  if (errors.length > 0) {
    console.error(`Schema lint failed with ${errors.length} violation(s):\n`);
    for (const err of errors) console.error(`  - ${err}`);
    process.exit(1);
  }

  console.log('Schema lint passed.');
}

main();
