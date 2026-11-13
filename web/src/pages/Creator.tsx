import { useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { v2, type ConfigV2, type ProgrammeV2 } from "../lib/v2";
import { near, toYocto } from "../lib/format";
import { useTx } from "../lib/useTx";
import { useSession } from "../lib/session";
import { errorText } from "../lib/wallet";

type Dash = Awaited<ReturnType<typeof v2.creator>>;
const STORAGE = "100000000000000000000000"; // 0.1 NEAR attached for storage; the contract refunds the unused part
const SMALL_STORAGE = "10000000000000000000000"; // 0.01 NEAR for check-ins and achievements, unused part refunded

function bps(percent: string): number {
  const n = Number(percent);
  if (!Number.isFinite(n) || n < 0) throw new Error("Enter a percentage like 10");
  return Math.round(n * 100);
}

function NewProgramme({ contract, onDone }: { contract?: string; onDone: () => void }) {
  const tx = useTx(contract, onDone);
  const [f, setF] = useState({ name: "", description: "", price: "0.1", referral: "10", member: "50", supply: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  function submit() {
    try {
      const args = {
        name: f.name.trim(),
        description: f.description.trim(),
        mint_price: toYocto(f.price),
        referral_bps: bps(f.referral),
        member_share_bps: bps(f.member),
        max_supply: f.supply ? Number(f.supply) : null,
      };
      if (!args.name) throw new Error("Give the programme a name.");
      tx.run("create", "create_programme", args, STORAGE, "Programme created. It now appears on Discover.");
    } catch (e) {
      tx.setMsg({ kind: "bad", text: errorText(e) });
    }
  }
  return (
    <form className="panel" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <h2>Launch a programme</h2>
      <p className="muted">One transaction from your wallet. You become its creator; the rules below are fixed in the contract once created.</p>
      <div className="field"><label className="label" htmlFor="p-name">Name</label><input id="p-name" maxLength={64} value={f.name} onChange={set("name")} placeholder="e.g. Rust Night School" /></div>
      <div className="field"><label className="label" htmlFor="p-desc">Description</label><textarea id="p-desc" maxLength={280} rows={3} value={f.description} onChange={set("description")} /></div>
      <div className="row">
        <div className="field"><label className="label" htmlFor="p-price">Mint price (NEAR, min 0.05)</label><input id="p-price" value={f.price} onChange={set("price")} inputMode="decimal" /></div>
        <div className="field"><label className="label" htmlFor="p-ref">Referral % (max 20)</label><input id="p-ref" value={f.referral} onChange={set("referral")} inputMode="decimal" /></div>
        <div className="field"><label className="label" htmlFor="p-mem">Ticket share to members % (max 80)</label><input id="p-mem" value={f.member} onChange={set("member")} inputMode="decimal" /></div>
        <div className="field"><label className="label" htmlFor="p-sup">Max supply (blank = none)</label><input id="p-sup" value={f.supply} onChange={(e) => setF((x) => ({ ...x, supply: e.target.value.replace(/\D/g, "") }))} inputMode="numeric" /></div>
      </div>
      <button type="submit" disabled={!!tx.busy}>{tx.busy ? "Waiting for your wallet…" : "Create programme"}</button>
      {tx.msg && <div className={`note ${tx.msg.kind}`}>{tx.msg.text}</div>}
    </form>
  );
}

function Dashboard({ programme, token, contract }: { programme: ProgrammeV2; token: string; contract?: string }) {
  const [d, setD] = useState<Dash | null>(null);
  const [err, setErr] = useState("");
  const load = () => v2.creator(token, programme.id).then(setD).catch((e) => setErr(e instanceof ApiError ? e.message : errorText(e)));
  const tx = useTx(contract, load);
  const [ev, setEv] = useState({ title: "", price: "0.05", capacity: "50", points: "20", starts: "" });
  const [award, setAward] = useState({ token: "", code: "", points: "10" });
  const [fund, setFund] = useState("0.1");
  useEffect(() => {
    load();
  }, [programme.id, token]);

  if (err) return <div className="note bad">{err}</div>;
  if (!d) return <p className="muted">Opening the dashboard (checked against the chain)…</p>;
  const p = d.programme;
  const pending = d.passTickets.filter((t) => !t.checked_in);
  const guard = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      tx.setMsg({ kind: "bad", text: errorText(e) });
    }
  };

  return (
    <section className="panel" style={{ gap: 20 }}>
      <div className="actions" style={{ justifyContent: "space-between" }}>
        <h2>{p.name} · programme {p.id}</h2>
        <a href={`#/programme/${p.id}`}>Public page →</a>
      </div>
      <section className="stats">
        <div className="hue-sun"><span className="label">Treasury</span><strong className="num">Ⓝ {near(p.treasury)}</strong></div>
        <div className="hue-teal"><span className="label">Passes</span><strong className="num">{p.active_passes}</strong></div>
        <div className="hue-violet"><span className="label">Ticket revenue</span><strong className="num">Ⓝ {near(p.ticket_revenue_total)}</strong></div>
        <div className="hue-green"><span className="label">Reserved for passes</span><strong className="num">Ⓝ {near(p.reserved)}</strong></div>
      </section>
      {tx.msg && <div className={`note ${tx.msg.kind}`}>{tx.msg.text}</div>}

      <div className="grid-cards">
        <div className="panel">
          <h3>Treasury</h3>
          <p className="muted">Your share of mints and tickets. Only you can withdraw it, never more than it holds.</p>
          <button disabled={BigInt(p.treasury) === 0n || !!tx.busy} onClick={() => tx.run("wd", "withdraw_treasury", { programme_id: p.id }, "0", `Withdrew Ⓝ ${near(p.treasury)}.`)}>
            Withdraw Ⓝ {near(p.treasury)}
          </button>
        </div>
        <div className="panel">
          <h3>Fund rewards</h3>
          <p className="muted">Split equally between the {p.active_passes} passes now; each holder claims into the pass account.</p>
          <div className="row">
            <div className="field"><label className="label" htmlFor="fund">Amount (NEAR)</label><input id="fund" value={fund} onChange={(e) => setFund(e.target.value)} inputMode="decimal" /></div>
            <button disabled={p.active_passes === 0 || !!tx.busy} onClick={() => guard(() => tx.run("fund", "fund_rewards", { programme_id: p.id }, toYocto(fund), "Rewards distributed to every pass."))}>Fund</button>
          </div>
        </div>
      </div>

      <form className="panel" onSubmit={(e) => {
        e.preventDefault();
        guard(() => tx.run("ev", "create_event", {
          programme_id: p.id, title: ev.title.trim(), price: toYocto(ev.price), capacity: Number(ev.capacity), points: Number(ev.points),
          starts_at_ms: ev.starts ? String(new Date(ev.starts).getTime()) : "0",
        }, STORAGE, "Event created."));
      }}>
        <h3>Create an event</h3>
        <div className="row">
          <div className="field" style={{ flex: "2 1 220px" }}><label className="label" htmlFor="e-title">Title</label><input id="e-title" maxLength={80} value={ev.title} onChange={(e) => setEv({ ...ev, title: e.target.value })} /></div>
          <div className="field"><label className="label" htmlFor="e-price">Ticket (NEAR, min 0.02)</label><input id="e-price" value={ev.price} onChange={(e) => setEv({ ...ev, price: e.target.value })} /></div>
          <div className="field"><label className="label" htmlFor="e-cap">Seats</label><input id="e-cap" value={ev.capacity} onChange={(e) => setEv({ ...ev, capacity: e.target.value.replace(/\D/g, "") })} /></div>
          <div className="field"><label className="label" htmlFor="e-pts">Points (max 50)</label><input id="e-pts" value={ev.points} onChange={(e) => setEv({ ...ev, points: e.target.value.replace(/\D/g, "") })} /></div>
          <div className="field"><label className="label" htmlFor="e-start">Starts</label><input id="e-start" type="datetime-local" value={ev.starts} onChange={(e) => setEv({ ...ev, starts: e.target.value })} /></div>
        </div>
        <button type="submit" disabled={!ev.title.trim() || !!tx.busy}>Create event</button>
      </form>

      <div className="panel">
        <h3>Check-ins waiting ({pending.length})</h3>
        <p className="muted">Passes whose holders bought a ticket with the pass attached. Checking in adds the event's points on chain.</p>
        {pending.length === 0 && <p className="muted">Nobody to check in.</p>}
        {pending.map((t) => {
          const e = d.events.find((x) => x.id === t.event_id);
          return (
            <div key={`${t.event_id}-${t.token_id}`} className="actions">
              <span>Pass #{t.token_id} · {e?.title ?? `event ${t.event_id}`} (+{e?.points ?? 0})</span>
              <button className="quiet" style={{ padding: "6px 10px" }} disabled={!!tx.busy}
                onClick={() => tx.run(`ci${t.event_id}-${t.token_id}`, "check_in", { event_id: t.event_id, token_id: t.token_id }, SMALL_STORAGE, `Pass #${t.token_id} checked in.`)}>
                Check in
              </button>
            </div>
          );
        })}
      </div>

      <form className="panel" onSubmit={(e) => {
        e.preventDefault();
        tx.run("aw", "award_achievement", { token_id: award.token, code: award.code.trim(), points: Number(award.points) }, SMALL_STORAGE, `Achievement awarded to pass #${award.token}.`);
      }}>
        <h3>Award an achievement</h3>
        <div className="row">
          <div className="field">
            <label className="label" htmlFor="a-pass">Pass</label>
            <select id="a-pass" value={award.token} onChange={(e) => setAward({ ...award, token: e.target.value })}>
              <option value="">Choose…</option>
              {d.passes.map((x) => <option key={x.token_id} value={x.token_id}>#{x.token_id} · {x.tier} · {x.points} pts</option>)}
            </select>
          </div>
          <div className="field"><label className="label" htmlFor="a-code">Code (unique per pass)</label><input id="a-code" maxLength={32} value={award.code} onChange={(e) => setAward({ ...award, code: e.target.value })} placeholder="first-project" /></div>
          <div className="field"><label className="label" htmlFor="a-pts">Points (1–50)</label><input id="a-pts" value={award.points} onChange={(e) => setAward({ ...award, points: e.target.value.replace(/\D/g, "") })} /></div>
        </div>
        <button type="submit" disabled={!award.token || !award.code.trim() || !!tx.busy}>Award</button>
      </form>
    </section>
  );
}

export function CreatorPage({ config }: { config: ConfigV2 | null }) {
  const session = useSession();
  const [programmes, setProgrammes] = useState<ProgrammeV2[] | null>(null);
  const tx = useTx(config?.contract);
  const load = () => v2.programmes().then(setProgrammes).catch(() => setProgrammes([]));
  useEffect(() => {
    load();
  }, []);
  const mine = programmes?.filter((p) => p.creator === tx.wallet.accountId) ?? [];

  return (
    <>
      <section className="intro">
        <h1>Creator dashboard</h1>
        <p>
          Run your programme: events, check-ins, achievements, reward funding and your treasury. Every button is a transaction the contract
          checks; the dashboard only opens for the programme's creator, verified on chain.
        </p>
      </section>
      {!tx.wallet.accountId ? (
        <div className="panel" style={{ maxWidth: 520 }}>
          <h2>Connect your wallet</h2>
          <button onClick={() => tx.wallet.connect().catch(() => undefined)}>Connect a testnet wallet</button>
        </div>
      ) : (
        <>
          <NewProgramme contract={config?.contract} onDone={load} />
          {mine.length > 0 && !session.token && (
            <div className="panel" style={{ maxWidth: 600 }}>
              <h2>Open your dashboards</h2>
              <p className="muted">Sign a one-time message (no funds move) so the server can confirm you are the creator.</p>
              <button onClick={session.signIn} disabled={session.busy}>{session.busy ? "Waiting…" : "Sign in"}</button>
              {session.error && <div className="note bad">{session.error}</div>}
            </div>
          )}
          {programmes && mine.length === 0 && <p className="muted">You have not created a programme with this account yet.</p>}
          {session.token && mine.map((p) => <Dashboard key={p.id} programme={p} token={session.token!} contract={config?.contract} />)}
        </>
      )}
    </>
  );
}
