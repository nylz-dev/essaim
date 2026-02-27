const fetch = require('node-fetch');
const db = require('./db');

const HEADERS = {
  'User-Agent': 'Essaim Community Marketing Bot 1.0 (by /u/essaim_app)',
  'Accept': 'application/json'
};

// ── Score relevance of a post against campaign keywords ────────────────────
function scoreRelevance(title, body, keywords) {
  const text = `${title} ${body || ''}`.toLowerCase();
  const kws = keywords.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
  let score = 0;
  for (const kw of kws) {
    if (text.includes(kw)) score += 2;
    if (title.toLowerCase().includes(kw)) score += 1; // bonus if in title
  }
  return Math.min(10, score);
}

// ── Fetch new posts from a subreddit ──────────────────────────────────────
async function fetchSubreddit(subreddit, limit = 25) {
  try {
    const url = `https://www.reddit.com/r/${subreddit}/new.json?limit=${limit}`;
    const res = await fetch(url, { headers: HEADERS, timeout: 10000 });
    if (!res.ok) return [];
    const data = await res.json();
    return data.data?.children?.map(c => c.data) || [];
  } catch (e) {
    console.error(`[scraper] Error fetching r/${subreddit}:`, e.message);
    return [];
  }
}

// ── Search Reddit for keywords ─────────────────────────────────────────────
async function searchReddit(keyword, subreddits = '', limit = 10) {
  try {
    const restrict = subreddits ? `&restrict_sr=1&sr=${subreddits}` : '';
    const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(keyword)}&sort=new&t=week&limit=${limit}${restrict}`;
    const res = await fetch(url, { headers: HEADERS, timeout: 10000 });
    if (!res.ok) return [];
    const data = await res.json();
    return data.data?.children?.map(c => c.data) || [];
  } catch (e) {
    console.error(`[scraper] Error searching "${keyword}":`, e.message);
    return [];
  }
}

// ── Check if post is already seen ─────────────────────────────────────────
function isSeen(postId) {
  const row = db.prepare('SELECT 1 FROM seen_posts WHERE reddit_post_id = ?').get(postId);
  return !!row;
}

function markSeen(postId) {
  db.prepare('INSERT OR IGNORE INTO seen_posts (reddit_post_id) VALUES (?)').run(postId);
}

// ── Main scan ─────────────────────────────────────────────────────────────
async function scanCampaign(campaign) {
  const subreddits = campaign.subreddits.split(',').map(s => s.trim()).filter(Boolean);
  const keywords = campaign.keywords.split(',').map(k => k.trim()).filter(Boolean);

  let allPosts = [];
  let foundCount = 0;

  // 1. Scrape each subreddit's new posts
  for (const sub of subreddits) {
    const posts = await fetchSubreddit(sub, 30);
    allPosts = allPosts.concat(posts.map(p => ({ ...p, _source_sub: sub })));
    await sleep(1500); // Rate limit respect
  }

  // 2. Search by keywords across French subreddits
  for (const kw of keywords.slice(0, 3)) { // max 3 keyword searches
    const subStr = subreddits.join('+');
    const posts = await searchReddit(kw, subStr, 10);
    allPosts = allPosts.concat(posts);
    await sleep(2000);
  }

  // Deduplicate
  const seen = new Set();
  allPosts = allPosts.filter(p => {
    if (!p.id || seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  const insertOpp = db.prepare(`
    INSERT OR IGNORE INTO opportunities (campaign_id, reddit_post_id, subreddit, title, body, url, author, relevance_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const post of allPosts) {
    if (isSeen(post.id)) continue;
    markSeen(post.id);

    const score = scoreRelevance(post.title, post.selftext, campaign.keywords);
    if (score === 0) continue; // Not relevant at all

    const url = `https://reddit.com${post.permalink}`;
    try {
      const result = insertOpp.run(
        campaign.id,
        post.id,
        post.subreddit,
        post.title,
        post.selftext?.slice(0, 2000) || '',
        url,
        post.author,
        score
      );
      if (result.changes > 0) foundCount++;
    } catch (e) {
      // duplicate, ignore
    }
  }

  return foundCount;
}

// ── Run all active campaigns ───────────────────────────────────────────────
async function scanAll() {
  const campaigns = db.prepare('SELECT * FROM campaigns WHERE active = 1').all();
  let total = 0;
  for (const campaign of campaigns) {
    const found = await scanCampaign(campaign);
    total += found;
    console.log(`[scraper] Campaign "${campaign.brand_name}": ${found} new opportunities`);
  }
  return total;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { scanAll, scanCampaign };
