import { useEffect, useState } from "react";
import { api, type Config, type PassInfo } from "../lib/api";
import { HUES, near } from "../lib/format";
import { errorText, useWallet } from "../lib/wallet";
import { PassCard } from "../components/PassCard";

function referrerFromUrl(): string {
  try {
    return new URLSearchParams(window.location.search).get("ref") ?? "";
  } catch {
    return "";
  }
}

export function PassesPage({ config }: { config: Config | null }) {
  const wallet = useWallet();
  const [passes, setPasses] = useState<PassInfo[] | null>(null);
  const [error, setError] = useState("");
  const [ref, setRef] = useState(referrerFromUrl);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  const load = () => api.passes().then(setPasses).catch((e) => setError(errorText(e)));
  useEffect(() => {
    load();
  }, []);

  const commission = config ? (BigInt(config.mint_price) * BigInt(config.commission_bps)) / 10000n : 0n;
  const refPass = passes?.find((p) => p.token_id === ref.trim());
  const refIsMine = !!refPass && refPass.owner_id === wallet.accountId;

  async function mint() {
    if (!config) return;
    setBusy(true);
    setMsg(null);
    try {
      const args = ref.trim() ? { referrer_token_id: ref.trim() } : {};
      await wallet.call(config.contract, "mint", args, config.mint_price);
      setMsg({ kind: "ok", text: ref.trim() ? `Minted. Ⓝ ${near(commission)} went into pass #${ref.trim()}'s vault.` : "Minted. Your pass is below." });
      await load();
    } catch (e) {
      setMsg({ kind: "bad", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="intro">
        <div className="ribbons" aria-hidden="true">
          {HUES.map((h) => <span key={h} className={`hue-${h}`} />)}
        </div>
        <h1>Passes that carry their own earnings</h1>
        <p>
          Each Ambassador Pass has a vault. When a fan mints through your pass, {config ? config.commission_bps / 100 : 10}% of the
          mint price lands in that vault. Sell the pass and the vault, the right to withdraw it and the members area all go with it.
        </p>
      </section>

      <ol className="steps" aria-label="How a pass earns">
        <li className="hue-teal">
          <span className="n">1</span>
          <strong>Share your pass link</strong>
          <p>Every pass has its own link. A fan mints through it for Ⓝ {config ? near(config.mint_price) : "0.1"}.</p>
        </li>
        <li className="hue-sun">
          <span className="n">2</span>
          <strong>Ⓝ {near(commission)} lands in its vault</strong>
          <p>Stored against the pass, not you. Withdraw it whenever you hold the pass.</p>
        </li>
        <li className="hue-coral">
          <span className="n">3</span>
          <strong>Sell it, and the vault goes too</strong>
          <p>The buyer gets the vault, future commissions and the members area. You are locked out at once.</p>
        </li>
      </ol>

      <section className="split">
        <div className="panel">
          <h2>Mint a pass</h2>
          <div className="stats">
            <div className="hue-teal">
              <span className="label">Price</span>
              <strong className="num">Ⓝ {config ? near(config.mint_price) : "…"}</strong>
            </div>
            <div className="hue-sun">
              <span className="label">To the referrer</span>
              <strong className="num">Ⓝ {near(commission)}</strong>
            </div>
          </div>
          <div className="field">
            <label className="label" htmlFor="ref">Referred by pass number (optional)</label>
            <input id="ref" inputMode="numeric" placeholder="e.g. 1" value={ref} onChange={(e) => setRef(e.target.value)} />
          </div>
          {ref.trim() && passes && !refPass && <div className="note bad">There is no pass #{ref.trim()}.</div>}
          {refIsMine && <div className="note bad">That pass is yours. A pass cannot refer its own holder.</div>}
          {wallet.accountId ? (
            <button onClick={mint} disabled={busy || !config || (!!ref.trim() && (!refPass || refIsMine))}>
              {busy ? "Waiting for your wallet…" : `Mint for Ⓝ ${config ? near(config.mint_price) : ""}`}
            </button>
          ) : (
            <button onClick={() => wallet.connect().catch((e) => setMsg({ kind: "bad", text: errorText(e) }))}>Connect a testnet wallet</button>
          )}
          {msg && <div className={`note ${msg.kind}`}>{msg.text}</div>}
          <p className="muted" style={{ fontSize: "var(--step--1)" }}>
            NEAR testnet only. Testnet NEAR is free from a faucet; nothing here costs real money.
          </p>
        </div>

        <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
          <h2>All passes</h2>
          {error && <div className="note bad">{error}</div>}
          {!passes && !error && <p className="muted">Reading passes from {config?.contract ?? "the contract"}…</p>}
          {passes && passes.length === 0 && <p className="muted">No passes yet. Mint the first one.</p>}
          {passes && (
            <div className="passes">
              {passes.map((p) => (
                <PassCard key={p.token_id} pass={p} href={`#/v1/pass/${p.token_id}`} />
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
