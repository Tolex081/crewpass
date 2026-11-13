import { useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { v2, tierClass, TIERS, type PassV2 } from "../lib/v2";
import { useSession } from "../lib/session";
import { errorText, useWallet } from "../lib/wallet";
import { PassCardV2 } from "../components/PassCardV2";
import { Companion } from "../components/Companion";

type Members = Awaited<ReturnType<typeof v2.members>>;

export function MembersV2Page() {
  const wallet = useWallet();
  const session = useSession();
  const [passes, setPasses] = useState<PassV2[] | null>(null);
  const [selected, setSelected] = useState("");
  const [data, setData] = useState<Members | null>(null);
  const [refused, setRefused] = useState("");

  useEffect(() => {
    if (!wallet.accountId) return;
    v2.passes(wallet.accountId)
      .then((l) => {
        setPasses(l);
        if (l[0]) setSelected((s) => s || l[0].token_id);
      })
      .catch((e) => setRefused(errorText(e)));
  }, [wallet.accountId]);

  async function open() {
    if (!session.token || !selected) return;
    setRefused("");
    try {
      setData(await v2.members(session.token, selected));
    } catch (e) {
      setData(null);
      if (e instanceof ApiError && e.status === 401) session.signOut();
      setRefused(errorText(e));
    }
  }
  useEffect(() => {
    open();
  }, [session.token, selected]);

  return (
    <>
      <section className="intro">
        <h1>Members area</h1>
        <p>
          For the current holder of a pass. The server reads the pass's owner and tier from the chain on every request, so a pass sold a minute
          ago no longer opens it, and content above your tier is not sent to your browser at all.
        </p>
      </section>

      {!data && (
        <div className="panel" style={{ maxWidth: 600 }}>
          {!wallet.accountId ? (
            <>
              <h2>Connect your wallet</h2>
              <button onClick={() => wallet.connect().catch(() => undefined)} disabled={!wallet.ready}>Connect a testnet wallet</button>
            </>
          ) : !session.token ? (
            <>
              <h2>Prove it is you</h2>
              <p className="muted">Your wallet signs a one-time message for this site. It moves no funds, expires after 5 minutes and works once.</p>
              <button onClick={session.signIn} disabled={session.busy}>{session.busy ? "Waiting for your wallet…" : `Sign in as ${wallet.accountId}`}</button>
            </>
          ) : passes && passes.length === 0 ? (
            <>
              <h2>No pass on this account</h2>
              <p className="muted"><a href="#/discover">Mint one</a> or buy one that is listed.</p>
            </>
          ) : (
            <p className="muted">Checking your pass on chain…</p>
          )}
          {refused && <div className="note bad">{refused}</div>}
          {session.error && <div className="note bad">{session.error}</div>}
        </div>
      )}

      {data && session.token && (
        <>
          <div className="note ok">
            Signed in as <span className="mono">{data.accountId}</span>. Pass #{data.pass.token_id} checked on chain at {new Date(data.checkedAt).toLocaleTimeString()}.{" "}
            <button className="quiet" style={{ padding: "4px 10px", marginLeft: 8 }} onClick={open}>Check again</button>{" "}
            <button className="quiet" style={{ padding: "4px 10px" }} onClick={() => { session.signOut(); setData(null); }}>Sign out</button>
          </div>
          {passes && passes.length > 1 && (
            <div className="field" style={{ maxWidth: 320 }}>
              <label className="label" htmlFor="mpass">Open the members area of</label>
              <select id="mpass" value={selected} onChange={(e) => setSelected(e.target.value)}>
                {passes.map((p) => <option key={p.token_id} value={p.token_id}>Pass #{p.token_id} · {p.tier}</option>)}
              </select>
            </div>
          )}
          <section className="split">
            <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
              <PassCardV2 pass={data.pass} programme={data.programme.name} href={`#/pass/${data.pass.token_id}`} />
              <div className="tier-track">
                {TIERS.map((t, i) => (
                  <div key={t} className={`${tierClass(t)} ${i <= TIERS.indexOf(data.pass.tier as (typeof TIERS)[number]) ? "reached" : ""}`}><strong>{t}</strong></div>
                ))}
              </div>
            </div>
            <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
              <span className="label">{data.content.label}</span>
              <article className="panel">
                <h2>{data.programme.name}</h2>
                <p className="muted">{data.programme.summary}</p>
                <ul className="benefits">
                  {data.content.benefits.map((b) => (
                    <li key={b.text} className={b.unlocked ? "" : "muted"}>
                      <span className={`tier-chip ${tierClass(b.minTier)}`}>{b.minTier}</span> {b.text} {b.unlocked ? "" : "(locked)"}
                    </li>
                  ))}
                </ul>
              </article>
              {data.content.posts.map((post) => (
                <article key={post.title} className={`panel ${post.unlocked ? "" : "locked-post"}`}>
                  <div className="actions" style={{ justifyContent: "space-between" }}>
                    <h2>{post.title}</h2>
                    <span className={`tier-chip ${tierClass(post.minTier)}`}>{post.minTier}</span>
                  </div>
                  {post.unlocked ? <p>{post.body}</p> : <p>Unlocks at {post.minTier}. Earn points at events and through achievements.</p>}
                </article>
              ))}
            </div>
          </section>
          <Companion
            key={data.pass.token_id}
            version="v2"
            token={session.token}
            passes={[{ token_id: data.pass.token_id }]}
            onLockedOut={(msg) => {
              setData(null);
              setRefused(msg);
            }}
          />
        </>
      )}
    </>
  );
}
