import { useState, useEffect, useMemo, useCallback, useRef } from "react";

/* ============================================================
   EFOOTBALL ELITE LEAGUE
   Shared standings, fixtures, predictions and collaborative editing.
   All league data lives in one shared storage key, so everyone who
   opens this sees and edits the same season.
   ============================================================ */

const STORE_KEY = "efl:league:v1";
const ME_KEY = "efl:me:v1";
const BYE = "__BYE__";

/* ---------- model constants (tuned against the plan's examples) ---------- */
const BASE_GOALS = 1.6;   // goals per player per match at even strength
const RATING_SCALE = 22;  // rating points that shift attack/defence by a factor of e
const HOME_FACTOR = 1.10; // home multiplier on expected goals
const SHRINK = 1;         // matches before real results outweigh the starting rating
const SIMS = 1500;        // simulated seasons for title odds

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

const DEFAULT_STATE = {
  version: 1,
  season: "Season 1",
  startDate: "2026-08-18",
  homeAdvantage: true,
  players: DEFAULT_PLAYERS,
  results: {}, // id -> { hg, ag, ts }
  dates: {},   // id -> "YYYY-MM-DD"
  friendlies: [],
  log: [],
};

/* ============================ engine ============================ */

function buildFixtures(players, startDate, dateOverrides) {
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
      date: dateOverrides[id] || addDays(startDate, (round - 1) * 7),
    });
  };
  rounds.forEach((pairs, i) => pairs.forEach(([h, a]) => push(h, a, i + 1)));
  rounds.forEach((pairs, i) => pairs.forEach(([h, a]) => push(a, h, rounds.length + i + 1)));
  return out;
}

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

function fmtDateLong(iso) {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

/** Fixtures with results attached, in playing order. */
function withResults(fixtures, results) {
  return fixtures.map((f) => {
    const r = results[f.id];
    return r ? { ...f, hg: r.hg, ag: r.ag, ts: r.ts, played: true } : { ...f, played: false };
  });
}

function blankRow(p) {
  return {
    name: p.name, rating: p.rating,
    p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0,
    seq: [], // chronological "W"|"D"|"L"
  };
}

function computeTable(players, matches) {
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
      b.rating - a.rating ||
      a.name.localeCompare(b.name)
  );
  list.forEach((r, i) => { r.pos = i + 1; });
  return list;
}

function sortByDate(a, b) {
  return a.date.localeCompare(b.date) || a.round - b.round || a.id.localeCompare(b.id);
}

/** Attack / defence multipliers: starting rating, shaded by actual results and recent form. */
function computeStrengths(players, table, matches) {
  const meanRating = players.reduce((s, p) => s + p.rating, 0) / players.length;
  const totalTeamMatches = table.reduce((s, r) => s + r.p, 0);
  const totalGoals = table.reduce((s, r) => s + r.gf, 0);
  const observedAvg = totalTeamMatches ? totalGoals / totalTeamMatches : BASE_GOALS;
  const wScale = totalTeamMatches / (totalTeamMatches + 20);
  const scale = (1 - wScale) * BASE_GOALS + wScale * observedAvg;

  const byName = new Map(table.map((r) => [r.name, r]));
  const out = new Map();
  for (const p of players) {
    const row = byName.get(p.name) || blankRow(p);
    const attPrior = Math.exp((p.rating - meanRating) / RATING_SCALE);
    const defPrior = Math.exp(-(p.rating - meanRating) / RATING_SCALE);
    let att = attPrior;
    let def = defPrior;
    if (row.p > 0) {
      const w = row.p / (row.p + SHRINK);
      att = (1 - w) * attPrior + w * (row.gf / row.p / scale);
      def = (1 - w) * defPrior + w * (row.ga / row.p / scale);
    }
    if (last5.length) {
      const ppg = last5.reduce((s, r) => s + (r === "W" ? 3 : r === "D" ? 1 : 0), 0) / last5.length;
      const form = clamp(1 + 0.04 * (ppg - 1.5), 0.92, 1.08);
      att *= form;
    }
    out.set(p.name, { att: clamp(att, 0.25, 3.2), def: clamp(def, 0.25, 3.2) });
  }
  return { strengths: out, scale };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const FACT = (() => {
  const f = [1];
  for (let i = 1; i <= 12; i++) f[i] = f[i - 1] * i;
  return f;
})();
const pmf = (k, l) => (Math.exp(-l) * Math.pow(l, k)) / FACT[k];

function lambdas(home, away, strengths, scale, homeAdvantage) {
  const H = strengths.get(home);
  const A = strengths.get(away);
  if (!H || !A) return [scale, scale];
  const adv = homeAdvantage ? HOME_FACTOR : 1;
  return [
    clamp(scale * H.att * A.def * adv, 0.12, 6),
    clamp(scale * A.att * H.def / adv, 0.12, 6),
  ];
}

function predict(home, away, strengths, scale, homeAdvantage) {
  const [lh, la] = lambdas(home, away, strengths, scale, homeAdvantage);
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

function samplePoisson(l) {
  const L = Math.exp(-l);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

/** Monte Carlo the rest of the season for title / top-three odds. */
function simulateSeason(players, matches, strengths, scale, homeAdvantage, sims = SIMS) {
  const remaining = matches.filter((m) => !m.played);
  if (!remaining.length) return null;
  const base = new Map(
    computeTable(players, matches).map((r) => [r.name, { pts: r.pts, gd: r.gd, gf: r.gf }])
  );
  const lam = remaining.map((m) => ({
    home: m.home,
    away: m.away,
    l: lambdas(m.home, m.away, strengths, scale, homeAdvantage),
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

function longestRun(seq, mark) {
  let best = 0, cur = 0;
  for (const s of seq) {
    if (s === mark) { cur++; best = Math.max(best, cur); } else cur = 0;
  }
  return best;
}

function currentStreak(seq) {
  if (!seq.length) return null;
  const mark = seq[seq.length - 1];
  let n = 0;
  for (let i = seq.length - 1; i >= 0 && seq[i] === mark; i--) n++;
  return { mark, n };
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function deltaText(v) {
  return v > 0 ? `+${v}` : `${v}`;
}

function friendlyDelta(homeRating, awayRating, hg, ag) {
  const expectedHome = 1 / (1 + Math.exp((awayRating - homeRating) / RATING_SCALE));
  const actualHome = hg > ag ? 1 : hg === ag ? 0.5 : 0;
  const margin = Math.max(1, Math.min(3, Math.abs(hg - ag) || 1));
  let raw = Math.round((actualHome - expectedHome) * 7 * margin);
  if (raw === 0 && actualHome !== 0.5) raw = actualHome === 1 ? 1 : -1;
  return clamp(raw, -6, 6);
}

function applyFriendlyImpact(players, match) {
  const home = players.find((p) => p.name === match.home);
  const away = players.find((p) => p.name === match.away);
  if (!home || !away || !match.played) return { homeDelta: 0, awayDelta: 0 };

  const raw = friendlyDelta(home.rating, away.rating, match.hg, match.ag);
  const delta = Math.round(raw * 0.3) || (raw > 0 ? 1 : raw < 0 ? -1 : 0);
  home.rating = clamp(home.rating + delta, 40, 99);
  away.rating = clamp(away.rating - delta, 40, 99);
  return { homeDelta: delta, awayDelta: -delta };
}

function revertFriendlyImpact(players, match) {
  const home = players.find((p) => p.name === match.home);
  const away = players.find((p) => p.name === match.away);
  if (!home || !away || !match.played) return;

  home.rating = clamp(home.rating - (match.homeDelta || 0), 40, 99);
  away.rating = clamp(away.rating - (match.awayDelta || 0), 40, 99);
}

/* ============================ storage ============================ */

const KV_URL = "https://frank-mutt-169456.upstash.io";
const KV_TOKEN = "gQAAAAAAApXwAAIgcDE1YmM3NzdjYTViM2E0MDJmYWZiMTk2NDg3ZmJhZWYxZQ";

async function readShared() {
  try {
    const res = await fetch(`${KV_URL}/get/${STORE_KEY}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    const data = await res.json();
    if (data.result) return JSON.parse(data.result);
  } catch (_) {}
  return null;
}

async function writeShared(state) {
  const res = await fetch(`${KV_URL}/set/${STORE_KEY}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "text/plain"
    },
    body: JSON.stringify(state)
  });
  if (!res.ok) throw new Error("Vercel KV write failed");
  return true;
}

async function readMe() {
  try {
    const res = await window.storage.get(ME_KEY, false);
    if (res && res.value) return JSON.parse(res.value).name || null;
  } catch (_) { /* no identity yet */ }
  return null;
}

/* ============================ app ============================ */

const TABS = [
  ["table", "Table"],
  ["fixtures", "Fixtures"],
  ["friendly", "Friendly"],
  ["predict", "Predictions"],
  ["players", "Players"],
  ["stats", "Stats"],
  ["log", "Activity"],
];

export default function App() {
  const [state, setState] = useState(DEFAULT_STATE);
  const [me, setMe] = useState(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState("table");
  const [sync, setSync] = useState("loading");
  const [error, setError] = useState(null);
  const editing = useRef(false);

  /* first load */
  useEffect(() => {
    let alive = true;
    (async () => {
      const [remote, name] = await Promise.all([readShared(), readMe()]);
      if (!alive) return;
      if (remote) setState({ ...DEFAULT_STATE, ...remote });
      else {
        try { await writeShared(DEFAULT_STATE); } catch (_) { /* read-only is fine */ }
      }
      setMe(name);
      setReady(true);
      setSync("ok");
    })();
    return () => { alive = false; };
  }, []);

  /* keep everyone in step */
  const pull = useCallback(async () => {
    if (editing.current) return;
    const remote = await readShared();
    if (remote) {
      setState((prev) =>
        JSON.stringify(prev) === JSON.stringify({ ...DEFAULT_STATE, ...remote })
          ? prev
          : { ...DEFAULT_STATE, ...remote }
      );
      setSync("ok");
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    const id = setInterval(pull, 20000);
    return () => clearInterval(id);
  }, [ready, pull]);

  /* read latest, apply the change, write back — keeps concurrent edits from clobbering */
  const commit = useCallback(async (mutator, entry) => {
    setSync("saving");
    setError(null);
    try {
      const remote = (await readShared()) || state;
      const next = JSON.parse(JSON.stringify({ ...DEFAULT_STATE, ...remote }));
      mutator(next);
      if (entry) {
        next.log = [
          { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, who: entry.who, text: entry.text, ts: Date.now() },
          ...(next.log || []),
        ].slice(0, 80);
      }
      await writeShared(next);
      setState(next);
      setSync("ok");
    } catch (e) {
      setSync("error");
      setError("Change didn't save. Check your connection and try again.");
    }
  }, [state]);

  const chooseMe = useCallback(async (name) => {
    setMe(name);
    try { await window.storage.set(ME_KEY, JSON.stringify({ name }), false); } catch (_) { /* non-critical */ }
  }, []);

  const fixtures = useMemo(
    () => buildFixtures(state.players, state.startDate, state.dates || {}),
    [state.players, state.startDate, state.dates]
  );
  const matches = useMemo(() => withResults(fixtures, state.results || {}), [fixtures, state.results]);
  const table = useMemo(() => computeTable(state.players, matches), [state.players, matches]);
  const { strengths, scale } = useMemo(
    () => computeStrengths(state.players, table, matches),
    [state.players, table, matches]
  );
  const predictor = useCallback(
    (h, a) => predict(h, a, strengths, scale, state.homeAdvantage),
    [strengths, scale, state.homeAdvantage]
  );

  const playedCount = matches.filter((m) => m.played).length;
  const canEdit = Boolean(me) && me !== "Spectator";

  return (
    <div className="efl">
      <Styles />
      <div className="wrap">
        <Header
          state={state}
          me={me}
          sync={sync}
          played={playedCount}
          total={matches.length}
          onRefresh={pull}
          onSwitch={() => setMe(null)}
        />

        {!me && ready && <Identity players={state.players} onPick={chooseMe} />}
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
            {tab === "table" && <TableView table={table} total={matches.length} />}
            {tab === "fixtures" && (
              <Fixtures
                state={state}
                matches={matches}
                predictor={predictor}
                canEdit={canEdit}
                me={me}
                commit={commit}
                editing={editing}
              />
            )}
            {tab === "friendly" && (
              <Friendly
                state={state}
                predictor={predictor}
                canEdit={canEdit}
                me={me}
                commit={commit}
              />
            )}
            {tab === "predict" && (
              <Predictions
                state={state}
                matches={matches}
                strengths={strengths}
                scale={scale}
                predictor={predictor}
                commit={commit}
                canEdit={canEdit}
                me={me}
              />
            )}
            {tab === "players" && (
              <Players
                state={state}
                table={table}
                matches={matches}
                canEdit={canEdit}
                me={me}
                commit={commit}
              />
            )}
            {tab === "stats" && <Stats table={table} matches={matches} />}
            {tab === "log" && <Activity log={state.log || []} canEdit={canEdit} me={me} commit={commit} />}
          </>
        )}

        <footer className="foot">
          <p>Everyone opening this link reads and writes the same season. Edits are logged under your name.</p>
        </footer>
      </div>
    </div>
  );
}

/* ---------------------------- header ---------------------------- */

function Header({ state, me, sync, played, total, onRefresh, onSwitch }) {
  const label = { loading: "Loading", ok: "In sync", saving: "Saving…", error: "Not saved" }[sync];
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
        <p className="eyebrow">
          {state.season} · {state.players.length} players · {played}/{total} played
        </p>
        <h1>EFootball Elite League</h1>
      </div>
      <div className="head-side">
        <span className={`pill sync-${sync}`}>{label}</span>
        <button className="ghost" onClick={onRefresh}>Refresh</button>
        {me && <button className="ghost who" onClick={onSwitch} title="Change who you are">{me}</button>}
      </div>
    </header>
  );
}

function Identity({ players, onPick }) {
  return (
    <section className="card ident">
      <h2 className="h2">Who's playing?</h2>
      <p className="muted">Pick your name so your edits are signed. Choose Spectator to look without editing.</p>
      <div className="chips">
        {players.map((p) => (
          <button key={p.name} className="chip" onClick={() => onPick(p.name)}>{p.name}</button>
        ))}
        <button className="chip quiet" onClick={() => onPick("Spectator")}>Spectator</button>
      </div>
    </section>
  );
}

/* ---------------------------- table ---------------------------- */

function TableView({ table, total }) {
  const done = table.reduce((s, r) => s + r.p, 0) / 2 === total && total > 0;
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="h2">League table</h2>
        <p className="muted sm">Points, then goal difference, then goals for, then head-to-head.</p>
      </div>
      <div className="scroll">
        <table className="grid">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Player</th>
              <th className="num">P</th>
              <th className="num sm-hide">W</th>
              <th className="num sm-hide">D</th>
              <th className="num sm-hide">L</th>
              <th className="num sm-hide">GF</th>
              <th className="num sm-hide">GA</th>
              <th className="num">GD</th>
              <th className="num pts">Pts</th>
              <th>Form</th>
            </tr>
          </thead>
          <tbody>
            {table.map((r, i) => (
              <tr key={r.name} className={`row-in${r.pos === 1 ? " lead" : ""}`} style={{ animationDelay: `${i * 40}ms` }}>
                <td className="num pos">{r.pos}</td>
                <td className="name">
                  {r.name}
                  {done && r.pos === 1 && <span className="crown" title="Champion">Champion</span>}
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
    </section>
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

/* ---------------------------- fixtures ---------------------------- */

function Fixtures({ state, matches, predictor, canEdit, me, commit, editing }) {
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
    <section>
      <div className="card-head bar">
        <div>
          <h2 className="h2">Fixtures</h2>
          <p className="muted sm">
            Double round-robin. Season opens {fmtDateLong(state.startDate)}; matchdays run weekly unless a date is changed.
          </p>
        </div>
        <div className="seg">
          {[["all", "All"], ["upcoming", "To play"], ["played", "Played"]].map(([k, l]) => (
            <button key={k} className={`segb${filter === k ? " on" : ""}`} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
      </div>

      {canEdit && (
        <div className="card sub">
          <label className="field">
            <span className="lbl">Season opens</span>
            <input
              type="date"
              className="input"
              value={state.startDate}
              onChange={(e) => {
                const v = e.target.value;
                if (v) commit((s) => { s.startDate = v; }, { who: me, text: `Moved the season opener to ${fmtDate(v)}` });
              }}
            />
          </label>
          <p className="muted sm">Moving this shifts every matchday that hasn't been given its own date.</p>
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
                  key={m.id}
                  m={m}
                  pred={predictor(m.home, m.away)}
                  open={open === m.id}
                  onToggle={() => setOpen(open === m.id ? null : m.id)}
                  canEdit={canEdit}
                  me={me}
                  commit={commit}
                  editing={editing}
                />
              ))}
            </ul>
          </div>
        );
      })}
      {!shown.length && <p className="empty">Nothing here yet.</p>}
    </section>
  );
}

function MatchRow({ m, pred, open, onToggle, canEdit, me, commit, editing }) {
  return (
    <li className={`match${open ? " open" : ""}`}>
      <button className="match-btn" onClick={onToggle} aria-expanded={open}>
        <span className="side home">{m.home}</span>
        <span className="score">
          {m.played ? (
            <span className="mono ft">{m.hg}<i>–</i>{m.ag}</span>
          ) : (
            <span className="mono vs">vs</span>
          )}
        </span>
        <span className="side away">{m.away}</span>
        <span className="match-meta">
          {m.played ? <span className="pill done">FT</span> : <ProbBar pred={pred} compact />}
        </span>
      </button>
      {open && <Editor m={m} pred={pred} canEdit={canEdit} me={me} commit={commit} editing={editing} />}
    </li>
  );
}

function Editor({ m, pred, canEdit, me, commit, editing }) {
  const [hg, setHg] = useState(m.played ? String(m.hg) : "");
  const [ag, setAg] = useState(m.played ? String(m.ag) : "");
  const [date, setDate] = useState(m.date);

  useEffect(() => {
    editing.current = true;
    return () => { editing.current = false; };
  }, [editing]);

  const valid = hg !== "" && ag !== "" && Number(hg) >= 0 && Number(ag) >= 0;

  const save = () => {
    if (!valid) return;
    const h = Math.min(30, Math.round(Number(hg)));
    const a = Math.min(30, Math.round(Number(ag)));
    commit(
      (s) => {
        s.results[m.id] = { hg: h, ag: a, ts: Date.now() };
        if (date !== m.date) s.dates[m.id] = date;
      },
      { who: me, text: `${m.home} ${h}–${a} ${m.away} · MD${m.round}` }
    );
  };

  const clear = () => {
    commit(
      (s) => { delete s.results[m.id]; },
      { who: me, text: `Cleared the result for ${m.home} v ${m.away} · MD${m.round}` }
    );
  };

  const moveDate = (v) => {
    setDate(v);
    if (!v || v === m.date) return;
    commit(
      (s) => { s.dates[m.id] = v; },
      { who: me, text: `Moved ${m.home} v ${m.away} to ${fmtDate(v)}` }
    );
  };

  return (
    <div className="editor">
      <div className="pred-full">
        <ProbBar pred={pred} />
        <p className="mono sm muted">
          Expected goals {pred.lh.toFixed(2)} – {pred.la.toFixed(2)} · most likely {pred.likely}
        </p>
      </div>

      {!canEdit ? (
        <p className="muted sm">Pick your name at the top to add or change results.</p>
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
              <input type="date" className="input" value={date} onChange={(e) => moveDate(e.target.value)} />
            </label>
            <div className="btns">
              <button className="primary" onClick={save} disabled={!valid}>
                {m.played ? "Update result" : "Save result"}
              </button>
              {m.played && <button className="ghost danger" onClick={clear}>Clear result</button>}
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
          className="goal mono"
          inputMode="numeric"
          value={value}
          placeholder="0"
          onChange={(e) => {
            const v = e.target.value.replace(/[^0-9]/g, "").slice(0, 2);
            onChange(v);
          }}
          aria-label={`Goals for ${label}`}
        />
        <button className="step" onClick={() => onChange(String(Math.min(30, n + 1)))} aria-label={`One more goal for ${label}`}>+</button>
      </div>
    </div>
  );
}

/* ---------------------------- predictions ---------------------------- */

function ProbBar({ pred, compact }) {
  const pct = (v) => `${Math.round(v * 100)}%`;
  return (
    <span className={`bar${compact ? " compact" : ""}`}>
      <span className="track">
        <span className="seg s-home" style={{ width: pct(pred.home) }} />
        <span className="seg s-draw" style={{ width: pct(pred.draw) }} />
        <span className="seg s-away" style={{ width: pct(pred.away) }} />
      </span>
      <span className="legend mono">
        <span className="l-home">{pct(pred.home)}</span>
        <span className="l-draw">{pct(pred.draw)}</span>
        <span className="l-away">{pct(pred.away)}</span>
      </span>
    </span>
  );
}

function Predictions({ state, matches, strengths, scale, predictor, commit, canEdit, me }) {
  const upcoming = matches.filter((m) => !m.played);
  const nextRound = upcoming.length ? Math.min(...upcoming.map((m) => m.round)) : null;
  const [round, setRound] = useState(nextRound || 1);
  const rounds = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b);
  const slate = matches.filter((m) => m.round === round);

  const odds = useMemo(
    () => simulateSeason(state.players, matches, strengths, scale, state.homeAdvantage),
    [state.players, matches, strengths, scale, state.homeAdvantage]
  );

  return (
    <section>
      <div className="card-head bar">
        <div>
          <h2 className="h2">Prediction centre</h2>
          <p className="muted sm">
            Starting ratings decide the early numbers. After five matches, real goals and form carry more weight than the rating.
          </p>
        </div>
        {canEdit && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={Boolean(state.homeAdvantage)}
              onChange={(e) => {
                const on = e.target.checked;
                commit((s) => { s.homeAdvantage = on; }, { who: me, text: `Turned home advantage ${on ? "on" : "off"}` });
              }}
            />
            <span>Home advantage</span>
          </label>
        )}
      </div>

      <div className="card">
        <div className="round-head">
          <h3 className="h3">Matchday {round}</h3>
          <span className="mono sm muted">{slate.length ? fmtDate(slate[0].date) : ""}</span>
          <div className="seg tight">
            <button className="segb" onClick={() => setRound(Math.max(rounds[0], round - 1))} disabled={round <= rounds[0]}>Prev</button>
            <button className="segb" onClick={() => setRound(Math.min(rounds[rounds.length - 1], round + 1))} disabled={round >= rounds[rounds.length - 1]}>Next</button>
          </div>
        </div>
        <div className="pcards">
          {slate.map((m) => {
            const p = predictor(m.home, m.away);
            return (
              <article className="pcard" key={m.id}>
                <header className="pcard-head">
                  <span className="side home">{m.home}</span>
                  <span className="mono sm muted">{m.played ? `FT ${m.hg}–${m.ag}` : fmtDate(m.date)}</span>
                  <span className="side away">{m.away}</span>
                </header>
                <ProbBar pred={p} />
                <p className="mono sm muted center">
                  xG {p.lh.toFixed(2)} – {p.la.toFixed(2)} · likely {p.likely}
                </p>
              </article>
            );
          })}
        </div>
      </div>

      {odds && (
        <div className="card">
          <div className="card-head">
            <h3 className="h3">Title odds</h3>
            <p className="muted sm">
              {SIMS.toLocaleString()} simulated seasons from today's table, using each fixture's expected goals.
            </p>
          </div>
          <ul className="odds">
            {odds.map((o) => (
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

/* ---------------------------- players ---------------------------- */

function Players({ state, table, matches, canEdit, me, commit }) {
  const [openName, setOpenName] = useState(null);
  const [setup, setSetup] = useState(false);
  const byName = new Map(table.map((r) => [r.name, r]));
  const ordered = [...state.players].sort((a, b) => b.rating - a.rating);

  return (
    <section>
      <div className="card-head bar">
        <div>
          <h2 className="h2">Players</h2>
          <p className="muted sm">Ratings are starting strength for the prediction engine. They never touch the table.</p>
        </div>
        {canEdit && (
          <button className="ghost" onClick={() => setSetup(!setup)}>{setup ? "Done" : "Edit ratings"}</button>
        )}
      </div>

      <div className="pgrid">
        {ordered.map((p) => {
          const r = byName.get(p.name) || blankRow(p);
          const st = currentStreak(r.seq);
          const isOpen = openName === p.name;
          return (
            <article className={`card player${isOpen ? " open" : ""}`} key={p.name}>
              <header className="player-head">
                <div className="rating">
                  {setup ? (
                    <input
                      className="rating-input mono"
                      inputMode="numeric"
                      defaultValue={p.rating}
                      onBlur={(e) => {
                        const v = clamp(Math.round(Number(e.target.value) || p.rating), 40, 99);
                        if (v === p.rating) return;
                        commit(
                          (s) => { const t = s.players.find((x) => x.name === p.name); if (t) t.rating = v; },
                          { who: me, text: `Set ${p.name}'s starting rating to ${v}` }
                        );
                      }}
                      aria-label={`Starting rating for ${p.name}`}
                    />
                  ) : (
                    <span className="mono rating-num">{p.rating}</span>
                  )}
                  <span className="rating-lbl">rating</span>
                </div>
                <div className="player-id">
                  <h3 className="h3">{p.name}</h3>
                  <p className="mono sm muted">
                    {r.p ? `${ordinal(r.pos)} · ${r.pts} pts` : "yet to play"}
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
  const rows = players
    .filter((p) => p.name !== name)
    .map((p) => {
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

const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/* ---------------------------- friendly ---------------------------- */

function Friendly({ state, predictor, canEdit, me, commit }) {
  const playerNames = useMemo(() => state.players.map((p) => p.name), [state.players]);
  const friendlies = useMemo(
    () => [...(state.friendlies || [])].sort((a, b) => (b.ts || 0) - (a.ts || 0)),
    [state.friendlies]
  );

  const [editingId, setEditingId] = useState(null);
  const [home, setHome] = useState(playerNames[0] || "");
  const [away, setAway] = useState(playerNames[1] || "");
  const [date, setDate] = useState(todayISO());
  const [hg, setHg] = useState("");
  const [ag, setAg] = useState("");

  const selected = friendlies.find((m) => m.id === editingId) || null;

  useEffect(() => {
    if (!selected) {
      setHome(playerNames[0] || "");
      setAway(playerNames[1] || "");
      setDate(todayISO());
      setHg("");
      setAg("");
      return;
    }
    setHome(selected.home);
    setAway(selected.away);
    setDate(selected.date || todayISO());
    setHg(selected.played ? String(selected.hg) : "");
    setAg(selected.played ? String(selected.ag) : "");
  }, [editingId, selected, playerNames]);

  const canSave =
    canEdit &&
    home &&
    away &&
    home !== away &&
    date &&
    ((hg === "" && ag === "") || (hg !== "" && ag !== "" && Number(hg) >= 0 && Number(ag) >= 0));

  const save = () => {
    if (!canSave) return;

    const hasScore = hg !== "" && ag !== "";
    const h = hasScore ? clamp(Math.round(Number(hg)), 0, 30) : null;
    const a = hasScore ? clamp(Math.round(Number(ag)), 0, 30) : null;
    const now = Date.now();

    commit(
      (s) => {
        if (!Array.isArray(s.friendlies)) s.friendlies = [];
        if (!Array.isArray(s.players)) return;

        const id = editingId || `${now}-${home}-${away}`.replace(/\s+/g, "-");
        const idx = s.friendlies.findIndex((m) => m.id === id);
        const existing = idx >= 0 ? s.friendlies[idx] : null;

        if (existing?.played) {
          revertFriendlyImpact(s.players, existing);
        }

        const match = {
          id,
          home,
          away,
          date,
          played: hasScore,
          ts: now,
        };

        if (hasScore) {
          match.hg = h;
          match.ag = a;
          const impact = applyFriendlyImpact(s.players, match);
          match.homeDelta = impact.homeDelta;
          match.awayDelta = impact.awayDelta;
        } else {
          match.homeDelta = 0;
          match.awayDelta = 0;
        }

        if (idx >= 0) s.friendlies[idx] = match;
        else s.friendlies.unshift(match);

        s.log = [
          {
            id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
            who: me,
            text: hasScore
              ? `Friendly: ${home} ${h}–${a} ${away}`
              : `Friendly scheduled: ${home} vs ${away}`,
            ts: now,
          },
          ...(s.log || []),
        ].slice(0, 80);
      },
      {
        who: me,
        text: editingId
          ? `Updated friendly ${home} vs ${away}`
          : `Added friendly ${home} vs ${away}`,
      }
    );

    setEditingId(null);
  };

  const remove = (match) => {
    commit(
      (s) => {
        if (!Array.isArray(s.friendlies)) return;
        const idx = s.friendlies.findIndex((m) => m.id === match.id);
        if (idx < 0) return;

        const existing = s.friendlies[idx];
        if (existing?.played) {
          revertFriendlyImpact(s.players, existing);
        }

        s.friendlies.splice(idx, 1);
      },
      { who: me, text: `Removed friendly ${match.home} vs ${match.away}` }
    );

    if (editingId === match.id) setEditingId(null);
  };

  const edit = (match) => {
    setEditingId(match.id);
  };

  return (
    <section>
      <div className="card-head bar">
        <div>
          <h2 className="h2">Friendly</h2>
          <p className="muted sm">
            Optional matches only. Add any pair you want. If you enter a score, the player ratings change and the prediction
            engine learns from it.
          </p>
        </div>
      </div>

      <div className="card friendly-card">
        <div className="friendly-grid">
          <div className="friendly-pair">
            <label className="field">
              <span className="lbl">Home player</span>
              <select className="input" value={home} onChange={(e) => setHome(e.target.value)}>
                {playerNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>

            <span className="mono muted" style={{ alignSelf: "center", paddingTop: 20 }}>
              vs
            </span>

            <label className="field">
              <span className="lbl">Away player</span>
              <select className="input" value={away} onChange={(e) => setAway(e.target.value)}>
                {playerNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="friendly-pair">
            <label className="field">
              <span className="lbl">Date</span>
              <input
                type="date"
                className="input"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>

            <span className="mono muted" style={{ alignSelf: "center", paddingTop: 20 }}>
              score
            </span>

            <div className="score-edit" style={{ justifyContent: "flex-start" }}>
              <Stepper label={home || "Home"} value={hg} onChange={setHg} tone="home" />
              <span className="dash mono">–</span>
              <Stepper label={away || "Away"} value={ag} onChange={setAg} tone="away" />
            </div>
          </div>

          <div className="btns">
            <button className="primary" onClick={save} disabled={!canSave}>
              {editingId ? "Update friendly" : "Save friendly"}
            </button>
            {editingId && (
              <button className="ghost" onClick={() => setEditingId(null)}>
                Cancel edit
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3 className="h3">Friendly matches</h3>
          <p className="muted sm">Newest first. Played matches move ratings, scheduled ones do not.</p>
        </div>

        {!friendlies.length ? (
          <p className="empty">No friendly matches yet.</p>
        ) : (
          <ul className="friendly-list">
            {friendlies.map((m) => {
              const pred = predictor(m.home, m.away);
              return (
                <li key={m.id} className="friendly-item">
                  <div className="friendly-top">
                    <div>
                      <div className="friendly-title">
                        <span className="side home">{m.home}</span>
                        <span className="mono muted" style={{ padding: "0 6px" }}>
                          vs
                        </span>
                        <span className="side away">{m.away}</span>
                      </div>
                      <div className="friendly-meta">
                        <span className="mono sm muted">{fmtDate(m.date)}</span>
                        {m.played ? (
                          <span className="pill done">FT {m.hg}–{m.ag}</span>
                        ) : (
                          <span className="pill todo">Scheduled</span>
                        )}
                        {m.played && (
                          <span className="pill">
                            {deltaText(m.homeDelta)} / {deltaText(m.awayDelta)}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="friendly-actions">
                      <button className="ghost small" onClick={() => edit(m)}>
                        Edit
                      </button>
                      <button className="ghost small danger" onClick={() => remove(m)}>
                        Delete
                      </button>
                    </div>
                  </div>

                  <div style={{ marginTop: 10 }}>
                    <ProbBar pred={pred} />
                    <p className="mono sm muted" style={{ marginTop: 6 }}>
                      xG {pred.lh.toFixed(2)} – {pred.la.toFixed(2)} · likely {pred.likely}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

/* ---------------------------- stats ---------------------------- */

function Stats({ table, matches }) {
  const active = table.filter((r) => r.p > 0);
  const played = matches.filter((m) => m.played).sort((a, b) => (b.ts || 0) - (a.ts || 0));

  if (!active.length) {
    return <p className="empty">Awards appear once the first result is in.</p>;
  }

  const bestAttack = [...active].sort((a, b) => b.gf / b.p - a.gf / a.p)[0];
  const bestDefence = [...active].sort((a, b) => a.ga / a.p - b.ga / b.p)[0];
  const streaks = active
    .map((r) => ({ name: r.name, n: longestRun(r.seq, "W") }))
    .sort((a, b) => b.n - a.n)[0];
  const ratingRank = new Map(
    [...table].sort((a, b) => b.rating - a.rating).map((r, i) => [r.name, i + 1])
  );
  const riser = [...active]
    .map((r) => ({ name: r.name, delta: ratingRank.get(r.name) - r.pos, pos: r.pos, seed: ratingRank.get(r.name) }))
    .sort((a, b) => b.delta - a.delta)[0];
  const biggest = [...matches.filter((m) => m.played)].sort(
    (a, b) => b.hg + b.ag - (a.hg + a.ag)
  )[0];
  const formTable = active
    .map((r) => {
      const last = r.seq.slice(-5);
      return {
        name: r.name,
        seq: last,
        pts: last.reduce((s, x) => s + (x === "W" ? 3 : x === "D" ? 1 : 0), 0),
      };
    })
    .sort((a, b) => b.pts - a.pts || b.seq.length - a.seq.length);

  return (
    <section>
      <div className="awards">
        <Award title="Best attack" name={bestAttack.name} value={`${(bestAttack.gf / bestAttack.p).toFixed(2)} goals per game`} tone="home" />
        <Award title="Best defence" name={bestDefence.name} value={`${(bestDefence.ga / bestDefence.p).toFixed(2)} conceded per game`} tone="away" />
        <Award
          title="Longest winning run"
          name={streaks.n ? streaks.name : "Nobody yet"}
          value={streaks.n ? `${streaks.n} straight win${streaks.n > 1 ? "s" : ""}` : "No back-to-back wins so far"}
          tone="win"
        />
        <Award
          title="Beating the seeding"
          name={riser && riser.delta > 0 ? riser.name : "Nobody yet"}
          value={
            riser && riser.delta > 0
              ? `Seeded ${ordinal(riser.seed)}, sitting ${ordinal(riser.pos)}`
              : "Everyone is at or below their seeding"
          }
          tone="draw"
        />
        <Award
          title="Highest scoring match"
          name={biggest ? `${biggest.home} ${biggest.hg}–${biggest.ag} ${biggest.away}` : "—"}
          value={biggest ? `${biggest.hg + biggest.ag} goals · MD${biggest.round}` : ""}
          tone="home"
          wide
        />
      </div>

      <div className="two">
        <div className="card">
          <h3 className="h3">Form table</h3>
          <p className="muted sm">Points from each player's last five matches.</p>
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
          <p className="muted sm">Newest first, by the time the score was entered.</p>
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

/* ---------------------------- activity ---------------------------- */

function Activity({ log, canEdit, me, commit }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="h2">Activity</h2>
        <p className="muted sm">Every change to a score, date or rating, newest first. Keeps the last 80.</p>
      </div>
      {!log.length ? (
        <p className="empty">Nothing has changed yet.</p>
      ) : (
        <ul className="logl">
          {log.map((e) => (
            <li key={e.id}>
              <span className="log-who">{e.who}</span>
              <span className="log-text">{e.text}</span>
              <span className="mono sm muted">{new Date(e.ts).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="reset">
          {!confirming ? (
            <button className="ghost danger" onClick={() => setConfirming(true)}>Start a new season</button>
          ) : (
            <div className="btns">
              <span className="muted sm">This clears every result, friendly, and the activity log. Ratings and dates stay.</span>
              <button
                className="primary danger"
                onClick={() => {
                  commit(
                    (s) => { s.results = {}; s.friendlies = []; s.log = []; },
                    { who: me, text: "Started a new season — all results cleared" }
                  );
                  setConfirming(false);
                }}
              >
                Clear all results
              </button>
              <button className="ghost" onClick={() => setConfirming(false)}>Keep the season</button>
            </div>
          )}
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
  color: var(--paper);
  min-height: 100vh;
  font-size: 15px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.efl *, .efl *::before, .efl *::after { box-sizing: border-box; }
.efl .wrap { max-width: 1080px; margin: 0 auto; padding: 22px 18px 56px; }
.efl h1, .efl h2, .efl h3 { margin: 0; }
.efl p { margin: 0; }
.efl button { font-family: inherit; font-size: inherit; cursor: pointer; }
.efl button:focus-visible, .efl input:focus-visible {
  outline: 2px solid var(--home); outline-offset: 2px; border-radius: 3px;
}
.efl .mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.efl .muted { color: var(--muted); }
.efl .sm { font-size: 12px; }
.efl .center { text-align: center; }
.efl .pad { padding: 24px 4px; }
.efl .empty { color: var(--muted); font-size: 13px; padding: 18px 4px; }
.efl .alert {
  border-left: 3px solid var(--loss); background: rgba(224,96,126,0.1);
  padding: 10px 14px; font-size: 13px; margin-bottom: 14px;
}

/* header */
.efl .head { display: flex; align-items: flex-start; gap: 14px; flex-wrap: wrap; margin-bottom: 20px; }
.efl .mark { color: var(--home); flex: 0 0 auto; margin-top: 4px; }
.efl .head-text { flex: 1 1 260px; min-width: 0; }
.efl .eyebrow {
  font-family: var(--mono); font-size: 11px; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--muted); margin-bottom: 4px;
}
.efl h1 {
  font-size: clamp(24px, 5.4vw, 40px); font-weight: 800;
  letter-spacing: -0.035em; line-height: 1.02; text-transform: uppercase;
}
.efl .head-side { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.efl .pill {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.09em;
  text-transform: uppercase; padding: 4px 8px; border: 1px solid var(--line);
  color: var(--muted); white-space: nowrap;
}
.efl .sync-ok { color: var(--win); border-color: rgba(78,216,168,0.4); }
.efl .sync-saving { color: var(--home); border-color: rgba(242,166,59,0.4); }
.efl .sync-error { color: var(--loss); border-color: rgba(224,96,126,0.5); }
.efl .pill.done { color: var(--win); border-color: rgba(78,216,168,0.35); }
.efl .pill.todo { color: var(--muted); }

.efl .ghost {
  background: none; border: 1px solid var(--line); color: var(--paper);
  padding: 5px 11px; font-size: 12px; transition: border-color .15s, color .15s;
}
.efl .ghost:hover { border-color: var(--home); color: var(--home); }
.efl .ghost.small { padding: 3px 9px; font-size: 11px; }
.efl .ghost.danger:hover { border-color: var(--loss); color: var(--loss); }
.efl .who { font-weight: 700; letter-spacing: -0.01em; }
.efl .primary {
  background: var(--home); border: 1px solid var(--home); color: #1A1206;
  font-weight: 700; padding: 7px 16px; font-size: 13px; letter-spacing: -0.01em;
}
.efl .primary:hover { filter: brightness(1.08); }
.efl .primary:disabled { opacity: .4; cursor: not-allowed; }
.efl .primary.danger { background: var(--loss); border-color: var(--loss); color: #22060D; }

/* tabs */
.efl .tabs {
  display: flex; gap: 2px; overflow-x: auto; border-bottom: 1px solid var(--line);
  margin-bottom: 18px; scrollbar-width: none;
}
.efl .tabs::-webkit-scrollbar { display: none; }
.efl .tab {
  background: none; border: none; border-bottom: 2px solid transparent;
  color: var(--muted); padding: 9px 13px; font-size: 12px;
  letter-spacing: 0.1em; text-transform: uppercase; font-family: var(--mono);
  white-space: nowrap; transition: color .15s;
}
.efl .tab:hover { color: var(--paper); }
.efl .tab.on { color: var(--home); border-bottom-color: var(--home); }

/* cards */
.efl .card {
  background: var(--panel); border: 1px solid var(--line);
  padding: 16px; margin-bottom: 14px;
}
.efl .card.sub { padding: 12px 16px; }
.efl .card-head { margin-bottom: 12px; }
.efl .card-head.bar {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 12px; flex-wrap: wrap;
}
.efl .h2 { font-size: 17px; font-weight: 750; letter-spacing: -0.02em; }
.efl .h3 { font-size: 14px; font-weight: 750; letter-spacing: -0.01em; }
.efl .ident .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.efl .chip {
  background: var(--panel2); border: 1px solid var(--line); color: var(--paper);
  padding: 7px 14px; font-weight: 650; letter-spacing: -0.01em; font-size: 13px;
}
.efl .chip:hover { border-color: var(--home); color: var(--home); }
.efl .chip.quiet { color: var(--muted); font-weight: 400; }

.efl .seg { display: flex; border: 1px solid var(--line); }
.efl .seg.tight { margin-left: auto; }
.efl .segb {
  background: none; border: none; color: var(--muted); padding: 5px 11px;
  font-size: 11px; font-family: var(--mono); letter-spacing: 0.08em; text-transform: uppercase;
}
.efl .segb + .segb { border-left: 1px solid var(--line); }
.efl .segb.on { background: var(--panel2); color: var(--home); }
.efl .segb:disabled { opacity: .35; cursor: not-allowed; }
.efl .toggle { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--muted); }
.efl .toggle input { accent-color: var(--home); width: 15px; height: 15px; }

/* table */
.efl .scroll { overflow-x: auto; }
.efl .grid { width: 100%; border-collapse: collapse; font-size: 14px; }
.efl .grid th {
  text-align: left; font-family: var(--mono); font-size: 10px;
  letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted);
  font-weight: 400; padding: 0 8px 8px; border-bottom: 1px solid var(--line);
}
.efl .grid td { padding: 9px 8px; border-bottom: 1px solid rgba(49,43,69,0.55); }
.efl .grid .num { text-align: right; font-family: var(--mono); font-variant-numeric: tabular-nums; }
.efl .grid th.num { text-align: right; }
.efl .grid .name { font-weight: 700; letter-spacing: -0.015em; white-space: nowrap; }
.efl .grid .pos { color: var(--muted); width: 30px; }
.efl .grid .pts { font-weight: 700; font-size: 15px; }
.efl .grid tbody tr.lead { background: rgba(242,166,59,0.06); }
.efl .grid tbody tr.lead .pos { color: var(--home); font-weight: 700; }
.efl .grid.tight td, .efl .grid.tight th { padding: 6px 7px; font-size: 13px; }
.efl .crown {
  font-family: var(--mono); font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--home); border: 1px solid rgba(242,166,59,0.4); padding: 2px 6px; margin-left: 8px;
}
.efl .row-in { animation: rise .34s ease-out both; }
@keyframes rise { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }

/* form dots */
.efl .form { display: inline-flex; gap: 3px; }
.efl .dot {
  width: 18px; height: 18px; display: grid; place-items: center;
  font-family: var(--mono); font-size: 10px; font-weight: 700;
}
.efl .d-W { background: rgba(78,216,168,0.16); color: var(--win); }
.efl .d-D { background: rgba(142,135,166,0.16); color: var(--muted); }
.efl .d-L { background: rgba(224,96,126,0.16); color: var(--loss); }

/* fixtures */
.efl .round-head {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding-bottom: 10px; margin-bottom: 6px; border-bottom: 1px solid var(--line);
}
.efl .round-head .pill { margin-left: auto; }
.efl .matches { list-style: none; margin: 0; padding: 0; }
.efl .match { border-bottom: 1px solid rgba(49,43,69,0.5); }
.efl .match:last-child { border-bottom: none; }
.efl .match.open { background: rgba(35,31,51,0.6); }
.efl .match-btn {
  width: 100%; background: none; border: none; color: inherit; text-align: left;
  display: grid; grid-template-columns: 1fr 74px 1fr 132px; align-items: center;
  gap: 10px; padding: 11px 4px;
}
.efl .match-btn:hover { background: rgba(35,31,51,0.5); }
.efl .side { font-weight: 700; letter-spacing: -0.015em; font-size: 14px; }
.efl .side.home { color: var(--home); }
.efl .side.away { color: var(--away); text-align: right; }
.efl .pcard-head .side.away, .efl .recent .side.away { text-align: right; }
.efl .score { text-align: center; }
.efl .ft { font-size: 17px; font-weight: 700; letter-spacing: -0.02em; }
.efl .ft i { color: var(--muted); font-style: normal; padding: 0 3px; }
.efl .ft.small { font-size: 14px; }
.efl .vs { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
.efl .match-meta { display: flex; justify-content: flex-end; }

/* prediction bar — the signature */
.efl .bar { display: block; width: 100%; }
.efl .track {
  display: flex; height: 8px; overflow: hidden; background: var(--panel2);
  border: 1px solid var(--line);
}
.efl .bar.compact .track { height: 6px; }
.efl .seg { display: block; transition: width .5s cubic-bezier(.22,.7,.25,1); }
.efl .s-home { background: var(--home); }
.efl .s-draw { background: var(--draw); }
.efl .s-away { background: var(--away); }
.efl .legend { display: flex; justify-content: space-between; font-size: 11px; margin-top: 4px; }
.efl .l-home { color: var(--home); }
.efl .l-draw { color: var(--muted); }
.efl .l-away { color: var(--away); }

/* editor */
.efl .editor { padding: 4px 4px 16px; display: grid; gap: 14px; }
.efl .pred-full { display: grid; gap: 6px; }
.efl .score-edit { display: flex; align-items: center; justify-content: center; gap: 14px; flex-wrap: wrap; }
.efl .stepper { display: grid; gap: 6px; justify-items: center; }
.efl .stepper-name {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase;
}
.efl .stepper.home .stepper-name { color: var(--home); }
.efl .stepper.away .stepper-name { color: var(--away); }
.efl .stepper-ctl { display: flex; align-items: stretch; border: 1px solid var(--line); }
.efl .step {
  background: var(--panel2); border: none; color: var(--paper);
  width: 34px; font-size: 16px; line-height: 1;
}
.efl .step:hover { color: var(--home); }
.efl .goal {
  width: 54px; background: var(--ink); border: none; border-left: 1px solid var(--line);
  border-right: 1px solid var(--line); color: var(--paper); text-align: center;
  font-size: 20px; font-weight: 700; padding: 8px 0;
}
.efl .dash { color: var(--muted); font-size: 18px; align-self: flex-end; padding-bottom: 10px; }
.efl .editor-row { display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap; justify-content: space-between; }
.efl .field { display: grid; gap: 5px; }
.efl .lbl {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em;
  text-transform: uppercase; color: var(--muted);
}
.efl .input {
  background: var(--ink); border: 1px solid var(--line); color: var(--paper);
  padding: 7px 10px; font-family: var(--mono); font-size: 13px;
}
.efl .btns { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

/* predictions */
.efl .pcards { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 14px; margin-top: 12px; }
.efl .pcard { background: var(--panel2); border-left: 2px solid var(--home); padding: 12px 14px; display: grid; gap: 8px; }
.efl .pcard-head { display: grid; grid-template-columns: 1fr auto 1fr; gap: 8px; align-items: center; }
.efl .odds { list-style: none; margin: 0; padding: 0; display: grid; gap: 7px; }
.efl .odds li { display: grid; grid-template-columns: 84px 1fr 56px 92px; align-items: center; gap: 10px; }
.efl .odds-name { font-weight: 700; font-size: 13px; letter-spacing: -0.015em; white-space: nowrap; }
.efl .odds-track { height: 10px; background: var(--panel2); border: 1px solid var(--line); }
.efl .odds-fill { display: block; height: 100%; background: var(--home); transition: width .5s cubic-bezier(.22,.7,.25,1); }
.efl .odds-val { font-size: 12px; text-align: right; }
.efl .odds-top { text-align: right; }

/* players */
.efl .pgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
.efl .player { margin-bottom: 0; }
.efl .player.open { grid-column: 1 / -1; }
.efl .player-head { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
.efl .rating {
  display: grid; justify-items: center; padding: 6px 10px;
  border: 1px solid rgba(242,166,59,0.35); background: rgba(242,166,59,0.07); min-width: 62px;
}
.efl .rating-num { font-size: 26px; font-weight: 800; letter-spacing: -0.04em; color: var(--home); line-height: 1; }
.efl .rating-input {
  width: 48px; background: var(--ink); border: 1px solid var(--home); color: var(--home);
  font-size: 22px; font-weight: 800; text-align: center; padding: 2px 0;
}
.efl .rating-lbl {
  font-family: var(--mono); font-size: 9px; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--muted); margin-top: 3px;
}
.efl .player-id { min-width: 0; }
.efl .player-id .h3 { font-size: 19px; font-weight: 800; letter-spacing: -0.03em; text-transform: uppercase; }
.efl .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 0 0 14px; }
.efl .stat { border-top: 1px solid var(--line); padding-top: 6px; }
.efl .stat dt {
  font-family: var(--mono); font-size: 9px; letter-spacing: 0.1em;
  text-transform: uppercase; color: var(--muted);
}
.efl .stat dd { margin: 2px 0 0; font-size: 16px; font-weight: 700; letter-spacing: -0.02em; }
.efl .stat.t-win dd { color: var(--win); }
.efl .stat.t-loss dd { color: var(--loss); }
.efl .player-foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.efl .streak.s-W { color: var(--win); border-color: rgba(78,216,168,0.35); }
.efl .streak.s-L { color: var(--loss); border-color: rgba(224,96,126,0.35); }
.efl .h2h { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 12px; }

/* stats */
.efl .awards { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-bottom: 14px; }
.efl .award { background: var(--panel); border: 1px solid var(--line); border-left-width: 2px; padding: 13px 15px; }
.efl .award.wide { grid-column: span 2; }
.efl .award.t-home { border-left-color: var(--home); }
.efl .award.t-away { border-left-color: var(--away); }
.efl .award.t-win { border-left-color: var(--win); }
.efl .award.t-draw { border-left-color: var(--draw); }
.efl .award-title {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.11em;
  text-transform: uppercase; color: var(--muted); margin-bottom: 5px;
}
.efl .award-name { font-size: 18px; font-weight: 800; letter-spacing: -0.03em; line-height: 1.15; }
.efl .two { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 14px; }
.efl .formlist, .efl .recent, .efl .logl { list-style: none; margin: 12px 0 0; padding: 0; }
.efl .formlist li { display: grid; grid-template-columns: 22px 1fr auto 30px; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid rgba(49,43,69,0.5); }
.efl .formlist .pos { color: var(--muted); font-size: 12px; }
.efl .formlist .pts { text-align: right; font-weight: 700; }
.efl .formlist .name, .efl .recent .name { font-weight: 700; letter-spacing: -0.015em; }
.efl .recent li { display: grid; grid-template-columns: 1fr auto 1fr 44px; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid rgba(49,43,69,0.5); }
.efl .recent li .sm { text-align: right; }

/* activity */
.efl .logl li { display: grid; grid-template-columns: 76px 1fr auto; gap: 12px; align-items: baseline; padding: 8px 0; border-bottom: 1px solid rgba(49,43,69,0.5); font-size: 13px; }
.efl .log-who { font-weight: 700; color: var(--home); font-size: 12px; letter-spacing: -0.01em; }
.efl .log-text { min-width: 0; }
.efl .reset { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line); }

/* friendly */
.efl .friendly-grid { display: grid; gap: 12px; }
.efl .friendly-pair { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 10px; align-items: end; }
.efl .friendly-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.efl .friendly-item { background: var(--panel2); border: 1px solid var(--line); padding: 12px; }
.efl .friendly-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.efl .friendly-title { display: flex; align-items: center; flex-wrap: wrap; gap: 0; font-weight: 800; letter-spacing: -0.02em; text-transform: uppercase; }
.efl .friendly-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; align-items: center; }
.efl .friendly-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }

.efl .foot { margin-top: 26px; padding-top: 14px; border-top: 1px solid var(--line); }
.efl .foot p { font-size: 11px; color: var(--muted); font-family: var(--mono); }

@media (max-width: 620px) {
  .efl .sm-hide { display: none; }
  .efl .match-btn { grid-template-columns: 1fr 60px 1fr; row-gap: 8px; }
  .efl .match-meta { grid-column: 1 / -1; }
  .efl .odds li { grid-template-columns: 68px 1fr 50px; }
  .efl .odds-top { display: none; }
  .efl .award.wide { grid-column: span 1; }
  .efl .logl li { grid-template-columns: 1fr; gap: 2px; }
  .efl .stats-row { grid-template-columns: repeat(4, 1fr); }
}
@media (prefers-reduced-motion: reduce) {
  .efl .row-in { animation: none; }
  .efl .seg, .efl .odds-fill { transition: none; }
}
`}</style>
  );
}


