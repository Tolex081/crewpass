import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { near } from "../lib/format";
import { errorText, useWallet } from "../lib/wallet";
import { PassCard } from "../components/PassCard";
import { Companion } from "../components/Companion";

type Members = Awaited<ReturnType<typeof api.members>>;
const KEY = "crewpass.session";

function savedToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}
function saveToken(t: string | null) {
  try {
    if (t) sessionStorage.setItem(KEY, t);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the session just lasts until the tab reloads */
  }
}

export function MembersPage() {
  const wallet = useWallet();
  const [token, setToken] = useState<string | null>(savedToken);
  const [data, setData] = useState<Members | null>(null);
  const [refused, setRefused] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function open(t: string) {
    setRefused("");
    setError("");
    try {
      setData(await api.members(t));
    } catch (e) {
      setData(null);
      if (e instanceof ApiError && e.status === 401) {
        saveToken(null);
        setToken(null);
      }
      if (e instanceof ApiError && (e.status === 403 || e.status === 401)) setRefused(e.message);
      else setError(errorText(e));
    }
  }

  useEffect(() => {
    if (token) open(token);
  }, [token]);

  async function signIn() {
    setBusy(true);
    setError("");
    try {
      const c = await api.challenge();
      const nonce = Uint8Array.from(atob(c.nonce), (ch) => ch.charCodeAt(0));
      const signed = await wallet.signMessage(c.message, c.recipient, nonce);
      const t = await api.session({ accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: c.nonce });
      saveToken(t);
      setToken(t);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function signOut() {
    saveToken(null);
    setToken(null);
    setData(null);
    setRefused("");
  }

  return (
    <>
      <section className="intro">
        <h1>Members area</h1>
        <p>
          Only for whoever holds a pass right now. Every time this page loads, the server checks the chain again, so a pass sold a minute
          ago no longer opens it.
        </p>
      </section>

      {!data && (
        <div className="panel" style={{ maxWidth: 560 }}>
          {!wallet.accountId ? (
            <>
              <h2>Connect your wallet</h2>
              <button onClick={() => wallet.connect().catch((e) => setError(errorText(e)))}>Connect a testnet wallet</button>
            </>
          ) : (
            <>
              <h2>Prove you hold a pass</h2>
              <p className="muted">
                Your wallet signs a one-time message for this site. It is not a transaction and moves no funds. The request expires after 5 minutes
                and works once.
              </p>
              <button onClick={signIn} disabled={busy}>{busy ? "Waiting for your wallet…" : `Sign in as ${wallet.accountId}`}</button>
            </>
          )}
          {refused && <div className="note bad">{refused}</div>}
          {error && <div className="note bad">{error}</div>}
        </div>
      )}

      {data && (
        <>
          <div className="note ok">
            Signed in as <span className="mono">{data.accountId}</span>. Ownership checked on chain at {new Date(data.checkedAt).toLocaleTimeString()}.{" "}
            <button className="quiet" style={{ padding: "4px 10px", marginLeft: 8 }} onClick={() => token && open(token)}>Check again</button>{" "}
            <button className="quiet" style={{ padding: "4px 10px" }} onClick={signOut}>Sign out</button>
          </div>
          <section className="split">
            <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
              <h2>Your passes</h2>
              <div className="passes">
                {data.passes.map((p) => <PassCard key={p.token_id} pass={p} href={`#/v1/pass/${p.token_id}`} />)}
              </div>
              <p className="muted">
                Total in your vaults: Ⓝ {near(data.passes.reduce((s, p) => s + BigInt(p.vault), 0n))}
              </p>
            </div>
            <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
              <span className="label">{data.content.label} · from {data.content.creator}</span>
              <article className="panel">
                <h2>{data.programme.name}</h2>
                <p className="muted">{data.programme.summary}</p>
                <ul className="benefits">
                  {data.programme.benefits.map((b) => <li key={b}>{b}</li>)}
                </ul>
                <p className="muted" style={{ fontSize: "var(--step--1)" }}>
                  Tiers ({data.programme.tiers.names.join(", ")}): {data.programme.tiers.note}
                </p>
              </article>
              {data.content.posts.map((post) => (
                <article key={post.title} className="panel">
                  <h2>{post.title}</h2>
                  <p>{post.body}</p>
                </article>
              ))}
            </div>
          </section>
          {token && (
            <Companion
              token={token}
              passes={data.passes}
              onLockedOut={(msg) => {
                setData(null);
                setRefused(msg);
              }}
            />
          )}
        </>
      )}
    </>
  );
}
