#!/usr/bin/env node
/**
 * Called by the enrich-submission workflow. Handles two kinds of submission,
 * dispatched on the PR branch name:
 *
 *   submit/*  — a new TBR book. Reads the stub from the PR diff, asks Claude
 *               to fill in tier / why / caveat, rewrites tbr.md, comments.
 *
 *   rating/*  — a new rating. Reads the rating from the ratings.md diff, asks
 *               Claude to *examine the live queue* and identify whether the
 *               rated book is still sitting in it (matching on the work, not
 *               exact strings — author-name variants, series suffixes, etc.).
 *               If so, it moves that entry into "Already Read / Removed from
 *               Queue" with the real score, rewrites tbr.md, and comments.
 *               Otherwise it leaves tbr.md untouched and says so.
 */

import https from 'https';
import fs   from 'fs';
import { execSync } from 'child_process';

const {
  ANTHROPIC_API_KEY,
  GH_PAT,
  GITHUB_REPOSITORY,
  PR_NUMBER,
  PR_HEAD_REF,
} = process.env;

// Model and API version are overridable via env so they can be bumped without
// a code change. Defaults preserve the previous hardcoded behavior.
const ANTHROPIC_MODEL   = process.env.ANTHROPIC_MODEL   || 'claude-opus-4-7';
const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION || '2023-06-01';

// ── Utilities ─────────────────────────────────────────────────────────────────

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function apiPost(hostname, path, extraHeaders, body) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': buf.length,
        ...extraHeaders,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch   { resolve({ status: res.statusCode, body: text }); }
      });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

// ── 1. Parse stub from diff ───────────────────────────────────────────────────

function parseStub() {
  const diff = run('git diff origin/main...HEAD -- tbr.md');
  const added = diff.split('\n')
    .filter(l => l.startsWith('+') && !l.startsWith('+++'))
    .map(l => l.slice(1))
    .join('\n');

  // Matches: ### Title — Author *(rec from Source)*
  const m = added.match(/^### (.+?) — (.+?)(?:\s+\*\(rec from ([^)]+)\)\*)?$/m);
  if (!m) throw new Error('Could not find stub ### heading in diff');

  return {
    title:     m[1].trim(),
    author:    m[2].replace(/\s*\*\(rec from [^)]+\)\*/, '').trim(),
    recSource: m[3]?.trim() ?? null,
  };
}

// ── 2. Call Claude ────────────────────────────────────────────────────────────

async function callClaude(title, author, recSource) {
  const constitution = fs.readFileSync('CONSTITUTION.md', 'utf8');
  const recNote = recSource ? `\nRecommended by: ${recSource}` : '';

  const userPrompt = `You are triaging a book submission for a personal reading queue.

<constitution>
${constitution}
</constitution>

New submission:
Title: ${title}
Author: ${author}${recNote}

Assess this book strictly against the taste profile above — not against general literary reputation.
Respond with ONLY a JSON object (no markdown fences, no surrounding text):

{"title":"Dark Matter","author":"Blake Crouch","tier":2,"predicted_rating":"7.5","why":"...","caveat":"..."}

Field rules:
- title: the book's canonical published title, correctly capitalized (the submitter's casing may be wrong — e.g. "dark matter" → "Dark Matter"). Do not add a subtitle or series suffix that isn't part of the book's main title.
- author: the author's canonical name, correctly spelled and capitalized (e.g. "ursula leguin" → "Ursula K. Le Guin"). If genuinely unsure of the exact canonical form, return the submitter's value unchanged rather than guessing a different person.
- tier: 1, 2, or 3 (1 = highest confidence of hitting a 9/10 against the profile)
- predicted_rating: a string like "7", "7.5", or "8-9"
- why: 2–4 sentences. Explain the voice/tone/structure match to the taste profile. Reference Dungeon Crawler Carl or other rated books where relevant. Write in the spare, direct register of the existing tbr.md entries — no hype.
- caveat: 1–3 sentences. Honest risk factors only. What specifically might cause this to underperform the prediction against this profile.`;

  const res = await apiPost('api.anthropic.com', '/v1/messages', {
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': ANTHROPIC_VERSION,
  }, {
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: userPrompt }],
  });

  if (res.status !== 200) {
    throw new Error(`Anthropic API ${res.status}: ${JSON.stringify(res.body)}`);
  }

  let text = res.body.content[0].text.trim();
  // Strip accidental markdown fences just in case
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Claude did not return valid JSON. Raw response: ${text.slice(0, 500)}`);
  }

  // Validate the fields we depend on before rewriting tbr.md.
  const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
  if (!nonEmpty(parsed.why) || !nonEmpty(parsed.caveat)) {
    throw new Error(`Claude response missing "why"/"caveat". Got: ${JSON.stringify(parsed)}`);
  }
  if (parsed.predicted_rating == null || parsed.predicted_rating === '') {
    throw new Error(`Claude response missing "predicted_rating". Got: ${JSON.stringify(parsed)}`);
  }

  // Clamp tier to valid range
  parsed.tier = Math.min(3, Math.max(1, Number(parsed.tier) || 2));
  return parsed;
}

// ── 3. Rewrite tbr.md ────────────────────────────────────────────────────────

// Every entry enriched here also gets a Fulton County OverDrive search link (see below).
function enrichTBR(title, author, recSource, enriched) {
  let md = fs.readFileSync('tbr.md', 'utf8');

  // Find the stub via its placeholder text, then walk back to the ### heading.
  const placeholder = '[To be filled during triage]';
  const pIdx = md.indexOf(placeholder);
  if (pIdx === -1) throw new Error('Placeholder not found in tbr.md — stub may already be enriched');

  const stubHeadingPos = md.lastIndexOf('\n### ', pIdx);
  if (stubHeadingPos === -1) throw new Error('Could not find stub ### heading in tbr.md');

  const arIdx = md.indexOf('\n## Already Read');
  if (arIdx === -1) throw new Error('"Already Read" section not found in tbr.md');

  // Extract the Kindle link from the stub so we can carry it over.
  const stubBlock   = md.slice(stubHeadingPos, arIdx);
  const kindleMatch = stubBlock.match(/\*\*Kindle:\*\* .+/);
  const kindleLine  = kindleMatch ? kindleMatch[0] : null;

  // Every entry reaching this point is unowned by construction (see header
  // comment on this function's caller). Fulton County's OverDrive catalog
  // requires a signed-in session for live availability, so this is a search
  // link, not a confirmed-available link.
  const libraryUrl  = `https://fulcolibrary.overdrive.com/search?query=${encodeURIComponent(`${title} ${author}`)}`;
  const libraryLine = `**Library:** [Check Fulton County OverDrive](${libraryUrl})`;

  // Build the enriched entry.
  const recSuffix = recSource ? ` *(rec from ${recSource})*` : '';
  const lines = [`### ${title} — ${author}${recSuffix}`];
  if (kindleLine) lines.push('', kindleLine);
  lines.push('', libraryLine);
  lines.push(
    '',
    `**Predicted rating:** ${enriched.predicted_rating}/10`,
    '',
    `**Why it's here:** ${enriched.why}`,
    '',
    `**The caveat:** ${enriched.caveat}`,
  );
  const enrichedEntry = lines.join('\n');

  // Remove the stub from its temporary location (floating before ## Already Read).
  const beforeStub = md.slice(0, stubHeadingPos);
  const afterStub  = md.slice(arIdx);
  const mdNoStub   = beforeStub + afterStub;

  // Insert at the end of the target tier section, just before the -----\n\n##
  // separator that closes it.
  const tierKey = `## Tier ${enriched.tier}`;
  const tierIdx = mdNoStub.indexOf(tierKey);

  let result;
  if (tierIdx !== -1) {
    const fromTier = mdNoStub.slice(tierIdx);
    // Match the separator + next section heading that closes this tier.
    const sepMatch = fromTier.match(/\n\n-----\n\n## /);
    if (sepMatch) {
      const insertAt = tierIdx + sepMatch.index;
      result =
        mdNoStub.slice(0, insertAt) +
        '\n\n-----\n\n' + enrichedEntry +
        mdNoStub.slice(insertAt);
    } else {
      // Tier is the last section before EOF — append after it.
      result = mdNoStub.trimEnd() + '\n\n-----\n\n' + enrichedEntry + '\n';
    }
  } else {
    // Tier heading not found — fall back to inserting before ## Already Read.
    const ar2 = mdNoStub.indexOf('\n## Already Read');
    result =
      mdNoStub.slice(0, ar2) +
      '\n\n' + enrichedEntry + '\n' +
      mdNoStub.slice(ar2);
  }

  fs.writeFileSync('tbr.md', result, 'utf8');
}

// ── Rating path: parse, examine queue, reconcile ─────────────────────────────

// Pull the rating that api/submit.js just added to ratings.md out of the diff.
function parseRatingStub() {
  const diff = run('git diff origin/main...HEAD -- ratings.md');
  const added = diff.split('\n')
    .filter(l => l.startsWith('+') && !l.startsWith('+++'))
    .map(l => l.slice(1))
    .join('\n');

  // Matches: ### Title — Author · 8.5/10 *(Format)*   (score may be a range like 8-9)
  const m = added.match(
    /^### (.+?) — (.+?) · ([\d.]+(?:-[\d.]+)?)\/10(?:\s+\*\(([^)]+)\)\*)?\s*$/m,
  );
  if (!m) throw new Error('Could not find rating ### heading in ratings.md diff');

  // Notes are whatever the submitter added after the heading line.
  const afterHeading = added.slice(added.indexOf(m[0]) + m[0].length).trim();

  return {
    displayTitle: m[1].trim(),
    author:       m[2].trim(),
    scoreStr:     m[3].trim(),
    format:       m[4]?.trim() ?? null,
    notes:        afterHeading || null,
  };
}

// Ask Claude to examine the live queue and tell us which entry (if any) the
// just-rated book corresponds to. Claude does the fuzzy matching; the actual
// file surgery stays deterministic in code below.
async function callClaudeForReconcile(rating, tbrContent) {
  const { displayTitle, author, scoreStr, format, notes } = rating;

  const userPrompt = `A book was just rated on a personal reading site. Your job is to reconcile the reading queue: figure out whether the rated book is still sitting in the live "to be read" queue, so a stale entry can be moved out of it.

The rating that was just logged:
Title: ${displayTitle}
Author: ${author}
Score: ${scoreStr}/10${format ? `\nFormat: ${format}` : ''}${notes ? `\nNotes: ${notes}` : ''}

Here is the current queue file (tbr.md):

<tbr>
${tbrContent}
</tbr>

The LIVE queue is only the book entries under any "## Tier N" heading (currently Tier 1 through Tier 4). Anything under "## Already Read / Removed from Queue" is already done, and "## Adding a New TBR Book (Checklist)" is not a book. Do not match against those.

Match on the underlying work, not exact string equality: allow for author-name variants (e.g. "Ursula Le Guin" vs "Ursula K. Le Guin"), series or subtitle differences, and punctuation/casing. A rating titled "X (Some Series)" still matches a live entry titled "X".

Respond with ONLY a JSON object (no markdown fences, no surrounding text). Always include canonical_title and canonical_author (the rated book as logged, not the queue entry).

If the rated book IS a live queue entry:
{"canonical_title": "<see rules>", "canonical_author": "<see rules>", "in_queue": true, "match_title": "<title copied verbatim from that ### heading>", "match_author": "<author copied verbatim from that ### heading>", "note": "<optional: one short clause, <=15 words, on how it landed vs. its queue prediction — or empty string>"}

If it is NOT a live queue entry:
{"canonical_title": "<see rules>", "canonical_author": "<see rules>", "in_queue": false}

Rules:
- canonical_title: the rated book's title in canonical published form — fix the submitter's casing/spelling (e.g. "dark matter" → "Dark Matter"). Preserve any parenthetical suffix the submitted title carries (e.g. "X (Some Series)") exactly. If you are genuinely unsure of the exact canonical form, copy the submitted title verbatim rather than guessing.
- canonical_author: the author's canonical name, casing and spelling corrected (e.g. "ursula leguin" → "Ursula K. Le Guin"). If genuinely unsure, copy the submitted author verbatim rather than guessing a different person.
- match_title and match_author must be copied exactly from the matching "### Title — Author" heading, excluding any "*(rec from ...)*" suffix.
- Only set in_queue to true if you are confident it is the same work.`;

  const res = await apiPost('api.anthropic.com', '/v1/messages', {
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': ANTHROPIC_VERSION,
  }, {
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: userPrompt }],
  });

  if (res.status !== 200) {
    throw new Error(`Anthropic API ${res.status}: ${JSON.stringify(res.body)}`);
  }

  let text = res.body.content[0].text.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Claude did not return valid JSON. Raw response: ${text.slice(0, 500)}`);
  }

  const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
  if (parsed.in_queue) {
    if (!nonEmpty(parsed.match_title) || !nonEmpty(parsed.match_author)) {
      throw new Error(`Claude flagged an in-queue match but omitted match_title/match_author. Got: ${JSON.stringify(parsed)}`);
    }
  }
  // canonical_title/author are best-effort; the caller falls back to the
  // submitted values when they're missing, so don't hard-fail on their absence.
  return parsed;
}

// Locate a "### Title — Author" heading by exact (case-insensitive) match,
// ignoring any "*(rec from ...)*" suffix. Returns the 0-based line index or -1.
// Shared by removeFromTBR and extractPredictedRating so they can never disagree
// about which entry a match resolves to.
function findHeadingIndex(lines, title, author) {
  const normalTitle  = title.toLowerCase().trim();
  const normalAuthor = author.toLowerCase().trim();

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('### ')) continue;
    const header = lines[i].slice(4);
    const clean  = header.replace(/\s*\*\(rec from [^)]+\)\*/, '').trim();
    const dash   = clean.indexOf(' — ');
    if (dash === -1) continue;
    const lineTitle  = clean.slice(0, dash).trim().toLowerCase();
    const lineAuthor = clean.slice(dash + 3).trim().toLowerCase();
    if (lineTitle === normalTitle && lineAuthor === normalAuthor) return i;
  }
  return -1;
}

// Pull the predicted-rating value out of a live queue entry so the calibration
// loop can record predicted→actual when the book graduates. Returns the value
// without the trailing "/10" (e.g. "8.5", or a range like "7.5–8"), or null if
// the entry has no such line. Ranges are preserved verbatim — collapsing them
// is a separate (taste) decision, not this function's job.
function extractPredictedRating(tbrContent, title, author) {
  const lines    = tbrContent.split('\n');
  const startIdx = findHeadingIndex(lines, title, author);
  if (startIdx === -1) return null;

  for (let j = startIdx + 1; j < lines.length; j++) {
    // Stop at the next entry/section/separator — stay within this block.
    if (lines[j].startsWith('### ') || lines[j].startsWith('## ') || /^-{3,}/.test(lines[j])) break;
    const m = lines[j].match(/^\*\*Predicted rating:\*\*\s*(.+?)\s*$/);
    if (m) return m[1].replace(/\/10\s*$/, '').trim();
  }
  return null;
}

// Remove a live queue entry by its exact heading title/author. Mirrors the
// matcher api/submit.js used to use, but also consumes the trailing "-----"
// separator so we don't leave a doubled divider behind.
function removeFromTBR(tbrContent, title, author) {
  const lines    = tbrContent.split('\n');
  const startIdx = findHeadingIndex(lines, title, author);

  if (startIdx === -1) return { content: tbrContent, found: false };

  let endIdx = lines.length;
  for (let j = startIdx + 1; j < lines.length; j++) {
    if (lines[j].startsWith('### ') || lines[j].startsWith('## ') || /^-{3,}/.test(lines[j])) {
      endIdx = j;
      break;
    }
  }

  // Some entries (Tier 3, the loose entries after "Already Read") are fenced by
  // a "-----" separator on *both* sides. Removing one would leave two adjacent
  // separators, so in that case consume the trailing one too. But when the
  // entry is the last in its section, that trailing separator is the divider
  // between sections (e.g. Tier 1 → Tier 2) and must be kept — detected by the
  // absence of a leading separator.
  const hasLeadingSep = (() => {
    let k = startIdx - 1;
    while (k >= 0 && lines[k].trim() === '') k--;
    return k >= 0 && /^-{3,}/.test(lines[k]);
  })();
  if (hasLeadingSep && endIdx < lines.length && /^-{3,}/.test(lines[endIdx])) {
    endIdx++;
    while (endIdx < lines.length && lines[endIdx].trim() === '') endIdx++;
  }

  const newLines = [...lines.slice(0, startIdx), ...lines.slice(endIdx)];
  return { content: newLines.join('\n'), found: true };
}

// Compose the "Already Read" outcome clause: "Predicted P → actual Y." when the
// graduating entry carried a prediction, else "Y/10. No prediction recorded."
// This is what closes the calibration loop, so it's deterministic — it does not
// depend on Claude's optional `note`.
function outcomeClause(scoreStr, predicted) {
  return predicted
    ? `Predicted ${predicted} → actual ${scoreStr}.`
    : `${scoreStr}/10. No prediction recorded.`;
}

// Add a "- Title — Author. Read (Format). <outcome>. note" line to the top of
// the "Already Read / Removed from Queue" list, matching the existing format.
function addToAlreadyRead(tbrContent, title, author, scoreStr, format, note, predicted) {
  const formatNote = format ? ` (${format})` : '';
  const extra      = note && note.trim() ? ` ${note.trim()}` : '';
  const entry = `- ${title} — ${author}. Read${formatNote}. ${outcomeClause(scoreStr, predicted)}${extra}`;

  const match = /^## Already Read/m.exec(tbrContent);
  if (!match) return tbrContent;

  let insertAt = tbrContent.indexOf('\n', match.index) + 1;
  while (insertAt < tbrContent.length && tbrContent[insertAt] === '\n') insertAt++;

  return tbrContent.slice(0, insertAt) + entry + '\n' + tbrContent.slice(insertAt);
}

// Rewrite the just-added ratings.md heading with canonical title/author,
// preserving the score and any *(format)* suffix. api/submit.js writes the
// heading verbatim from the submission form, so a mis-cased/misspelled rating
// (e.g. "dark matter — Blake crouch") lands uncorrected; this is the ratings-side
// analogue of the enrichment step that canonicalizes tbr.md submissions. Matches
// the specific entry by submitted title+author+score so a re-rating of a
// same-titled book can't rewrite the wrong heading. Returns {content, changed}.
function canonicalizeRatingHeading(ratingsContent, rating, canonTitle, canonAuthor) {
  const lines = ratingsContent.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(
      /^### (.+?) — (.+?) · ([\d.]+(?:-[\d.]+)?)\/10(\s+\*\([^)]+\)\*)?\s*$/,
    );
    if (!m) continue;
    if (
      m[1].trim() === rating.displayTitle.trim() &&
      m[2].trim() === rating.author.trim() &&
      m[3].trim() === rating.scoreStr.trim()
    ) {
      const formatPart = m[4] || '';
      lines[i] = `### ${canonTitle} — ${canonAuthor} · ${m[3]}/10${formatPart}`;
      return { content: lines.join('\n'), changed: true };
    }
  }
  return { content: ratingsContent, changed: false };
}

// Resolve the canonical title/author for the rating (falling back to the
// submitted values when Claude omits or declines to correct them) and, if they
// differ from what api/submit.js wrote, rewrite ratings.md on disk. Returns the
// title/author to display plus whether the file changed.
function canonicalizeRatings(rating, claude) {
  const canonTitle  = typeof claude.canonical_title  === 'string' && claude.canonical_title.trim()  ? claude.canonical_title.trim()  : rating.displayTitle;
  const canonAuthor = typeof claude.canonical_author === 'string' && claude.canonical_author.trim() ? claude.canonical_author.trim() : rating.author;

  if (canonTitle === rating.displayTitle && canonAuthor === rating.author) {
    return { title: canonTitle, author: canonAuthor, changed: false };
  }

  const ratingsContent = fs.readFileSync('ratings.md', 'utf8');
  const { content, changed } = canonicalizeRatingHeading(ratingsContent, rating, canonTitle, canonAuthor);
  if (changed) {
    fs.writeFileSync('ratings.md', content, 'utf8');
    console.log(`Canonicalized rating heading: "${rating.displayTitle} — ${rating.author}" → "${canonTitle} — ${canonAuthor}"`);
  } else {
    // Claude proposed a correction but the exact submitted heading wasn't found
    // (e.g. it was hand-edited before the Action ran) — don't guess, leave it.
    console.log(`Canonical form differs ("${canonTitle} — ${canonAuthor}") but the submitted heading wasn't found in ratings.md — leaving it untouched.`);
  }
  return { title: canonTitle, author: canonAuthor, changed };
}

// ── 4. Post PR comment ────────────────────────────────────────────────────────

async function postComment(title, author, enriched) {
  const body = [
    `### Claude enrichment — *${title}* by ${author}`,
    '',
    `| | |`,
    `|---|---|`,
    `| **Suggested tier** | Tier ${enriched.tier} |`,
    `| **Predicted rating** | ${enriched.predicted_rating}/10 |`,
    '',
    `**Why it's here:** ${enriched.why}`,
    '',
    `**The caveat:** ${enriched.caveat}`,
    '',
    `---`,
    `*Enriched by \`${ANTHROPIC_MODEL}\` · stub moved to Tier ${enriched.tier} and committed to this branch · edit or merge as-is*`,
  ].join('\n');

  await postIssueComment(body);
}

// Comment summarizing what the rating enrichment did to the queue.
async function postReconcileComment(rating, result) {
  const { displayTitle, author, scoreStr } = rating;
  const header = `### Claude enrichment — *${displayTitle}* by ${author} · ${scoreStr}/10`;

  // Optional line noting a canonical-casing correction to the ratings.md heading.
  const canonLine = result.ratingsCanon
    ? `Corrected the \`ratings.md\` heading to canonical form: **${result.canonTitle} — ${result.canonAuthor}**.`
    : null;

  const body = result.changed
    ? [
        header,
        '',
        `Matched **${result.matchTitle} — ${result.matchAuthor}** in the live queue and moved it into *Already Read / Removed from Queue*:`,
        '',
        `> ${result.entryLine}`,
        '',
        `The stale queue entry has been removed; the rating itself stays in \`ratings.md\`.`,
        ...(canonLine ? ['', canonLine] : []),
        '',
        `---`,
        `*Reconciled by \`${ANTHROPIC_MODEL}\` · tbr.md updated on this branch · edit or merge as-is*`,
      ].join('\n')
    : [
        header,
        '',
        canonLine
          ? `This book isn't a live entry in the TBR queue, so no queue reconciliation was needed. ${canonLine}`
          : `This book isn't a live entry in the TBR queue, so no queue reconciliation was needed — \`tbr.md\` and \`ratings.md\` are left as submitted.`,
        '',
        `---`,
        `*Checked by \`${ANTHROPIC_MODEL}\` · tbr.md left untouched*`,
      ].join('\n');

  await postIssueComment(body);
}

// Low-level PR/issue comment poster, shared by success and failure paths.
async function postIssueComment(body) {
  const [owner, repo] = GITHUB_REPOSITORY.split('/');

  const res = await apiPost(
    'api.github.com',
    `/repos/${owner}/${repo}/issues/${PR_NUMBER}/comments`,
    {
      Authorization: `token ${GH_PAT}`,
      'User-Agent': `${owner}/${repo}-enrich-action`,
      Accept: 'application/vnd.github.v3+json',
    },
    { body },
  );

  if (res.status !== 201) {
    throw new Error(`GitHub comment API ${res.status}: ${JSON.stringify(res.body)}`);
  }
}

// Best-effort failure notice so a broken enrichment is visible on the PR
// instead of only as a red ✗ in the Actions tab that nobody is watching.
async function postFailureComment(err) {
  const body = [
    `### ⚠️ Automatic enrichment failed`,
    '',
    `This submission could **not** be auto-enriched. It still needs manual triage before merge.`,
    '',
    '```',
    String(err && err.message ? err.message : err).slice(0, 800),
    '```',
    '',
    `See the [Actions run](https://github.com/${GITHUB_REPOSITORY}/actions) for full logs. Common cause: an expired \`GH_PAT\` or \`ANTHROPIC_API_KEY\` — see \`RUNBOOK.md\`.`,
  ].join('\n');

  try {
    await postIssueComment(body);
  } catch (commentErr) {
    // If even the comment fails (e.g. the PAT is what's expired), don't mask
    // the original error — just log and let the job fail below.
    console.error('Could not post failure comment:', commentErr.message);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

// Commit the given file(s) and push back to the PR branch. Embeds the token in
// the remote URL so git can authenticate without an interactive prompt — the
// checkout's HTTP extraheader auth doesn't survive into this child process.
// GH_PAT here is the workflow's default GITHUB_TOKEN (see enrich-submission.yml) —
// "x-access-token" as the username and the "token <value>" Authorization scheme
// both work identically whether the value is a PAT or GITHUB_TOKEN, so no format
// changes were needed when this moved off a stored PAT.
// Note: a push authenticated with GITHUB_TOKEN does not trigger other workflow
// runs (GitHub suppresses that to prevent recursive Action loops) — intentional
// here, since there's nothing further that should fire off this commit.
// Run the schema lint against the working tree before anything is committed.
//
// This exists because the lint-schema workflow structurally cannot cover these
// commits: the push below is authenticated with GITHUB_TOKEN, which GitHub
// deliberately prevents from triggering further workflow runs (see the note on
// commitAndPush). The Lint Schema check on a submission PR therefore only ever
// examines the human/API-written stub — the Action's own file surgery, which is
// what actually rewrites tbr.md and ratings.md, reaches main unchecked. Running
// the lint here closes that gap at the point of damage: malformed content never
// leaves the runner, and the failure comment names the violation.
//
// One consequence worth knowing: the lint reads whole files, not the diff, so a
// pre-existing violation on the branch will fail enrichment even though this run
// didn't cause it. That's the right trade — the violation is real either way,
// and the comment shows exactly what to fix.
function lintSchemaOrThrow() {
  try {
    const out = execSync('node .github/scripts/lint-schema.mjs', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log(out.trim());
  } catch (err) {
    const detail = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    throw new Error(
      `Schema lint rejected the edited files — nothing was committed or pushed.\n\n${detail}`,
    );
  }
}

function commitAndPush(paths, message) {
  const list = Array.isArray(paths) ? paths : [paths];
  lintSchemaOrThrow();
  run('git config user.name "github-actions[bot]"');
  run('git config user.email "github-actions[bot]@users.noreply.github.com"');
  run(`git add ${list.join(' ')}`);
  run(`git commit -m ${JSON.stringify(message)}`);
  run(`git remote set-url origin https://x-access-token:${GH_PAT}@github.com/${GITHUB_REPOSITORY}.git`);
  run(`git push origin HEAD:refs/heads/${PR_HEAD_REF}`);
}

// submit/* — new TBR book: fill in tier / why / caveat.
async function enrichSubmission() {
  const { title, author, recSource } = parseStub();
  console.log(`Enriching: "${title}" by ${author}${recSource ? ` (rec: ${recSource})` : ''}`);

  const enriched = await callClaude(title, author, recSource);
  console.log('Claude response:', JSON.stringify(enriched, null, 2));

  // Prefer Claude's canonical casing/spelling over the submitter's raw form
  // input, falling back to the submitted values if the model omitted them.
  const finalTitle  = typeof enriched.title  === 'string' && enriched.title.trim()  ? enriched.title.trim()  : title;
  const finalAuthor = typeof enriched.author === 'string' && enriched.author.trim() ? enriched.author.trim() : author;
  if (finalTitle !== title || finalAuthor !== author) {
    console.log(`Canonicalized title/author: "${title} — ${author}" → "${finalTitle} — ${finalAuthor}"`);
  }

  enrichTBR(finalTitle, finalAuthor, recSource, enriched);
  commitAndPush('tbr.md', `Enrich: ${finalTitle} — ${finalAuthor} (Tier ${enriched.tier}, ~${enriched.predicted_rating}/10)`);
  console.log('Enriched entry committed and pushed.');

  await postComment(finalTitle, finalAuthor, enriched);
  console.log('PR comment posted.');
}

// rating/* — new rating: examine the queue and reconcile it against the read.
async function reconcileRating() {
  const rating = parseRatingStub();
  console.log(`Reconciling rating: "${rating.displayTitle}" by ${rating.author} · ${rating.scoreStr}/10`);

  const tbrContent = fs.readFileSync('tbr.md', 'utf8');
  const claude = await callClaudeForReconcile(rating, tbrContent);
  console.log('Claude response:', JSON.stringify(claude, null, 2));

  // Canonicalize the just-added ratings.md heading (independent of any queue
  // match) — api/submit.js writes it verbatim from the form. Returns the final
  // title/author to use and whether ratings.md was rewritten.
  const { title: canonTitle, author: canonAuthor, changed: ratingsCanon } =
    canonicalizeRatings(rating, claude);

  if (!claude.in_queue) {
    console.log('Rated book is not a live queue entry — leaving tbr.md untouched.');
    if (ratingsCanon) {
      commitAndPush('ratings.md', `Canonicalize rating heading: ${canonTitle} — ${canonAuthor} · ${rating.scoreStr}/10`);
      console.log('Canonicalized ratings.md committed and pushed.');
    }
    await postReconcileComment(rating, { changed: false, ratingsCanon, canonTitle, canonAuthor });
    console.log('PR comment posted.');
    return;
  }

  // Capture the prediction from the live entry BEFORE removing it, so the
  // Already Read line can record predicted→actual deterministically.
  const predicted = extractPredictedRating(tbrContent, claude.match_title, claude.match_author);
  console.log(predicted
    ? `Prediction for graduating entry: ${predicted}/10 (actual ${rating.scoreStr}/10)`
    : 'Graduating entry has no predicted-rating line — recording "no prediction recorded".');

  const { content: removed, found } = removeFromTBR(tbrContent, claude.match_title, claude.match_author);
  if (!found) {
    // Claude claimed a match but the heading didn't resolve — don't guess.
    throw new Error(`Claude reported an in-queue match for "${claude.match_title} — ${claude.match_author}" but no matching ### heading was found in tbr.md.`);
  }

  const updated = addToAlreadyRead(removed, claude.match_title, claude.match_author, rating.scoreStr, rating.format, claude.note, predicted);
  fs.writeFileSync('tbr.md', updated, 'utf8');

  const formatNote = rating.format ? ` (${rating.format})` : '';
  const extra      = claude.note && claude.note.trim() ? ` ${claude.note.trim()}` : '';
  const entryLine  = `- ${claude.match_title} — ${claude.match_author}. Read${formatNote}. ${outcomeClause(rating.scoreStr, predicted)}${extra}`;

  const paths   = ratingsCanon ? ['tbr.md', 'ratings.md'] : 'tbr.md';
  const message = ratingsCanon
    ? `Reconcile queue: move ${claude.match_title} — ${claude.match_author} to already-read (${rating.scoreStr}/10); canonicalize rating heading`
    : `Reconcile queue: move ${claude.match_title} — ${claude.match_author} to already-read (${rating.scoreStr}/10)`;
  commitAndPush(paths, message);
  console.log('Queue reconciliation committed and pushed.');

  await postReconcileComment(rating, {
    changed:     true,
    matchTitle:  claude.match_title,
    matchAuthor: claude.match_author,
    entryLine,
    ratingsCanon,
    canonTitle,
    canonAuthor,
  });
  console.log('PR comment posted.');
}

async function main() {
  if (PR_HEAD_REF.startsWith('rating/')) {
    await reconcileRating();
  } else {
    await enrichSubmission();
  }
}

try {
  await main();
} catch (err) {
  console.error('Enrichment failed:', err);
  await postFailureComment(err);
  process.exit(1);
}
