/* ============================================================
   EFL ENGINE — shared by the site (src/App.jsx) and the API
   (api/league.js). Pure functions only: no fetch, no DOM.

   Ratings are replayed, never stored. players[].rating is the
   SEED rating; the live rating is derived by replaying every
   played match (league + friendly) in date order. League games
   move ratings at full weight, friendlies at FRIENDLY_WEIGHT.
   Editing or deleting any old result simply re-derives
   everything, so nothing ever drifts out of sync.
   ============================================================ */

export const BYE = "__BYE__";

export const BASE_GOALS = 1.6;    // goals per player per match at even strength
export const RATING_SCALE = 22;   // rating points that shift attack/defence by a factor of e
export const HOME_FACTOR = 1.10;  // home multiplier on expected goals (league only)
export const SIMS = 1500;         // simulated seasons for title odds

export const K_LEAGUE = 5;          // max base rating swing for a league match
export const FRIENDLY_WEIGHT = 0.35; // friendlies count 35% of a league match
export const K_FRIENDLY = K_LEAGUE * FRIENDLY_WEIGHT;

export const START_COINS = 1000;
export const MIN_STAKE = 10;
export const MAX_ODDS = 25;

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ---------------------------- fixtures ---------------------------- */

export function buildFixtures(players, startDate, dateOverrides) {
  const names = players.map((p) => p.name);
  const list = [...names];
  if (list.length % 2) list.push(BYE);
  const n = list.length;
  const arr = [...list];
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      if (a !== BYE && b !== BYE) pairs.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    arr.splice(1, 0, arr.pop());
  }
  const out = [];
  const push = (h, a, round) => {
    const id = `${h}__${a}`;
    out.push({
      id,
      home: h,
      away: a,
      round,
      date: (dateOverrides && dateOverrides[id]) || addDays(startDate, (round - 1) * 7),
    });
  };
  rounds.forEach((pairs, i) => pairs.forEach(([h, a]) => push(h, a, i + 1)));
  rounds.forEach((pairs, i) => pairs.forEach(([h, a]) => push(a, h, rounds.length + i + 1)));
  return out;
}

export function addDays(iso, days) {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function withResults(fixtures, results) {
  return fixtures.map((f) => {
    const r = results[f.id];
    return r ? { ...f, hg: r.hg, ag: r.ag, ts: r.ts, played: true } : { ...f, played: false };
  });
}

export function fixtureParticipants(matchId) {
  return String(matchId).split("__");
}

/* ---------------------------- league table ---------------------------- */

export function blankRow(p) {
  return {
    name: p.name, seed: p.rating,
    p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0,
    seq: [],
  };
}

export function sortByDate(a, b) {
  return a.date.localeCompare(b.date) || (a.round || 0) - (b.round || 0) || a.id.localeCompare(b.id);
}

export function computeTable(players, matches) {
  const rows = new Map(players.map((p) => [p.name, blankRow(p)]));
  const played = matches.filter((m) => m.played).sort(sortByDate);
  for (const m of played) {
    const h = rows.get(m.home);
    const a = rows.get(m.away);
    if (!h || !a) continue;
    h.p++; a.p++;
    h.gf += m.hg; h.ga += m.ag;
    a.gf += m.ag; a.ga += m.hg;
    if (m.hg > m.ag) { h.w++; a.l++; h.pts += 3; h.seq.push("W"); a.seq.push("L"); }
    else if (m.hg < m.ag) { a.w++; h.l++; a.pts += 3; a.seq.push("W"); h.seq.push("L"); }
    else { h.d++; a.d++; h.pts++; a.pts++; h.seq.push("D"); a.seq.push("D"); }
  }
  const list = [...rows.values()];
  for (const r of list) {
    r.gd = r.gf - r.ga;
    r.winPct = r.p ? r.w / r.p : 0;
  }
  const h2h = (x, y) => {
    let xp = 0, yp = 0;
    for (const m of played) {
      const isPair =
        (m.home === x.name && m.away === y.name) || (m.home === y.name && m.away === x.name);
      if (!isPair) continue;
      const xIsHome = m.home === x.name;
      const xg = xIsHome ? m.hg : m.ag;
      const yg = xIsHome ? m.ag : m.hg;
      if (xg > yg) xp += 3; else if (xg < yg) yp += 3; else { xp++; yp++; }
    }
    return yp - xp;
  };
  list.sort(
    (a, b) =>
      b.pts - a.pts ||
      b.gd - a.gd ||
      b.gf - a.gf ||
      h2h(a, b) ||
      b.seed - a.seed ||
      a.name.localeCompare(b.name)
  );
  list.forEach((r, i) => { r.pos = i + 1; });
  return list;
}

/* ---------------------------- poisson model ---------------------------- */

const FACT = (() => {
  const f = [1];
  for (let i = 1; i <= 12; i++) f[i] = f[i - 1] * i;
  return f;
})();
const pmf = (k, l) => (Math.exp(-l) * Math.pow(l, k)) / FACT[k];

function strengthsFromRatings(ratings) {
  const vals = [...ratings.values()];
  const mean = vals.reduce((s, v) => s + v, 0) / (vals.length || 1);
  const out = new Map();
  for (const [name, r] of ratings) {
    out.set(name, {
      att: clamp(Math.exp((r - mean) / RATING_SCALE), 0.25, 3.2),
      def: clamp(Math.exp(-(r - mean) / RATING_SCALE), 0.25, 3.2),
    });
  }
  return out;
}

function lambdasFrom(strengths, home, away, homeAdv) {
  const H = strengths.get(home);
  const A = strengths.get(away);
  if (!H || !A) return [BASE_GOALS, BASE_GOALS];
  const adv = homeAdv ? HOME_FACTOR : 1;
  return [
    clamp(BASE_GOALS * H.att * A.def * adv, 0.12, 6),
    clamp((BASE_GOALS * A.att * H.def) / adv, 0.12, 6),
  ];
}

function poissonOutcome(lh, la) {
  let ph = 0, pd = 0, pa = 0;
  let best = { p: -1, h: 0, a: 0 };
  for (let i = 0; i <= 9; i++) {
    const pi = pmf(i, lh);
    for (let j = 0; j <= 9; j++) {
      const p = pi * pmf(j, la);
      if (i > j) ph += p; else if (i === j) pd += p; else pa += p;
      if (p > best.p) best = { p, h: i, a: j };
    }
  }
  const t = ph + pd + pa || 1;
  return { home: ph / t, draw: pd / t, away: pa / t, lh, la, likely: `${best.h}\u2013${best.a}` };
}

/* ---------------------------- live ratings ---------------------------- */

/**
 * Replays every played match in date order from the seed ratings.
 * League matches move ratings with K_LEAGUE, friendlies with
 * K_FRIENDLY (35%). Home advantage applies to league games only;
 * friendlies are treated as neutral venue.
 *
 * Returns Map(name -> { seed, live, delta, leagueShift, friendlyShift }).
 */
export function computeLiveRatings(players, leagueMatches, friendlies, homeAdvantage) {
  const ratings = new Map(players.map((p) => [p.name, p.rating]));
  const shifts = new Map(players.map((p) => [p.name, { league: 0, friendly: 0 }]));

  const events = [
    ...leagueMatches.filter((m) => m.played).map((m) => ({ ...m, kind: "league" })),
    ...(friendlies || [])
      .filter((m) => m.played && m.hg != null && m.ag != null)
      .map((m) => ({ ...m, kind: "friendly", round: 0 })),
  ].sort((a, b) => sortByDate(a, b) || (a.ts || 0) - (b.ts || 0));

  for (const m of events) {
    if (!ratings.has(m.home) || !ratings.has(m.away)) continue;
    const strengths = strengthsFromRatings(ratings);
    const [lh, la] = lambdasFrom(
      strengths, m.home, m.away, m.kind === "league" && homeAdvantage
    );
    const p = poissonOutcome(lh, la);
    const expectedHome = p.home + 0.5 * p.draw;
    const actualHome = m.hg > m.ag ? 1 : m.hg === m.ag ? 0.5 : 0;
    const gd = Math.abs(m.hg - m.ag);
    const margin = gd <= 1 ? 1 : 1 + 0.15 * (Math.min(gd, 4) - 1);
    const K = m.kind === "league" ? K_LEAGUE : K_FRIENDLY;
    const delta = K * margin * (actualHome - expectedHome);

    ratings.set(m.home, clamp(ratings.get(m.home) + delta, 40, 99));
    ratings.set(m.away, clamp(ratings.get(m.away) - delta, 40, 99));
    const sh = shifts.get(m.home);
    const sa = shifts.get(m.away);
    if (m.kind === "league") { sh.league += delta; sa.league -= delta; }
    else { sh.friendly += delta; sa.friendly -= delta; }
  }

  const out = new Map();
  for (const p of players) {
    const live = ratings.get(p.name);
    const s = shifts.get(p.name);
    out.set(p.name, {
      seed: p.rating,
      live,
      delta: live - p.rating,
      leagueShift: s.league,
      friendlyShift: s.friendly,
    });
  }
  return out;
}

/* ---------------------------- predictions ---------------------------- */

/**
 * Prediction strengths: live rating plus a small form multiplier
 * from the last five LEAGUE matches. Friendlies influence
 * predictions through the rating they already moved.
 */
export function computeStrengths(players, liveRatings, table) {
  const ratings = new Map(players.map((p) => [p.name, liveRatings.get(p.name)?.live ?? p.rating]));
  const base = strengthsFromRatings(ratings);
  const byName = new Map(table.map((r) => [r.name, r]));
  const out = new Map();
  for (const p of players) {
    let { att, def } = base.get(p.name);
    const row = byName.get(p.name);
    const last5 = row ? row.seq.slice(-5) : [];
    if (last5.length) {
      const ppg = last5.reduce((s, r) => s + (r === "W" ? 3 : r === "D" ? 1 : 0), 0) / last5.length;
      const form = clamp(1 + 0.05 * (ppg - 1.5), 0.9, 1.1);
      att *= form;
      def /= form;
    }
    out.set(p.name, { att: clamp(att, 0.25, 3.2), def: clamp(def, 0.25, 3.2) });
  }
  return out;
}

export function predict(home, away, strengths, homeAdvantage) {
  const [lh, la] = lambdasFrom(strengths, home, away, homeAdvantage);
  return poissonOutcome(lh, la);
}

/** Decimal odds for one outcome probability. Fair odds, capped. */
export function oddsFromProb(p) {
  if (!p || p <= 0) return MAX_ODDS;
  return clamp(Math.round(100 / p) / 100, 1.01, MAX_ODDS);
}

export function oddsForMatch(pred) {
  return {
    home: oddsFromProb(pred.home),
    draw: oddsFromProb(pred.draw),
    away: oddsFromProb(pred.away),
  };
}

/**
 * One place both the site and the API use to price a fixture from
 * raw stored state, so a bet's odds can be verified server-side.
 */
export function priceFixture(state, matchId) {
  const players = state.players || [];
  const fixtures = buildFixtures(players, state.startDate, state.dates || {});
  const fixture = fixtures.find((f) => f.id === matchId);
  if (!fixture) return null;
  const matches = withResults(fixtures, state.results || {});
  const table = computeTable(players, matches);
  const live = computeLiveRatings(players, matches, state.friendlies || [], state.homeAdvantage);
  const strengths = computeStrengths(players, live, table);
  const pred = predict(fixture.home, fixture.away, strengths, state.homeAdvantage);
  return { fixture, pred, odds: oddsForMatch(pred) };
}

/* ---------------------------- season simulation ---------------------------- */

function samplePoisson(l) {
  const L = Math.exp(-l);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

export function simulateSeason(players, matches, strengths, homeAdvantage, sims = SIMS) {
  const remaining = matches.filter((m) => !m.played);
  if (!remaining.length) return null;
  const base = new Map(
    computeTable(players, matches).map((r) => [r.name, { pts: r.pts, gd: r.gd, gf: r.gf }])
  );
  const lam = remaining.map((m) => ({
    home: m.home,
    away: m.away,
    l: lambdasFrom(strengths, m.home, m.away, homeAdvantage),
  }));
  const titles = new Map(players.map((p) => [p.name, 0]));
  const top3 = new Map(players.map((p) => [p.name, 0]));
  const acc = new Map();
  for (let s = 0; s < sims; s++) {
    for (const p of players) {
      const b = base.get(p.name);
      acc.set(p.name, { name: p.name, pts: b.pts, gd: b.gd, gf: b.gf });
    }
    for (const m of lam) {
      const hg = samplePoisson(m.l[0]);
      const ag = samplePoisson(m.l[1]);
      const h = acc.get(m.home);
      const a = acc.get(m.away);
      h.gf += hg; a.gf += ag;
      h.gd += hg - ag; a.gd += ag - hg;
      if (hg > ag) h.pts += 3; else if (ag > hg) a.pts += 3; else { h.pts++; a.pts++; }
    }
    const ranked = [...acc.values()].sort(
      (x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || Math.random() - 0.5
    );
    titles.set(ranked[0].name, titles.get(ranked[0].name) + 1);
    for (let i = 0; i < Math.min(3, ranked.length); i++) {
      top3.set(ranked[i].name, top3.get(ranked[i].name) + 1);
    }
  }
  return players
    .map((p) => ({
      name: p.name,
      title: titles.get(p.name) / sims,
      top3: top3.get(p.name) / sims,
    }))
    .sort((a, b) => b.title - a.title || b.top3 - a.top3);
}

/* ---------------------------- coins ---------------------------- */

/**
 * Balances are replayed from bets + current results, never stored.
 * Placing a bet holds the stake. When the match result exists the
 * bet settles: correct pick pays stake × odds back, wrong pick
 * loses the stake. Editing or clearing a result re-derives every
 * balance automatically.
 *
 * Returns Map(name -> { balance, held, open, settled, won, lost }).
 */
export function computeBalances(accounts, bets, results) {
  const out = new Map();
  for (const name of Object.keys(accounts || {})) {
    out.set(name, { balance: START_COINS, held: 0, open: 0, settled: 0, won: 0, lost: 0 });
  }
  for (const bet of bets || []) {
    const acc = out.get(bet.who);
    if (!acc) continue;
    const result = (results || {})[bet.matchId];
    if (!result) {
      acc.balance -= bet.stake;
      acc.held += bet.stake;
      acc.open++;
      continue;
    }
    const outcome = result.hg > result.ag ? "home" : result.hg < result.ag ? "away" : "draw";
    acc.settled++;
    if (outcome === bet.pick) {
      acc.balance += Math.round(bet.stake * (bet.odds - 1));
      acc.won++;
    } else {
      acc.balance -= bet.stake;
      acc.lost++;
    }
  }
  return out;
}

export function settleBet(bet, results) {
  const result = (results || {})[bet.matchId];
  if (!result) return { status: "open" };
  const outcome = result.hg > result.ag ? "home" : result.hg < result.ag ? "away" : "draw";
  return outcome === bet.pick
    ? { status: "won", payout: Math.round(bet.stake * bet.odds) }
    : { status: "lost", payout: 0 };
}

/* ---------------------------- misc shared ---------------------------- */

export function longestRun(seq, mark) {
  let best = 0, cur = 0;
  for (const s of seq) {
    if (s === mark) { cur++; best = Math.max(best, cur); } else cur = 0;
  }
  return best;
}

export function currentStreak(seq) {
  if (!seq.length) return null;
  const mark = seq[seq.length - 1];
  let n = 0;
  for (let i = seq.length - 1; i >= 0 && seq[i] === mark; i--) n++;
  return { mark, n };
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/* ---------------------------- state shape ---------------------------- */

export const DEFAULT_PLAYERS = [
  { name: "Drilden", rating: 95 },
  { name: "Nolan", rating: 91 },
  { name: "Chen", rating: 90 },
  { name: "Patar", rating: 86 },
  { name: "David", rating: 82 },
  { name: "Keenan", rating: 85 },
  { name: "Ian", rating: 80 },
  { name: "Harold", rating: 75 },
];

export function defaultState() {
  return {
    version: 2,
    season: "Season 1",
    startDate: "2026-08-18",
    homeAdvantage: true,
    players: DEFAULT_PLAYERS.map((p) => ({ ...p })),
    results: {},
    dates: {},
    friendlies: [],
    bets: [],
    accounts: {},
    log: [],
  };
}

/**
 * Upgrades v1 state in place. v1 friendlies mutated the stored
 * ratings directly and remembered the deltas; v2 replays instead,
 * so we unwind those deltas to recover the true seed ratings.
 */
export function migrate(state) {
  if (!state) return defaultState();
  if ((state.version || 1) >= 2) return { ...defaultState(), ...state };
  const next = { ...defaultState(), ...state, version: 2 };
  next.players = (state.players || DEFAULT_PLAYERS).map((p) => ({ ...p }));
  for (const f of state.friendlies || []) {
    if (!f.played) continue;
    const home = next.players.find((p) => p.name === f.home);
    const away = next.players.find((p) => p.name === f.away);
    if (home && typeof f.homeDelta === "number") home.rating = clamp(home.rating - f.homeDelta, 40, 99);
    if (away && typeof f.awayDelta === "number") away.rating = clamp(away.rating - f.awayDelta, 40, 99);
  }
  next.friendlies = (state.friendlies || []).map(({ homeDelta, awayDelta, ...rest }) => rest);
  next.bets = [];
  next.accounts = {};
  return next;
}
