// server.js

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const YahooFantasy = require('yahoo-fantasy');
const https = require('https');
const fs = require('fs');
const mockLeague = require('./mockLeague');
const {
  analyzeTrade,
  analyzeTradeAsync,
  evaluateRosterAsync,
  getTeamInsights,
  setYahooValueFetcher,
} = require('./tradeAnalysis');

const app = express();

// CORS (fine for now, you can adjust when you add a Vue frontend)
app.use(cors({
  origin: true,
  credentials: true,
}));

app.use(express.json());

app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback-secret',
  resave: false,
  saveUninitialized: false,
}));

// Serve static frontend
app.use(express.static('public'));

// Create YahooFantasy client
const yf = new YahooFantasy(
  process.env.YAHOO_CLIENT_ID,
  process.env.YAHOO_CLIENT_SECRET,
  undefined, // we'll skip token callback for now
  process.env.YAHOO_REDIRECT_URI
);

// Attach saved Yahoo tokens (if any) to the YahooFantasy client for each request
app.use((req, _res, next) => {
  const tokens = req.session.yahooTokens;
  if (tokens?.access_token) {
    yf.setUserToken(tokens.access_token);
  }
  if (tokens?.refresh_token) {
    yf.setRefreshToken(tokens.refresh_token);
  }
  next();
});

// Serve frontend index
app.get('/', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

// 👉 Send user to Yahoo to log in
app.get('/auth/yahoo', (req, res) => {
  yf.auth(res); // redirects to Yahoo
});

// 👉 Yahoo sends the user back here after login
app.get('/auth/yahoo/callback', (req, res) => {
  yf.authCallback(req, (err, tokenData) => {
    if (err) {
      console.error('Yahoo auth error:', err);
      return res.status(500).send('Something went wrong with Yahoo auth');
    }

    // Persist tokens in the session so API routes can use them
    req.session.yahooTokens = tokenData;
    return req.session.save((saveErr) => {
      if (saveErr) {
        console.error('Failed to persist Yahoo tokens to session:', saveErr);
        return res.status(500).send('Failed to persist Yahoo login');
      }
      return res.redirect('/success');
    });
  });
});

// Simple success page
app.get('/success', (req, res) => {
  res.send('Yahoo auth worked! 🎉');
});

// Mock league (local dev when no real Yahoo league exists)
app.get('/api/mock-league', (_req, res) => {
  res.json(mockLeague);
});

// Yahoo-backed player valuation helpers
const playerValueCache = new Map();
let cachedNflGameKey = null;

async function getLatestNflGameKey(req) {
  if (cachedNflGameKey) return cachedNflGameKey;
  if (!req.session.yahooTokens?.access_token) return null;
  try {
    const userGames = await yf.user.games();
    const gamesArray = Array.isArray(userGames.games) ? userGames.games : [];
    const nflGames = gamesArray.filter(g => g.code === 'nfl');
    if (!nflGames.length) return null;
    const nflGame = nflGames.sort((a, b) => Number(b.season) - Number(a.season))[0];
    cachedNflGameKey = nflGame.game_key;
    return cachedNflGameKey;
  } catch (e) {
    console.error('Failed to resolve NFL game key from Yahoo:', e);
    return null;
  }
}

async function yahooValueFromYahoo(player, req) {
  if (playerValueCache.has(player.name)) {
    return playerValueCache.get(player.name);
  }

  const gameKey = await getLatestNflGameKey(req);
  if (!gameKey) {
    throw new Error('No Yahoo NFL game key available for valuation (auth required)');
  }

  // Search player by name within the NFL game and request stats
  const url = `https://fantasysports.yahooapis.com/fantasy/v2/players;search=${encodeURIComponent(player.name)};game_keys=${gameKey};out=stats`;
  const data = await yf.api(yf.GET, url);

  const first = data?.fantasy_content?.players?.[0]?.player;
  if (!first) throw new Error('Player not found on Yahoo');

  // Try to grab total fantasy points; fallback to 0
  const points = Number(first?.[1]?.player_points?.total || 0);
  const value = Math.max(10, Math.round(points));

  playerValueCache.set(player.name, value);
  return value;
}

// Mock trade analysis
app.post('/api/mock-trade/analyze', async (req, res) => {
  try {
    const { fromTeamId, toTeamId, offerFromIds = [], offerToIds = [] } = req.body || {};
    if (!fromTeamId || !toTeamId) {
      return res.status(400).json({ error: 'fromTeamId and toTeamId are required' });
    }
    // Wire Yahoo valuations for this request; falls back to heuristic if unavailable.
    setYahooValueFetcher((player) => yahooValueFromYahoo(player, req));

    const result = await analyzeTradeAsync({
      league: mockLeague,
      fromTeamId: Number(fromTeamId),
      toTeamId: Number(toTeamId),
      offerFromIds: offerFromIds.map(Number),
      offerToIds: offerToIds.map(Number),
    });
    return res.json(result);
  } catch (err) {
    console.error('Trade analysis error:', err);
    return res.status(400).json({ error: err.message || 'Failed to analyze trade' });
  }
});

// Mock team insights (strengths/weaknesses)
app.get('/api/mock-team-insights/:teamId', (req, res) => {
  try {
    const teamId = Number(req.params.teamId);
    // Wire Yahoo valuations for this request; falls back to heuristic if unavailable.
    setYahooValueFetcher((player) => yahooValueFromYahoo(player, req));
    const insights = getTeamInsights(mockLeague, teamId);
    return res.json({ ...insights, valuationSource: playerValueCache.size ? 'yahoo+fallback' : 'fallback' });
  } catch (err) {
    console.error('Team insight error:', err);
    return res.status(400).json({ error: err.message || 'Failed to get team insights' });
  }
});

// Get user's NFL leagues
app.get('/api/leagues', async (req, res) => {
  try {
    if (!req.session.yahooTokens?.access_token) {
      return res
        .status(401)
        .json({ error: 'Not authenticated with Yahoo. Visit /auth/yahoo first.' });
    }

    // Ensure the YahooFantasy client is using the current access/refresh tokens
    yf.setUserToken(req.session.yahooTokens.access_token);
    if (req.session.yahooTokens.refresh_token) {
      yf.setRefreshToken(req.session.yahooTokens.refresh_token);
    }

    // 1) Get ALL games this Yahoo user has played in
    const userGames = await yf.user.games();

    // 2) Find the most recent NFL game (covers off-season when current year isn't ready yet)
    const gamesArray = Array.isArray(userGames.games) ? userGames.games : [];
    const nflGames = gamesArray.filter(g => g.code === 'nfl');
    if (!nflGames.length) {
      const payload = {
        error: 'No NFL games found for this user',
        games: gamesArray, // expose what Yahoo returned for debugging
      };
      // Optionally allow empty response to keep frontend flows unblocked during dev
      if (req.query.allowEmpty === 'true') {
        return res.json({ ...payload, leagues: [] });
      }
      console.log('No NFL games found for this user', userGames);
      return res.status(404).json(payload);
    }
    const nflGame = nflGames.sort((a, b) => Number(b.season) - Number(a.season))[0];

    // 3) Get the leagues for that NFL game
    const leaguesData = await yf.user.game_leagues(nflGame.game_key);

    // 4) Send the leagues back to the frontend
    res.json(leaguesData);
  } catch (err) {
    console.error('Error fetching leagues:', err);
    res.status(500).json({ error: 'Failed to fetch leagues from Yahoo' });
  }
});

// 🔒 HTTPS server setup
const PORT = 3000;

const httpsOptions = {
  key: fs.readFileSync('localhost.key'),
  cert: fs.readFileSync('localhost.cert'),
};

https.createServer(httpsOptions, app).listen(PORT, () => {
  console.log(`HTTPS server running on https://localhost:${PORT}`);
});
