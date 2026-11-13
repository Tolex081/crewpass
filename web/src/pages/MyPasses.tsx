import { useEffect, useState } from "react";
import { v2, type PassV2 } from "../lib/v2";
import { near } from "../lib/format";
import { errorText, useWallet } from "../lib/wallet";
import { PassCardV2 } from "../components/PassCardV2";

export function MyPassesPage() {
  const wallet = useWallet();
  const [passes, setPasses] = useState<PassV2[] | null>(null);
  const [balances, setBalances] = useState<Record<string, string | null>>({});
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!wallet.accountId) return;
    setPasses(null);
    v2.passes(wallet.accountId)
      .then((list) => {
        setPasses(list);
        for (const p of list) {
          setBalances((b) => ({ ...b, [p.token_id]: null }));
          v2.pass(p.token_id)
            .then((d) => setBalances((b) => ({ ...b, [p.token_id]: d.account?.balance ?? "0" })))
            .catch(() => undefined);
        }
      })
      .catch((e) => setErr(errorText(e)));
  }, [wallet.accountId]);

  const total = Object.values(balances).reduce((s, b) => s + BigInt(b ?? "0"), 0n);
  const claimable = passes?.reduce((s, p) => s + BigInt(p.rewards_available), 0n) ?? 0n;

  return (
    <>
      <section className="intro">
        <h1>My passes</h1>
        <p>Passes held by your wallet right now, with the NEAR held by each pass's own account.</p>
      </section>
      {!wallet.accountId && (
        <div className="panel" style={{ maxWidth: 520 }}>
          <h2>Connect your wallet</h2>
          <button onClick={() => wallet.connect().catch(() => undefined)} disabled={!wallet.ready}>Connect a testnet wallet</button>
        </div>
      )}
      {err && <div className="note bad">{err}</div>}
      {wallet.accountId && !passes && !err && <p className="muted">Reading your passes from the registry…</p>}
      {passes && passes.length === 0 && (
        <div className="panel">
          <h2>No passes yet</h2>
          <p className="muted"><a href="#/discover">Browse programmes</a> to mint one.</p>
        </div>
      )}
      {passes && passes.length > 0 && (
        <>
          <section className="stats">
            <div className="hue-teal"><span className="label">Passes</span><strong className="num">{passes.length}</strong></div>
            <div className="hue-sun"><span className="label">In their accounts</span><strong className="num">Ⓝ {near(total)}</strong></div>
            <div className="hue-green"><span className="label">Rewards to claim</span><strong className="num">Ⓝ {near(claimable)}</strong></div>
            <div className="hue-violet"><span className="label">Achievements</span><strong className="num">{passes.reduce((s, p) => s + p.achievements, 0)}</strong></div>
          </section>
          <div className="passes">
            {passes.map((p) => <PassCardV2 key={p.token_id} pass={p} balance={balances[p.token_id]} href={`#/pass/${p.token_id}`} />)}
          </div>
        </>
      )}
    </>
  );
}
