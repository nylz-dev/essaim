const fetch = require('node-fetch');
const db = require('./db');

const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';

// ── Score relevance ───────────────────────────────────────────────────────
function scoreRelevance(title, snippet, keywords) {
  const text = `${title} ${snippet || ''}`.toLowerCase();
  const kws = keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
  let score = 0;
  for (const kw of kws) {
    if (text.includes(kw)) score += 2;
    if (title.toLowerCase().includes(kw)) score += 1;
  }
  return Math.min(10, score);
}

// ── Parse Reddit URL → post ID ────────────────────────────────────────────
function extractPostId(url) {
  const m = url.match(/\/comments\/([a-z0-9]+)\//i);
  return m ? m[1] : url.replace(/[^a-z0-9]/gi, '').slice(-12);
}

function extractSubreddit(url) {
  const m = url.match(/reddit\.com\/r\/([^/]+)/i);
  return m ? m[1] : 'reddit';
}

// ── Brave search for Reddit posts ─────────────────────────────────────────
async function braveSearchReddit(query, subreddit = null, count = 10) {
  if (!BRAVE_API_KEY) {
    console.error('[scraper] No BRAVE_API_KEY set');
    return [];
  }

  try {
    // Brave works better with "reddit.com/r/subreddit query" than site: filter
    const siteFilter = subreddit
      ? `reddit.com/r/${subreddit}`
      : 'reddit.com/r/';

    const fullQuery = `${siteFilter} ${query}`;
    const url = `${BRAVE_URL}?q=${encodeURIComponent(fullQuery)}&count=${count}&search_lang=fr`;

    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': BRAVE_API_KEY
      },
      timeout: 12000
    });

    if (!res.ok) {
      console.error(`[scraper] Brave API error: ${res.status}`);
      return [];
    }

    const data = await res.json();
    return data.web?.results || [];
  } catch (e) {
    console.error('[scraper] Brave search error:', e.message);
    return [];
  }
}

// ── Seen posts ────────────────────────────────────────────────────────────
function isSeen(postId) {
  return !!db.prepare('SELECT 1 FROM seen_posts WHERE reddit_post_id = ?').get(postId);
}
function markSeen(postId) {
  db.prepare('INSERT OR IGNORE INTO seen_posts (reddit_post_id) VALUES (?)').run(postId);
}

// ── Scan one campaign ─────────────────────────────────────────────────────
async function scanCampaign(campaign) {
  const subreddits = campaign.subreddits.split(',').map(s => s.trim()).filter(Boolean);
  const keywords = campaign.keywords.split(',').map(k => k.trim()).filter(Boolean);

  let allResults = [];

  // 1. Search each keyword across all subreddits
  for (const kw of keywords.slice(0, 5)) {
    for (const sub of subreddits.slice(0, 4)) {
      const results = await braveSearchReddit(kw, sub, 5);
      allResults = allResults.concat(results);
      await sleep(400); // Brave rate limit
    }
  }

  // 2. Also broad search per subreddit (recent posts)
  for (const sub of subreddits.slice(0, 3)) {
    const broadQuery = keywords.slice(0, 3).join(' OR ');
    const results = await braveSearchReddit(broadQuery, sub, 8);
    allResults = allResults.concat(results);
    await sleep(400);
  }

  // Deduplicate by URL
  const seenUrls = new Set();
  allResults = allResults.filter(r => {
    if (!r.url || seenUrls.has(r.url)) return false;
    // Only Reddit post URLs (not profiles, wiki, etc.)
    if (!r.url.includes('/comments/')) return false;
    seenUrls.add(r.url);
    return true;
  });

  const insert = db.prepare(`
    INSERT OR IGNORE INTO opportunities
      (campaign_id, reddit_post_id, subreddit, title, body, url, author, relevance_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let foundCount = 0;
  for (const result of allResults) {
    const postId = extractPostId(result.url);
    if (isSeen(postId)) continue;
    markSeen(postId);

    const title = result.title || '';
    const snippet = result.description || result.extra_snippets?.join(' ') || '';
    const score = scoreRelevance(title, snippet, campaign.keywords);
    if (score === 0) continue;

    const sub = extractSubreddit(result.url);

    try {
      const r = insert.run(
        campaign.id, postId, sub,
        title, snippet.slice(0, 2000),
        result.url, null, score
      );
      if (r.changes > 0) foundCount++;
    } catch { /* duplicate */ }
  }

  return foundCount;
}

// ── Scan all active campaigns ─────────────────────────────────────────────
async function scanAll() {
  const campaigns = db.prepare('SELECT * FROM campaigns WHERE active = 1').all();
  let total = 0;
  for (const c of campaigns) {
    const n = await scanCampaign(c);
    total += n;
    console.log(`[scraper] "${c.brand_name}": ${n} new opportunities`);
  }
  return total;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { scanAll, scanCampaign };
