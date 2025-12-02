# Fantasy Trade Analyzer

A local-first fantasy football trade analyzer that blends your custom league data with Yahoo valuations. Mock league rosters are built in, and Yahoo auth is used to pull live player values when available. Propose a trade, see a verdict, and get quick rationale with value deltas and positional impact.

Right now my fantasy league is programmed into it for personal use, maybe in the future I can add a feature where you can add in your own league

## Highlights
- Mock league support: run analysis without a live Yahoo league.
- Yahoo-backed valuations: falls back to a heuristic if Yahoo isn’t available.
- Clear verdicts: value-first scoring with light positional notes.
- Simple UI: select teams, enter player IDs, and get an instant recommendation.

## Run it
1. Install deps: `cd backend && npm install`
2. Add `.env` with `YAHOO_CLIENT_ID`, `YAHOO_CLIENT_SECRET`, `YAHOO_REDIRECT_URI`, `SESSION_SECRET`
3. Start backend: `node server.js`
4. Open: `https://localhost:3000/` (accept self-signed cert)
5. Optional: `https://localhost:3000/auth/yahoo` to enable Yahoo valuations
6. Analyze trades at the UI (root) or via API: `POST /api/mock-trade/analyze`

## API (mock mode)
- `GET /api/mock-league` — mock league data (My personal league with friends)
- `GET /api/mock-team-insights/:teamId` — strengths/weaknesses
- `POST /api/mock-trade/analyze` — analyze a proposed trade
