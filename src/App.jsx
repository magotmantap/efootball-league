import { useState, useEffect, useMemo, useCallback, useRef } from "react";

/* ============================================================
   EFOOTBALL ELITE LEAGUE — everything in one file.

   TO GO ONLINE (share one league with everyone):
   deploy to Vercel, then paste your URL below. Leave it empty
   and the site runs in this browser only, which is perfect for
   trying it out.
   ============================================================ */

const API = ""; // e.g. "https://efootball-league.vercel.app/api/league"

/* ---------- settings you can tweak ---------- */
const BASE_GOALS = 1.6;      // goals per player per match at even strength
const RATING_SCALE = 22;     // rating points that change strength by a factor of e
const HOME_FACTOR = 1.10;    // home advantage multiplier
const K_LEAGUE = 5;          // how much a league match moves ratings
const FRIENDLY_WEIGHT = 0.35;// friendlies move ratings 35% as much
const K_FRIENDLY = K_LEAGUE * FRIENDLY_WEIGHT;
const START_COINS = 1000;
const MIN_STAKE = 10;
const MAX_ODDS = 25;
const SIMS = 1500;           // simulated seasons for title odds

const DEFAULT_PLAYERS = [
  { name: "Drilden", rating: 95 },
  { name: "Nolan", rating: 91 },
  { name: "Chen", rating: 90 },
  { name: "Patar", rating: 86 },
  { name: "David", rating: 82 },
  { name: "Keenan", rating: 85 },
  { name: "Ian", rating: 80 },
  { name: "Harold", rating: 75 },
];
const ADMIN = "David";

function defaultState() {
  return {
    version: 2,
    season: "Season 1",
    startDate: "2026-08-18",
    homeAdvantage: true,
    players: DEFAULT_PLAYERS.map((p) => ({ ...p })),
    results: {},     // "Home__Away" -> { hg, ag, ts }
    dates: {},       // "Home__Away" -> "YYYY-MM-DD"
    friendlies: [],
    bets: [],
    accounts: {},
    log: [],
  };
}

/* Old saves had friendly rating changes baked into players[].rating.
   We now replay ratings instead, so unwind them once. */
function migrate(s) {
  if (!s) return defaultState();
  const next = { ...defaultState(), ...s };
  if ((s.version || 1) < 2) {
    next.version = 2;
    next.players = (s.players || DEFAULT_PLAYERS).map((p) => ({ ...p }));
    for (const f of s.friendlies || []) {
      if (!f.played) continue;
      const h = next.players.find((p) => p.name === f.home);
      const a = next.players.find((p) => p.name === f.away);
      if (h && typeof f.homeDelta === "number") h.rating = clamp(h.rating - f.homeDelta, 40, 99);
      if (a && typeof f.awayDelta === "number") a.rating = clamp(a.rating - f.awayDelta, 40, 99);
    }
    next.friendlies = (s.friendlies || []).map(({ homeDelta, awayDelta, ...rest }) => rest);
    next.bets = [];
    next.accounts = {};
  }
  return next;
}

/* ============================================================
   THE MATHS
   ============================================================ */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function addDays(iso, days) {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function fmtDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

const todayISO = () => new Date().toISOString().slice(0, 10);

/* Every player plays every other twice, home and away. */
function buildFixtures(players, startDate, dateOverrides = {}) {
  const list = players.map((p) => p.name);
  if (list.length % 2) list.push("__BYE__");
  const n = list.length;
  const arr = [...list];
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      if (a !== "__BYE__" && b !== "__BYE__") pairs.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    arr.splice(1, 0, arr.pop());
  }
  const out = [];
  const add = (h, a, round) => {
    const id = `${h}__${a}`;
    out.push({ id, home: h, away: a, round, date: dateOverrides[id] || addDays(startDate, (round - 1) * 7) });
  };
  rounds.forEach((pairs, i) => pairs.forEach(([h, a]) => add(h, a, i + 1)));
  rounds.forEach((pairs, i) => pairs.forEach(([h, a]) => add(a, h, rounds.length + i + 1)));
  return out;
}

function withResults(fixtures, results) {
  return fixtures.map((f) => {
    const r = results[f.id];
    return r ? { ...f, hg: r.hg, ag: r.ag, ts: r.ts, played: true } : { ...f, played: false };
  });
}

const byDate = (a, b) =>
  a.date.localeCompare(b.date) || (a.round || 0) - (b.round || 0) || a.id.localeCompare(b.id);

function computeTable(players, matches) {
  const rows = new Map(
    players.map((p) => [p.name, {
      name: p.name, seed: p.rating,
      p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0, seq: [],
    }])
  );
  const played = matches.filter((m) => m.played).sort(byDate);
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
  const headToHead = (x, y) => {
    let xp = 0, yp = 0;
    for (const m of played) {
      const pair = (m.home === x.name && m.away === y.name) || (m.home === y.name && m.away === x.name);
      if (!pair) continue;
      const xHome = m.home === x.name;
      const xg = xHome ? m.hg : m.ag;
      const yg = xHome ? m.ag : m.hg;
      if (xg > yg) xp += 3; else if (xg < yg) yp += 3; else { xp++; yp++; }
    }
    return yp - xp;
  };
  list.sort((a, b) =>
    b.pts - a.pts || b.gd - a.gd || b.gf - a.gf ||
    headToHead(a, b) || b.seed - a.seed || a.name.localeCompare(b.name)
  );
  list.forEach((r, i) => { r.pos = i + 1; });
  return list;
}

/* Poisson: turn two expected-goal numbers into win/draw/win chances. */
const FACT = (() => { const f = [1]; for (let i = 1; i <= 12; i++) f[i] = f[i - 1] * i; return f; })();
const pmf = (k, l) => (Math.exp(-l) * Math.pow(l, k)) / FACT[k];

function strengthsOf(ratings) {
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

function expectedGoals(strengths, home, away, homeAdv) {
  const H = strengths.get(home);
  const A = strengths.get(away);
  if (!H || !A) return [BASE_GOALS, BASE_GOALS];
  const adv = homeAdv ? HOME_FACTOR : 1;
  return [
    clamp(BASE_GOALS * H.att * A.def * adv, 0.12, 6),
    clamp((BASE_GOALS * A.att * H.def) / adv, 0.12, 6),
  ];
}

function outcomeFrom(lh, la) {
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

/* Live ratings: replay every played match from the seed ratings.
   League games count full, friendlies count 35%. */
function computeLiveRatings(players, leagueMatches, friendlies, homeAdvantage) {
  const ratings = new Map(players.map((p) => [p.name, p.rating]));
  const shifts = new Map(players.map((p) => [p.name, { league: 0, friendly: 0 }]));
  const events = [
    ...leagueMatches.filter((m) => m.played).map((m) => ({ ...m, kind: "league" })),
    ...(friendlies || [])
      .filter((m) => m.played && m.hg != null && m.ag != null)
      .map((m) => ({ ...m, kind: "friendly", round: 0 })),
  ].sort((a, b) => byDate(a, b) || (a.ts || 0) - (b.ts || 0));

  for (const m of events) {
    if (!ratings.has(m.home) || !ratings.has(m.away)) continue;
    const [lh, la] = expectedGoals(
      strengthsOf(ratings), m.home, m.away, m.kind === "league" && homeAdvantage
    );
    const o = outcomeFrom(lh, la);
    const expected = o.home + 0.5 * o.draw;
    const actual = m.hg > m.ag ? 1 : m.hg === m.ag ? 0.5 : 0;
    const gd = Math.abs(m.hg - m.ag);
    const margin = gd <= 1 ? 1 : 1 + 0.15 * (Math.min(gd, 4) - 1);
    const K = m.kind === "league" ? K_LEAGUE : K_FRIENDLY;
    const delta = K * margin * (actual - expected);

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
    out.set(p.name, {
      seed: p.rating, live, delta: live - p.rating,
      leagueShift: shifts.get(p.name).league,
      friendlyShift: shifts.get(p.name).friendly,
    });
  }
  return out;
}

/* Prediction strength = live rating, nudged by the last five league games. */
function computeStrengths(players, liveRatings, table) {
  const base = strengthsOf(
    new Map(players.map((p) => [p.name, liveRatings.get(p.name)?.live ?? p.rating]))
  );
  const byName = new Map(table.map((r) => [r.name, r]));
  const out = new Map();
  for (const p of players) {
    let { att, def } = base.get(p.name);
    const last5 = (byName.get(p.name)?.seq || []).slice(-5);
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

function predict(home, away, strengths, homeAdvantage) {
  const [lh, la] = expectedGoals(strengths, home, away, homeAdvantage);
  return outcomeFrom(lh, la);
}

/* Odds: a 25% chance pays 4x. Favourites pay little, underdogs pay big. */
const oddsFromProb = (p) => (!p || p <= 0 ? MAX_ODDS : clamp(Math.round(100 / p) / 100, 1.01, MAX_ODDS));
const oddsForMatch = (pred) => ({
  home: oddsFromProb(pred.home),
  draw: oddsFromProb(pred.draw),
  away: oddsFromProb(pred.away),
});

function samplePoisson(l) {
  const L = Math.exp(-l);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

function simulateSeason(players, matches, strengths, homeAdvantage, sims = SIMS) {
  const remaining = matches.filter((m) => !m.played);
  if (!remaining.length) return null;
  const base = new Map(
    computeTable(players, matches).map((r) => [r.name, { pts: r.pts, gd: r.gd, gf: r.gf }])
  );
  const lam = remaining.map((m) => ({
    home: m.home, away: m.away, l: expectedGoals(strengths, m.home, m.away, homeAdvantage),
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
    for (let i = 0; i < Math.min(3, ranked.length); i++) top3.set(ranked[i].name, top3.get(ranked[i].name) + 1);
  }
  return players
    .map((p) => ({ name: p.name, title: titles.get(p.name) / sims, top3: top3.get(p.name) / sims }))
    .sort((a, b) => b.title - a.title || b.top3 - a.top3);
}

/* Coin balances are replayed from the bet list, so fixing a
   wrong score automatically fixes everyone's coins. */
function computeBalances(accounts, bets, results) {
  const out = new Map();
  for (const name of Object.keys(accounts || {})) {
    out.set(name, { balance: START_COINS, held: 0, open: 0, won: 0, lost: 0 });
  }
  for (const bet of bets || []) {
    const acc = out.get(bet.who);
    if (!acc) continue;
    const r = (results || {})[bet.matchId];
    if (!r) { acc.balance -= bet.stake; acc.held += bet.stake; acc.open++; continue; }
    const outcome = r.hg > r.ag ? "home" : r.hg < r.ag ? "away" : "draw";
    if (outcome === bet.pick) { acc.balance += Math.round(bet.stake * (bet.odds - 1)); acc.won++; }
    else { acc.balance -= bet.stake; acc.lost++; }
  }
  return out;
}

const longestRun = (seq, mark) => {
  let best = 0, cur = 0;
  for (const s of seq) { if (s === mark) { cur++; best = Math.max(best, cur); } else cur = 0; }
  return best;
};

const currentStreak = (seq) => {
  if (!seq.length) return null;
  const mark = seq[seq.length - 1];
  let n = 0;
  for (let i = seq.length - 1; i >= 0 && seq[i] === mark; i--) n++;
  return { mark, n };
};

const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/* ============================================================
   SAVING AND LOADING
   With API set, everything goes through the server.
   Without it, everything stays in this browser.
   ============================================================ */

const LOCAL_KEY = "efl:local:v2";
const SESSION_KEY = "efl:session:v2";
const online = Boolean(API);

async function hashPassword(password, salt) {
  const text = `${salt}:${password}`;
  if (globalThis.crypto?.subtle) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return String(h);
}

function readLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? migrate(JSON.parse(raw)) : null;
  } catch { return null; }
}
function writeLocal(state) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(state)); } catch { /* full or blocked */ }
  return state;
}
function addLog(state, who, text) {
  state.log = [
    { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, who, text, ts: Date.now() },
    ...(state.log || []),
  ].slice(0, 120);
}

async function loadState() {
  if (!online) return readLocal() || writeLocal(defaultState());
  const res = await fetch(API);
  const data = await res.json().catch(() => ({}));
  return data.state ? migrate(data.state) : defaultState();
}

/** One door for every change. Returns the new state or throws a readable error. */
async function send(action, body) {
  if (online) {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }
  return handleLocally(action, body);
}

async function handleLocally(action, body) {
  const state = readLocal() || defaultState();
  const { name, password } = body;

  if (action === "claim") {
    const clean = String(name || "").trim();
    if (!/^[A-Za-z0-9 _-]{2,16}$/.test(clean)) throw new Error("Name must be 2–16 letters or numbers.");
    if (!password || password.length < 4) throw new Error("Password must be at least 4 characters.");
    if (Object.keys(state.accounts).some((n) => n.toLowerCase() === clean.toLowerCase())) {
      throw new Error("That account is already taken.");
    }
    const names = state.players.map((p) => p.name);
    const isPlayer = names.includes(clean);
    if (!isPlayer && names.some((n) => n.toLowerCase() === clean.toLowerCase())) {
      throw new Error("That name belongs to a league player.");
    }
    const role = isPlayer ? (clean === ADMIN ? "admin" : "player") : "spectator";
    const salt = Math.random().toString(36).slice(2, 12);
    state.accounts[clean] = { salt, hash: await hashPassword(password, salt), role, createdTs: Date.now() };
    addLog(state, clean, `joined as ${role}`);
    return { role, state: writeLocal(state) };
  }

  const acc = state.accounts[name];
  const ok = acc && (await hashPassword(password, acc.salt)) === acc.hash;
  if (!ok) throw new Error(action === "login" ? "Wrong name or password." : "Please sign in again.");
  if (action === "login") return { role: acc.role, state };

  if (action === "save") {
    if (acc.role === "spectator") throw new Error("Spectators can watch and bet, but not edit.");
    const merged = migrate(body.state);
    merged.accounts = state.accounts;
    merged.bets = state.bets;
    return { state: writeLocal(merged) };
  }

  if (action === "bet") {
    const { matchId, pick, stake, odds } = body.bet;
    const s = Math.round(Number(stake));
    if (!["home", "draw", "away"].includes(pick)) throw new Error("Pick home, draw, or away.");
    if (!Number.isFinite(s) || s < MIN_STAKE) throw new Error(`Minimum stake is ${MIN_STAKE} coins.`);
    if (state.results[matchId]) throw new Error("That match has already been played.");
    if (String(matchId).split("__").includes(name)) throw new Error("You can't bet on your own match.");
    if (state.bets.some((b) => b.who === name && b.matchId === matchId && !state.results[b.matchId])) {
      throw new Error("You already have a bet on this match. Cancel it first.");
    }
    const balance = computeBalances(state.accounts, state.bets, state.results).get(name).balance;
    if (s > balance) throw new Error(`Not enough coins — you have ${balance}.`);
    const safeOdds = clamp(Number(odds) || 2, 1.01, MAX_ODDS);
    state.bets.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      who: name, matchId, pick, stake: s, odds: safeOdds, ts: Date.now(),
    });
    addLog(state, name, `bet ${s} coins at ${safeOdds.toFixed(2)}x`);
    return { state: writeLocal(state) };
  }

  if (action === "cancelbet") {
    const i = state.bets.findIndex((b) => b.id === body.id);
    if (i < 0) throw new Error("Bet not found.");
    if (state.bets[i].who !== name) throw new Error("That isn't your bet.");
    if (state.results[state.bets[i].matchId]) throw new Error("That match already has a result.");
    const bet = state.bets.splice(i, 1)[0];
    addLog(state, name, `cancelled a ${bet.stake}-coin bet`);
    return { state: writeLocal(state) };
  }

  if (acc.role !== "admin") throw new Error("Admins only.");
  if (action === "voidbet") {
    const i = state.bets.findIndex((b) => b.id === body.id);
    if (i < 0) throw new Error("Bet not found.");
    const bet = state.bets.splice(i, 1)[0];
    addLog(state, name, `voided ${bet.who}'s ${bet.stake}-coin bet`);
  }
  if (action === "resetpw") {
    if (!state.accounts[body.target]) throw new Error("No such account.");
    delete state.accounts[body.target];
    addLog(state, name, `reset ${body.target}'s password`);
  }
  if (action === "removeaccount") {
    const t = state.accounts[body.target];
    if (!t) throw new Error("No such account.");
    if (t.role === "admin") throw new Error("You can't remove an admin.");
    delete state.accounts[body.target];
    state.bets = state.bets.filter((b) => b.who !== body.target);
    addLog(state, name, `removed ${body.target}'s account`);
  }
  if (action === "newseason") {
    state.results = {}; state.friendlies = []; state.bets = []; state.log = [];
    addLog(state, name, "started a new season");
  }
  return { state: writeLocal(state) };
}

const readSession = () => {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
};
const writeSession = (s) => {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* blocked */ }
};

/* ============================================================
   THE APP
   ============================================================ */

const TABS = [
  ["league", "League"], ["friendly", "Friendly"], ["predict", "Predictions"],
  ["coins", "Coins"], ["players", "Players"], ["stats", "Stats"], ["log", "Activity"],
];

export default function App() {
  const [state, setState] = useState(defaultState);
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState("league");
  const [sync, setSync] = useState("loading");
  const [error, setError] = useState(null);
  const [authOpen, setAuthOpen] = useState(false);
  const busyEditing = useRef(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const loaded = await loadState();
        if (alive && loaded) { setState(loaded); setSync("ok"); }
      } catch {
        if (alive) setSync("error");
      }
      const saved = readSession();
      if (saved?.name && saved?.password) {
        try {
          const res = await send("login", { name: saved.name, password: saved.password });
          if (alive) {
            setSession({ ...saved, role: res.role });
            if (res.state) setState(migrate(res.state));
          }
        } catch { writeSession(null); }
      }
      if (alive) setReady(true);
    })();
    return () => { alive = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (busyEditing.current) return;
    try {
      const loaded = await loadState();
      if (loaded) {
        setState((prev) => (JSON.stringify(prev) === JSON.stringify(loaded) ? prev : loaded));
        setSync("ok");
      }
    } catch { /* keep showing what we have */ }
  }, []);

  useEffect(() => {
    if (!ready || !online) return;
    const id = setInterval(refresh, 20000);
    return () => clearInterval(id);
  }, [ready, refresh]);

  const auth = session ? { name: session.name, password: session.password } : null;
  const isAdmin = session?.role === "admin";

  const run = useCallback(async (action, body) => {
    setSync("saving");
    setError(null);
    try {
      const res = await send(action, { ...auth, ...body });
      if (res?.state) setState(migrate(res.state));
      setSync("ok");
      return true;
    } catch (e) {
      setSync("error");
      setError(e.message || "That didn't save.");
      return false;
    }
  }, [auth]);

  /* Change league data: grab the latest, apply the edit, save it back. */
  const commit = useCallback(async (change, entry) => {
    if (!auth) { setError("Sign in to make changes."); return false; }
    setSync("saving");
    setError(null);
    try {
      const latest = migrate(JSON.parse(JSON.stringify((await loadState()) || state)));
      change(latest);
      if (entry) addLog(latest, entry.who, entry.text);
      const res = await send("save", { ...auth, state: latest });
      if (res?.state) setState(migrate(res.state));
      setSync("ok");
      return true;
    } catch (e) {
      setSync("error");
      setError(e.message || "That didn't save.");
      return false;
    }
  }, [auth, state]);

  const signIn = useCallback(async (mode, name, password) => {
    try {
      const res = await send(mode, { name: String(name).trim(), password });
      const next = { name: String(name).trim(), password, role: res.role };
      setSession(next);
      writeSession(next);
      if (res.state) setState(migrate(res.state));
      setAuthOpen(false);
      return null;
    } catch (e) {
      return e.message || "Sign-in failed.";
    }
  }, []);

  const signOut = useCallback(() => { setSession(null); writeSession(null); }, []);

  /* everything the pages need, worked out once */
  const fixtures = useMemo(
    () => buildFixtures(state.players, state.startDate, state.dates || {}),
    [state.players, state.startDate, state.dates]
  );
  const matches = useMemo(() => withResults(fixtures, state.results || {}), [fixtures, state.results]);
  const table = useMemo(() => computeTable(state.players, matches), [state.players, matches]);
  const liveRatings = useMemo(
    () => computeLiveRatings(state.players, matches, state.friendlies || [], state.homeAdvantage),
    [state.players, matches, state.friendlies, state.homeAdvantage]
  );
  const strengths = useMemo(
    () => computeStrengths(state.players, liveRatings, table),
    [state.players, liveRatings, table]
  );
  const predictor = useCallback(
    (h, a) => predict(h, a, strengths, state.homeAdvantage),
    [strengths, state.homeAdvantage]
  );
  const balances = useMemo(
    () => computeBalances(state.accounts || {}, state.bets || [], state.results || {}),
    [state.accounts, state.bets, state.results]
  );

  const canEditMatch = useCallback(
    (m) => Boolean(session) && (isAdmin || session.name === m.home || session.name === m.away),
    [session, isAdmin]
  );

  const shared = {
    state, session, isAdmin, commit, balances, busyEditing,
    matches, table, strengths, liveRatings, predictor, canEditMatch,
    openSignIn: () => setAuthOpen(true),
    placeBet: (bet) => run("bet", { bet }),
    cancelBet: (id) => run("cancelbet", { id }),
    adminAction: (action, extra) => run(action, extra),
  };

  return (
    <div className="efl">
      <Styles />
      <div className="wrap">
        <Header
          state={state}
          session={session}
          balance={session ? balances.get(session.name) : null}
          sync={sync}
          played={matches.filter((m) => m.played).length}
          total={matches.length}
          onRefresh={refresh}
          onSignIn={() => setAuthOpen(true)}
          onSignOut={signOut}
        />

        {!online && (
          <p className="banner">
            Saved in this browser only. To share one league with everyone, deploy it and paste your
            web address into the <code>API</code> line at the top of App.jsx.
          </p>
        )}

        {authOpen && !session && (
          <AuthPanel state={state} onSubmit={signIn} onClose={() => setAuthOpen(false)} />
        )}
        {error && <p className="alert" role="status">{error}</p>}

        <nav className="tabs" aria-label="Sections">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              className={`tab${tab === id ? " on" : ""}`}
              onClick={() => setTab(id)}
              aria-current={tab === id ? "page" : undefined}
            >
              {label}
            </button>
          ))}
        </nav>

        {!ready ? (
          <p className="muted pad">Loading the season…</p>
        ) : (
          <>
            {tab === "league" && <LeagueView {...shared} />}
            {tab === "friendly" && <Friendly {...shared} />}
            {tab === "predict" && <Predictions {...shared} />}
            {tab === "coins" && <Coins {...shared} />}
            {tab === "players" && <Players {...shared} />}
            {tab === "stats" && <Stats {...shared} />}
            {tab === "log" && <Activity {...shared} />}
          </>
        )}

        <footer className="foot">
          <p>
            Anyone can watch. Sign in to edit results or bet coins — every change is logged under
            your name. Coins are just for fun, never real money.
          </p>
        </footer>
      </div>
    </div>
  );
}

/* ---------------------------- header + sign in ---------------------------- */

function Header({ state, session, balance, sync, played, total, onRefresh, onSignIn, onSignOut }) {
  const label = { loading: "Loading", ok: online ? "In sync" : "Saved", saving: "Saving…", error: "Not saved" }[sync];
  return (
    <header className="head">
      <div className="mark" aria-hidden="true">
        <svg viewBox="0 0 40 28" width="40" height="28">
          <rect x="0.5" y="0.5" width="39" height="27" rx="2" fill="none" stroke="currentColor" strokeOpacity="0.5" />
          <line x1="20" y1="0.5" x2="20" y2="27.5" stroke="currentColor" strokeOpacity="0.5" />
          <circle cx="20" cy="14" r="6" fill="none" stroke="currentColor" />
          <path d="M0.5 8.5H7V19.5H0.5M39.5 8.5H33V19.5H39.5" fill="none" stroke="currentColor" strokeOpacity="0.5" />
        </svg>
      </div>
      <div className="head-text">
        <p className="eyebrow">{state.season} · {state.players.length} players · {played}/{total} played</p>
        <h1>EFootball Elite League</h1>
      </div>
      <div className="head-side">
        <span className={`pill sync-${sync}`}>{label}</span>
        <button className="ghost" onClick={onRefresh}>Refresh</button>
        {session ? (
          <>
            <span className="userchip">
              <b>{session.name}</b>
              <span className="rolechip">{session.role}</span>
              {balance && <span className="mono coinchip">{balance.balance}c</span>}
            </span>
            <button className="ghost" onClick={onSignOut}>Sign out</button>
          </>
        ) : (
          <button className="primary" onClick={onSignIn}>Sign in</button>
        )}
      </div>
    </header>
  );
}

function AuthPanel({ state, onSubmit, onClose }) {
  const accounts = state.accounts || {};
  const playerNames = state.players.map((p) => p.name);
  const [picked, setPicked] = useState("");
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const name = picked || typed.trim();
  const mode = name ? (accounts[name] ? "login" : "claim") : null;

  const submit = async () => {
    if (!name || !password || busy) return;
    if (mode === "claim" && password !== confirm) { setErr("Those passwords don't match."); return; }
    setBusy(true);
    const failure = await onSubmit(mode, name, password);
    setBusy(false);
    if (failure) setErr(failure);
  };

  return (
    <section className="card ident">
      <div className="card-head bar">
        <div>
          <h2 className="h2">Sign in</h2>
          <p className="muted sm">
            First time? Pick your name and choose a password — that claims your account. No
            passwords live in the code.
          </p>
        </div>
        <button className="ghost" onClick={onClose}>Close</button>
      </div>

      <p className="lbl">League players</p>
      <div className="chips">
        {playerNames.map((p) => (
          <button
            key={p}
            className={`chip${picked === p ? " sel" : ""}`}
            onClick={() => { setPicked(picked === p ? "" : p); setTyped(""); setErr(null); }}
          >
            {p}
            <span className={`chipstate ${accounts[p] ? "c" : "u"}`}>{accounts[p] ? "claimed" : "free"}</span>
          </button>
        ))}
      </div>

      <label className="field" style={{ marginTop: 12 }}>
        <span className="lbl">Not a player? Watch and bet under any name</span>
        <input
          className="input"
          value={typed}
          placeholder="e.g. Maya"
          maxLength={16}
          onChange={(e) => { setTyped(e.target.value); setPicked(""); setErr(null); }}
        />
      </label>

      {name && (
        <div className="authform">
          <p className="sm muted">
            {mode === "login"
              ? <>Welcome back, <b>{name}</b>. Enter your password.</>
              : <>Claiming <b>{name}</b> — choose a password (4 characters or more).</>}
          </p>
          <div className="authrow">
            <input
              className="input" type="password" placeholder="Password" value={password}
              onChange={(e) => { setPassword(e.target.value); setErr(null); }}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            {mode === "claim" && (
              <input
                className="input" type="password" placeholder="Repeat password" value={confirm}
                onChange={(e) => { setConfirm(e.target.value); setErr(null); }}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
            )}
            <button className="primary" onClick={submit} disabled={busy || !password}>
              {busy ? "…" : mode === "login" ? "Sign in" : "Claim account"}
            </button>
          </div>
          {err && <p className="alert">{err}</p>}
        </div>
      )}

      <p className="muted sm" style={{ marginTop: 12 }}>
        Players edit the matches they play in. Spectators watch and bet. {ADMIN} is the admin and
        can fix anything.
      </p>
    </section>
  );
}

/* ---------------------------- league ---------------------------- */

function LeagueView(props) {
  const [sub, setSub] = useState("table");
  return (
    <section>
      <div className="seg" style={{ marginBottom: 14, display: "inline-flex" }}>
        {[["table", "Table"], ["fixtures", "Fixtures"]].map(([k, l]) => (
          <button key={k} className={`segb${sub === k ? " on" : ""}`} onClick={() => setSub(k)}>{l}</button>
        ))}
      </div>
      {sub === "table"
        ? <TableView table={props.table} total={props.matches.length} />
        : <Fixtures {...props} />}
    </section>
  );
}

function TableView({ table, total }) {
  const done = total > 0 && table.reduce((s, r) => s + r.p, 0) / 2 === total;
  return (
    <div className="card">
      <div className="card-head">
        <h2 className="h2">League table</h2>
        <p className="muted sm">
          League matches only — friendlies never appear here. Points, then goal difference, then
          goals scored, then head-to-head.
        </p>
      </div>
      <div className="scroll">
        <table className="grid">
          <thead>
            <tr>
              <th className="num">#</th><th>Player</th><th className="num">P</th>
              <th className="num sm-hide">W</th><th className="num sm-hide">D</th><th className="num sm-hide">L</th>
              <th className="num sm-hide">GF</th><th className="num sm-hide">GA</th>
              <th className="num">GD</th><th className="num pts">Pts</th><th>Form</th>
            </tr>
          </thead>
          <tbody>
            {table.map((r, i) => (
              <tr key={r.name} className={`row-in${r.pos === 1 ? " lead" : ""}`} style={{ animationDelay: `${i * 40}ms` }}>
                <td className="num pos">{r.pos}</td>
                <td className="name">
                  {r.name}
                  {done && r.pos === 1 && <span className="crown">Champion</span>}
                </td>
                <td className="num">{r.p}</td>
                <td className="num sm-hide">{r.w}</td>
                <td className="num sm-hide">{r.d}</td>
                <td className="num sm-hide">{r.l}</td>
                <td className="num sm-hide">{r.gf}</td>
                <td className="num sm-hide">{r.ga}</td>
                <td className="num">{r.gd > 0 ? `+${r.gd}` : r.gd}</td>
                <td className="num pts">{r.pts}</td>
                <td><Form seq={r.seq} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.every((r) => r.p === 0) && (
        <p className="empty">No results yet. Open Fixtures and add the first score.</p>
      )}
    </div>
  );
}

function Form({ seq }) {
  const last = seq.slice(-5);
  if (!last.length) return <span className="muted mono sm">—</span>;
  return (
    <span className="form">
      {last.map((s, i) => (
        <span key={i} className={`dot d-${s}`} title={s === "W" ? "Win" : s === "D" ? "Draw" : "Loss"}>{s}</span>
      ))}
    </span>
  );
}

function Fixtures({ state, matches, predictor, session, isAdmin, canEditMatch, commit, busyEditing }) {
  const [open, setOpen] = useState(null);
  const [filter, setFilter] = useState("all");

  const rounds = useMemo(() => {
    const map = new Map();
    for (const m of matches) {
      if (!map.has(m.round)) map.set(m.round, []);
      map.get(m.round).push(m);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [matches]);

  const shown = rounds.filter(([, ms]) => {
    if (filter === "upcoming") return ms.some((m) => !m.played);
    if (filter === "played") return ms.some((m) => m.played);
    return true;
  });

  return (
    <div>
      <div className="card-head bar">
        <div>
          <h2 className="h2">Fixtures</h2>
          <p className="muted sm">
            Everyone plays everyone twice. You can enter scores for the matches you play in
            {isAdmin ? "; as admin you can edit any of them" : ""}.
          </p>
        </div>
        <div className="seg">
          {[["all", "All"], ["upcoming", "To play"], ["played", "Played"]].map(([k, l]) => (
            <button key={k} className={`segb${filter === k ? " on" : ""}`} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
      </div>

      {isAdmin && (
        <div className="card sub">
          <label className="field">
            <span className="lbl">Season opens</span>
            <input
              type="date" className="input" value={state.startDate}
              onChange={(e) => {
                const v = e.target.value;
                if (v) commit((s) => { s.startDate = v; }, { who: session.name, text: `Moved the season opener to ${fmtDate(v)}` });
              }}
            />
          </label>
          <p className="muted sm">This shifts every matchday that hasn't been given its own date.</p>
        </div>
      )}

      {shown.map(([round, ms]) => {
        const playedIn = ms.filter((m) => m.played).length;
        return (
          <div className="card" key={round}>
            <div className="round-head">
              <h3 className="h3">Matchday {round}</h3>
              <span className="mono sm muted">{fmtDate(ms[0].date)}</span>
              <span className={`pill ${playedIn === ms.length ? "done" : "todo"}`}>{playedIn}/{ms.length} played</span>
            </div>
            <ul className="matches">
              {ms.map((m) => (
                <MatchRow
                  key={m.id} m={m} pred={predictor(m.home, m.away)}
                  open={open === m.id} onToggle={() => setOpen(open === m.id ? null : m.id)}
                  canEdit={canEditMatch(m)} signedIn={Boolean(session)} me={session?.name}
                  commit={commit} busyEditing={busyEditing}
                />
              ))}
            </ul>
          </div>
        );
      })}
      {!shown.length && <p className="empty">Nothing here yet.</p>}
    </div>
  );
}

function MatchRow({ m, pred, open, onToggle, canEdit, signedIn, me, commit, busyEditing }) {
  return (
    <li className={`match${open ? " open" : ""}`}>
      <button className="match-btn" onClick={onToggle} aria-expanded={open}>
        <span className="side home">{m.home}</span>
        <span className="score">
          {m.played ? <span className="mono ft">{m.hg}<i>–</i>{m.ag}</span> : <span className="mono vs">vs</span>}
        </span>
        <span className="side away">{m.away}</span>
        <span className="match-meta">
          {m.played ? <span className="pill done">FT</span> : <ProbBar pred={pred} compact />}
        </span>
      </button>
      {open && (
        <MatchEditor
          m={m} pred={pred} canEdit={canEdit} signedIn={signedIn}
          me={me} commit={commit} busyEditing={busyEditing}
        />
      )}
    </li>
  );
}

function MatchEditor({ m, pred, canEdit, signedIn, me, commit, busyEditing }) {
  const [hg, setHg] = useState(m.played ? String(m.hg) : "");
  const [ag, setAg] = useState(m.played ? String(m.ag) : "");
  const [date, setDate] = useState(m.date);

  useEffect(() => {
    busyEditing.current = true;
    return () => { busyEditing.current = false; };
  }, [busyEditing]);

  const valid = hg !== "" && ag !== "";

  return (
    <div className="editor">
      <div className="pred-full">
        <ProbBar pred={pred} />
        <p className="mono sm muted">
          Expected goals {pred.lh.toFixed(2)} – {pred.la.toFixed(2)} · most likely {pred.likely}
        </p>
      </div>

      {!canEdit ? (
        <p className="muted sm">
          {signedIn
            ? "Only the two players in this match, or an admin, can enter the score."
            : "Sign in to add or change results."}
        </p>
      ) : (
        <>
          <div className="score-edit">
            <Stepper label={m.home} value={hg} onChange={setHg} tone="home" />
            <span className="dash mono">–</span>
            <Stepper label={m.away} value={ag} onChange={setAg} tone="away" />
          </div>
          <div className="editor-row">
            <label className="field">
              <span className="lbl">Match date</span>
              <input
                type="date" className="input" value={date}
                onChange={(e) => {
                  const v = e.target.value;
                  setDate(v);
                  if (v && v !== m.date) {
                    commit((s) => { s.dates[m.id] = v; }, { who: me, text: `Moved ${m.home} v ${m.away} to ${fmtDate(v)}` });
                  }
                }}
              />
            </label>
            <div className="btns">
              <button
                className="primary"
                disabled={!valid}
                onClick={() => {
                  const h = clamp(Math.round(Number(hg)), 0, 30);
                  const a = clamp(Math.round(Number(ag)), 0, 30);
                  commit(
                    (s) => {
                      s.results[m.id] = { hg: h, ag: a, ts: Date.now() };
                      if (date !== m.date) s.dates[m.id] = date;
                    },
                    { who: me, text: `${m.home} ${h}–${a} ${m.away} · MD${m.round}` }
                  );
                }}
              >
                {m.played ? "Update result" : "Save result"}
              </button>
              {m.played && (
                <button
                  className="ghost danger"
                  onClick={() => commit(
                    (s) => { delete s.results[m.id]; },
                    { who: me, text: `Cleared ${m.home} v ${m.away} · MD${m.round}` }
                  )}
                >
                  Clear result
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Stepper({ label, value, onChange, tone }) {
  const n = value === "" ? 0 : Number(value);
  return (
    <div className={`stepper ${tone}`}>
      <span className="stepper-name">{label}</span>
      <div className="stepper-ctl">
        <button className="step" onClick={() => onChange(String(Math.max(0, n - 1)))} aria-label={`One fewer goal for ${label}`}>−</button>
        <input
          className="goal mono" inputMode="numeric" value={value} placeholder="0"
          onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
          aria-label={`Goals for ${label}`}
        />
        <button className="step" onClick={() => onChange(String(Math.min(30, n + 1)))} aria-label={`One more goal for ${label}`}>+</button>
      </div>
    </div>
  );
}

/* ---------------------------- friendly ---------------------------- */

function Friendly({ state, session, isAdmin, commit, busyEditing }) {
  const playerNames = useMemo(() => state.players.map((p) => p.name), [state.players]);
  const friendlies = useMemo(
    () => [...(state.friendlies || [])].sort((a, b) => (b.ts || 0) - (a.ts || 0)),
    [state.friendlies]
  );

  const me = session?.name;
  const canAdd = Boolean(session) && session.role !== "spectator";
  const canTouch = (f) => Boolean(session) && (isAdmin || f.home === me || f.away === me);

  const [editingId, setEditingId] = useState(null);
  const [home, setHome] = useState("");
  const [away, setAway] = useState("");
  const [date, setDate] = useState(todayISO());
  const [hg, setHg] = useState("");
  const [ag, setAg] = useState("");

  useEffect(() => {
    busyEditing.current = editingId !== null || hg !== "" || ag !== "";
    return () => { busyEditing.current = false; };
  }, [busyEditing, editingId, hg, ag]);

  const selected = friendlies.find((m) => m.id === editingId) || null;
  useEffect(() => {
    if (selected) {
      setHome(selected.home); setAway(selected.away);
      setDate(selected.date || todayISO());
      setHg(selected.played ? String(selected.hg) : "");
      setAg(selected.played ? String(selected.ag) : "");
    } else {
      setHome(me && playerNames.includes(me) ? me : playerNames[0] || "");
      setAway(playerNames.find((n) => n !== me) || playerNames[1] || "");
      setDate(todayISO()); setHg(""); setAg("");
    }
  }, [editingId, selected, playerNames, me]);

  const involvesMe = isAdmin || home === me || away === me;
  const scored = hg !== "" && ag !== "";
  const canSave = canAdd && involvesMe && home && away && home !== away && date;

  const save = () => {
    if (!canSave) return;
    const h = scored ? clamp(Math.round(Number(hg)), 0, 30) : null;
    const a = scored ? clamp(Math.round(Number(ag)), 0, 30) : null;
    const now = Date.now();
    const id = editingId || `f-${now}-${Math.random().toString(36).slice(2, 6)}`;
    commit(
      (s) => {
        if (!Array.isArray(s.friendlies)) s.friendlies = [];
        const match = { id, home, away, date, played: scored, ts: now };
        if (scored) { match.hg = h; match.ag = a; }
        const i = s.friendlies.findIndex((m) => m.id === id);
        if (i >= 0) s.friendlies[i] = match; else s.friendlies.unshift(match);
      },
      {
        who: me,
        text: scored
          ? `Friendly: ${home} ${h}–${a} ${away}`
          : `Friendly booked: ${home} vs ${away} on ${fmtDate(date)}`,
      }
    );
    setEditingId(null);
  };

  return (
    <section>
      <div className="card-head bar">
        <div>
          <h2 className="h2">Friendly matches</h2>
          <p className="muted sm">
            Games outside the league. They never touch the table or your points — but a played
            friendly still moves both ratings, at {Math.round(FRIENDLY_WEIGHT * 100)}% of a league
            match, so the predictions keep learning.
          </p>
        </div>
      </div>

      {canAdd ? (
        <div className="card">
          <div className="friendly-grid">
            <div className="friendly-pair">
              <label className="field">
                <span className="lbl">Home player</span>
                <select className="input" value={home} onChange={(e) => setHome(e.target.value)}>
                  {playerNames.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <span className="mono muted pairvs">vs</span>
              <label className="field">
                <span className="lbl">Away player</span>
                <select className="input" value={away} onChange={(e) => setAway(e.target.value)}>
                  {playerNames.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            </div>

            <div className="friendly-pair">
              <label className="field">
                <span className="lbl">Date</span>
                <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
              </label>
              <span className="mono muted pairvs">score</span>
              <div className="score-edit" style={{ justifyContent: "flex-start" }}>
                <Stepper label={home || "Home"} value={hg} onChange={setHg} tone="home" />
                <span className="dash mono">–</span>
                <Stepper label={away || "Away"} value={ag} onChange={setAg} tone="away" />
              </div>
            </div>

            {!involvesMe && (
              <p className="muted sm">Pick yourself as one of the two players to save this.</p>
            )}
            <div className="btns">
              <button className="primary" onClick={save} disabled={!canSave}>
                {editingId ? "Update friendly" : scored ? "Save friendly" : "Book friendly"}
              </button>
              {editingId && <button className="ghost" onClick={() => setEditingId(null)}>Cancel</button>}
            </div>
          </div>
        </div>
      ) : (
        <div className="card sub">
          <p className="muted sm">{session ? "Spectators can't add friendlies." : "Sign in to add a friendly."}</p>
        </div>
      )}

      <div className="card">
        <div className="card-head"><h3 className="h3">All friendlies</h3></div>
        {!friendlies.length ? (
          <p className="empty">No friendlies yet.</p>
        ) : (
          <ul className="matches">
            {friendlies.map((m) => (
              <li key={m.id} className="match">
                <div className="match-btn asrow">
                  <span className="side home">{m.home}</span>
                  <span className="score">
                    {m.played ? <span className="mono ft">{m.hg}<i>–</i>{m.ag}</span> : <span className="mono vs">vs</span>}
                  </span>
                  <span className="side away">{m.away}</span>
                  <span className="match-meta friendlymeta">
                    <span className="mono sm muted">{fmtDate(m.date)}</span>
                    {!m.played && <span className="pill todo">Booked</span>}
                    {canTouch(m) && (
                      <>
                        <button className="ghost small" onClick={() => setEditingId(m.id)}>Edit</button>
                        <button
                          className="ghost small danger"
                          onClick={() => {
                            commit(
                              (s) => {
                                const i = (s.friendlies || []).findIndex((x) => x.id === m.id);
                                if (i >= 0) s.friendlies.splice(i, 1);
                              },
                              { who: me, text: `Removed friendly ${m.home} vs ${m.away}` }
                            );
                            if (editingId === m.id) setEditingId(null);
                          }}
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/* ---------------------------- predictions + betting ---------------------------- */

function ProbBar({ pred, compact }) {
  const pct = (v) => `${Math.round(v * 100)}%`;
  return (
    <span className={`bar${compact ? " compact" : ""}`}>
      <span className="track">
        <span className="pseg s-home" style={{ width: pct(pred.home) }} />
        <span className="pseg s-draw" style={{ width: pct(pred.draw) }} />
        <span className="pseg s-away" style={{ width: pct(pred.away) }} />
      </span>
      <span className="legend mono">
        <span className="l-home">{pct(pred.home)}</span>
        <span className="l-draw">{pct(pred.draw)}</span>
        <span className="l-away">{pct(pred.away)}</span>
      </span>
    </span>
  );
}

function Predictions({ state, matches, strengths, predictor, session, isAdmin, balances, placeBet, cancelBet, commit, openSignIn }) {
  const upcoming = matches.filter((m) => !m.played);
  const [round, setRound] = useState(upcoming.length ? Math.min(...upcoming.map((m) => m.round)) : 1);
  const allRounds = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b);
  const slate = matches.filter((m) => m.round === round);

  const titleOdds = useMemo(
    () => simulateSeason(state.players, matches, strengths, state.homeAdvantage),
    [state.players, matches, strengths, state.homeAdvantage]
  );

  const myCoins = session ? balances.get(session.name)?.balance ?? 0 : 0;
  const myBets = (state.bets || []).filter(
    (b) => session && b.who === session.name && !(state.results || {})[b.matchId]
  );

  return (
    <section>
      <div className="card-head bar">
        <div>
          <h2 className="h2">Prediction centre</h2>
          <p className="muted sm">
            Odds come from each player's live rating and recent form. Back the favourite for a
            small, safe win — or the underdog for a big one.
          </p>
        </div>
        {isAdmin && (
          <label className="toggle">
            <input
              type="checkbox" checked={Boolean(state.homeAdvantage)}
              onChange={(e) => {
                const on = e.target.checked;
                commit((s) => { s.homeAdvantage = on; }, { who: session.name, text: `Turned home advantage ${on ? "on" : "off"}` });
              }}
            />
            <span>Home advantage</span>
          </label>
        )}
      </div>

      {!session && (
        <div className="card sub bar">
          <p className="muted sm">Sign in to bet — everyone starts with {START_COINS} coins.</p>
          <button className="ghost" onClick={openSignIn}>Sign in</button>
        </div>
      )}

      <div className="card">
        <div className="round-head">
          <h3 className="h3">Matchday {round}</h3>
          <span className="mono sm muted">{slate.length ? fmtDate(slate[0].date) : ""}</span>
          <div className="seg tight">
            <button className="segb" onClick={() => setRound(Math.max(allRounds[0], round - 1))} disabled={round <= allRounds[0]}>Prev</button>
            <button className="segb" onClick={() => setRound(Math.min(allRounds[allRounds.length - 1], round + 1))} disabled={round >= allRounds[allRounds.length - 1]}>Next</button>
          </div>
        </div>
        <div className="pcards">
          {slate.map((m) => (
            <PredictionCard
              key={m.id} m={m} pred={predictor(m.home, m.away)} session={session}
              myCoins={myCoins} myBet={myBets.find((b) => b.matchId === m.id)}
              placeBet={placeBet} cancelBet={cancelBet}
            />
          ))}
        </div>
      </div>

      {titleOdds && (
        <div className="card">
          <div className="card-head">
            <h3 className="h3">Title odds</h3>
            <p className="muted sm">
              {SIMS.toLocaleString()} simulated seasons played out from today's table.
            </p>
          </div>
          <ul className="odds">
            {titleOdds.map((o) => (
              <li key={o.name}>
                <span className="odds-name">{o.name}</span>
                <span className="odds-track">
                  <span className="odds-fill" style={{ width: `${Math.max(o.title * 100, o.title > 0 ? 1.5 : 0)}%` }} />
                </span>
                <span className="mono odds-val">{o.title >= 0.005 ? `${(o.title * 100).toFixed(1)}%` : "<0.5%"}</span>
                <span className="mono sm muted odds-top">top 3 {Math.round(o.top3 * 100)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function PredictionCard({ m, pred, session, myCoins, myBet, placeBet, cancelBet }) {
  const [pick, setPick] = useState(null);
  const [stake, setStake] = useState("");
  const [busy, setBusy] = useState(false);
  const odds = oddsForMatch(pred);
  const playingInIt = session && (m.home === session.name || m.away === session.name);
  const label = (p) => (p === "home" ? m.home : p === "away" ? m.away : "Draw");

  const n = Math.round(Number(stake));
  const stakeOk = Number.isFinite(n) && n >= MIN_STAKE && n <= myCoins;

  return (
    <article className="pcard">
      <header className="pcard-head">
        <span className="side home">{m.home}</span>
        <span className="mono sm muted">{m.played ? `FT ${m.hg}–${m.ag}` : fmtDate(m.date)}</span>
        <span className="side away">{m.away}</span>
      </header>
      <ProbBar pred={pred} />
      <p className="mono sm muted center">
        xG {pred.lh.toFixed(2)} – {pred.la.toFixed(2)} · likely {pred.likely}
      </p>

      {!m.played && (
        <div className="betbox">
          {myBet ? (
            <div className="mybet">
              <span className="sm">
                Your bet: <b>{myBet.stake}c</b> on <b>{label(myBet.pick)}</b>
                <span className="mono"> @ {myBet.odds.toFixed(2)}</span>
                <span className="muted"> → {Math.round(myBet.stake * myBet.odds)}c if it lands</span>
              </span>
              <button className="ghost small danger" onClick={() => cancelBet(myBet.id)}>Cancel</button>
            </div>
          ) : playingInIt ? (
            <p className="muted sm">You're playing in this one — no betting on your own matches.</p>
          ) : !session ? (
            <p className="muted sm">Sign in to bet on this match.</p>
          ) : (
            <>
              <div className="oddsrow">
                {["home", "draw", "away"].map((p) => (
                  <button
                    key={p}
                    className={`oddsbtn ob-${p}${pick === p ? " on" : ""}`}
                    onClick={() => setPick(pick === p ? null : p)}
                  >
                    <span className="obl">{label(p)}</span>
                    <span className="mono obv">{odds[p].toFixed(2)}×</span>
                  </button>
                ))}
              </div>
              {pick && (
                <>
                  <div className="stakerow">
                    <input
                      className="input mono" inputMode="numeric"
                      placeholder={`Stake (min ${MIN_STAKE})`} value={stake}
                      onChange={(e) => setStake(e.target.value.replace(/[^0-9]/g, "").slice(0, 5))}
                    />
                    <button
                      className="primary" disabled={!stakeOk || busy}
                      onClick={async () => {
                        setBusy(true);
                        const ok = await placeBet({ matchId: m.id, pick, stake: n, odds: odds[pick] });
                        setBusy(false);
                        if (ok) { setPick(null); setStake(""); }
                      }}
                    >
                      {busy ? "…" : stakeOk ? `Win ${Math.round(n * odds[pick])}c` : "Place bet"}
                    </button>
                  </div>
                  {stake !== "" && !stakeOk && (
                    <p className="muted sm">
                      {n < MIN_STAKE ? `Minimum stake is ${MIN_STAKE} coins.` : `You only have ${myCoins} coins.`}
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </article>
  );
}

/* ---------------------------- coins ---------------------------- */

function Coins({ state, matches, session, isAdmin, balances, cancelBet, adminAction, openSignIn }) {
  const accounts = state.accounts || {};
  const bets = state.bets || [];
  const results = state.results || {};
  const matchById = useMemo(() => new Map(matches.map((m) => [m.id, m])), [matches]);

  const board = Object.keys(accounts)
    .map((name) => ({ name, role: accounts[name].role, ...(balances.get(name) || {}) }))
    .sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0));

  const describe = (b) => {
    const m = matchById.get(b.matchId);
    const what = !m
      ? b.matchId
      : b.pick === "draw" ? `${m.home} v ${m.away} draw` : b.pick === "home" ? m.home : m.away;
    const r = results[b.matchId];
    const status = !r
      ? { text: "open", cls: "todo" }
      : (r.hg > r.ag ? "home" : r.hg < r.ag ? "away" : "draw") === b.pick
        ? { text: `won +${Math.round(b.stake * (b.odds - 1))}c`, cls: "wonpill" }
        : { text: `lost −${b.stake}c`, cls: "lostpill" };
    return { what, status };
  };

  const mine = session ? bets.filter((b) => b.who === session.name).sort((a, b) => b.ts - a.ts) : [];
  const openBets = bets.filter((b) => !results[b.matchId]).sort((a, b) => b.ts - a.ts);
  const me = session ? balances.get(session.name) : null;

  return (
    <section>
      <div className="card-head">
        <h2 className="h2">Coins</h2>
        <p className="muted sm">
          Everyone starts with {START_COINS}. Bet them on matches — favourites pay little,
          underdogs pay big. Just for fun, never real money, and they never affect the table or
          anyone's rating.
        </p>
      </div>

      {session ? (
        <div className="card coincard">
          <div className="coinbig">
            <span className="mono coinnum">{me?.balance ?? START_COINS}</span>
            <span className="rating-lbl">your coins</span>
          </div>
          <dl className="stats-row coinstats">
            <Stat k="In play" v={me?.held ?? 0} />
            <Stat k="Open" v={me?.open ?? 0} />
            <Stat k="Won" v={me?.won ?? 0} tone="win" />
            <Stat k="Lost" v={me?.lost ?? 0} tone="loss" />
          </dl>
        </div>
      ) : (
        <div className="card sub bar">
          <p className="muted sm">Sign in — players and spectators both get {START_COINS} coins.</p>
          <button className="ghost" onClick={openSignIn}>Sign in</button>
        </div>
      )}

      <div className="two">
        <div className="card">
          <h3 className="h3">Leaderboard</h3>
          {!board.length ? (
            <p className="empty">Nobody has claimed an account yet.</p>
          ) : (
            <ul className="formlist">
              {board.map((r, i) => (
                <li key={r.name}>
                  <span className="mono pos">{i + 1}</span>
                  <span className="name">{r.name} <span className="rolechip">{r.role}</span></span>
                  <span className="mono sm muted">{r.won ?? 0}W {r.lost ?? 0}L</span>
                  <span className="mono pts">{r.balance ?? START_COINS}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h3 className="h3">{session ? "Your bets" : "Open bets"}</h3>
          {session ? (
            !mine.length ? (
              <p className="empty">No bets yet — head to Predictions.</p>
            ) : (
              <ul className="betlist">
                {mine.slice(0, 12).map((b) => {
                  const { what, status } = describe(b);
                  return (
                    <li key={b.id}>
                      <span className="betwhat">
                        <b>{b.stake}c</b> on {what} <span className="mono muted">@ {b.odds.toFixed(2)}</span>
                      </span>
                      <span className={`pill ${status.cls}`}>{status.text}</span>
                      {!results[b.matchId] && (
                        <button className="ghost small danger" onClick={() => cancelBet(b.id)}>Cancel</button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )
          ) : !openBets.length ? (
            <p className="empty">No open bets right now.</p>
          ) : (
            <ul className="betlist">
              {openBets.slice(0, 12).map((b) => (
                <li key={b.id}>
                  <span className="betwhat">
                    <b>{b.who}</b>: {b.stake}c on {describe(b).what}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {isAdmin && openBets.length > 0 && (
            <div className="reset">
              <p className="lbl">Admin — void a bet</p>
              <ul className="betlist">
                {openBets.map((b) => (
                  <li key={b.id}>
                    <span className="betwhat"><b>{b.who}</b>: {b.stake}c on {describe(b).what}</span>
                    <button className="ghost small danger" onClick={() => adminAction("voidbet", { id: b.id })}>Void</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------- players ---------------------------- */

function Players({ state, table, matches, liveRatings, isAdmin, session, commit }) {
  const [openName, setOpenName] = useState(null);
  const [editSeeds, setEditSeeds] = useState(false);
  const byName = new Map(table.map((r) => [r.name, r]));
  const ordered = [...state.players].sort(
    (a, b) => (liveRatings.get(b.name)?.live ?? b.rating) - (liveRatings.get(a.name)?.live ?? a.rating)
  );

  const friendlyRecord = (name) => {
    let w = 0, d = 0, l = 0;
    for (const f of state.friendlies || []) {
      if (!f.played) continue;
      const mine = f.home === name ? f.hg : f.away === name ? f.ag : null;
      if (mine === null) continue;
      const theirs = f.home === name ? f.ag : f.hg;
      if (mine > theirs) w++; else if (mine < theirs) l++; else d++;
    }
    return { w, d, l, any: w + d + l > 0 };
  };

  return (
    <section>
      <div className="card-head bar">
        <div>
          <h2 className="h2">Players</h2>
          <p className="muted sm">
            The live rating moves with every result — league games at full weight, friendlies at
            {" "}{Math.round(FRIENDLY_WEIGHT * 100)}%. The seed is just where the season started.
          </p>
        </div>
        {isAdmin && (
          <button className="ghost" onClick={() => setEditSeeds(!editSeeds)}>
            {editSeeds ? "Done" : "Edit seed ratings"}
          </button>
        )}
      </div>

      <div className="pgrid">
        {ordered.map((p) => {
          const r = byName.get(p.name) || { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0, seq: [], winPct: 0 };
          const lr = liveRatings.get(p.name) || { seed: p.rating, live: p.rating, delta: 0 };
          const st = currentStreak(r.seq);
          const fr = friendlyRecord(p.name);
          const isOpen = openName === p.name;
          return (
            <article className={`card player${isOpen ? " open" : ""}`} key={p.name}>
              <header className="player-head">
                <div className="rating">
                  {editSeeds ? (
                    <input
                      className="rating-input mono" inputMode="numeric" defaultValue={p.rating}
                      onBlur={(e) => {
                        const v = clamp(Math.round(Number(e.target.value) || p.rating), 40, 99);
                        if (v === p.rating) return;
                        commit(
                          (s) => { const t = s.players.find((x) => x.name === p.name); if (t) t.rating = v; },
                          { who: session.name, text: `Set ${p.name}'s seed rating to ${v}` }
                        );
                      }}
                      aria-label={`Seed rating for ${p.name}`}
                    />
                  ) : (
                    <span className="mono rating-num">{Math.round(lr.live)}</span>
                  )}
                  <span className="rating-lbl">live rating</span>
                  {!editSeeds && Math.abs(lr.delta) >= 0.5 && (
                    <span className={`deltachip ${lr.delta > 0 ? "up" : "down"} mono`}>
                      {lr.delta > 0 ? "▲" : "▼"} {Math.abs(lr.delta).toFixed(1)}
                    </span>
                  )}
                </div>
                <div className="player-id">
                  <h3 className="h3">{p.name}</h3>
                  <p className="mono sm muted">
                    seed {p.rating} · {r.p ? `${ordinal(r.pos)} · ${r.pts} pts` : "yet to play"}
                  </p>
                </div>
              </header>

              <dl className="stats-row">
                <Stat k="P" v={r.p} />
                <Stat k="W" v={r.w} tone="win" />
                <Stat k="D" v={r.d} />
                <Stat k="L" v={r.l} tone="loss" />
                <Stat k="GF" v={r.gf} />
                <Stat k="GA" v={r.ga} />
                <Stat k="GD" v={r.gd > 0 ? `+${r.gd}` : r.gd} />
                <Stat k="Win%" v={r.p ? `${Math.round(r.winPct * 100)}` : "–"} />
              </dl>

              <div className="player-foot">
                <Form seq={r.seq} />
                {st && (
                  <span className={`pill streak s-${st.mark}`}>
                    {st.n} {st.mark === "W" ? "win" : st.mark === "L" ? "loss" : "draw"}{st.n > 1 ? "s" : ""} in a row
                  </span>
                )}
                {fr.any && <span className="mono sm muted">friendlies {fr.w}-{fr.d}-{fr.l}</span>}
                <button className="ghost small" onClick={() => setOpenName(isOpen ? null : p.name)}>
                  {isOpen ? "Hide head-to-head" : "Head-to-head"}
                </button>
              </div>

              {isOpen && <H2H name={p.name} players={state.players} matches={matches} />}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Stat({ k, v, tone }) {
  return (
    <div className={`stat${tone ? ` t-${tone}` : ""}`}>
      <dt>{k}</dt>
      <dd className="mono">{v}</dd>
    </div>
  );
}

function H2H({ name, players, matches }) {
  const rows = players.filter((p) => p.name !== name).map((p) => {
    const games = matches.filter(
      (m) => m.played && ((m.home === name && m.away === p.name) || (m.home === p.name && m.away === name))
    );
    let w = 0, d = 0, l = 0, gf = 0, ga = 0;
    for (const m of games) {
      const mine = m.home === name ? m.hg : m.ag;
      const theirs = m.home === name ? m.ag : m.hg;
      gf += mine; ga += theirs;
      if (mine > theirs) w++; else if (mine < theirs) l++; else d++;
    }
    return { opp: p.name, played: games.length, w, d, l, gf, ga };
  });
  return (
    <div className="h2h">
      <table className="grid tight">
        <thead>
          <tr>
            <th>Opponent</th><th className="num">P</th><th className="num">W</th>
            <th className="num">D</th><th className="num">L</th><th className="num">Goals</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.opp}>
              <td className="name">{r.opp}</td>
              <td className="num">{r.played}</td>
              <td className="num">{r.w}</td>
              <td className="num">{r.d}</td>
              <td className="num">{r.l}</td>
              <td className="num mono">{r.played ? `${r.gf}–${r.ga}` : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------- stats ---------------------------- */

function Stats({ table, matches, liveRatings }) {
  const active = table.filter((r) => r.p > 0);
  const played = matches.filter((m) => m.played).sort((a, b) => (b.ts || 0) - (a.ts || 0));

  if (!active.length) return <p className="empty">Awards appear once the first result is in.</p>;

  const bestAttack = [...active].sort((a, b) => b.gf / b.p - a.gf / a.p)[0];
  const bestDefence = [...active].sort((a, b) => a.ga / a.p - b.ga / b.p)[0];
  const streak = active.map((r) => ({ name: r.name, n: longestRun(r.seq, "W") })).sort((a, b) => b.n - a.n)[0];
  const riser = [...liveRatings.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.delta - a.delta)[0];
  const biggest = [...played].sort((a, b) => b.hg + b.ag - (a.hg + a.ag))[0];
  const formTable = active
    .map((r) => {
      const last = r.seq.slice(-5);
      return { name: r.name, seq: last, pts: last.reduce((s, x) => s + (x === "W" ? 3 : x === "D" ? 1 : 0), 0) };
    })
    .sort((a, b) => b.pts - a.pts || b.seq.length - a.seq.length);

  return (
    <section>
      <div className="awards">
        <Award title="Best attack" name={bestAttack.name} value={`${(bestAttack.gf / bestAttack.p).toFixed(2)} goals a game`} tone="home" />
        <Award title="Best defence" name={bestDefence.name} value={`${(bestDefence.ga / bestDefence.p).toFixed(2)} conceded a game`} tone="away" />
        <Award
          title="Longest winning run"
          name={streak.n ? streak.name : "Nobody yet"}
          value={streak.n ? `${streak.n} straight win${streak.n > 1 ? "s" : ""}` : "No back-to-back wins so far"}
          tone="win"
        />
        <Award
          title="Biggest improvement"
          name={riser && riser.delta >= 0.5 ? riser.name : "Nobody yet"}
          value={
            riser && riser.delta >= 0.5
              ? `Rating up ${riser.delta.toFixed(1)} (${riser.seed} → ${Math.round(riser.live)})`
              : "Nobody has beaten their seed rating yet"
          }
          tone="draw"
        />
        <Award
          title="Highest scoring match"
          name={biggest ? `${biggest.home} ${biggest.hg}–${biggest.ag} ${biggest.away}` : "—"}
          value={biggest ? `${biggest.hg + biggest.ag} goals · MD${biggest.round}` : ""}
          tone="home" wide
        />
      </div>

      <div className="two">
        <div className="card">
          <h3 className="h3">Form table</h3>
          <p className="muted sm">Points from each player's last five league matches.</p>
          <ul className="formlist">
            {formTable.map((f, i) => (
              <li key={f.name}>
                <span className="mono pos">{i + 1}</span>
                <span className="name">{f.name}</span>
                <Form seq={f.seq} />
                <span className="mono pts">{f.pts}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h3 className="h3">Recent results</h3>
          <p className="muted sm">Newest first.</p>
          <ul className="recent">
            {played.slice(0, 8).map((m) => (
              <li key={m.id}>
                <span className="side home">{m.home}</span>
                <span className="mono ft small">{m.hg}<i>–</i>{m.ag}</span>
                <span className="side away">{m.away}</span>
                <span className="mono sm muted">MD{m.round}</span>
              </li>
            ))}
          </ul>
          {!played.length && <p className="empty">No results yet.</p>}
        </div>
      </div>
    </section>
  );
}

function Award({ title, name, value, tone, wide }) {
  return (
    <article className={`award t-${tone}${wide ? " wide" : ""}`}>
      <p className="award-title">{title}</p>
      <p className="award-name">{name}</p>
      <p className="mono sm muted">{value}</p>
    </article>
  );
}

/* ---------------------------- activity + admin ---------------------------- */

function Activity({ state, session, isAdmin, adminAction }) {
  const log = state.log || [];
  const accounts = state.accounts || {};
  const [confirming, setConfirming] = useState(false);

  return (
    <section>
      <div className="card">
        <div className="card-head">
          <h2 className="h2">Activity</h2>
          <p className="muted sm">Every change to a score, date, rating, friendly or bet.</p>
        </div>
        {!log.length ? (
          <p className="empty">Nothing has changed yet.</p>
        ) : (
          <ul className="logl">
            {log.map((e) => (
              <li key={e.id}>
                <span className="log-who">{e.who}</span>
                <span className="log-text">{e.text}</span>
                <span className="mono sm muted">
                  {new Date(e.ts).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {isAdmin && (
        <div className="card">
          <div className="card-head">
            <h3 className="h3">Admin</h3>
            <p className="muted sm">
              Forgotten password? Reset it and they can claim their account again.
            </p>
          </div>
          {!Object.keys(accounts).length ? (
            <p className="empty">No accounts yet.</p>
          ) : (
            <ul className="acctlist">
              {Object.entries(accounts).map(([n, a]) => (
                <li key={n}>
                  <span className="name">{n}</span>
                  <span className="rolechip">{a.role}</span>
                  <span className="btns">
                    {n !== session.name && (
                      <button className="ghost small" onClick={() => adminAction("resetpw", { target: n })}>Reset password</button>
                    )}
                    {a.role === "spectator" && (
                      <button className="ghost small danger" onClick={() => adminAction("removeaccount", { target: n })}>Remove</button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="reset">
            {!confirming ? (
              <button className="ghost danger" onClick={() => setConfirming(true)}>Start a new season</button>
            ) : (
              <div className="btns">
                <span className="muted sm">
                  Clears every result, friendly, bet and log entry. Accounts stay; coins reset to {START_COINS}.
                </span>
                <button
                  className="primary danger"
                  onClick={() => { adminAction("newseason", {}); setConfirming(false); }}
                >
                  Clear the season
                </button>
                <button className="ghost" onClick={() => setConfirming(false)}>Keep it</button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/* ---------------------------- styles ---------------------------- */

function Styles() {
  return (
    <style>{`
.efl {
  --ink:#13111C; --panel:#1B1828; --panel2:#231F33; --line:#312B45;
  --home:#F2A63B; --away:#56C8E8; --draw:#6A6288;
  --win:#4ED8A8; --loss:#E0607E;
  --paper:#EFECF7; --muted:#8E87A6;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Roboto Mono", monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, system-ui, sans-serif;
  font-family: var(--sans);
  background: var(--ink);
  background-image: radial-gradient(120% 55% at 50% -12%, rgba(242,166,59,0.14), rgba(19,17,28,0) 62%);
  color: var(--paper); min-height: 100vh; font-size: 15px; line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.efl *, .efl *::before, .efl *::after { box-sizing: border-box; }
.efl .wrap { max-width: 1080px; margin: 0 auto; padding: 22px 18px 56px; }
.efl h1, .efl h2, .efl h3 { margin: 0; }
.efl p { margin: 0; }
.efl code { font-family: var(--mono); font-size: 11px; color: var(--home); }
.efl button { font-family: inherit; font-size: inherit; cursor: pointer; }
.efl button:focus-visible, .efl input:focus-visible, .efl select:focus-visible {
  outline: 2px solid var(--home); outline-offset: 2px; border-radius: 3px;
}
.efl .mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.efl .muted { color: var(--muted); }
.efl .sm { font-size: 12px; }
.efl .center { text-align: center; }
.efl .pad { padding: 24px 4px; }
.efl .empty { color: var(--muted); font-size: 13px; padding: 18px 4px; }
.efl .alert { border-left: 3px solid var(--loss); background: rgba(224,96,126,0.1); padding: 10px 14px; font-size: 13px; margin: 10px 0 14px; }
.efl .banner { border-left: 3px solid var(--away); background: rgba(86,200,232,0.08); padding: 10px 14px; font-size: 12px; color: var(--muted); margin-bottom: 14px; }

.efl .head { display: flex; align-items: flex-start; gap: 14px; flex-wrap: wrap; margin-bottom: 16px; }
.efl .mark { color: var(--home); flex: 0 0 auto; margin-top: 4px; }
.efl .head-text { flex: 1 1 260px; min-width: 0; }
.efl .eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); margin-bottom: 4px; }
.efl h1 { font-size: clamp(24px, 5.4vw, 40px); font-weight: 800; letter-spacing: -0.035em; line-height: 1.02; text-transform: uppercase; }
.efl .head-side { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.efl .pill { font-family: var(--mono); font-size: 10px; letter-spacing: 0.09em; text-transform: uppercase; padding: 4px 8px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
.efl .sync-ok { color: var(--win); border-color: rgba(78,216,168,0.4); }
.efl .sync-saving { color: var(--home); border-color: rgba(242,166,59,0.4); }
.efl .sync-error { color: var(--loss); border-color: rgba(224,96,126,0.5); }
.efl .pill.done { color: var(--win); border-color: rgba(78,216,168,0.35); }
.efl .pill.todo { color: var(--muted); }
.efl .pill.wonpill { color: var(--win); border-color: rgba(78,216,168,0.4); }
.efl .pill.lostpill { color: var(--loss); border-color: rgba(224,96,126,0.4); }
.efl .userchip { display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--line); padding: 5px 10px; font-size: 12px; }
.efl .rolechip { font-family: var(--mono); font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); border: 1px solid var(--line); padding: 1px 5px; }
.efl .coinchip { color: var(--home); font-size: 12px; }

.efl .ghost { background: none; border: 1px solid var(--line); color: var(--paper); padding: 5px 11px; font-size: 12px; transition: border-color .15s, color .15s; }
.efl .ghost:hover { border-color: var(--home); color: var(--home); }
.efl .ghost.small { padding: 3px 9px; font-size: 11px; }
.efl .ghost.danger:hover { border-color: var(--loss); color: var(--loss); }
.efl .primary { background: var(--home); border: 1px solid var(--home); color: #1A1206; font-weight: 700; padding: 7px 16px; font-size: 13px; letter-spacing: -0.01em; }
.efl .primary:hover { filter: brightness(1.08); }
.efl .primary:disabled { opacity: .4; cursor: not-allowed; }
.efl .primary.danger { background: var(--loss); border-color: var(--loss); color: #22060D; }

.efl .tabs { display: flex; gap: 2px; overflow-x: auto; border-bottom: 1px solid var(--line); margin-bottom: 18px; scrollbar-width: none; }
.efl .tabs::-webkit-scrollbar { display: none; }
.efl .tab { background: none; border: none; border-bottom: 2px solid transparent; color: var(--muted); padding: 9px 13px; font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; font-family: var(--mono); white-space: nowrap; transition: color .15s; }
.efl .tab:hover { color: var(--paper); }
.efl .tab.on { color: var(--home); border-bottom-color: var(--home); }

.efl .card { background: var(--panel); border: 1px solid var(--line); padding: 16px; margin-bottom: 14px; }
.efl .card.sub { padding: 12px 16px; }
.efl .card-head { margin-bottom: 12px; }
.efl .card-head.bar, .efl .card.sub.bar { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.efl .card-head.bar { align-items: flex-start; }
.efl .card.sub.bar { align-items: center; }
.efl .h2 { font-size: 17px; font-weight: 750; letter-spacing: -0.02em; }
.efl .h3 { font-size: 14px; font-weight: 750; letter-spacing: -0.01em; }

.efl .ident .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.efl .chip { background: var(--panel2); border: 1px solid var(--line); color: var(--paper); padding: 7px 12px; font-weight: 650; letter-spacing: -0.01em; font-size: 13px; display: inline-flex; align-items: center; gap: 8px; }
.efl .chip:hover, .efl .chip.sel { border-color: var(--home); color: var(--home); }
.efl .chipstate { font-family: var(--mono); font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; }
.efl .chipstate.c { color: var(--win); }
.efl .chipstate.u { color: var(--muted); }
.efl .authform { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 12px; }
.efl .authrow { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.efl .authrow .input { flex: 1 1 160px; }

.efl .seg { display: flex; border: 1px solid var(--line); }
.efl .seg.tight { margin-left: auto; }
.efl .segb { background: none; border: none; color: var(--muted); padding: 5px 11px; font-size: 11px; font-family: var(--mono); letter-spacing: 0.08em; text-transform: uppercase; }
.efl .segb + .segb { border-left: 1px solid var(--line); }
.efl .segb.on { background: var(--panel2); color: var(--home); }
.efl .segb:disabled { opacity: .35; cursor: not-allowed; }
.efl .toggle { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--muted); }
.efl .toggle input { accent-color: var(--home); width: 15px; height: 15px; }

.efl .scroll { overflow-x: auto; }
.efl .grid { width: 100%; border-collapse: collapse; font-size: 14px; }
.efl .grid th { text-align: left; font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); font-weight: 400; padding: 0 8px 8px; border-bottom: 1px solid var(--line); }
.efl .grid td { padding: 9px 8px; border-bottom: 1px solid rgba(49,43,69,0.55); }
.efl .grid .num, .efl .grid th.num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; }
.efl .grid .name { font-weight: 700; letter-spacing: -0.015em; white-space: nowrap; }
.efl .grid .pos { color: var(--muted); width: 30px; }
.efl .grid .pts { font-weight: 700; font-size: 15px; }
.efl .grid tbody tr.lead { background: rgba(242,166,59,0.06); }
.efl .grid tbody tr.lead .pos { color: var(--home); font-weight: 700; }
.efl .grid.tight td, .efl .grid.tight th { padding: 6px 7px; font-size: 13px; }
.efl .crown { font-family: var(--mono); font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--home); border: 1px solid rgba(242,166,59,0.4); padding: 2px 6px; margin-left: 8px; }
.efl .row-in { animation: rise .34s ease-out both; }
@keyframes rise { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }

.efl .form { display: inline-flex; gap: 3px; }
.efl .dot { width: 18px; height: 18px; display: grid; place-items: center; font-family: var(--mono); font-size: 10px; font-weight: 700; }
.efl .d-W { background: rgba(78,216,168,0.16); color: var(--win); }
.efl .d-D { background: rgba(142,135,166,0.16); color: var(--muted); }
.efl .d-L { background: rgba(224,96,126,0.16); color: var(--loss); }

.efl .round-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-bottom: 10px; margin-bottom: 6px; border-bottom: 1px solid var(--line); }
.efl .round-head .pill { margin-left: auto; }
.efl .matches { list-style: none; margin: 0; padding: 0; }
.efl .match { border-bottom: 1px solid rgba(49,43,69,0.5); }
.efl .match:last-child { border-bottom: none; }
.efl .match.open { background: rgba(35,31,51,0.6); }
.efl .match-btn { width: 100%; background: none; border: none; color: inherit; text-align: left; display: grid; grid-template-columns: 1fr 74px 1fr 150px; align-items: center; gap: 10px; padding: 11px 4px; }
.efl .match-btn.asrow { cursor: default; }
.efl .match-btn:not(.asrow):hover { background: rgba(35,31,51,0.5); }
.efl .side { font-weight: 700; letter-spacing: -0.015em; font-size: 14px; }
.efl .side.home { color: var(--home); }
.efl .side.away { color: var(--away); text-align: right; }
.efl .score { text-align: center; }
.efl .ft { font-size: 17px; font-weight: 700; letter-spacing: -0.02em; }
.efl .ft i { color: var(--muted); font-style: normal; padding: 0 3px; }
.efl .ft.small { font-size: 14px; }
.efl .vs { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
.efl .match-meta { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
.efl .friendlymeta { flex-wrap: wrap; }

.efl .bar { display: block; width: 100%; }
.efl .track { display: flex; height: 8px; overflow: hidden; background: var(--panel2); border: 1px solid var(--line); }
.efl .bar.compact .track { height: 6px; }
.efl .pseg { display: block; transition: width .5s cubic-bezier(.22,.7,.25,1); }
.efl .s-home { background: var(--home); }
.efl .s-draw { background: var(--draw); }
.efl .s-away { background: var(--away); }
.efl .legend { display: flex; justify-content: space-between; font-size: 11px; margin-top: 4px; }
.efl .l-home { color: var(--home); }
.efl .l-draw { color: var(--muted); }
.efl .l-away { color: var(--away); }

.efl .editor { padding: 4px 4px 16px; display: grid; gap: 14px; }
.efl .pred-full { display: grid; gap: 6px; }
.efl .score-edit { display: flex; align-items: center; justify-content: center; gap: 14px; flex-wrap: wrap; }
.efl .stepper { display: grid; gap: 6px; justify-items: center; }
.efl .stepper-name { font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; }
.efl .stepper.home .stepper-name { color: var(--home); }
.efl .stepper.away .stepper-name { color: var(--away); }
.efl .stepper-ctl { display: flex; align-items: stretch; border: 1px solid var(--line); }
.efl .step { background: var(--panel2); border: none; color: var(--paper); width: 34px; font-size: 16px; line-height: 1; }
.efl .step:hover { color: var(--home); }
.efl .goal { width: 54px; background: var(--ink); border: none; border-left: 1px solid var(--line); border-right: 1px solid var(--line); color: var(--paper); text-align: center; font-size: 20px; font-weight: 700; padding: 8px 0; }
.efl .dash { color: var(--muted); font-size: 18px; align-self: flex-end; padding-bottom: 10px; }
.efl .editor-row { display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap; justify-content: space-between; }
.efl .field { display: grid; gap: 5px; }
.efl .lbl { font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
.efl .input { background: var(--ink); border: 1px solid var(--line); color: var(--paper); padding: 7px 10px; font-family: var(--mono); font-size: 13px; }
.efl .btns { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.efl .friendly-grid { display: grid; gap: 14px; }
.efl .friendly-pair { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
.efl .pairvs { padding-bottom: 10px; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; }

.efl .pcards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin-top: 12px; }
.efl .pcard { background: var(--panel2); border-left: 2px solid var(--home); padding: 12px 14px; display: grid; gap: 8px; align-content: start; }
.efl .pcard-head { display: grid; grid-template-columns: 1fr auto 1fr; gap: 8px; align-items: center; }
.efl .pcard-head .side.away { text-align: right; }
.efl .odds { list-style: none; margin: 0; padding: 0; display: grid; gap: 7px; }
.efl .odds li { display: grid; grid-template-columns: 84px 1fr 56px 92px; align-items: center; gap: 10px; }
.efl .odds-name { font-weight: 700; font-size: 13px; letter-spacing: -0.015em; white-space: nowrap; }
.efl .odds-track { height: 10px; background: var(--panel2); border: 1px solid var(--line); }
.efl .odds-fill { display: block; height: 100%; background: var(--home); transition: width .5s cubic-bezier(.22,.7,.25,1); }
.efl .odds-val { font-size: 12px; text-align: right; }
.efl .odds-top { text-align: right; }

.efl .betbox { border-top: 1px solid var(--line); padding-top: 10px; display: grid; gap: 8px; }
.efl .oddsrow { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.efl .oddsbtn { background: var(--ink); border: 1px solid var(--line); color: var(--paper); display: grid; gap: 2px; padding: 7px 6px; justify-items: center; }
.efl .oddsbtn:hover { border-color: var(--home); }
.efl .oddsbtn.on { border-color: var(--home); background: rgba(242,166,59,0.08); }
.efl .oddsbtn.ob-away.on { border-color: var(--away); background: rgba(86,200,232,0.08); }
.efl .obl { font-size: 11px; font-weight: 700; letter-spacing: -0.01em; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.efl .obv { font-size: 12px; color: var(--muted); }
.efl .oddsbtn.on .obv { color: var(--home); }
.efl .oddsbtn.ob-away.on .obv { color: var(--away); }
.efl .stakerow { display: flex; gap: 8px; }
.efl .stakerow .input { flex: 1; min-width: 0; }
.efl .mybet { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }

.efl .coincard { display: flex; align-items: center; gap: 22px; flex-wrap: wrap; }
.efl .coinbig { display: grid; justify-items: center; border: 1px solid rgba(242,166,59,0.35); background: rgba(242,166,59,0.07); padding: 10px 18px; }
.efl .coinnum { font-size: 32px; font-weight: 800; letter-spacing: -0.04em; color: var(--home); line-height: 1; }
.efl .coinstats { flex: 1; min-width: 240px; margin: 0; }
.efl .betlist { list-style: none; margin: 10px 0 0; padding: 0; }
.efl .betlist li { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 0; border-bottom: 1px solid rgba(49,43,69,0.5); font-size: 13px; }
.efl .betwhat { flex: 1; min-width: 180px; }

.efl .pgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
.efl .player { margin-bottom: 0; }
.efl .player.open { grid-column: 1 / -1; }
.efl .player-head { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
.efl .rating { display: grid; justify-items: center; padding: 6px 10px; position: relative; border: 1px solid rgba(242,166,59,0.35); background: rgba(242,166,59,0.07); min-width: 74px; }
.efl .rating-num { font-size: 26px; font-weight: 800; letter-spacing: -0.04em; color: var(--home); line-height: 1; }
.efl .rating-input { width: 48px; background: var(--ink); border: 1px solid var(--home); color: var(--home); font-size: 22px; font-weight: 800; text-align: center; padding: 2px 0; }
.efl .rating-lbl { font-family: var(--mono); font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); margin-top: 3px; }
.efl .deltachip { position: absolute; top: -8px; right: -8px; font-size: 9px; padding: 2px 5px; border: 1px solid var(--line); background: var(--ink); }
.efl .deltachip.up { color: var(--win); border-color: rgba(78,216,168,0.5); }
.efl .deltachip.down { color: var(--loss); border-color: rgba(224,96,126,0.5); }
.efl .player-id { min-width: 0; }
.efl .player-id .h3 { font-size: 19px; font-weight: 800; letter-spacing: -0.03em; text-transform: uppercase; }
.efl .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 0 0 14px; }
.efl .stat { border-top: 1px solid var(--line); padding-top: 6px; }
.efl .stat dt { font-family: var(--mono); font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
.efl .stat dd { margin: 2px 0 0; font-size: 16px; font-weight: 700; letter-spacing: -0.02em; }
.efl .stat.t-win dd { color: var(--win); }
.efl .stat.t-loss dd { color: var(--loss); }
.efl .player-foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.efl .streak.s-W { color: var(--win); border-color: rgba(78,216,168,0.35); }
.efl .streak.s-L { color: var(--loss); border-color: rgba(224,96,126,0.35); }
.efl .h2h { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 12px; }

.efl .awards { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-bottom: 14px; }
.efl .award { background: var(--panel); border: 1px solid var(--line); border-left-width: 2px; padding: 13px 15px; }
.efl .award.wide { grid-column: span 2; }
.efl .award.t-home { border-left-color: var(--home); }
.efl .award.t-away { border-left-color: var(--away); }
.efl .award.t-win { border-left-color: var(--win); }
.efl .award.t-draw { border-left-color: var(--draw); }
.efl .award-title { font-family: var(--mono); font-size: 10px; letter-spacing: 0.11em; text-transform: uppercase; color: var(--muted); margin-bottom: 5px; }
.efl .award-name { font-size: 18px; font-weight: 800; letter-spacing: -0.03em; line-height: 1.15; }
.efl .two { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 14px; }
.efl .formlist, .efl .recent, .efl .logl, .efl .acctlist { list-style: none; margin: 12px 0 0; padding: 0; }
.efl .formlist li { display: grid; grid-template-columns: 22px 1fr auto auto; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid rgba(49,43,69,0.5); }
.efl .formlist .pos { color: var(--muted); font-size: 12px; }
.efl .formlist .pts { text-align: right; font-weight: 700; }
.efl .formlist .name, .efl .recent .name, .efl .acctlist .name { font-weight: 700; letter-spacing: -0.015em; }
.efl .recent li { display: grid; grid-template-columns: 1fr auto 1fr 44px; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid rgba(49,43,69,0.5); }
.efl .recent li .side.away { text-align: right; }
.efl .recent li .sm { text-align: right; }

.efl .logl li { display: grid; grid-template-columns: 76px 1fr auto; gap: 12px; align-items: baseline; padding: 8px 0; border-bottom: 1px solid rgba(49,43,69,0.5); font-size: 13px; }
.efl .log-who { font-weight: 700; color: var(--home); font-size: 12px; letter-spacing: -0.01em; }
.efl .log-text { min-width: 0; }
.efl .acctlist li { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 0; border-bottom: 1px solid rgba(49,43,69,0.5); }
.efl .acctlist .btns { margin-left: auto; }
.efl .reset { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line); }

.efl .foot { margin-top: 26px; padding-top: 14px; border-top: 1px solid var(--line); }
.efl .foot p { font-size: 11px; color: var(--muted); font-family: var(--mono); }

@media (max-width: 620px) {
  .efl .sm-hide { display: none; }
  .efl .match-btn { grid-template-columns: 1fr 60px 1fr; row-gap: 8px; }
  .efl .match-meta { grid-column: 1 / -1; justify-content: flex-start; }
  .efl .odds li { grid-template-columns: 68px 1fr 50px; }
  .efl .odds-top { display: none; }
  .efl .award.wide { grid-column: span 1; }
  .efl .logl li { grid-template-columns: 1fr; gap: 2px; }
}
@media (prefers-reduced-motion: reduce) {
  .efl .row-in { animation: none; }
  .efl .pseg, .efl .odds-fill { transition: none; }
}
`}</style>
  );
}
