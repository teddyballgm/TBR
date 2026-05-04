const REPO = 'teddyballgm/TBR';
const API  = 'https://api.github.com';

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
  if (!res.ok) throw new Error(body.message || `GitHub API error ${res.status}`);
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

async function submitRating({ title, author, scoreStr, format, notes }) {
  const mainRef = await ghFetch(`/repos/${REPO}/git/ref/heads/main`);
  const mainSha = mainRef.object.sha;

  const branch = `rating/${slugify(title)}-${Date.now()}`;
  await ghFetch(`/repos/${REPO}/git/refs`, jsonPost({ ref: `refs/heads/${branch}`, sha: mainSha }));

  const { content, sha: fileSha } = await getFileContent('ratings.md');

  const formatNote = format ? ` *(${format})*` : '';
  const notesLine  = notes ? '\n' + notes : '';
  const stub = [
    '',
    `### ${title} — ${author} · ${scoreStr}/10${formatNote}`,
    notesLine,
    ''
  ].join('\n');

  const score = parseFloat(scoreStr);
  const newContent = insertIntoRatingsSection(content, score, stub);

  await ghFetch(`/repos/${REPO}/contents/ratings.md`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `Add rating: ${title} — ${author} · ${scoreStr}/10`,
      content: b64Encode(newContent),
      sha: fileSha,
      branch,
    }),
  });

  const pr = await ghFetch(`/repos/${REPO}/pulls`, jsonPost({
    title: `Rating: ${title} — ${author} · ${scoreStr}/10`,
    body: 'Submitted via tefleming.com',
    head: branch,
    base: 'main',
  }));

  return pr.html_url;
}

function insertIntoRatingsSection(md, score, stub) {
  const parts = md.split(/^(?=## )/m);
  let bestSection = null;
  let bestDist    = Infinity;

  for (const part of parts) {
    if (!part.startsWith('## ')) continue;
    const nl      = part.indexOf('\n');
    const heading = part.slice(3, nl).trim();
    if (/not finish/i.test(heading)) continue;

    const scoreMatches = [...part.matchAll(/·\s*([\d.]+(?:-[\d.]+)?)\/10/g)];
    if (!scoreMatches.length) continue;

    const scores = scoreMatches.map(m => {
      const s = m[1];
      return s.includes('-')
        ? (parseFloat(s) + parseFloat(s.split('-')[1])) / 2
        : parseFloat(s);
    });
    const avg  = scores.reduce((a, b) => a + b, 0) / scores.length;
    const dist = Math.abs(score - avg);
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

  // CORS — lock this down to your domain once DNS is sorted
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (!process.env.GH_PAT) {
    return res.status(500).json({ error: 'GH_PAT not configured' });
  }

  try {
    const { type, ...fields } = req.body;

    let prUrl;
    if (type === 'tbr') {
      prUrl = await submitTBR(fields);
    } else if (type === 'rating') {
      prUrl = await submitRating(fields);
    } else {
      return res.status(400).json({ error: 'Invalid type' });
    }

    res.status(200).json({ prUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Unexpected error' });
  }
}
