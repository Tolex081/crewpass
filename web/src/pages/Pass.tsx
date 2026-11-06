import { useEffect, useState, type ReactNode } from "react";
import { api, type Config, type HistoryEvent, type PassInfo } from "../lib/api";
import { explorerTx, near, shortAccount, toYocto, when } from "../lib/format";
import { errorText, useWallet } from "../lib/wallet";
import { PassCard } from "../components/PassCard";

const ONE_YOCTO = "1";

/** One readable line per event, from this pass's point of view. Null hides duplicates. */
function describe(e: HistoryEvent, id: string): ReactNode | null {
  const d = e.data as Record<string, string>;
  const acct = (a: string) => <span className="mono">{shortAccount(a)}</span>;
  switch (e.event) {
    case "pass_minted":
      return d.token_id === id ? (
        <>Minted by {acct(d.owner_id)}{d.referrer_token_id ? <> through pass #{d.referrer_token_id}</> : null}</>
      ) : (
        <>Referred a new fan: pass #{d.token_id} minted by {acct(d.owner_id)}</>
      );
    case "commission_credited":
      return d.token_id === id ? <>Commission of Ⓝ {near(d.amount)} added to the vault</> : null;
    case "pass_listed":
      return <>Listed for Ⓝ {near(d.price)} by {acct(d.seller)}</>;
    case "pass_delisted":
      return <>Taken off sale</>;
    case "pass_sold":
      return <>Sold by {acct(d.seller)} to {acct(d.buyer)} for Ⓝ {near(d.price)}; the vault (Ⓝ {near(d.vault)}) went with it</>;
    case "vault_withdrawn":
      return <>{acct(d.to)} withdrew Ⓝ {near(d.amount)} from the vault</>;
    case "transfer_call_locked":
      return <>Locked while sent to contract {acct(d.receiver_id)}</>;
    case "transfer_call_unlocked":
      return <>Unlocked: {String(e.data.kept_by_receiver) === "true" ? "the receiving contract kept it" : "returned to its holder"}</>;
    case "nft_transfer":
      return d.memo === "crewpass sale" ? null : <>Moved from {acct(d.old_owner_id)} to {acct(d.new_owner_id)}</>;
    case "nft_burn":
      return <>Burned by {acct(d.owner_id)}</>;
    default:
      return null; // nft_mint duplicates pass_minted
  }
}

export function PassPage({ id, config }: { id: string; config: Config | null }) {
  const wallet = useWallet();
  const [pass, setPass] = useState<PassInfo | null>(null);
  const [missing, setMissing] = useState("");
  const [history, setHistory] = useState<{ complete: boolean; events: HistoryEvent[]; note?: string } | null>(null);
  const [price, setPrice] = useState("1");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    try {
      setPass(await api.pass(id));
    } catch (e) {
      setMissing(errorText(e));
    }
    api.history(id).then(setHistory).catch(() => setHistory({ complete: false, events: [], note: "History could not be loaded." }));
  };
  useEffect(() => {
    setPass(null);
    setHistory(null);
    setMissing("");
    load();
  }, [id]);

  async function run(label: string, method: string, args: object, deposit: string, done: string) {
    if (!config) return;
    setBusy(label);
    setMsg(null);
    try {
      await wallet.call(config.contract, method, args, deposit);
      setMsg({ kind: "ok", text: done });
      await load();
    } catch (e) {
      setMsg({ kind: "bad", text: errorText(e) });
    } finally {
      setBusy("");
    }
  }

  if (missing) return <div className="note bad">{missing}</div>;
  if (!pass) return <p className="muted">Reading pass #{id} from the contract…</p>;

  const mine = wallet.accountId === pass.owner_id;
  const listed = pass.listing;
  const refLink = `${window.location.origin}/?ref=${pass.token_id}`;
  const lines = (history?.events ?? []).map((e) => ({ e, text: describe(e, id) })).filter((x) => x.text);

  async function copy() {
    try {
      await navigator.clipboard.writeText(refLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setMsg({ kind: "bad", text: "Copy did not work here. Select the link and copy it yourself." });
    }
  }

  return (
    <>
      <p><a href="#/">← All passes</a></p>
      <section className="split">
        <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
          <PassCard pass={pass} big />
          <div className="field">
            <span className="label">Referral link for this pass</span>
            <div className="row" style={{ alignItems: "center" }}>
              <input id="reflink" readOnly value={refLink} onFocus={(e) => e.currentTarget.select()} style={{ flex: "1 1 200px" }} />
              <button className="quiet" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gap: 20, minWidth: 0 }}>
          <div className="stats">
            <div><span className="label">In the vault</span><strong className="num">Ⓝ {near(pass.vault)}</strong></div>
            <div><span className="label">Withdrawn</span><strong className="num">Ⓝ {near(pass.stats.withdrawn)}</strong></div>
            <div><span className="label">Referrals</span><strong className="num">{pass.stats.referrals}</strong></div>
            <div><span className="label">Times sold or moved</span><strong className="num">{pass.stats.transfers}</strong></div>
          </div>

          <div className="panel">
            {!wallet.accountId && (
              <>
                <h2>Hold or buy this pass</h2>
                <p className="muted">Connect a testnet wallet to withdraw, list or buy.</p>
                <button onClick={() => wallet.connect().catch((e) => setMsg({ kind: "bad", text: errorText(e) }))}>Connect a testnet wallet</button>
              </>
            )}

            {wallet.accountId && mine && (
              <>
                <h2>You hold this pass</h2>
                {pass.in_transfer_call && <div className="note">This pass is in the middle of a transfer to a contract. Everything is locked until it finishes.</div>}
                <div className="row">
                  <button
                    onClick={() => run("withdraw", "withdraw", { token_id: id }, ONE_YOCTO, `Ⓝ ${near(pass.vault)} sent to ${wallet.accountId}.`)}
                    disabled={!!busy || pass.vault === "0" || !!listed || pass.in_transfer_call}
                  >
                    {busy === "withdraw" ? "Waiting for your wallet…" : `Withdraw Ⓝ ${near(pass.vault)}`}
                  </button>
                </div>
                {listed && <p className="muted">Withdrawing is paused while the pass is listed, so a buyer gets the vault they saw.</p>}
                {!listed ? (
                  <div className="row">
                    <div className="field">
                      <label className="label" htmlFor="price">Sale price in NEAR</label>
                      <input id="price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
                    </div>
                    <button
                      className="quiet"
                      disabled={!!busy || pass.in_transfer_call}
                      onClick={() => {
                        let yocto: string;
                        try {
                          yocto = toYocto(price);
                        } catch (e) {
                          setMsg({ kind: "bad", text: errorText(e) });
                          return;
                        }
                        run("list", "list", { token_id: id, price: yocto }, config?.list_deposit ?? "0", `Listed for Ⓝ ${price}.`);
                      }}
                    >
                      {busy === "list" ? "Waiting for your wallet…" : "List for sale"}
                    </button>
                  </div>
                ) : (
                  <button className="quiet" disabled={!!busy} onClick={() => run("delist", "delist", { token_id: id }, ONE_YOCTO, "Taken off sale. Your listing deposit is on its way back.")}>
                    {busy === "delist" ? "Waiting for your wallet…" : `Take off sale (listed at Ⓝ ${near(listed.price)})`}
                  </button>
                )}
                <p className="muted" style={{ fontSize: "var(--step--1)" }}>
                  Listing holds a Ⓝ {config ? near(config.list_deposit) : "0.01"} deposit, returned with the sale price or when you take it off sale.
                </p>
              </>
            )}

            {wallet.accountId && !mine && (
              <>
                <h2>{listed ? `For sale at Ⓝ ${near(listed.price)}` : "Not for sale"}</h2>
                {listed ? (
                  <>
                    <p>
                      You get the pass, its vault of <strong>Ⓝ {near(pass.vault)}</strong>, every future commission and the members area. The seller
                      cannot withdraw while it is listed, and the purchase fails if the vault ever holds less than Ⓝ {near(pass.vault)}.
                    </p>
                    <button
                      disabled={!!busy}
                      onClick={() => run("buy", "buy", { token_id: id, expected_min_vault: pass.vault }, listed.price, `Pass #${id} is yours, with its vault of Ⓝ ${near(pass.vault)}.`)}
                    >
                      {busy === "buy" ? "Waiting for your wallet…" : `Buy for Ⓝ ${near(listed.price)}`}
                    </button>
                  </>
                ) : (
                  <p className="muted">Held by <span className="mono">{pass.owner_id}</span>. Mint your own pass through its referral link instead.</p>
                )}
              </>
            )}
            {msg && <div className={`note ${msg.kind}`}>{msg.text}</div>}
          </div>

          <div className="panel">
            <h2>History</h2>
            {!history && <p className="muted">Reading this pass's transactions…</p>}
            {history && !history.complete && <div className="note">{history.note}</div>}
            {history && history.complete && lines.length === 0 && <p className="muted">No recorded activity yet.</p>}
            {lines.length > 0 && (
              <ol className="timeline">
                {lines.map(({ e, text }, i) => (
                  <li key={`${e.txHash}-${i}`}>
                    <time dateTime={new Date(e.timestampMs).toISOString()}>{when(e.timestampMs)}</time>
                    <span className="what">{text}</span>
                    <a href={explorerTx(e.txHash)} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: "var(--step--1)" }}>
                      {e.txHash.slice(0, 6)}…
                    </a>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
