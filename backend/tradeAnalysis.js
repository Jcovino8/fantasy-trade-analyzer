// Lightweight trade analysis over mock league data.

const positionBaseValue = {
  QB: 40,
  RB: 80,
  WR: 75,
  TE: 40,
  DST: 10,
  K: 10,
};

const eliteNames = new Set([
  'Patrick Mahomes',
  'Josh Allen',
  'Lamar Jackson',
  'Christian McCaffrey',
  'Bijan Robinson',
  'Jahmyr Gibbs',
  'Breece Hall',
  'Saquon Barkley',
  'Travis Kelce',
  'Sam LaPorta',
  'Justin Jefferson',
  "Ja'Marr Chase",
  'Amon-Ra St. Brown',
  'A.J. Brown',
]);

const breakoutNames = new Set([
  'Puka Nacua',
  'Jaylen Waddle',
  'CeeDee Lamb',
  'Garrett Wilson',
  'Brock Purdy',
  'C.J. Stroud',
  'Jayden Daniels',
  'Caleb Williams',
  'Xavier Worthy',
  'Brian Thomas Jr.',
  'Rome Odunze',
  'Brock Bowers',
  'Trey McBride',
  'Sam LaPorta',
  'Dalton Kincaid',
  'Jaxon Smith-Njigba',
  'Ladd McConkey',
  'Keon Coleman',
]);

const riskNames = new Set([
  'Derrick Henry',
  'Joe Mixon',
  'David Montgomery',
  'Aaron Jones Sr.',
  'Dalvin Cook',
]);

// Optional Yahoo-backed value fetcher (set from server)
let yahooValueFetcher = null;
function setYahooValueFetcher(fn) {
  yahooValueFetcher = fn;
}

function valuePlayerHeuristic(player) {
  const base = positionBaseValue[player.position] || 40;
  let bonus = 0;
  if (eliteNames.has(player.name)) bonus += 20;
  else if (breakoutNames.has(player.name)) bonus += 12;
  if (riskNames.has(player.name)) bonus -= 8;
  return Math.max(10, base + bonus);
}

async function valuePlayerWithYahoo(player) {
  if (yahooValueFetcher) {
    try {
      const yahooValue = await yahooValueFetcher(player);
      if (typeof yahooValue === 'number' && yahooValue > 0) {
        return { value: yahooValue, source: 'yahoo' };
      }
    } catch (e) {
      // ignore and fallback
    }
  }
  return { value: valuePlayerHeuristic(player), source: 'fallback' };
}

function evaluateRoster(roster) {
  const withValues = roster.map((p) => ({ ...p, value: valuePlayerHeuristic(p), source: 'fallback' }));
  const byPos = {};
  for (const p of withValues) {
    if (!byPos[p.position]) byPos[p.position] = [];
    byPos[p.position].push(p.value);
  }
  const starterNeeds = { QB: 1, RB: 2, WR: 3, TE: 1, DST: 1, K: 1 };
  const scores = {};
  for (const [pos, need] of Object.entries(starterNeeds)) {
    const vals = (byPos[pos] || []).sort((a, b) => b - a);
    const take = vals.slice(0, need);
    const depth = vals.slice(need, need + 2);
    const starterScore = take.length
      ? take.reduce((a, b) => a + b, 0) / take.length
      : 0;
    const depthScore = depth.length
      ? depth.reduce((a, b) => a + b, 0) / depth.length
      : 0;
    scores[pos] = {
      starterScore: Math.round(starterScore),
      depthScore: Math.round(depthScore),
      count: vals.length,
    };
  }

  const strengths = [];
  const weaknesses = [];
  for (const [pos, data] of Object.entries(scores)) {
    if (data.starterScore >= 75) strengths.push(pos);
    if (data.starterScore < 60 || data.count < (starterNeeds[pos] || 1)) {
      weaknesses.push(pos);
    }
  }

  const totalValue = withValues.reduce((sum, p) => sum + p.value, 0);

  return {
    players: withValues,
    totalValue,
    scores,
    strengths,
    weaknesses,
  };
}

async function evaluateRosterAsync(roster) {
  const evaluated = [];
  for (const p of roster) {
    const { value, source } = await valuePlayerWithYahoo(p);
    evaluated.push({ ...p, value, source });
  }
  return evaluateRoster(evaluated);
}

function cloneTeam(team) {
  return { ...team, roster: team.roster.map((p) => ({ ...p })) };
}

function applyTrade(team, outgoingIds, incomingPlayers) {
  const remaining = team.roster.filter((p) => !outgoingIds.includes(p.playerId));
  return { ...team, roster: [...remaining, ...incomingPlayers] };
}

function getPlayersByIds(league, ids) {
  const pool = league.teams.flatMap((t) => t.roster);
  return ids.map((id) => pool.find((p) => p.playerId === id)).filter(Boolean);
}

function analyzeTrade({ league, fromTeamId, toTeamId, offerFromIds, offerToIds }) {
  const fromTeam = league.teams.find((t) => t.teamId === fromTeamId);
  const toTeam = league.teams.find((t) => t.teamId === toTeamId);
  if (!fromTeam || !toTeam) {
    throw new Error('Invalid team ids for trade analysis');
  }

  const offerFromPlayers = getPlayersByIds(league, offerFromIds);
  const offerToPlayers = getPlayersByIds(league, offerToIds);

  const beforeA = evaluateRoster(fromTeam.roster);
  const beforeB = evaluateRoster(toTeam.roster);

  const afterTeamA = applyTrade(fromTeam, offerFromIds, offerToPlayers);
  const afterTeamB = applyTrade(toTeam, offerToIds, offerFromPlayers);

  const afterA = evaluateRoster(afterTeamA.roster);
  const afterB = evaluateRoster(afterTeamB.roster);

  const offerFromValue = offerFromPlayers.reduce((s, p) => s + valuePlayerHeuristic(p), 0);
  const offerToValue = offerToPlayers.reduce((s, p) => s + valuePlayerHeuristic(p), 0);
  // FromTeam (user) perspective: net gain = value received - value sent
  const valueDelta = Math.round(offerToValue - offerFromValue);

  const scale = Math.max(20, Math.round(0.12 * Math.max(offerFromValue, offerToValue, 1)));
  let verdict = 'Fair';
  if (valueDelta >= scale) verdict = 'User gains value';
  if (valueDelta <= -scale) verdict = 'User loses value';

  // Build rationale with value first, light positional notes
  const rationale = [];
  if (valueDelta > scale) {
    rationale.push(`You gain about ${valueDelta} in net value (threshold ~${scale}).`);
  } else if (valueDelta < -scale) {
    rationale.push(`You are giving up about ${Math.abs(valueDelta)} more value than you receive (threshold ~${scale}).`);
  } else {
    rationale.push('Value looks roughly even.');
  }

  const posNotes = describePositionalChanges(beforeA, afterA);
  rationale.push(...posNotes);
  if (!posNotes.length) rationale.push('No big lineup shifts detected.');

  return {
    offerFromValue,
    offerToValue,
    valueDelta,
    verdict,
    rationale,
    fromTeam: {
      id: fromTeamId,
      name: fromTeam.name,
      before: beforeA,
      after: afterA,
    },
    toTeam: {
      id: toTeamId,
      name: toTeam.name,
      before: beforeB,
      after: afterB,
    },
    offerFromPlayers,
    offerToPlayers,
  };
}

async function analyzeTradeAsync({ league, fromTeamId, toTeamId, offerFromIds, offerToIds }) {
  const fromTeam = league.teams.find((t) => t.teamId === fromTeamId);
  const toTeam = league.teams.find((t) => t.teamId === toTeamId);
  if (!fromTeam || !toTeam) {
    throw new Error('Invalid team ids for trade analysis');
  }

  const offerFromPlayers = getPlayersByIds(league, offerFromIds);
  const offerToPlayers = getPlayersByIds(league, offerToIds);

  const beforeA = await evaluateRosterAsync(fromTeam.roster);
  const beforeB = await evaluateRosterAsync(toTeam.roster);

  const afterTeamA = applyTrade(fromTeam, offerFromIds, offerToPlayers);
  const afterTeamB = applyTrade(toTeam, offerToIds, offerFromPlayers);

  const afterA = await evaluateRosterAsync(afterTeamA.roster);
  const afterB = await evaluateRosterAsync(afterTeamB.roster);

  const offerFromValues = [];
  for (const p of offerFromPlayers) {
    const { value, source } = await valuePlayerWithYahoo(p);
    offerFromValues.push({ value, source });
  }
  const offerToValues = [];
  for (const p of offerToPlayers) {
    const { value, source } = await valuePlayerWithYahoo(p);
    offerToValues.push({ value, source });
  }
  const offerFromValue = offerFromValues.reduce((s, v) => s + v.value, 0);
  const offerToValue = offerToValues.reduce((s, v) => s + v.value, 0);
  // FromTeam (user) perspective: net gain = value received - value sent
  const valueDelta = Math.round(offerToValue - offerFromValue);

  const scale = Math.max(20, Math.round(0.12 * Math.max(offerFromValue, offerToValue, 1)));
  let verdict = 'Fair';
  if (valueDelta >= scale) verdict = 'User gains value';
  if (valueDelta <= -scale) verdict = 'User loses value';

  const rationale = [];
  if (valueDelta > scale) {
    rationale.push(`You gain about ${valueDelta} in net value (threshold ~${scale}).`);
  } else if (valueDelta < -scale) {
    rationale.push(`You are giving up about ${Math.abs(valueDelta)} more value than you receive (threshold ~${scale}).`);
  } else {
    rationale.push('Value looks roughly even.');
  }

  const posNotes = describePositionalChanges(beforeA, afterA);
  rationale.push(...posNotes);
  if (!posNotes.length) rationale.push('No big lineup shifts detected.');

  return {
    offerFromValue,
    offerToValue,
    valueDelta,
    verdict,
    rationale,
    fromTeam: {
      id: fromTeamId,
      name: fromTeam.name,
      before: beforeA,
      after: afterA,
    },
    toTeam: {
      id: toTeamId,
      name: toTeam.name,
      before: beforeB,
      after: afterB,
    },
    offerFromPlayers,
    offerToPlayers,
    valuationSources: {
      usesYahoo: !!yahooValueFetcher,
    },
  };
}

function describePositionalChanges(beforeEval, afterEval) {
  const notes = [];
  const positions = Object.keys(beforeEval.scores || {});
  positions.forEach((pos) => {
    const before = beforeEval.scores[pos] || { starterScore: 0, depthScore: 0 };
    const after = afterEval.scores[pos] || { starterScore: 0, depthScore: 0 };
    const starterDiff = Math.round((after.starterScore || 0) - (before.starterScore || 0));
    const depthDiff = Math.round((after.depthScore || 0) - (before.depthScore || 0));
    if (starterDiff >= 8) notes.push(`Starter ${pos} improves (+${starterDiff}).`);
    if (starterDiff <= -8) notes.push(`Starter ${pos} weakens (${starterDiff}).`);
    if (depthDiff >= 10) notes.push(`Depth at ${pos} improves (+${depthDiff}).`);
    if (depthDiff <= -10) notes.push(`Depth at ${pos} drops (${depthDiff}).`);
  });
  return notes;
}

function getTeamInsights(league, teamId) {
  const team = league.teams.find((t) => t.teamId === teamId);
  if (!team) throw new Error('Invalid team id');
  return {
    teamId,
    name: team.name,
    evaluation: evaluateRoster(team.roster),
  };
}

module.exports = {
  valuePlayer: valuePlayerHeuristic,
  valuePlayerHeuristic,
  evaluateRoster,
  evaluateRosterAsync,
  analyzeTrade,
  analyzeTradeAsync,
  getTeamInsights,
  setYahooValueFetcher,
};
