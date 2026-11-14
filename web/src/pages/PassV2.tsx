import { useEffect, useState, type ReactNode } from "react";
import type { HistoryEvent } from "../lib/api";
import { v2, tierClass, TIERS, ONE_YOCTO, type ConfigV2, type History, type PassDetail } from "../lib/v2";
import { explorerAccount, explorerTx, near, shortAccount, toYocto, when, type Hue } from "../lib/format";
import { useTx } from "../lib/useTx";
import { errorText } from "../lib/wallet";
import { PassCardV2 } from "../components/PassCardV2";

interface Line {
  tag: string;
  hue: Hue;
  text: ReactNode;
}

function describe(e: HistoryEvent, id: string): Line | null {
  const d = e.data as Record<string, string>;
  const acct = (a: string) => <span className="mono">{shortAccount(String(a))}</span>;
  switch (e.event) {
    case "pass_account_created":
      return { tag: "Mint", hue: "teal", text: <>Minted to {acct(d.controller)}; account {acct(d.account_id)} created with Ⓝ {near(d.seed)}</> };
    case "referral_paid":
      return d.token_id === id
        ? { tag: "Referral", hue: "violet", text: <>Ⓝ {near(d.amount)} paid into the account for referring pass #{d.from_token_id}</> }
        : null;
    case "control_changed":
      return { tag: "Control", hue: "coral", text: <>Control of {acct(d.account_id)} moved from {acct(d.previous_controller)} to {acct(d.controller)} (epoch {d.owner_epoch})</> };
    case "pass_sold":
      return { tag: "Sale", hue: "coral", text: <>Sold by {acct(d.seller)} to {acct(d.buyer)} for Ⓝ {near(d.price)}</> };
    case "pass_listed":
      return { tag: "Listed", hue: "cobalt", text: <>Listed for Ⓝ {near(d.price)} (listing {d.listing_id})</> };
    case "pass_delisted":
      return { tag: "Off sale", hue: "cobalt", text: <>Taken off sale</> };
    case "account_op_started":
      return { tag: "Account", hue: "green", text: <>{acct(d.controller)} started {d.op}{d.op === "transfer" ? <> of Ⓝ {near(d.amount)} to {acct(d.receiver_id)}</> : <> on {acct(d.receiver_id)}</>}</> };
    case "account_op_finished":
      return { tag: "Account", hue: "green", text: <>{d.op} {String(e.data.succeeded) === "true" ? "succeeded" : "failed; lock released"}</> };
    case "rewards_claimed":
      return { tag: "Reward", hue: "sun", text: <>Ⓝ {near(d.amount)} of programme revenue paid into the account</> };
    case "ticket_purchased":
      return { tag: "Ticket", hue: "sun", text: <>Ticket for event {d.event_id} bought by {acct(d.buyer)}</> };
    case "checked_in":
      return { tag: "Check-in", hue: "violet", text: <>Checked in at event {d.event_id}: +{d.points} points</> };
    case "achievement_awarded":
      return { tag: "Achievement", hue: "violet", text: <>“{d.code}” awarded: +{d.points} points</> };
    case "tier_changed":
      return { tag: "Tier", hue: "violet", text: <>{d.from} → {d.to} ({d.points} points)</> };
    case "nft_metadata_update":
      return { tag: "Metadata", hue: "cobalt", text: <>NFT metadata updated (NEP-171 nft_metadata_update)</> };
    case "transfer_call_locked":
      return { tag: "Locked", hue: "violet", text: <>Locked while sent to contract {acct(d.receiver_id)}</> };
    case "transfer_call_unlocked":
      return { tag: "Unlocked", hue: "violet", text: <>{String(e.data.kept_by_receiver) === "true" ? "The receiving contract kept it" : "Returned to its holder"}</> };
    case "nft_transfer":
      return d.memo === "crewpass sale" ? null : { tag: "Moved", hue: "cobalt", text: <>From {acct(d.old_owner_id)} to {acct(d.new_owner_id)}</> };
    default:
      return null;
  }
}

export function PassV2Page({ id, config }: { id: string; config: ConfigV2 | null }) {
  const [detail, setDetail] = useState<PassDetail | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [missing, setMissing] = useState("");
  const [amount, setAmount] = useState("0.01");
  const [price, setPrice] = useState("1");
  const load = async () => {
    try {
      setDetail(await v2.pass(id));
    } catch (e) {
      setMissing(errorText(e));
    }
    v2.history(id).then(setHistory).catch(() => setHistory({ complete: false, events: [], note: "History could not be loaded." }));
  };
  const tx = useTx(config?.contract, load);
  useEffect(() => {
    setDetail(null);
    setHistory(null);
    setMissing("");
    load();
  }, [id]);

  if (missing) return <div className="note bad">{missing}</div>;
  if (!detail) return <p className="muted">Reading pass #{id} and its account…</p>;
  const { pass, account, metadata } = detail;
  const mine = tx.wallet.accountId === pass.owner_id;
  const busyLock = !!pass.lock;
  const lines = (history?.events ?? []).map((e) => ({ e, line: describe(e, id) })).filter((x): x is { e: HistoryEvent; line: Line } => !!x.line);
  const tierIndex = TIERS.indexOf(pass.tier as (typeof TIERS)[number]);

  function withYocto(fn: (y: string) => unknown) {
    try {
      fn(toYocto(amount));
    } catch (e) {
      tx.setMsg({ kind: "bad", text: errorText(e) });
    }
  }

  return (
    <>
      <p><a href={`#/programme/${pass.programme_id}`}>← Programme {pass.programme_id}</a></p>
      <section className="split">
        <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
          <PassCardV2 pass={pass} balance={account?.balance ?? null} big />
          {metadata?.media?.startsWith("data:image/svg+xml") && (
            <figure className="panel" style={{ margin: 0 }}>
              <span className="label">NFT image (on-chain metadata)</span>
              <img src={metadata.media} alt={`Metadata image: ${metadata.title ?? ""}`} style={{ width: 160, borderRadius: 12 }} />
              <figcaption className="mono muted" style={{ fontSize: "var(--step--1)" }}>{metadata.title}</figcaption>
            </figure>
          )}
        </div>

        <div style={{ display: "grid", gap: 20, minWidth: 0 }}>
          <div className="panel">
            <h2>The pass's own account</h2>
            {account ? (
              <>
                <dl className="kv">
                  <dt>Account</dt><dd><a href={explorerAccount(account.accountId)} target="_blank" rel="noreferrer">{account.accountId}</a></dd>
                  <dt>Balance</dt><dd>Ⓝ {near(account.balance)}</dd>
                  <dt>Access keys</dt><dd>{account.accessKeys}</dd>
                  <dt>Runs code</dt><dd>{account.globalContractHash ?? "none"}</dd>
                  <dt>Controller now</dt><dd>{pass.owner_id}</dd>
                </dl>
                <div className="proof-line">
                  <span className={account.keyless ? "yes" : "no"}>{account.keyless ? "✓ No keys" : "✗ Has keys"}</span>
                  <span className={account.runsPassAccountCode ? "yes" : "no"}>{account.runsPassAccountCode ? "✓ Runs the published pass-account code" : "✗ Unexpected code"}</span>
                </div>
                <p className="muted" style={{ fontSize: "var(--step--1)" }}>
                  Nobody holds a key to this account. It only follows instructions from the registry, which only accepts them from the current
                  holder. Read live from the chain.
                </p>
              </>
            ) : (
              <p className="muted">The account could not be read right now.</p>
            )}
          </div>

          <div className="panel">
            <h2>Tier</h2>
            <div className="tier-track">
              {TIERS.map((t, i) => (
                <div key={t} className={`${tierClass(t)} ${i <= tierIndex ? "reached" : ""}`}>
                  <strong>{t}</strong>
                  <span className="num">{config?.tiers.find(([n]) => n === t)?.[1] ?? ""} pts</span>
                </div>
              ))}
            </div>
            <p className="muted">
              {pass.points} points from {pass.check_ins} check-ins, {pass.achievements} achievements and {pass.referrals} referrals.
              {pass.next_tier ? ` ${pass.points_to_next_tier} more to reach ${pass.next_tier}.` : " Top tier."}
            </p>
          </div>

          <div className="panel">
            <h2>Money</h2>
            <dl className="kv">
              <dt>Rewards waiting (programme revenue)</dt><dd>Ⓝ {near(pass.rewards_available)}</dd>
              <dt>Rewards paid into the account so far</dt><dd>Ⓝ {near(pass.rewards_claimed)}</dd>
              <dt>Referral commissions paid into the account</dt><dd>Ⓝ {near(pass.referral_earned)}</dd>
              <dt>Times sold or moved</dt><dd>{pass.transfers}</dd>
            </dl>
            <div className="actions">
              <button
                disabled={!!tx.busy || BigInt(pass.rewards_available) === 0n || !tx.wallet.accountId}
                onClick={() => tx.run("claim", "claim_rewards", { token_id: id }, "0", `Paid Ⓝ ${near(pass.rewards_available)} into ${pass.account_id}.`)}
              >
                {tx.busy === "claim" ? "Waiting…" : "Claim rewards into the account"}
              </button>
              <span className="muted" style={{ fontSize: "var(--step--1)" }}>Anyone can press this: the money can only go to the pass's account.</span>
            </div>
          </div>

          <div className="panel">
            {!tx.wallet.accountId ? (
              <>
                <h2>Hold or buy this pass</h2>
                <button onClick={() => tx.wallet.connect().catch(() => undefined)}>Connect a testnet wallet</button>
              </>
            ) : mine ? (
              <>
                <h2>You control this pass</h2>
                {busyLock && <div className="note">The pass is locked while an operation finishes. Reload in a moment.</div>}
                <div className="row">
                  <div className="field">
                    <label className="label" htmlFor="amt">Withdraw from the account (NEAR)</label>
                    <input id="amt" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
                  </div>
                  <button
                    disabled={!!tx.busy || !!pass.listing || busyLock}
                    onClick={() => withYocto((y) => tx.run("withdraw", "account_transfer", { token_id: id, receiver_id: tx.wallet.accountId, amount: y }, ONE_YOCTO, `Sent Ⓝ ${amount} from ${pass.account_id} to your wallet.`))}
                  >
                    {tx.busy === "withdraw" ? "Waiting…" : "Withdraw"}
                  </button>
                </div>
                {!pass.listing ? (
                  <div className="row">
                    <div className="field">
                      <label className="label" htmlFor="price">Sell for (NEAR)</label>
                      <input id="price" value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
                    </div>
                    <button
                      className="quiet"
                      disabled={!!tx.busy || busyLock}
                      onClick={() => {
                        try {
                          tx.run("list", "list", { token_id: id, price: toYocto(price) }, config?.list_deposit ?? "10000000000000000000000", "Listed. Nothing can leave the account while it is for sale.");
                        } catch (e) {
                          tx.setMsg({ kind: "bad", text: errorText(e) });
                        }
                      }}
                    >
                      List (Ⓝ 0.01 deposit, returned)
                    </button>
                  </div>
                ) : (
                  <button className="quiet" disabled={!!tx.busy} onClick={() => tx.run("delist", "delist", { token_id: id }, ONE_YOCTO, "Taken off sale.")}>
                    Take off sale (listed for Ⓝ {near(pass.listing.price)})
                  </button>
                )}
                <p className="muted" style={{ fontSize: "var(--step--1)" }}>
                  Referral link: <span className="mono">{`${window.location.origin}/?ref=${id}#/programme/${pass.programme_id}`}</span>
                </p>
              </>
            ) : pass.listing ? (
              <>
                <h2>For sale: Ⓝ {near(pass.listing.price)}</h2>
                <p className="muted">
                  You get the pass, control of <span className="mono">{pass.account_id}</span> (Ⓝ {near(account?.balance ?? "0")} now), Ⓝ {near(pass.rewards_available)} of
                  unclaimed rewards, its {pass.tier} tier and its history. Nothing can leave the account while it is listed. A {(config?.creator_royalty_bps ?? 500) / 100}% creator royalty is included in CrewPass sales.
                </p>
                <button
                  disabled={!!tx.busy}
                  onClick={() => tx.run("buy", "buy", { token_id: id, listing_id: pass.listing!.id }, pass.listing!.price, "Bought. You now control the pass and its account.")}
                >
                  {tx.busy === "buy" ? "Waiting…" : `Buy for Ⓝ ${near(pass.listing.price)}`}
                </button>
              </>
            ) : (
              <>
                <h2>Not for sale</h2>
                <p className="muted">Held by <span className="mono">{pass.owner_id}</span>.</p>
              </>
            )}
            {tx.msg && <div className={`note ${tx.msg.kind}`}>{tx.msg.text}</div>}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="actions" style={{ justifyContent: "space-between" }}>
          <h2>History</h2>
          {history && (
            <span className={`status ${history.complete ? "live" : "demo"}`}>
              {history.complete ? `Complete · ${history.transactionsRead ?? "?"} transactions read` : "Incomplete"}
            </span>
          )}
        </div>
        {history?.note && <div className="note">{history.note}</div>}
        {!history && <p className="muted">Reading every registry transaction…</p>}
        <ol className="timeline">
          {lines.map(({ e, line }, i) => (
            <li key={`${e.txHash}-${i}`} className={`hue-${line.hue}`}>
              <time>{when(e.timestampMs)}</time>
              <span className="tag">{line.tag}</span>
              <span className="what">{line.text}</span>
              <a className="mono" href={explorerTx(e.txHash)} target="_blank" rel="noreferrer">{e.txHash.slice(0, 8)}…</a>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
