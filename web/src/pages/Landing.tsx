import { useEffect, useState } from "react";
import { v2, type ConfigV2, type ProgrammeV2 } from "../lib/v2";
import { HUES, near } from "../lib/format";

/** How control flows: the owner never holds a key to the pass account. */
function ControlDiagram({ contract }: { contract: string }) {
  return (
    <div className="diagram" role="img" aria-label="The current owner signs a request to the registry; the registry checks ownership and instructs the keyless pass account, which then acts on other contracts as itself.">
      <svg viewBox="0 0 640 190">
        <rect x="8" y="60" width="150" height="70" rx="10" fill="var(--sunken)" stroke="var(--line)" />
        <text x="83" y="90" textAnchor="middle" fontSize="15" fontWeight="600">Current owner</text>
        <text x="83" y="110" textAnchor="middle" fontSize="11" className="sub">any NEAR wallet</text>

        <rect x="225" y="50" width="180" height="90" rx="10" fill="var(--accent-soft)" stroke="var(--accent)" />
        <text x="315" y="82" textAnchor="middle" fontSize="15" fontWeight="600">Registry</text>
        <text x="315" y="101" textAnchor="middle" fontSize="11" className="sub">{contract}</text>
        <text x="315" y="120" textAnchor="middle" fontSize="11" className="sub">checks owner, locks, records</text>

        <rect x="472" y="18" width="160" height="70" rx="10" fill="var(--surface)" stroke="var(--teal)" strokeWidth="2" />
        <text x="552" y="47" textAnchor="middle" fontSize="15" fontWeight="600">Pass account</text>
        <text x="552" y="67" textAnchor="middle" fontSize="11" className="sub">7.{contract}</text>

        <rect x="472" y="112" width="160" height="62" rx="10" fill="var(--sunken)" stroke="var(--line)" />
        <text x="552" y="139" textAnchor="middle" fontSize="14" fontWeight="600">Any NEAR app</text>
        <text x="552" y="158" textAnchor="middle" fontSize="11" className="sub">tokens, staking, events</text>

        <path d="M158 95 H222" stroke="var(--fg)" strokeWidth="1.5" fill="none" markerEnd="url(#arrow)" />
        <text x="190" y="86" textAnchor="middle" fontSize="10" className="sub">signs</text>
        <path d="M405 80 L469 56" stroke="var(--fg)" strokeWidth="1.5" fill="none" markerEnd="url(#arrow)" />
        <text x="430" y="58" textAnchor="middle" fontSize="10" className="sub">instructs</text>
        <path d="M552 88 V109" stroke="var(--fg)" strokeWidth="1.5" fill="none" markerEnd="url(#arrow)" />
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="var(--fg)" />
          </marker>
        </defs>
      </svg>
    </div>
  );
}

const FEATURES: { title: string; body: string; status: "live" | "planned" }[] = [
  { title: "A real account per pass", body: "Minting pass N creates N.registry with no access keys. It holds NEAR, calls other contracts and shows in any explorer.", status: "live" },
  { title: "Control is ownership", body: "The account obeys only the registry, and the registry only the current owner. A sale moves control in the same receipt. No key to rotate, so none to keep.", status: "live" },
  { title: "Earns from the programme", body: "Part of every ticket goes to a pool shared by every pass. Claims pay real NEAR into the pass accounts. Referrals pay the referring pass's account.", status: "live" },
  { title: "Evolves on chain", body: "Check-ins, achievements and referrals add points. Bronze, Silver, Gold, Platinum are computed by the contract and written into the NFT's metadata.", status: "live" },
  { title: "Safe hand-over", body: "While a withdrawal, call, listing or nft_transfer_call is in flight the pass is locked, so nobody sells it from under a pending payment.", status: "live" },
  { title: "Private companion", body: "Each holder gets an AI companion that reads the pass's live state. Memory is encrypted per holder and per ownership period.", status: "live" },
];

export function LandingPage() {
  const [config, setConfig] = useState<ConfigV2 | null>(null);
  const [programmes, setProgrammes] = useState<ProgrammeV2[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    v2.config().then(setConfig).catch((e) => setErr(String(e.message ?? e)));
    v2.programmes().then(setProgrammes).catch(() => setProgrammes([]));
  }, []);
  const contract = config?.contract ?? "crewpass-v2.testnet";
  const passes = programmes?.reduce((s, p) => s + p.active_passes, 0) ?? 0;
  const revenue = programmes?.reduce((s, p) => s + BigInt(p.ticket_revenue_total) + BigInt(p.funded_total), 0n) ?? 0n;
  const paid = programmes?.reduce((s, p) => s + BigInt(p.claimed_total), 0n) ?? 0n;

  return (
    <>
      <section className="hero">
        <div className="intro">
          <div className="ribbons" aria-hidden="true">{HUES.map((h) => <span key={h} className={`hue-${h}`} />)}</div>
          <h1>Membership passes that own an account</h1>
          <p className="lede">
            Every CrewPass is an NFT with its own NEAR account. The pass earns from its programme, carries its tier and history, and when it is
            sold the buyer takes control of the account in the same transaction. The seller keeps nothing they could use.
          </p>
          <div className="actions">
            <a className="btn" href="#/discover">Browse programmes</a>
            <a className="btn quiet" href="#/creator">Launch a programme</a>
            <a className="btn quiet" href="#/proof">See the proof</a>
          </div>
        </div>
        <ControlDiagram contract={contract} />
      </section>

      {err && <div className="note bad">The V2 registry could not be reached: {err}</div>}
      <section className="stats" aria-label="Live totals from the registry">
        <div className="hue-teal"><span className="label">Programmes</span><strong className="num">{programmes?.length ?? "…"}</strong></div>
        <div className="hue-violet"><span className="label">Passes with accounts</span><strong className="num">{programmes ? passes : "…"}</strong></div>
        <div className="hue-sun"><span className="label">Revenue into pools</span><strong className="num">Ⓝ {near(revenue)}</strong></div>
        <div className="hue-green"><span className="label">Paid into pass accounts</span><strong className="num">Ⓝ {near(paid)}</strong></div>
        <div className="hue-cobalt"><span className="label">Registry books</span><strong>{config ? (config.accounting.solvent ? "Solvent" : "Check!") : "…"}</strong></div>
      </section>

      <section style={{ display: "grid", gap: 16 }}>
        <h2>What a pass does</h2>
        <div className="grid-cards">
          {FEATURES.map((f) => (
            <article key={f.title} className="panel">
              <div className="actions" style={{ justifyContent: "space-between" }}>
                <h3>{f.title}</h3>
                <span className={`status ${f.status}`}>{f.status === "live" ? "On testnet" : "Planned"}</span>
              </div>
              <p className="muted">{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>How to try it</h2>
        <ol className="benefits">
          <li>Connect a NEAR testnet wallet (testnet NEAR is free from the faucet).</li>
          <li>Open a programme on <a href="#/discover">Discover</a> and mint a pass. Its account appears on the pass page with proof that it has no keys.</li>
          <li>Buy an event ticket on <a href="#/events">Events</a>; claim your pass's share on <a href="#/rewards">Rewards</a>.</li>
          <li>Open the <a href="#/members">Members</a> area to talk to your companion. Sell the pass and watch access move to the buyer.</li>
        </ol>
        <p className="muted" style={{ fontSize: "var(--step--1)" }}>
          V1 (vaults inside one contract, <span className="mono">crewpass.testnet</span>) stays live as evidence under <a href="#/v1">V1 archive</a>.
        </p>
      </section>
    </>
  );
}
