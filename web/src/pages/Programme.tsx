import { useEffect, useState } from "react";
import { v2, tierClass, type ConfigV2 } from "../lib/v2";
import { near, shortAccount, when } from "../lib/format";
import { errorText } from "../lib/wallet";
import { useTx } from "../lib/useTx";
import { PassCardV2 } from "../components/PassCardV2";

type Data = Awaited<ReturnType<typeof v2.programme>>;

function refFromUrl(): string {
  try {
    return new URLSearchParams(window.location.search).get("ref") ?? "";
  } catch {
    return "";
  }
}

export function ProgrammePage({ id, config }: { id: string; config: ConfigV2 | null }) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [ref, setRef] = useState(refFromUrl);
  const load = () => v2.programme(id).then(setData).catch((e) => setErr(errorText(e)));
  const tx = useTx(config?.contract, load);
  useEffect(() => {
    load();
  }, [id]);

  if (err) return <div className="note bad">{err}</div>;
  if (!data) return <p className="muted">Reading programme {id}…</p>;
  const p = data.programme;
  const referral = (BigInt(p.mint_price) * BigInt(p.referral_bps)) / 10000n;
  const refPass = data.passes.find((x) => x.token_id === ref.trim());
  const soldOut = p.max_supply !== null && p.minted >= p.max_supply;

  return (
    <>
      <p><a href="#/discover">← All programmes</a></p>
      <section className="intro">
        <span className="label">Programme {p.id} · created by <span className="mono">{p.creator}</span> · {data.content.label}</span>
        <h1>{p.name}</h1>
        <p>{data.content.summary}</p>
      </section>

      <section className="split">
        <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
          <div className="panel">
            <h2>Join</h2>
            <p className="muted">
              Minting creates the pass and its own NEAR account in one step. If the account cannot be created, no pass is minted and you get
              your money back (the account seed is claimable).
            </p>
            <div className="field">
              <label className="label" htmlFor="ref">Referred by pass # (optional)</label>
              <input id="ref" value={ref} onChange={(e) => setRef(e.target.value.replace(/\D/g, ""))} placeholder="e.g. 1" inputMode="numeric" />
            </div>
            {ref && !refPass && <div className="note">There is no pass #{ref} in this programme.</div>}
            {refPass && (
              <div className="note ok">Ⓝ {near(referral)} of your mint goes into <span className="mono">{refPass.account_id}</span>.</div>
            )}
            {!tx.wallet.accountId ? (
              <button onClick={() => tx.wallet.connect().catch(() => undefined)}>Connect a testnet wallet</button>
            ) : (
              <button
                disabled={!!tx.busy || soldOut || (!!ref && !refPass)}
                onClick={() =>
                  tx.run("mint", "mint", { programme_id: p.id, referrer_token_id: ref.trim() || null }, p.mint_price, "Minted. Your pass and its account are below and on My passes.")
                }
              >
                {soldOut ? "Sold out" : tx.busy ? "Waiting for your wallet…" : `Mint a pass for Ⓝ ${near(p.mint_price)}`}
              </button>
            )}
            {tx.msg && <div className={`note ${tx.msg.kind}`}>{tx.msg.text}</div>}
          </div>

          <div className="panel">
            <h2>Rules (enforced by the contract)</h2>
            <dl className="kv">
              <dt>Mint price</dt><dd>Ⓝ {near(p.mint_price)}</dd>
              <dt>Seed into the new pass account</dt><dd>Ⓝ {near(config?.account_seed ?? "0")}</dd>
              <dt>Referral, paid to the referrer pass's account</dt><dd>{p.referral_bps / 100}%</dd>
              <dt>Creator resale royalty</dt><dd>{(config?.creator_royalty_bps ?? 500) / 100}%</dd>
              <dt>Share of each ticket to all passes</dt><dd>{p.member_share_bps / 100}%</dd>
              <dt>Supply</dt><dd>{p.max_supply ? `${p.minted} of ${p.max_supply}` : `${p.minted}, no cap`}</dd>
            </dl>
            <p className="muted" style={{ fontSize: "var(--step--1)" }}>CrewPass sales apply this royalty directly. Other marketplaces can honor it through the NEP-199 payout interface.</p>
          </div>

          <div className="panel">
            <h2>Treasury and rewards</h2>
            <dl className="kv">
              <dt>Ticket revenue</dt><dd>Ⓝ {near(p.ticket_revenue_total)}</dd>
              <dt>Creator-funded rewards</dt><dd>Ⓝ {near(p.funded_total)}</dd>
              <dt>Credited to passes</dt><dd>Ⓝ {near(p.distributed_total)}</dd>
              <dt>Paid into pass accounts</dt><dd>Ⓝ {near(p.claimed_total)}</dd>
              <dt>Reserved, not yet claimed</dt><dd>Ⓝ {near(p.reserved)}</dd>
              <dt>Creator treasury</dt><dd>Ⓝ {near(p.treasury)}</dd>
            </dl>
            <a href={`#/rewards/${p.id}`}>Every distribution and claim →</a>
          </div>
        </div>

        <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
          <div className="panel">
            <h2>Benefits by tier</h2>
            <ul className="benefits">
              {data.content.benefits.map((b) => (
                <li key={b.text}><span className={`tier-chip ${tierClass(b.minTier)}`}>{b.minTier}</span> {b.text}</li>
              ))}
            </ul>
            <p className="muted" style={{ fontSize: "var(--step--1)" }}>Tiers come from on-chain points: Silver 30, Gold 80, Platinum 150.</p>
          </div>

          <div className="panel">
            <h2>Events</h2>
            {data.events.length === 0 && <p className="muted">No events yet.</p>}
            {data.events.map((e) => (
              <div key={e.id} className="proof-line" style={{ justifyContent: "space-between" }}>
                <span><strong>{e.title}</strong> · Ⓝ {near(e.price)} · {e.points} pts{Number(e.starts_at_ms) ? ` · ${when(Number(e.starts_at_ms))}` : ""}</span>
                <span className="num muted">{e.capacity - e.sold} of {e.capacity} seats left</span>
              </div>
            ))}
            <a href="#/events">Buy tickets →</a>
          </div>
        </div>
      </section>

      <section style={{ display: "grid", gap: 16 }}>
        <h2>Passes ({data.passes.length})</h2>
        {data.passes.length === 0 && <p className="muted">No passes minted yet.</p>}
        <div className="passes">
          {data.passes.map((x) => <PassCardV2 key={x.token_id} pass={x} programme={p.name} href={`#/pass/${x.token_id}`} />)}
        </div>
        <p className="muted" style={{ fontSize: "var(--step--1)" }}>Creator: <span className="mono">{shortAccount(p.creator)}</span>.</p>
      </section>
    </>
  );
}
