const REPO = 'teddyballgm/TBR';
const API  = 'https://api.github.com';

// ── Abuse protection ──────────────────────────────────────────────────────
//
// Each submission triggers a paid GitHub API call chain (and, later, a paid
// Claude call in the enrichment Action), and the endpoint is unauthenticated.
// Two cheap layers, no external services:

// 1. Honeypot: a hidden form field real users never fill in. Bots that
//    populate every input trip it; we fake success and do nothing further.
function isHoneypotTripped(fields) {
  return typeof fields.website === 'string' && fields.website.trim().length > 0;
}

// 2. Rate limit: max submissions per IP per hour, tracked in an in-module
//    Map. Serverless instances don't share memory (and Vercel functions are
//    frequently cold-started), so this is best-effort per-instance
//    throttling, not a hard global cap — acceptable for this threat model,
//    where the goal is capping runaway cost from a single abusive client
//    hammering one warm instance, not a distributed attacker.
const RATE_LIMIT_MAX    = 5;
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
const submissionsByIP = new Map();

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress;
}

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (submissionsByIP.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW);

  if (timestamps.length >= RATE_LIMIT_MAX) {
    submissionsByIP.set(ip, timestamps);
    return true;
  }

  timestamps.push(now);
  submissionsByIP.set(ip, timestamps);
  return false;
}

async function ghFetch(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github.v3+json',
      Authorization: `token ${process.env.GH_PAT}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(body.message || `GitHub API error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

async function getFileContent(path) {
  const data = await ghFetch(`/repos/${REPO}/contents/${path}`);
  const content = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
  return { content, sha: data.sha };
}

function b64Encode(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function jsonPost(body) {
  return { method: 'POST', body: JSON.stringify(body) };
}

// Returns an error string if the submission is invalid, or null if it's fine.
function validateSubmission(type, fields) {
  const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

  if (!nonEmpty(fields.title))  return 'A title is required.';
  if (!nonEmpty(fields.author)) return 'An author is required.';

  // slugify() strips everything but [a-z0-9]; all-symbol input yields an empty
  // slug and a malformed branch name, so require at least one usable character.
  if (!slugify(fields.title)) return 'Title must contain letters or numbers.';

  if (type === 'rating') {
    const score = parseFloat(fields.scoreStr);
    if (!nonEmpty(fields.scoreStr) || Number.isNaN(score)) {
      return 'A numeric score is required.';
    }
    if (score < 1 || score > 10 || Math.round(score * 2) !== score * 2) {
      return 'Score must be between 1 and 10 in 0.5 increments.';
    }
  }

  return null;
}

async function submitTBR({ title, author, recSource, submitterName }) {
  const mainRef = await ghFetch(`/repos/${REPO}/git/ref/heads/main`);
  const mainSha = mainRef.object.sha;

  const branch = `submit/${slugify(title)}-${Date.now()}`;
  await ghFetch(`/repos/${REPO}/git/refs`, jsonPost({ ref: `refs/heads/${branch}`, sha: mainSha }));

  const { content, sha: fileSha } = await getFileContent('tbr.md');

  const ereaderUrl = `https://www.ereaderiq.com/search/?q=${encodeURIComponent(title + ' ' + author)}`;
  const recLine = recSource ? ` *(rec from ${recSource})*` : '';
  const stub = [
    '',
    `### ${title} — ${author}${recLine}`,
    '',
    `**Kindle:** [Track on eReaderIQ](${ereaderUrl})`,
    '',
    `**Why it's here:** [To be filled during triage]`,
    '',
    `**The caveat:** [To be filled during triage]`,
    ''
  ].join('\n');

  const marker = '\n## Already Read';
  const idx = content.indexOf(marker);
  const newContent = idx !== -1
    ? content.slice(0, idx) + '\n' + stub + content.slice(idx)
    : content.trimEnd() + '\n' + stub;

  await ghFetch(`/repos/${REPO}/contents/tbr.md`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `Add TBR stub: ${title} — ${author}`,
      content: b64Encode(newContent),
      sha: fileSha,
      branch,
    }),
  });

  const prBody = submitterName
    ? `Submitted by ${submitterName} via tefleming.com`
    : 'Submitted via tefleming.com';

  const pr = await ghFetch(`/repos/${REPO}/pulls`, jsonPost({
    title: `TBR: ${title} — ${author}`,
    body: prBody,
    head: branch,
    base: 'main',
  }));

  return pr.html_url;
}

async function submitRating({ title, author, series, scoreStr, format, notes }) {
  const mainRef = await ghFetch(`/repos/${REPO}/git/ref/heads/main`);
  const mainSha = mainRef.object.sha;

  const displayTitle = series ? `${title} (${series})` : title;
  const branch = `rating/${slugify(displayTitle)}-${Date.now()}`;
  await ghFetch(`/repos/${REPO}/git/refs`, jsonPost({ ref: `refs/heads/${branch}`, sha: mainSha }));

  const ratingsFile = await getFileContent('ratings.md');

  const formatNote = format ? ` *(${format})*` : '';
  const notesLine  = notes ? '\n' + notes : '';
  const stub = [
    '',
    `### ${displayTitle} — ${author} · ${scoreStr}/10${formatNote}`,
    notesLine,
    ''
  ].join('\n');

  const score = parseFloat(scoreStr);
  const newRatingsContent = insertIntoRatingsSection(ratingsFile.content, score, stub);

  await ghFetch(`/repos/${REPO}/contents/ratings.md`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `Add rating: ${displayTitle} — ${author} · ${scoreStr}/10`,
      content: b64Encode(newRatingsContent),
      sha: ratingsFile.sha,
      branch,
    }),
  });

  // Reconciling the TBR queue (removing the book if it was queued, logging it
  // under "Already Read") is handled by the enrichment Action on PR open, which
  // matches on the underlying work rather than an exact title/author string.
  const pr = await ghFetch(`/repos/${REPO}/pulls`, jsonPost({
    title: `Rating: ${displayTitle} — ${author} · ${scoreStr}/10`,
    body: 'Submitted via tefleming.com — queue reconciliation runs automatically on open.',
    head: branch,
    base: 'main',
  }));

  return pr.html_url;
}

// Parses a section heading's numeric range, e.g. "9-10" → [9, 10], "7-8.5" →
// [7, 8.5], "5 and below" → [-Infinity, 5]. Returns null if the heading has
// no recognizable range (e.g. "Did Not Finish").
function parseSectionRange(heading) {
  const belowMatch = heading.match(/^([\d.]+)\s+and below$/i);
  if (belowMatch) return [-Infinity, parseFloat(belowMatch[1])];

  const rangeMatch = heading.match(/^([\d.]+)\s*-\s*([\d.]+)$/);
  if (rangeMatch) return [parseFloat(rangeMatch[1]), parseFloat(rangeMatch[2])];

  return null;
}

function insertIntoRatingsSection(md, score, stub) {
  const parts = md.split(/^(?=## )/m);
  let bestSection  = null;
  let bestDist     = Infinity;

  for (const part of parts) {
    if (!part.startsWith('## ')) continue;
    const nl      = part.indexOf('\n');
    const heading = part.slice(3, nl).trim();
    if (/not finish/i.test(heading)) continue;

    const range = parseSectionRange(heading);
    if (!range) continue;
    const [min, max] = range;

    if (score >= min && score <= max) { bestSection = `## ${heading}`; bestDist = 0; break; }

    const dist = score < min ? min - score : score - max;
    if (dist < bestDist) { bestDist = dist; bestSection = `## ${heading}`; }
  }

  if (bestSection) {
    const idx     = md.indexOf(bestSection);
    const lineEnd = md.indexOf('\n', idx) + 1;
    let insertAt  = lineEnd;
    if (md[insertAt] === '\n') insertAt++;
    return md.slice(0, insertAt) + stub + md.slice(insertAt);
  }

  const firstSection = md.search(/^## /m);
  if (firstSection > 0) return md.slice(0, firstSection) + stub + '\n' + md.slice(firstSection);
  return md.trimEnd() + '\n' + stub;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // CORS — restricted to the site's own origin. Override via ALLOWED_ORIGIN.
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || 'https://tefleming.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Fake success, do nothing — don't tip off the bot that it was caught.
  // Checked before anything else so a bot trips it as cheaply as possible.
  if (isHoneypotTripped(req.body || {})) {
    return res.status(200).json({ prUrl: `https://github.com/${REPO}` });
  }

  const ip = getClientIP(req);
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many submissions from this connection — please try again in a bit.' });
  }

  if (!process.env.GH_PAT) {
    return res.status(500).json({ error: 'GH_PAT not configured' });
  }

  try {
    const { type, ...fields } = req.body;

    if (type !== 'tbr' && type !== 'rating') {
      return res.status(400).json({ error: 'Invalid type' });
    }

    const invalid = validateSubmission(type, fields);
    if (invalid) {
      return res.status(400).json({ error: invalid });
    }

    const prUrl = type === 'tbr'
      ? await submitTBR(fields)
      : await submitRating(fields);

    res.status(200).json({ prUrl });
  } catch (err) {
    console.error(err);
    // A 401 from GitHub almost always means the GH_PAT has expired or been
    // revoked. Surface that clearly instead of leaking the raw API message.
    if (err.status === 401) {
      console.error('GitHub returned 401 — GH_PAT is likely expired. See RUNBOOK.md.');
      return res.status(502).json({
        error: 'GitHub authentication failed — the access token is likely expired. Please try again later.',
      });
    }
    res.status(500).json({ error: err.message || 'Unexpected error' });
  }
}
