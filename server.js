require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ─── Generate replies ──────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  try {
    const { brand, description, community, thread } = req.body;

    if (!brand || !description || !community || !thread) {
      return res.status(400).json({ error: 'Tous les champs sont requis.' });
    }

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { responseMimeType: 'application/json' }
    });

    const communityGuide = {
      'reddit_fr': 'Reddit francophone (r/france, r/EntreprendreenFrance, etc.) — ton décontracté, valeur avant tout, citations de sources si possible, évite les majuscules excessives.',
      'discord': 'Serveur Discord — messages courts, emojis naturels (pas excessifs), réponds direct à la question, pas de markdown lourd.',
      'jvc': 'JeuxVideoCom — argot JVC acceptable, humour second degré, sois concis, attaque direct, le moindre pitch explicite = ban.',
      'forum': 'Forum sectoriel FR — ton expert mais accessible, réponds précisément à la question posée, cite des expériences concrètes.'
    };

    const guide = communityGuide[community] || communityGuide['forum'];

    const prompt = `Tu es un expert en community marketing authentique pour le marché francophone.

CONTEXTE :
- Marque/Produit : ${brand}
- Description : ${description}
- Communauté cible : ${guide}

THREAD/POST À COMMENTER :
${thread}

MISSION : Génère 3 réponses distinctes à ce thread. Chaque réponse doit sembler écrite par un vrai membre de la communauté — pas par une marque. La valeur apportée à la discussion prime sur toute mention du produit.

RÈGLES ANTI-BAN ABSOLUES :
1. Maximum 1 mention du produit par réponse (ou aucune si le contexte ne s'y prête pas)
2. Répondre D'ABORD à la question/problème posé
3. Longueur naturelle pour la plateforme
4. Pas de liens dans la première réponse
5. Ton authentique de la communauté

Retourne UNIQUEMENT ce JSON :
{
  "replies": [
    {
      "style": "Casual",
      "text": "...",
      "score": 8,
      "tips": ["conseil1", "conseil2"]
    },
    {
      "style": "Expert",
      "text": "...",
      "score": 9,
      "tips": ["conseil1", "conseil2"]
    },
    {
      "style": "Humour",
      "text": "...",
      "score": 7,
      "tips": ["conseil1", "conseil2"]
    }
  ]
}`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Try to extract JSON from markdown blocks
      const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) parsed = JSON.parse(match[1]);
      else throw new Error('Réponse Gemini invalide');
    }

    res.json(parsed);
  } catch (err) {
    console.error('Error /api/generate:', err.message);
    res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
});

// ─── Health ────────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ status: 'ok', service: 'essaim' }));

// ─── SPA fallback ──────────────────────────────────────────────────────────
app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🐝 Essaim running on port ${PORT}`);
});
