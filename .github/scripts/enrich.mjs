#!/usr/bin/env node
/**
 * Called by the enrich-submission workflow.
 * Reads the TBR stub from the PR diff, asks Claude to enrich it,
 * rewrites tbr.md on the PR branch, and posts a summary comment.
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

{"tier":2,"predicted_rating":"7.5","why":"...","caveat":"..."}

Field rules:
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

  // Build the enriched entry.
  const recSuffix = recSource ? ` *(rec from ${recSource})*` : '';
  const lines = [`### ${title} — ${author}${recSuffix}`];
  if (kindleLine) lines.push('', kindleLine);
  lines.push(
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

async function main() {
  const { title, author, recSource } = parseStub();
  console.log(`Enriching: "${title}" by ${author}${recSource ? ` (rec: ${recSource})` : ''}`);

  const enriched = await callClaude(title, author, recSource);
  console.log('Claude response:', JSON.stringify(enriched, null, 2));

  enrichTBR(title, author, recSource, enriched);

  run('git config user.name "github-actions[bot]"');
  run('git config user.email "github-actions[bot]@users.noreply.github.com"');
  run('git add tbr.md');
  run(`git commit -m "Enrich: ${title} — ${author} (Tier ${enriched.tier}, ~${enriched.predicted_rating}/10)"`);

  // Embed the PAT in the remote URL so git can authenticate without an
  // interactive terminal prompt. actions/checkout wires up credentials via an
  // HTTP extraheader on the checkout call, but that auth context doesn't
  // survive into child processes spawned later in the job.
  run(`git remote set-url origin https://x-access-token:${GH_PAT}@github.com/${GITHUB_REPOSITORY}.git`);
  run(`git push origin HEAD:refs/heads/${PR_HEAD_REF}`);
  console.log('Enriched entry committed and pushed.');

  await postComment(title, author, enriched);
  console.log('PR comment posted.');
}

try {
  await main();
} catch (err) {
  console.error('Enrichment failed:', err);
  await postFailureComment(err);
  process.exit(1);
}
