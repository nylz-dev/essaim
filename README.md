# 🐝 Essaim — Community Marketing IA

Postez naturellement sur Reddit FR, Discord, JVC et forums sectoriels sans vous faire bannir.

## Lancement local

```bash
npm install
cp .env.example .env
# Remplir GEMINI_API_KEY dans .env
npm start
# → http://localhost:3000
```

## Déploiement Railway

1. Push sur GitHub
2. New Project → Deploy from GitHub repo
3. Variables d'env : `GEMINI_API_KEY`
4. Railway détecte le `package.json` automatiquement

## Stack

- Backend : Node.js + Express.js
- IA : Google Gemini 2.5 Flash
- Frontend : HTML + Tailwind CSS (CDN)
- Hébergement : Railway
