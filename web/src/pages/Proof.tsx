import { attackRun, liveRun, type ProofRow } from "../proof-data";
import { v2Run, v2RunAt } from "../proof-data-v2";
import { explorerAccount } from "../lib/format";
import { explorerTx } from "../lib/format";

function Table({ rows }: { rows: ProofRow[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Who</th>
            <th scope="col">What they tried</th>
            <th scope="col">Outcome</th>
            <th scope="col">Transaction</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.tx}>
              <td>{r.who}</td>
              <td>{r.action}</td>
              <td>
                <span className={`outcome ${r.outcome}`}>{r.outcome === "ok" ? "Done" : "Refused"}</span>
                {r.detail && <div className="mono muted" style={{ fontSize: "var(--step--1)" }}>{r.detail}</div>}
              </td>
              <td>
                <a className="mono" href={explorerTx(r.tx)} target="_blank" rel="noreferrer">{r.tx.slice(0, 10)}…</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Test counts from the last full runs (scripts/test.sh, scripts/test-v2.sh, npm test in web/). */
export const TESTS = { v2Unit: 73, v2Sandbox: 11, web: 46, v1Unit: 36, v1Sandbox: 6 };

const CONTRACTS = [
  { what: "V2 registry (NEP-171, 177, 181, 297)", id: "crewpass-v2.testnet", note: "wasm sha256 72a927f5…db47e05 (2026-11-14 upgrade)" },
  { what: "Pass-account code (global contract, by hash)", id: "CuX7PYtWMa9ZG18jkHGTYKutgQVQoKNWiQSFvmmzEzRL", note: "wasm sha256 b0e4cdcd…a921f, 43.6 KB, immutable" },
  { what: "Pass #1's own account", id: "1.crewpass-v2.testnet", note: "no access keys; created at mint" },
  { what: "Test-only target / hostile receiver", id: "crewpass-v2-target.testnet", note: "never part of the product" },
  { what: "V1 contract (archive)", id: "crewpass.testnet", note: "unchanged since 2026-11-06" },
];

export function ProofPage() {
  const ok = v2Run.filter((r) => r.outcome === "ok").length;
  return (
    <>
      <section className="intro">
        <h1>Proof, on chain</h1>
        <p>
          Every row is a real NEAR testnet transaction with an explorer link. Refused rows show the contract's own error. Nothing on this page
          is simulated.
        </p>
      </section>

      <section className="table-scroll">
        <table>
          <thead><tr><th>What</th><th>Account or hash</th><th>Note</th></tr></thead>
          <tbody>
            {CONTRACTS.map((c) => (
              <tr key={c.id}>
                <td>{c.what}</td>
                <td className="mono">{c.id.includes(".") ? <a href={explorerAccount(c.id)} target="_blank" rel="noreferrer">{c.id}</a> : c.id}</td>
                <td className="muted">{c.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="stats" aria-label="Automated tests">
        <div className="hue-teal"><span className="label">V2 contract unit tests</span><strong className="num">{TESTS.v2Unit}</strong></div>
        <div className="hue-violet"><span className="label">V2 sandbox tests</span><strong className="num">{TESTS.v2Sandbox}</strong></div>
        <div className="hue-cobalt"><span className="label">Web server tests</span><strong className="num">{TESTS.web}</strong></div>
        <div className="hue-sun"><span className="label">V1 unit + sandbox</span><strong className="num">{TESTS.v1Unit} + {TESTS.v1Sandbox}</strong></div>
      </section>

      <section style={{ display: "grid", gap: 14 }}>
        <h2>V2: the whole journey, live</h2>
        <p className="muted">
          Run {v2RunAt} by <span className="mono">deploy/v2-live-run.sh</span>: {v2Run.length} transactions, {ok} done and {v2Run.length - ok} refused,
          every one as expected. A programme launches; Alice's pass gets its own keyless account; referral and ticket revenue land in that
          account; the pass reaches Gold; Carol buys it and takes control; every route Alice tries afterwards is refused; Carol uses the account;
          a hostile receiver fails.
        </p>
        <Table rows={v2Run} />
      </section>

      <section style={{ display: "grid", gap: 14 }}>
        <h2>V1 archive: a sale, and the old owner locked out</h2>
        <Table rows={liveRun} />
      </section>

      <section style={{ display: "grid", gap: 14 }}>
        <h2>V1 archive: a hostile contract cannot drain a pass</h2>
        <Table rows={attackRun} />
      </section>

      <section className="panel">
        <h2>Check it yourself</h2>
        <p>
          Source, threat model, architecture decision and every test are in the repository. <span className="mono">scripts/test-v2.sh</span> runs
          the V2 unit and sandbox tests (a real local NEAR node with the pass-account code published as a global contract) for free.
        </p>
      </section>
    </>
  );
}
