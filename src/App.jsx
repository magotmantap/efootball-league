import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  buildFixtures, withResults, computeTable, computeLiveRatings, computeStrengths,
  predict, oddsForMatch, priceFixture, simulateSeason, computeBalances,
  fixtureParticipants, longestRun, currentStreak, todayISO, clamp,
  defaultState, migrate, MIN_STAKE, START_COINS, FRIENDLY_WEIGHT, SIMS,
} from "./engine.js";

/* ============================================================
   EFOOTBALL ELITE LEAGUE
   League + friendlies + predictions + coin betting, with player
   accounts. All math lives in src/engine.js (shared with the
   API). All writes go through api/league.js, which owns the
   database token, accounts and bets.

   With no API configured the site runs in local demo mode:
   same features, stored only in this browser.
   ============================================================ */

const SESSION_KEY = "efl:session:v2";
const LOCAL_STATE_KEY = "efl:local:v2";

const API_URL =
  import.meta.env.VITE_API_URL ||
  (typeof window !== "undefined" && window.location.hostname.endsWith(".vercel.app")
    ? "/api/league"
    : "");

/* ============================ drivers ============================ */

async function post(body) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed.");
  return data;
}

const remoteDriver = {
  demo: false,
  async load() {
    const res = await fetch(API_URL);
    const data = await res.json().catch(() => ({}));
    return data.state ? migrate(data.state) : null;
  },
  claim: (name, password, seed) => post({ action: "claim", name, password, seed }),
  login: (name, password) => post({ action: "login", name, password }),
  save: (auth, state) => post({ action: "save", ...auth, state }),
  bet: (auth, bet) => post({ action: "bet", ...auth, bet }),
  cancelBet: (auth, id) => post({ action: "cancelbet", ...auth, id }),
  adminAction: (auth, action, extra = {}) => post({ action, ...auth, ...extra }),
};

/* Local demo driver: same rules, this browser only. */

async function localHash(password, salt) {
  const text = `${salt}:${password}`;
  if (globalThis.crypto?.subtle) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return String(h);
}

function localRead() {
  try {
    const raw = localStorage.getItem(LOCAL_STATE_KEY);
    return raw ? migrate(JSON.parse(raw)) : null;
  } catch { return null; }
}
function localWrite(state) {
  localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(state));
  return state;
}
function localLog(state, who, text) {
  state.log = [
    { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, who, text, ts: Date.now() },
    ...(state.log || []),
  ].slice(0, 120);
}
async function localVerify(state, name, password) {
  const acc = state?.accounts?.[name];
  if (!acc || !password) return null;
  return (await localHash(password, acc.salt)) === acc.hash ? acc : null;
}

const localDriver = {
  demo: true,
  async load() {
    return localRead() || localWrite(defaultState());
  },
  async claim(name, password, seed) {
    const clean = String(name || "").trim();
    if (!/^[A-Za-z0-9 _-]{2,16}$/.test(clean)) throw new Error("Name must be 2–16 letters or numbers.");
    if (!password || password.length < 4) throw new Error("Password must be at least 4 characters.");
    const state = localRead() || migrate(seed) || defaultState();
    if (Object.keys(state.accounts).some((n) => n.toLowerCase() === clean.toLowerCase())) {
      throw new Error("That account is already claimed.");
    }
    const playerNames = state.players.map((p) => p.name);
    const isPlayer = playerNames.includes(clean);
    if (!isPlayer && playerNames.some((n) => n.toLowerCase() === clean.toLowerCase())) {
      throw new Error("That name belongs to a league player.");
    }
    const role = isPlayer ? (clean === "David" ? "admin" : "player") : "spectator";
    const salt = Math.random().toString(36).slice(2, 12);
    state.accounts[clean] = { salt, hash: await localHash(password, salt), role, createdTs: Date.now() };
    localLog(state, clean, `joined as ${role}`);
    return { ok: true, role, state: localWrite(state) };
  },
  async login(name, password) {
    const state = localRead();
    const acc = await localVerify(state, name, password);
    if (!acc) throw new Error("Wrong name or password.");
    return { ok: true, role: acc.role, state };
  },
  async save(auth, next) {
    const state = localRead();
    const acc = await localVerify(state, auth.name, auth.password);
    if (!acc) throw new Error("Please sign in again.");
    if (!["player", "admin"].includes(acc.role)) throw new Error("Spectators can watch and bet, not edit.");
    const merged = migrate(next);
    merged.accounts = state.accounts;
    merged.bets = state.bets;
    return { ok: true, state: localWrite(merged) };
  },
  async bet(auth, bet) {
    const state = localRead();
    const acc = await localVerify(state, auth.name, auth.password);
    if (!acc) throw new Error("Please sign in again.");
    const { matchId, pick, stake } = bet;
    const stakeInt = Math.round(Number(stake));
    if (!["home", "draw", "away"].includes(pick)) throw new Error("Pick home, draw, or away.");
    if (!Number.isFinite(stakeInt) || stakeInt < MIN_STAKE) throw new Error(`Minimum stake is ${MIN_STAKE} coins.`);
    if (state.results[matchId]) throw new Error("That match is already played.");
    if (fixtureParticipants(matchId).includes(auth.name)) throw new Error("You can't bet on your own match.");
    if (state.bets.some((b) => b.who === auth.name && b.matchId === matchId && !state.results[b.matchId])) {
      throw new Error("You already have a bet on this match. Cancel it first.");
    }
    const priced = priceFixture(state, matchId);
    if (!priced) throw new Error("Unknown fixture.");
    const balance = computeBalances(state.accounts, state.bets, state.results).get(auth.name)?.balance ?? 0;
    if (stakeInt > balance) throw new Error(`Not enough coins (you have ${balance}).`);
    const placed = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      who: auth.name, matchId, pick, stake: stakeInt, odds: priced.odds[pick], ts: Date.now(),
    };
    state.bets.push(placed);
    const label = pick === "draw" ? "a draw" : pick === "home" ? priced.fixture.home : priced.fixture.away;
    localLog(state, auth.name, `bet ${stakeInt} coins on ${label} at ${placed.odds.toFixed(2)} (${priced.fixture.home} v ${priced.fixture.away})`);
    return { ok: true, bet: placed, state: localWrite(state) };
  },
  async cancelBet(auth, id) {
    const state = localRead();
    const acc = await localVerify(state, auth.name, auth.password);
    if (!acc) throw new Error("Please sign in again.");
    const idx = state.bets.findIndex((b) => b.id === id);
    if (idx < 0) throw new Error("Bet not found.");
    if (state.bets[idx].who !== auth.name) throw new Error("Not your bet.");
    if (state.results[state.bets[idx].matchId]) throw new Error("That match already has a result.");
    const bet = state.bets.splice(idx, 1)[0];
    localLog(state, auth.name, `cancelled a ${bet.stake}-coin bet`);
    return { ok: true, state: localWrite(state) };
  },
  async adminAction(auth, action, extra = {}) {
    const state = localRead();
    const acc = await localVerify(state, auth.name, auth.password);
    if (!acc || acc.role !== "admin") throw new Error("Admin only.");
    if (action === "voidbet") {
      const idx = state.bets.findIndex((b) => b.id === extra.id);
      if (idx < 0) throw new Error("Bet not found.");
      const bet = state.bets.splice(idx, 1)[0];
      localLog(state, auth.name, `voided ${bet.who}'s ${bet.stake}-coin bet`);
    }
    if (action === "resetpw") {
      if (!state.accounts[extra.target]) throw new Error("No such account.");
      delete state.accounts[extra.target];
      localLog(state, auth.name, `reset ${extra.target}'s password — they can claim their account again`);
    }
    if (action === "removeaccount") {
      const target = state.accounts[extra.target];
      if (!target) throw new Error("No such account.");
      if (target.role === "admin") throw new Error("Can't remove an admin.");
      delete state.accounts[extra.target];
      state.bets = state.bets.filter((b) => b.who !== extra.target);
      localLog(state, auth.name, `removed ${extra.target}'s account`);
    }
    if (action === "newseason") {
      state.results = {}; state.friendlies = []; state.bets = []; state.log = [];
      localLog(state, auth.name, "started a new season — results, friendlies and bets cleared");
    }
    return { ok: true, state: localWrite(state) };
  },
};

const driver = API_URL ? remoteDriver : localDriver;

/* ============================ session ============================ */

function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function writeSession(session) {
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}

/* ============================ app ============================ */

const TABS = [
  ["league", "League"],
  ["friendly", "Friendly"],
  ["predict", "Predictions"],
  ["coins", "Coins"],
  ["players", "Players"],
  ["stats", "Stats"],
  ["log", "Activity"],
];

export default function App() {
  const [state, setState] = useState(defaultState());
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState("league");
  const [sync, setSync] = useState("loading");
  const [error, setError] = useState(null);
  const [authOpen, setAuthOpen] = useState(false);
  const editing = useRef(false);

  /* first load: fetch state, then quietly re-verify any stored session */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const remote = await driver.load();
        if (!alive) return;
        if (remote) setState(remote);
        setSync("ok");
      } catch {
        if (alive) setSync("error");
      }
      const saved = readSession();
      if (saved?.name && saved?.password) {
        try {
          const res = await driver.login(saved.name, saved.password);
          if (!alive) return;
          setSession({ name: saved.name, password: saved.password, role: res.role });
          if (res.state) setState(migrate(res.state));
        } catch {
          writeSession(null);
        }
      }
      if (alive) setReady(true);
    })();
    return () => { alive = false; };
  }, []);

  const pull = useCallback(async () => {
    if (editing.current) return;
    try {
      const remote = await driver.load();
      if (remote) {
        setState((prev) => (JSON.stringify(prev) === JSON.stringify(remote) ? prev : remote));
        setSync("ok");
      }
    } catch { /* keep showing last known state */ }
  }, []);

  useEffect(() => {
    if (!ready || driver.demo) return;
    const id = setInterval(pull, 20000);
    return () => clearInterval(id);
  }, [ready, pull]);

  const auth = session ? { name: session.name, password: session.password } : null;
  const isAdmin = session?.role === "admin";
  const canEditLeague = session && session.role !== "spectator";

  const run = useCallback(async (fn) => {
    setSync("saving");
    setError(null);
    try {
      const res = await fn();
      if (res?.state) setState(migrate(res.state));
      setSync("ok");
      return true;
    } catch (e) {
      setSync("error");
      setError(e.message || "That didn't save. Try again.");
      return false;
    }
  }, []);

  /* league-data writes: read latest, apply change, save with auth */
  const commit = useCallback(
    (mutator, entry) =>
      run(async () => {
        if (!auth) throw new Error("Sign in to edit.");
        const latest = (await driver.load()) || state;
        const next = migrate(JSON.parse(JSON.stringify(latest)));
        mutator(next);
        if (entry) {
          next.log = [
            { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, who: entry.who, text: entry.text, ts: Date.now() },
            ...(next.log || []),
          ].slice(0, 120);
        }
        return driver.save(auth, next);
      }),
    [run, auth, state]
  );

  const placeBet = useCallback((bet) => run(() => driver.bet(auth, bet)), [run, auth]);
  const cancelBet = useCallback((id) => run(() => driver.cancelBet(auth, id)), [run, auth]);
  const adminAction = useCallback(
    (action, extra) => run(() => driver.adminAction(auth, action, extra)),
    [run, auth]
  );

  const signIn = useCallback(async (mode, name, password) => {
    setError(null);
    try {
      const res =
        mode === "claim"
          ? await driver.claim(name, password, migrate(state))
          : await driver.login(name, password);
      const next = { name: String(name).trim(), password, role: res.role };
      setSession(next);
      writeSession(next);
      if (res.state) setState(migrate(res.state));
      setAuthOpen(false);
      return null;
    } catch (e) {
      return e.message || "Sign-in failed.";
    }
  }, [state]);

  const signOut = useCallback(() => {
    setSession(null);
    writeSession(null);
  }, []);

  /* derived league data */
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

  const playedCount = matches.filter((m) => m.played).length;
  const myBalance = session ? balances.get(session.name) : null;

  const canEditMatch = useCallback(
    (m) => Boolean(session) && (isAdmin || session.name === m.home || session.name === m.away),
    [session, isAdmin]
  );

  return (
    <div className="efl">
      <Styles />
      <div className="wrap">
        <Header
          state={state}
          session={session}
          balance={myBalance}
          sync={sync}
          played={playedCount}
          total={matches.length}
          onRefresh={pull}
          onSignIn={() => setAuthOpen(true)}
          onSignOut={signOut}
        />

        {driver.demo && (
          <p className="banner">
            Local demo mode — no API configured, so everything is stored only in this browser.
            Deploy with the API to share one league with everyone (see README).
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
            {tab === "league" && (
              <LeagueView
                state={state}
                table={table}
                matches={matches}
                predictor={predictor}
                session={session}
                isAdmin={isAdmin}
                canEditMatch={canEditMatch}
                commit={commit}
                editing={editing}
              />
            )}
            {tab === "friendly" && (
              <Friendly
                state={state}
                session={session}
                isAdmin={isAdmin}
                commit={commit}
                editing={editing}
              />
            )}
            {tab === "predict" && (
              <Predictions
                state={state}
                matches={matches}
                strengths={strengths}
                predictor={predictor}
                session={session}
                isAdmin={isAdmin}
                balances={balances}
                placeBet={placeBet}
                cancelBet={cancelBet}
                commit={commit}
                onSignIn={() => setAuthOpen(true)}
              />
            )}
            {tab === "coins" && (
              <Coins
                state={state}
                matches={matches}
                session={session}
                isAdmin={isAdmin}
                balances={balances}
                cancelBet={cancelBet}
                adminAction={adminAction}
                onSignIn={() => setAuthOpen(true)}
              />
            )}
            {tab === "players" && (
              <Players
                state={state}
                table={table}
                matches={matches}
                liveRatings={liveRatings}
                isAdmin={isAdmin}
                session={session}
                commit={commit}
              />
            )}
            {tab === "stats" && <Stats table={table} matches={matches} liveRatings={liveRatings} />}
            {tab === "log" && (
              <Activity
                state={state}
                session={session}
                isAdmin={isAdmin}
                adminAction={adminAction}
              />
            )}
          </>
        )}

        <footer className="foot">
          <p>
            Public to watch. Sign in to edit results or bet coins — every change is logged under
            your name. Coins are just for fun, never real money.
          </p>
        </footer>
      </div>
    </div>
  );
}

/* ---------------------------- header + auth ---------------------------- */

function Header({ state, session, balance, sync, played, total, onRefresh, onSignIn, onSignOut }) {
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
  const [name, setName] = useState("");
  const [spectatorName, setSpectatorName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const activeName = name || spectatorName.trim();
  const claimed = Boolean(accounts[activeName]);
  const mode = activeName ? (claimed ? "login" : "claim") : null;

  const submit = async () => {
    if (!activeName || !password || busy) return;
    if (mode === "claim" && password !== confirm) {
      setErr("Passwords don't match.");
      return;
    }
    setBusy(true);
    const failure = await onSubmit(mode, activeName, password);
    setBusy(false);
    if (failure) setErr(failure);
  };

  return (
    <section className="card ident">
      <div className="card-head bar">
        <div>
          <h2 className="h2">Sign in</h2>
          <p className="muted sm">
            First time? Pick your name and set a password to claim your account — no passwords are
            stored in the code, and admins can reset yours if you forget it.
          </p>
        </div>
        <button className="ghost" onClick={onClose}>Close</button>
      </div>

      <p className="lbl">League players</p>
      <div className="chips">
        {playerNames.map((p) => (
          <button
            key={p}
            className={`chip${name === p ? " sel" : ""}`}
            onClick={() => { setName(name === p ? "" : p); setSpectatorName(""); setErr(null); }}
          >
            {p}
            <span className={`chipstate ${accounts[p] ? "c" : "u"}`}>
              {accounts[p] ? "claimed" : "unclaimed"}
            </span>
          </button>
        ))}
      </div>

      <label className="field" style={{ marginTop: 12 }}>
        <span className="lbl">Or watch as a spectator — pick any name</span>
        <input
          className="input"
          value={spectatorName}
          placeholder="e.g. Maya"
          maxLength={16}
          onChange={(e) => { setSpectatorName(e.target.value); setName(""); setErr(null); }}
        />
      </label>

      {activeName && (
        <div className="authform">
          <p className="sm muted">
            {mode === "login"
              ? <>Welcome back, <b>{activeName}</b>. Enter your password.</>
              : <>Claiming <b>{activeName}</b> — choose a password (4+ characters).</>}
          </p>
          <div className="authrow">
            <input
              className="input"
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setErr(null); }}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            {mode === "claim" && (
              <input
                className="input"
                type="password"
                placeholder="Repeat password"
                value={confirm}
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
        Spectators can watch everything and bet coins, but can't edit results. Players can edit
        the matches they play in. Admins can edit anything.
      </p>
    </section>
  );
}

/* ---------------------------- league (table + fixtures) ---------------------------- */

function LeagueView(props) {
  const [sub, setSub] = useState("table");
  return (
    <section>
      <div className="seg" style={{ marginBottom: 14, display: "inline-flex" }}>
        {[["table", "Table"], ["fixtures", "Fixtures"]].map(([k, l]) => (
          <button key={k} className={`segb${sub === k ? " on" : ""}`} onClick={() => setSub(k)}>{l}</button>
        ))}
      </div>
      {sub === "table" ? <TableView table={props.table} total={props.matches.length} /> : <Fixtures {...props} />}
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
          League matches only — friendlies never touch this table. Points, then goal difference,
          then goals for, then head-to-head.
        </p>
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

function Fixtures({ state, matches, predictor, session, isAdmin, canEditMatch, commit, editing }) {
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
            Double round-robin. You can edit the matches you play in{isAdmin ? "; as admin you can edit any" : ""}.
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
              type="date"
              className="input"
              value={state.startDate}
              onChange={(e) => {
                const v = e.target.value;
                if (v) commit((s) => { s.startDate = v; }, { who: session.name, text: `Moved the season opener to ${fmtDate(v)}` });
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
                  canEdit={canEditMatch(m)}
                  signedIn={Boolean(session)}
                  me={session?.name}
                  commit={commit}
                  editing={editing}
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

function MatchRow({ m, pred, open, onToggle, canEdit, signedIn, me, commit, editing }) {
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
      {open && (
        <MatchEditor m={m} pred={pred} canEdit={canEdit} signedIn={signedIn} me={me} commit={commit} editing={editing} />
      )}
    </li>
  );
}

function MatchEditor({ m, pred, canEdit, signedIn, me, commit, editing }) {
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
        <p className="muted sm">
          {signedIn
            ? "Only the two players in this match (or an admin) can enter its result."
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
          onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
          aria-label={`Goals for ${label}`}
        />
        <button className="step" onClick={() => onChange(String(Math.min(30, n + 1)))} aria-label={`One more goal for ${label}`}>+</button>
      </div>
    </div>
  );
}

/* ---------------------------- friendly ---------------------------- */

function Friendly({ state, session, isAdmin, commit, editing }) {
  const playerNames = useMemo(() => state.players.map((p) => p.name), [state.players]);
  const friendlies = useMemo(
    () => [...(state.friendlies || [])].sort((a, b) => (b.ts || 0) - (a.ts || 0)),
    [state.friendlies]
  );

  const me = session?.name;
  const canTouch = (f) => Boolean(session) && (isAdmin || f.home === me || f.away === me);
  const canAdd = Boolean(session) && session.role !== "spectator";

  const [editingId, setEditingId] = useState(null);
  const [home, setHome] = useState(playerNames[0] || "");
  const [away, setAway] = useState(playerNames[1] || "");
  const [date, setDate] = useState(todayISO());
  const [hg, setHg] = useState("");
  const [ag, setAg] = useState("");

  useEffect(() => {
    editing.current = editingId !== null || hg !== "" || ag !== "";
    return () => { editing.current = false; };
  }, [editing, editingId, hg, ag]);

  const selected = friendlies.find((m) => m.id === editingId) || null;
  useEffect(() => {
    if (!selected) {
      setHome(me && playerNames.includes(me) ? me : playerNames[0] || "");
      setAway(playerNames.find((n) => n !== me) || playerNames[1] || "");
      setDate(todayISO());
      setHg(""); setAg("");
      return;
    }
    setHome(selected.home);
    setAway(selected.away);
    setDate(selected.date || todayISO());
    setHg(selected.played ? String(selected.hg) : "");
    setAg(selected.played ? String(selected.ag) : "");
  }, [editingId, selected, playerNames, me]);

  const involvesMe = isAdmin || home === me || away === me;
  const canSave =
    canAdd && involvesMe && home && away && home !== away && date &&
    ((hg === "" && ag === "") || (hg !== "" && ag !== "" && Number(hg) >= 0 && Number(ag) >= 0));

  const save = () => {
    if (!canSave) return;
    const hasScore = hg !== "" && ag !== "";
    const h = hasScore ? clamp(Math.round(Number(hg)), 0, 30) : null;
    const a = hasScore ? clamp(Math.round(Number(ag)), 0, 30) : null;
    const now = Date.now();
    const id = editingId || `f-${now}-${Math.random().toString(36).slice(2, 6)}`;

    commit(
      (s) => {
        if (!Array.isArray(s.friendlies)) s.friendlies = [];
        const idx = s.friendlies.findIndex((m) => m.id === id);
        const match = { id, home, away, date, played: hasScore, ts: now };
        if (hasScore) { match.hg = h; match.ag = a; }
        if (idx >= 0) s.friendlies[idx] = match;
        else s.friendlies.unshift(match);
      },
      {
        who: me,
        text: hasScore
          ? `Friendly: ${home} ${h}–${a} ${away}`
          : `Friendly scheduled: ${home} vs ${away} on ${fmtDate(date)}`,
      }
    );
    setEditingId(null);
  };

  const remove = (match) => {
    commit(
      (s) => {
        if (!Array.isArray(s.friendlies)) return;
        const idx = s.friendlies.findIndex((m) => m.id === match.id);
        if (idx >= 0) s.friendlies.splice(idx, 1);
      },
      { who: me, text: `Removed friendly ${match.home} vs ${match.away}` }
    );
    if (editingId === match.id) setEditingId(null);
  };

  return (
    <section>
      <div className="card-head bar">
        <div>
          <h2 className="h2">Friendly matches</h2>
          <p className="muted sm">
            Extra games outside the league. They never touch the table or points — but a played
            friendly moves both players' live ratings at {Math.round(FRIENDLY_WEIGHT * 100)}% of a
            league match, so the prediction engine still learns from it.
          </p>
        </div>
      </div>

      {canAdd ? (
        <div className="card friendly-card">
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
              <p className="muted sm">You can only add friendlies you play in{isAdmin ? "" : " — pick yourself as one side"}.</p>
            )}
            <div className="btns">
              <button className="primary" onClick={save} disabled={!canSave}>
                {editingId ? "Update friendly" : hg !== "" || ag !== "" ? "Save friendly" : "Schedule friendly"}
              </button>
              {editingId && (
                <button className="ghost" onClick={() => setEditingId(null)}>Cancel edit</button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="card sub">
          <p className="muted sm">
            {session ? "Spectators can't add friendlies." : "Sign in to add a friendly."}
          </p>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3 className="h3">All friendlies</h3>
        </div>
        {!friendlies.length ? (
          <p className="empty">No friendlies yet.</p>
        ) : (
          <ul className="matches">
            {friendlies.map((m) => (
              <li key={m.id} className="match">
                <div className="match-btn asrow">
                  <span className="side home">{m.home}</span>
                  <span className="score">
                    {m.played
                      ? <span className="mono ft">{m.hg}<i>–</i>{m.ag}</span>
                      : <span className="mono vs">vs</span>}
                  </span>
                  <span className="side away">{m.away}</span>
                  <span className="match-meta friendlymeta">
                    <span className="mono sm muted">{fmtDate(m.date)}</span>
                    {!m.played && <span className="pill todo">Scheduled</span>}
                    {canTouch(m) && (
                      <>
                        <button className="ghost small" onClick={() => setEditingId(m.id)}>Edit</button>
                        <button className="ghost small danger" onClick={() => remove(m)}>Remove</button>
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

function Predictions({ state, matches, strengths, predictor, session, isAdmin, balances, placeBet, cancelBet, commit, onSignIn }) {
  const upcoming = matches.filter((m) => !m.played);
  const nextRound = upcoming.length ? Math.min(...upcoming.map((m) => m.round)) : 1;
  const [round, setRound] = useState(nextRound);
  const rounds = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b);
  const slate = matches.filter((m) => m.round === round);

  const odds = useMemo(
    () => simulateSeason(state.players, matches, strengths, state.homeAdvantage),
    [state.players, matches, strengths, state.homeAdvantage]
  );

  const myBalance = session ? balances.get(session.name)?.balance ?? 0 : 0;
  const myOpenBets = (state.bets || []).filter(
    (b) => session && b.who === session.name && !(state.results || {})[b.matchId]
  );

  return (
    <section>
      <div className="card-head bar">
        <div>
          <h2 className="h2">Prediction centre</h2>
          <p className="muted sm">
            Odds come from each player's live rating and recent form. Pick the favourite for a
            small safe win, or the underdog for a big payout.
          </p>
        </div>
        {isAdmin && (
          <label className="toggle">
            <input
              type="checkbox"
              checked={Boolean(state.homeAdvantage)}
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
          <p className="muted sm">Sign in to bet coins on these matches — everyone starts with {START_COINS}.</p>
          <button className="ghost" onClick={onSignIn}>Sign in</button>
        </div>
      )}

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
          {slate.map((m) => (
            <PredictionCard
              key={m.id}
              m={m}
              pred={predictor(m.home, m.away)}
              session={session}
              myBalance={myBalance}
              myBet={myOpenBets.find((b) => b.matchId === m.id)}
              placeBet={placeBet}
              cancelBet={cancelBet}
            />
          ))}
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

function PredictionCard({ m, pred, session, myBalance, myBet, placeBet, cancelBet }) {
  const [pick, setPick] = useState(null);
  const [stake, setStake] = useState("");
  const [busy, setBusy] = useState(false);
  const odds = oddsForMatch(pred);
  const isMine = session && (m.home === session.name || m.away === session.name);
  const canBet = session && !m.played && !isMine && !myBet;

  const stakeInt = Math.round(Number(stake));
  const stakeOk = Number.isFinite(stakeInt) && stakeInt >= MIN_STAKE && stakeInt <= myBalance;
  const payout = pick && stakeOk ? Math.round(stakeInt * odds[pick]) : null;

  const submit = async () => {
    if (!pick || !stakeOk || busy) return;
    setBusy(true);
    const ok = await placeBet({ matchId: m.id, pick, stake: stakeInt });
    setBusy(false);
    if (ok) { setPick(null); setStake(""); }
  };

  const pickLabel = (p) => (p === "home" ? m.home : p === "away" ? m.away : "Draw");

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
                Your bet: <b>{myBet.stake}c</b> on <b>{pickLabel(myBet.pick)}</b>
                <span className="mono"> @ {myBet.odds.toFixed(2)}</span>
                <span className="muted"> → {Math.round(myBet.stake * myBet.odds)}c if it lands</span>
              </span>
              <button className="ghost small danger" onClick={() => cancelBet(myBet.id)}>Cancel</button>
            </div>
          ) : isMine ? (
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
                    <span className="obl">{pickLabel(p)}</span>
                    <span className="mono obv">{odds[p].toFixed(2)}×</span>
                  </button>
                ))}
              </div>
              {pick && (
                <div className="stakerow">
                  <input
                    className="input mono"
                    inputMode="numeric"
                    placeholder={`Stake (min ${MIN_STAKE})`}
                    value={stake}
                    onChange={(e) => setStake(e.target.value.replace(/[^0-9]/g, "").slice(0, 5))}
                  />
                  <button className="primary" onClick={submit} disabled={!stakeOk || busy || !canBet}>
                    {busy ? "…" : payout ? `Win ${payout}c` : "Place bet"}
                  </button>
                </div>
              )}
              {pick && !stakeOk && stake !== "" && (
                <p className="muted sm">
                  {stakeInt < MIN_STAKE ? `Minimum stake is ${MIN_STAKE} coins.` : `You only have ${myBalance} coins.`}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </article>
  );
}

/* ---------------------------- coins ---------------------------- */

function Coins({ state, matches, session, isAdmin, balances, cancelBet, adminAction, onSignIn }) {
  const accounts = state.accounts || {};
  const bets = state.bets || [];
  const results = state.results || {};
  const matchById = useMemo(() => new Map(matches.map((m) => [m.id, m])), [matches]);

  const board = Object.keys(accounts)
    .map((name) => ({ name, role: accounts[name].role, ...(balances.get(name) || {}) }))
    .sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0));

  const mine = session ? bets.filter((b) => b.who === session.name).sort((a, b) => b.ts - a.ts) : [];
  const openBets = bets.filter((b) => !results[b.matchId]).sort((a, b) => b.ts - a.ts);

  const betLine = (b) => {
    const m = matchById.get(b.matchId);
    const label = !m ? b.matchId : b.pick === "draw" ? `${m.home} v ${m.away} draw` : b.pick === "home" ? m.home : m.away;
    const r = results[b.matchId];
    const status = !r
      ? { text: "open", cls: "todo" }
      : (r.hg > r.ag ? "home" : r.hg < r.ag ? "away" : "draw") === b.pick
        ? { text: `won +${Math.round(b.stake * (b.odds - 1))}c`, cls: "wonpill" }
        : { text: `lost −${b.stake}c`, cls: "lostpill" };
    return { label, status, m };
  };

  return (
    <section>
      <div className="card-head">
        <h2 className="h2">Coins</h2>
        <p className="muted sm">
          Everyone starts with {START_COINS} coins. Bet them on match predictions — favourites pay
          little, underdogs pay big. Just for fun, never real money, and they don't touch the
          league table or ratings.
        </p>
      </div>

      {session ? (
        <div className="card coincard">
          <div className="coinbig">
            <span className="mono coinnum">{balances.get(session.name)?.balance ?? START_COINS}</span>
            <span className="rating-lbl">your coins</span>
          </div>
          <dl className="stats-row coinstats">
            <Stat k="In play" v={balances.get(session.name)?.held ?? 0} />
            <Stat k="Open" v={balances.get(session.name)?.open ?? 0} />
            <Stat k="Won" v={balances.get(session.name)?.won ?? 0} tone="win" />
            <Stat k="Lost" v={balances.get(session.name)?.lost ?? 0} tone="loss" />
          </dl>
        </div>
      ) : (
        <div className="card sub bar">
          <p className="muted sm">Sign in (players and spectators both) to get your {START_COINS} coins.</p>
          <button className="ghost" onClick={onSignIn}>Sign in</button>
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
                  <span className="name">
                    {r.name} <span className="rolechip">{r.role}</span>
                  </span>
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
                  const { label, status } = betLine(b);
                  return (
                    <li key={b.id}>
                      <span className="betwhat">
                        <b>{b.stake}c</b> on {label} <span className="mono muted">@ {b.odds.toFixed(2)}</span>
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
              {openBets.slice(0, 12).map((b) => {
                const { label } = betLine(b);
                return (
                  <li key={b.id}>
                    <span className="betwhat">
                      <b>{b.who}</b>: {b.stake}c on {label} <span className="mono muted">@ {b.odds.toFixed(2)}</span>
                    </span>
                    {isAdmin && (
                      <button className="ghost small danger" onClick={() => adminAction("voidbet", { id: b.id })}>Void</button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {session && isAdmin && openBets.some((b) => b.who !== session.name) && (
            <div className="reset">
              <p className="lbl">Admin — all open bets</p>
              <ul className="betlist">
                {openBets.filter((b) => b.who !== session.name).map((b) => {
                  const { label } = betLine(b);
                  return (
                    <li key={b.id}>
                      <span className="betwhat">
                        <b>{b.who}</b>: {b.stake}c on {label}
                      </span>
                      <button className="ghost small danger" onClick={() => adminAction("voidbet", { id: b.id })}>Void</button>
                    </li>
                  );
                })}
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
  const [setup, setSetup] = useState(false);
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
            Live rating moves with every result — league games at full weight, friendlies at
            {" "}{Math.round(FRIENDLY_WEIGHT * 100)}%. The seed is only the season's starting point.
          </p>
        </div>
        {isAdmin && (
          <button className="ghost" onClick={() => setSetup(!setup)}>{setup ? "Done" : "Edit seed ratings"}</button>
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
                          { who: session.name, text: `Set ${p.name}'s seed rating to ${v}` }
                        );
                      }}
                      aria-label={`Seed rating for ${p.name}`}
                    />
                  ) : (
                    <span className="mono rating-num">{Math.round(lr.live)}</span>
                  )}
                  <span className="rating-lbl">live rating</span>
                  {!setup && Math.abs(lr.delta) >= 0.5 && (
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

/* ---------------------------- stats ---------------------------- */

function Stats({ table, matches, liveRatings }) {
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
  const riser = [...liveRatings.entries()]
    .map(([name, v]) => ({ name, delta: v.delta, seed: v.seed, live: v.live }))
    .sort((a, b) => b.delta - a.delta)[0];
  const biggest = [...played].sort((a, b) => b.hg + b.ag - (a.hg + a.ag))[0];
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
          title="Biggest improvement"
          name={riser && riser.delta >= 0.5 ? riser.name : "Nobody yet"}
          value={
            riser && riser.delta >= 0.5
              ? `Rating up ${riser.delta.toFixed(1)} (${riser.seed} → ${Math.round(riser.live)})`
              : "No one has outgrown their seed rating yet"
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
          <p className="muted sm">Every change to a score, date, rating, friendly or bet — newest first.</p>
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
              Reset a password if someone forgets theirs (they claim the account again), remove
              spectator accounts, or wipe the season.
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
                  Clears every result, friendly, bet and the log. Accounts stay; coins reset to {START_COINS}.
                </span>
                <button
                  className="primary danger"
                  onClick={() => { adminAction("newseason"); setConfirming(false); }}
                >
                  Clear the season
                </button>
                <button className="ghost" onClick={() => setConfirming(false)}>Keep the season</button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/* ---------------------------- shared helpers ---------------------------- */

function fmtDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
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
.efl button:focus-visible, .efl input:focus-visible, .efl select:focus-visible {
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
  padding: 10px 14px; font-size: 13px; margin: 10px 0 14px;
}
.efl .banner {
  border-left: 3px solid var(--away); background: rgba(86,200,232,0.08);
  padding: 10px 14px; font-size: 12px; color: var(--muted); margin-bottom: 14px;
}

/* header */
.efl .head { display: flex; align-items: flex-start; gap: 14px; flex-wrap: wrap; margin-bottom: 16px; }
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
.efl .sync-loading { color: var(--muted); }
.efl .pill.done { color: var(--win); border-color: rgba(78,216,168,0.35); }
.efl .pill.todo { color: var(--muted); }
.efl .pill.wonpill { color: var(--win); border-color: rgba(78,216,168,0.4); }
.efl .pill.lostpill { color: var(--loss); border-color: rgba(224,96,126,0.4); }

.efl .userchip {
  display: inline-flex; align-items: center; gap: 7px;
  border: 1px solid var(--line); padding: 5px 10px; font-size: 12px;
}
.efl .userchip b { letter-spacing: -0.01em; }
.efl .rolechip {
  font-family: var(--mono); font-size: 9px; letter-spacing: 0.1em;
  text-transform: uppercase; color: var(--muted);
  border: 1px solid var(--line); padding: 1px 5px;
}
.efl .coinchip { color: var(--home); font-size: 12px; }

.efl .ghost {
  background: none; border: 1px solid var(--line); color: var(--paper);
  padding: 5px 11px; font-size: 12px; transition: border-color .15s, color .15s;
}
.efl .ghost:hover { border-color: var(--home); color: var(--home); }
.efl .ghost.small { padding: 3px 9px; font-size: 11px; }
.efl .ghost.danger:hover { border-color: var(--loss); color: var(--loss); }
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
.efl .card-head.bar, .efl .card.sub.bar {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; flex-wrap: wrap;
}
.efl .card-head.bar { align-items: flex-start; }
.efl .h2 { font-size: 17px; font-weight: 750; letter-spacing: -0.02em; }
.efl .h3 { font-size: 14px; font-weight: 750; letter-spacing: -0.01em; }

/* auth */
.efl .ident .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.efl .chip {
  background: var(--panel2); border: 1px solid var(--line); color: var(--paper);
  padding: 7px 12px; font-weight: 650; letter-spacing: -0.01em; font-size: 13px;
  display: inline-flex; align-items: center; gap: 8px;
}
.efl .chip:hover { border-color: var(--home); color: var(--home); }
.efl .chip.sel { border-color: var(--home); color: var(--home); }
.efl .chipstate { font-family: var(--mono); font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; }
.efl .chipstate.c { color: var(--win); }
.efl .chipstate.u { color: var(--muted); }
.efl .authform { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 12px; }
.efl .authrow { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.efl .authrow .input { flex: 1 1 160px; }

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
  display: grid; grid-template-columns: 1fr 74px 1fr 150px; align-items: center;
  gap: 10px; padding: 11px 4px;
}
.efl .match-btn.asrow { cursor: default; }
button.efl-none { cursor: default; }
.efl .match-btn:not(.asrow):hover { background: rgba(35,31,51,0.5); }
.efl .side { font-weight: 700; letter-spacing: -0.015em; font-size: 14px; }
.efl .side.home { color: var(--home); }
.efl .side.away { color: var(--away); text-align: right; }
.efl .pcard-head .side.away, .efl .recent .side.away { text-align: right; }
.efl .score { text-align: center; }
.efl .ft { font-size: 17px; font-weight: 700; letter-spacing: -0.02em; }
.efl .ft i { color: var(--muted); font-style: normal; padding: 0 3px; }
.efl .ft.small { font-size: 14px; }
.efl .vs { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
.efl .match-meta { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
.efl .friendlymeta { flex-wrap: wrap; }

/* prediction bar */
.efl .bar { display: block; width: 100%; }
.efl .track {
  display: flex; height: 8px; overflow: hidden; background: var(--panel2);
  border: 1px solid var(--line);
}
.efl .bar.compact .track { height: 6px; }
.efl .pseg { display: block; transition: width .5s cubic-bezier(.22,.7,.25,1); }
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
.efl select.input { appearance: none; }
.efl .btns { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

/* friendly */
.efl .friendly-grid { display: grid; gap: 14px; }
.efl .friendly-pair { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
.efl .pairvs { padding-bottom: 10px; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; }

/* predictions */
.efl .pcards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin-top: 12px; }
.efl .pcard { background: var(--panel2); border-left: 2px solid var(--home); padding: 12px 14px; display: grid; gap: 8px; align-content: start; }
.efl .pcard-head { display: grid; grid-template-columns: 1fr auto 1fr; gap: 8px; align-items: center; }
.efl .odds { list-style: none; margin: 0; padding: 0; display: grid; gap: 7px; }
.efl .odds li { display: grid; grid-template-columns: 84px 1fr 56px 92px; align-items: center; gap: 10px; }
.efl .odds-name { font-weight: 700; font-size: 13px; letter-spacing: -0.015em; white-space: nowrap; }
.efl .odds-track { height: 10px; background: var(--panel2); border: 1px solid var(--line); }
.efl .odds-fill { display: block; height: 100%; background: var(--home); transition: width .5s cubic-bezier(.22,.7,.25,1); }
.efl .odds-val { font-size: 12px; text-align: right; }
.efl .odds-top { text-align: right; }

/* betting */
.efl .betbox { border-top: 1px solid var(--line); padding-top: 10px; display: grid; gap: 8px; }
.efl .oddsrow { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.efl .oddsbtn {
  background: var(--ink); border: 1px solid var(--line); color: var(--paper);
  display: grid; gap: 2px; padding: 7px 6px; justify-items: center;
}
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

/* coins */
.efl .coincard { display: flex; align-items: center; gap: 22px; flex-wrap: wrap; }
.efl .coinbig { display: grid; justify-items: center; border: 1px solid rgba(242,166,59,0.35); background: rgba(242,166,59,0.07); padding: 10px 18px; }
.efl .coinnum { font-size: 32px; font-weight: 800; letter-spacing: -0.04em; color: var(--home); line-height: 1; }
.efl .coinstats { flex: 1; min-width: 240px; margin: 0; }
.efl .betlist { list-style: none; margin: 10px 0 0; padding: 0; }
.efl .betlist li {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 8px 0; border-bottom: 1px solid rgba(49,43,69,0.5); font-size: 13px;
}
.efl .betwhat { flex: 1; min-width: 180px; }

/* players */
.efl .pgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
.efl .player { margin-bottom: 0; }
.efl .player.open { grid-column: 1 / -1; }
.efl .player-head { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
.efl .rating {
  display: grid; justify-items: center; padding: 6px 10px; position: relative;
  border: 1px solid rgba(242,166,59,0.35); background: rgba(242,166,59,0.07); min-width: 74px;
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
.efl .deltachip {
  position: absolute; top: -8px; right: -8px; font-size: 9px; padding: 2px 5px;
  border: 1px solid var(--line); background: var(--ink);
}
.efl .deltachip.up { color: var(--win); border-color: rgba(78,216,168,0.5); }
.efl .deltachip.down { color: var(--loss); border-color: rgba(224,96,126,0.5); }
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
.efl .formlist, .efl .recent, .efl .logl, .efl .acctlist { list-style: none; margin: 12px 0 0; padding: 0; }
.efl .formlist li { display: grid; grid-template-columns: 22px 1fr auto auto; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid rgba(49,43,69,0.5); }
.efl .formlist .pos { color: var(--muted); font-size: 12px; }
.efl .formlist .pts { text-align: right; font-weight: 700; }
.efl .formlist .name, .efl .recent .name, .efl .acctlist .name { font-weight: 700; letter-spacing: -0.015em; }
.efl .recent li { display: grid; grid-template-columns: 1fr auto 1fr 44px; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid rgba(49,43,69,0.5); }
.efl .recent li .sm { text-align: right; }

/* activity + admin */
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
