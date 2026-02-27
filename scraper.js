const fetch = require('node-fetch');
const db = require('./db');

const USER_AGENT = `Essaim/1.0 by /u/${process.env.REDDIT_USERNAME || 'essaim_app'}`;

// ── Reddit OAuth token (cached) ───────────────────────────────────────────
let _token = null;
let _tokenExpiry = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;

  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.warn('[scraper] No Reddit OAuth credentials — using public API (may be blocked on cloud)');
    return null;
  }

  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!res.ok) {
    console.error('[scraper] Reddit OAuth failed:', res.status);
    return null;
  }

  const data = await res.json();
  _token = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  console.log('[scraper] Reddit OAuth token obtained ✓');
  return _token;
}

// ── Fetch helpers ─────────────────────────────────────────────────────────
async function redditFetch(url) {
  const token = await getToken();

  const baseUrl = token
    ? url.replace('www.reddit.com', 'oauth.reddit.com')
    : url;

  const headers = {
    'User-Agent': USER_AGENT,
    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
  };

  const res = await fetch(baseUrl, { headers, timeout: 12000 });

  // Token expired — refresh and retry once
  if (res.status === 401 && token) {
    _token = null;
    return redditFetch(url);
  }

  if (!res.ok) return null;
  return res.json();
}

// ── Score relevance ───────────────────────────────────────────────────────
function scoreRelevance(title, body, keywords) {
  const text = `${title} ${body || ''}`.toLowerCase();
  const kws = keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
  let score = 0;
  for (const kw of kws) {
    if (text.includes(kw)) score += 2;
    if (title.toLowerCase().includes(kw)) score += 1;
  }
  return Math.min(10, score);
}

// ── Fetch subreddit new posts ─────────────────────────────────────────────
async function fetchSubreddit(subreddit, limit = 25) {
  try {
    const data = await redditFetch(
      `https://www.reddit.com/r/${subreddit}/new.json?limit=${limit}`
    );
    return data?.data?.children?.map(c => c.data) || [];
  } catch (e) {
    console.error(`[scraper] Error r/${subreddit}:`, e.message);
    return [];
  }
}

// ── Search Reddit by keyword ──────────────────────────────────────────────
async function searchReddit(keyword, subreddits = '', limit = 10) {
  try {
    const restrict = subreddits ? `&restrict_sr=1&sr=${subreddits}` : '';
    const data = await redditFetch(
      `https://www.reddit.com/search.json?q=${encodeURIComponent(keyword)}&sort=new&t=week&limit=${limit}${restrict}`
    );
    return data?.data?.children?.map(c => c.data) || [];
  } catch (e) {
    console.error(`[scraper] Error search "${keyword}":`, e.message);
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

  let allPosts = [];

  // 1. New posts from each subreddit
  for (const sub of subreddits) {
    const posts = await fetchSubreddit(sub, 30);
    allPosts = allPosts.concat(posts);
    await sleep(1200);
  }

  // 2. Keyword search (max 3 keywords to stay within rate limits)
  const subStr = subreddits.join('+');
  for (const kw of keywords.slice(0, 3)) {
    const posts = await searchReddit(kw, subStr, 10);
    allPosts = allPosts.concat(posts);
    await sleep(1500);
  }

  // Deduplicate by post ID
  const seen = new Set();
  allPosts = allPosts.filter(p => {
    if (!p?.id || seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  const insert = db.prepare(`
    INSERT OR IGNORE INTO opportunities
      (campaign_id, reddit_post_id, subreddit, title, body, url, author, relevance_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let foundCount = 0;
  for (const post of allPosts) {
    if (isSeen(post.id)) continue;
    markSeen(post.id);

    const score = scoreRelevance(post.title, post.selftext, campaign.keywords);
    if (score === 0) continue;

    const url = `https://reddit.com${post.permalink}`;
    try {
      const result = insert.run(
        campaign.id, post.id, post.subreddit,
        post.title, post.selftext?.slice(0, 2000) || '',
        url, post.author, score
      );
      if (result.changes > 0) foundCount++;
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
