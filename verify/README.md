# VERIFY + Gemini smart search

The VERIFY app is unchanged. Only the search bar got an optional enhancement:
it sends the typed text to a small backend, which asks Gemini to understand it and
returns general information shown in a card using the existing result style.
The marketplace link checker also shows an authentic-vs-mimic comparison through the backend (`POST /api/compare`).
Saved products, checklist and the other tabs do not use Gemini and work even if the backend or API is down.

## Setup
1. Install Node.js 18 or newer.
2. In this folder run: `npm install`
3. Open `.env` and set `GEMINI_API_KEY` (copy `.env.example` if `.env` is missing).
4. Run: `npm start`
5. Open http://localhost:3000

Open the app through this server (not by double-clicking index.html), otherwise
the smart-search card will not appear. Everything else still works either way.

## Files
- `public/index.html` - the VERIFY app (original, plus the small search patch)
- `server.js` - backend: serves the app and `POST /api/search`
- `.env` - API key, server side only (git-ignored)

## Notes
- Optional: change `GEMINI_MODEL` in `.env`.
- Never commit `.env`. Never put the key in `public/`.
