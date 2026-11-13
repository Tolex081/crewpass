import { useEffect, useRef, useState } from "react";
import { api, ApiError, type ChatMessage } from "../lib/api";
import { v2 } from "../lib/v2";
import { hueFor } from "../lib/format";

type Info = Awaited<ReturnType<typeof api.companionInfo>>;

const STARTERS_V1 = ["What should I study next?", "How much is in my pass vault?", "What happens to my chats if I sell my pass?"];
const STARTERS_V2 = ["How far am I from the next tier?", "What is in my pass account?", "Which events can I join?"];

/** Holder-only AI companion for one pass. Every request is re-checked against the chain by the server. */
/** version picks the V1 (crewpass.testnet) or V2 (crewpass-v2.testnet) companion routes. */
export function Companion({ token, passes, onLockedOut, version = "v1" }: { token: string; passes: { token_id: string }[]; onLockedOut: (msg: string) => void; version?: "v1" | "v2" }) {
  const client = version === "v2"
    ? { history: v2.companionHistory, send: v2.companionSend, clear: v2.companionClear }
    : { history: api.companionHistory, send: api.companionSend, clear: api.companionClear };
  const STARTERS = version === "v2" ? STARTERS_V2 : STARTERS_V1;
  const [info, setInfo] = useState<Info | null>(null);
  const [infoError, setInfoError] = useState("");
  const [passId, setPassId] = useState(passes[0]?.token_id ?? "");
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.companionInfo().then(setInfo).catch((e) => setInfoError(e instanceof Error ? e.message : String(e)));
  }, []);

  function handle(e: unknown) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) onLockedOut(e.message);
    else setError(e instanceof Error ? e.message : String(e));
  }

  useEffect(() => {
    if (!passId) return;
    setError("");
    setConfirmClear(false);
    client.history(token, passId).then((r) => setHistory(r.history)).catch(handle);
  }, [passId, token]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [history, busy]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setError("");
    setHistory((h) => [...h, { role: "user", content: message, at: Date.now() }]);
    setDraft("");
    try {
      const reply = await client.send(token, passId, message);
      setHistory((h) => [...h, { role: "assistant", content: reply, at: Date.now() }]);
    } catch (e) {
      setHistory((h) => h.slice(0, -1)); // the server saved nothing, so neither do we
      setDraft(message);
      handle(e);
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    try {
      await client.clear(token, passId);
      setHistory([]);
      setConfirmClear(false);
    } catch (e) {
      handle(e);
    }
  }

  if (infoError) return <div className="note bad">The companion is not available: {infoError}</div>;
  if (!info) return <p className="muted">Starting your companion…</p>;

  return (
    <section className={`panel companion hue-${hueFor(passId)}`} aria-label={info.name}>
      <div className="companion-head">
        <div style={{ display: "grid", gap: 4 }}>
          <h2>{info.name}</h2>
          <span className="muted" style={{ fontSize: "var(--step--1)" }}>
            {info.mode === "model" ? <>Model: <span className="mono">{info.model}</span></> : "Offline mode: answers from the programme notes"}
          </span>
        </div>
        {passes.length > 1 && (
          <div className="field" style={{ minWidth: 0 }}>
            <label className="label" htmlFor="companion-pass">For pass</label>
            <select id="companion-pass" value={passId} onChange={(e) => setPassId(e.target.value)}>
              {passes.map((p) => <option key={p.token_id} value={p.token_id}>#{p.token_id}</option>)}
            </select>
          </div>
        )}
      </div>

      <div className="chat" role="log" aria-live="polite">
        {history.length === 0 && !busy && (
          <div className="chat-empty">
            <p>{version === "v2" ? "Ask about your tier, your pass account, rewards, events or what happens if you sell." : "Ask about lessons, sessions, your pass vault or what happens if you sell."} It only knows the programme notes, your pass's live state and what you tell it here.</p>
            <div className="row">
              {STARTERS.map((s) => (
                <button key={s} className="quiet starter" onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {history.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            <span className="label">{m.role === "user" ? "You" : info.name}</span>
            <p>{m.content}</p>
          </div>
        ))}
        {busy && <div className="bubble assistant pending"><span className="label">{info.name}</span><p>Thinking…</p></div>}
        <div ref={endRef} />
      </div>

      <div className="note">{info.dataNotice}{!info.memoryPersists && " (This server keeps memory only until it restarts.)"}</div>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <div className="field" style={{ flex: "1 1 260px" }}>
          <label className="label" htmlFor="companion-input">Message</label>
          <input
            id="companion-input"
            value={draft}
            maxLength={info.maxInputChars}
            placeholder="Ask your companion…"
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
            autoComplete="off"
          />
        </div>
        <button type="submit" disabled={busy || !draft.trim()}>{busy ? "Sending…" : "Send"}</button>
      </form>
      {error && <div className="note bad">{error}</div>}

      <div className="row" style={{ alignItems: "center" }}>
        {!confirmClear ? (
          <button className="quiet" onClick={() => setConfirmClear(true)} disabled={history.length === 0}>Clear memory</button>
        ) : (
          <>
            <span>Delete everything you told the companion for pass #{passId}? This cannot be undone.</span>
            <button className="danger" onClick={clear}>Delete</button>
            <button className="quiet" onClick={() => setConfirmClear(false)}>Keep</button>
          </>
        )}
      </div>
    </section>
  );
}
