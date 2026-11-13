import { useEffect, useState } from "react";
import { v2, type ConfigV2, type EventV2, type PassV2, type ProgrammeV2 } from "../lib/v2";
import { near, when } from "../lib/format";
import { useTx } from "../lib/useTx";
import { useSession } from "../lib/session";
import { errorText } from "../lib/wallet";

export function EventsPage({ config }: { config: ConfigV2 | null }) {
  const [events, setEvents] = useState<EventV2[] | null>(null);
  const [programmes, setProgrammes] = useState<Record<number, ProgrammeV2>>({});
  const [mine, setMine] = useState<PassV2[]>([]);
  const [attach, setAttach] = useState<Record<number, string>>({});
  const [access, setAccess] = useState<Record<number, string>>({});
  const [err, setErr] = useState("");
  const load = () => {
    v2.events().then(setEvents).catch((e) => setErr(errorText(e)));
    v2.programmes().then((l) => setProgrammes(Object.fromEntries(l.map((p) => [p.id, p])))).catch(() => undefined);
  };
  const tx = useTx(config?.contract, load);
  const session = useSession();
  useEffect(load, []);
  useEffect(() => {
    if (tx.wallet.accountId) v2.passes(tx.wallet.accountId).then(setMine).catch(() => setMine([]));
  }, [tx.wallet.accountId]);

  async function checkAccess(id: number) {
    if (!session.token) return;
    try {
      const r = await v2.eventAccess(session.token, id);
      setAccess((a) => ({ ...a, [id]: `✓ Access confirmed via ${r.via}. Checked on chain just now.` }));
    } catch (e) {
      setAccess((a) => ({ ...a, [id]: `✗ ${errorText(e)}` }));
    }
  }

  return (
    <>
      <section className="intro">
        <h1>Events</h1>
        <p>
          Tickets are bought from the registry. Part of each ticket goes into the programme's reward pool and is shared by every pass. Attach
          your pass to a ticket so the creator's check-in adds points to it.
        </p>
      </section>
      {err && <div className="note bad">{err}</div>}
      {!events && !err && <p className="muted">Reading events…</p>}
      {events?.length === 0 && <div className="panel"><p className="muted">No events yet. Creators add them from the <a href="#/creator">creator dashboard</a>.</p></div>}
      {tx.msg && <div className={`note ${tx.msg.kind}`}>{tx.msg.text}</div>}
      <div className="grid-cards">
        {events?.map((e) => {
          const p = programmes[e.programme_id];
          const share = p ? (BigInt(e.price) * BigInt(p.member_share_bps)) / 10000n : 0n;
          const eligible = mine.filter((x) => x.programme_id === e.programme_id);
          const full = e.sold >= e.capacity;
          return (
            <article key={e.id} className="panel">
              <span className="label">Event {e.id} · {p?.name ?? `Programme ${e.programme_id}`}</span>
              <h2>{e.title}</h2>
              <dl className="kv">
                <dt>Ticket</dt><dd>Ⓝ {near(e.price)}</dd>
                <dt>To the members' pool</dt><dd>Ⓝ {near(share)}</dd>
                <dt>Points on check-in</dt><dd>{e.points}</dd>
                <dt>Seats</dt><dd>{e.capacity - e.sold} of {e.capacity} left</dd>
                <dt>Checked in</dt><dd>{e.checked_in}</dd>
                {Number(e.starts_at_ms) > 0 && (<><dt>Starts</dt><dd>{when(Number(e.starts_at_ms))}</dd></>)}
              </dl>
              {tx.wallet.accountId ? (
                <>
                  {eligible.length > 0 && (
                    <div className="field">
                      <label className="label" htmlFor={`attach-${e.id}`}>Attach to pass</label>
                      <select id={`attach-${e.id}`} value={attach[e.id] ?? ""} onChange={(ev) => setAttach((a) => ({ ...a, [e.id]: ev.target.value }))}>
                        <option value="">No pass (visitor ticket)</option>
                        {eligible.map((x) => <option key={x.token_id} value={x.token_id}>#{x.token_id} · {x.tier}</option>)}
                      </select>
                    </div>
                  )}
                  <div className="actions">
                    <button
                      disabled={full || !!tx.busy}
                      onClick={() =>
                        tx.run(`t${e.id}`, "buy_ticket", { event_id: e.id, token_id: attach[e.id] || null }, e.price, `Ticket bought. Ⓝ ${near(share)} went into the members' pool.`)
                      }
                    >
                      {full ? "Sold out" : tx.busy === `t${e.id}` ? "Waiting…" : `Buy ticket · Ⓝ ${near(e.price)}`}
                    </button>
                    {session.token ? (
                      <button className="quiet" onClick={() => checkAccess(e.id)}>Check my access</button>
                    ) : (
                      <button className="quiet" onClick={session.signIn} disabled={session.busy}>Sign in to check access</button>
                    )}
                  </div>
                  {access[e.id] && <div className={`note ${access[e.id].startsWith("✓") ? "ok" : "bad"}`}>{access[e.id]}</div>}
                </>
              ) : (
                <button onClick={() => tx.wallet.connect().catch(() => undefined)}>Connect a wallet to buy</button>
              )}
            </article>
          );
        })}
      </div>
      {session.error && <div className="note bad">{session.error}</div>}
    </>
  );
}
