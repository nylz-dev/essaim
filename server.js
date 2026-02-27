require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./db');
const { scanAll, scanCampaign } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;
const SCAN_INTERVAL_MS = 20 * 60 * 1000; // every 20 minutes

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── CAMPAIGNS ─────────────────────────────────────────────────────────────

app.get('/api/campaigns', (req, res) => {
  const campaigns = db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all();
  const counts = db.prepare(`
    SELECT campaign_id,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
    FROM opportunities GROUP BY campaign_id
  `).all();
  const countMap = {};
  for (const c of counts) countMap[c.campaign_id] = c;
  res.json(campaigns.map(c => ({
    ...c,
    total_opportunities: countMap[c.id]?.total || 0,
    pending_opportunities: countMap[c.id]?.pending || 0
  })));
});

app.post('/api/campaigns', (req, res) => {
  const { brand_name, description, keywords, subreddits } = req.body;
  if (!brand_name || !description || !keywords || !subreddits) {
    return res.status(400).json({ error: 'Tous les champs sont requis.' });
  }
  const result = db.prepare(
    'INSERT INTO campaigns (brand_name, description, keywords, subreddits) VALUES (?, ?, ?, ?)'
  ).run(brand_name, description, keywords, subreddits);

  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(result.lastInsertRowid);

  // Trigger immediate scan for this new campaign
  scanCampaign(campaign).then(n => {
    console.log(`[server] Initial scan for "${brand_name}": ${n} opportunities found`);
  }).catch(console.error);

  res.json(campaign);
});

app.delete('/api/campaigns/:id', (req, res) => {
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── OPPORTUNITIES ─────────────────────────────────────────────────────────

app.get('/api/opportunities', (req, res) => {
  const { campaign_id, status = 'pending', limit = 50 } = req.query;
  let query = `
    SELECT o.*, c.brand_name, c.description as brand_description
    FROM opportunities o
    JOIN campaigns c ON c.id = o.campaign_id
    WHERE o.status = ?
  `;
  const params = [status];
  if (campaign_id) {
    query += ' AND o.campaign_id = ?';
    params.push(campaign_id);
  }
  query += ' ORDER BY o.relevance_score DESC, o.detected_at DESC LIMIT ?';
  params.push(parseInt(limit));
  res.json(db.prepare(query).all(...params));
});

app.patch('/api/opportunities/:id', (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE opportunities SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true });
});

// ── GENERATE RESPONSES ────────────────────────────────────────────────────

app.post('/api/opportunities/:id/generate', async (req, res) => {
  try {
    const opp = db.prepare(`
      SELECT o.*, c.brand_name, c.description as brand_description, c.keywords
      FROM opportunities o JOIN campaigns c ON c.id = o.campaign_id
      WHERE o.id = ?
    `).get(req.params.id);

    if (!opp) return res.status(404).json({ error: 'Opportunité introuvable.' });

    // Check if already generated
    const existing = db.prepare('SELECT * FROM responses WHERE opportunity_id = ?').all(opp.id);
    if (existing.length > 0) {
      return res.json({ replies: existing.map(r => ({
        id: r.id,
        style: r.style,
        text: r.text,
        score: r.anti_ban_score,
        tips: JSON.parse(r.tips || '[]')
      }))});
    }

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { responseMimeType: 'application/json' }
    });

    const prompt = `Tu es un expert en community marketing authentique pour le marché francophone.

CONTEXTE :
- Marque/Produit : ${opp.brand_name}
- Ce qu'on propose : ${opp.brand_description}

POST REDDIT À COMMENTER (r/${opp.subreddit}) :
Titre : ${opp.title}
Contenu : ${opp.body || '(pas de contenu, juste le titre)'}

MISSION : Génère 3 réponses distinctes à ce post. Chaque réponse doit sembler écrite par un vrai Redditor francophone — pas par une marque. La valeur apportée à la discussion prime sur toute mention du produit.

RÈGLES ANTI-BAN ABSOLUES :
1. Maximum 1 mention subtile du produit par réponse (ou aucune si le contexte ne s'y prête pas naturellement)
2. Répondre D'ABORD à la question/problème posé avec de la vraie valeur
3. Longueur naturelle pour Reddit (50-200 mots)
4. Ton authentique d'un membre de la communauté francophone
5. Jamais de liens directs, jamais de "je vous recommande", jamais de ton commercial

Retourne UNIQUEMENT ce JSON :
{
  "replies": [
    {
      "style": "Casual",
      "text": "...",
      "score": 8,
      "tips": ["conseil anti-ban court"]
    },
    {
      "style": "Expert",
      "text": "...",
      "score": 9,
      "tips": ["conseil anti-ban court"]
    },
    {
      "style": "Humour",
      "text": "...",
      "score": 7,
      "tips": ["conseil anti-ban court"]
    }
  ]
}`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      parsed = JSON.parse(match ? match[1] : raw);
    }

    // Save to DB
    const insert = db.prepare(
      'INSERT INTO responses (opportunity_id, style, text, anti_ban_score, tips) VALUES (?, ?, ?, ?, ?)'
    );
    for (const r of parsed.replies) {
      insert.run(opp.id, r.style, r.text, r.score, JSON.stringify(r.tips || []));
    }

    // Mark opportunity as "generated"
    db.prepare("UPDATE opportunities SET status = 'generated' WHERE id = ?").run(opp.id);

    res.json(parsed);
  } catch (err) {
    console.error('Error /generate:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── MANUAL SCAN ───────────────────────────────────────────────────────────

app.post('/api/scan', async (req, res) => {
  try {
    const total = await scanAll();
    res.json({ ok: true, found: total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── STATS ─────────────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM campaigns WHERE active = 1) as active_campaigns,
      (SELECT COUNT(*) FROM opportunities WHERE status = 'pending') as pending_opportunities,
      (SELECT COUNT(*) FROM opportunities WHERE status = 'generated') as generated,
      (SELECT COUNT(*) FROM opportunities WHERE status = 'approved') as approved,
      (SELECT COUNT(*) FROM opportunities) as total_opportunities
  `).get();
  res.json(stats);
});

// ── HEALTH ────────────────────────────────────────────────────────────────

app.get('/api/health', (_, res) => res.json({ status: 'ok', service: 'essaim' }));

// ── SPA ───────────────────────────────────────────────────────────────────

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── PERIODIC SCAN ─────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🐝 Essaim running on port ${PORT}`);

  // Initial scan on startup
  setTimeout(() => {
    scanAll().catch(console.error);
  }, 5000);

  // Periodic scan every 20 minutes
  setInterval(() => {
    scanAll().catch(console.error);
  }, SCAN_INTERVAL_MS);
});
