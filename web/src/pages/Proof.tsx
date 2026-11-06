import { attackRun, liveRun, type ProofRow } from "../proof-data";
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

export function ProofPage() {
  return (
    <>
      <section className="intro">
        <h1>Proof, on chain</h1>
        <p>
          Every row is a real NEAR testnet transaction against <span className="mono">crewpass.testnet</span>. Refused rows show the
          contract's own error.
        </p>
      </section>

      <section style={{ display: "grid", gap: 14 }}>
        <h2>A sale, and the old owner locked out</h2>
        <Table rows={liveRun} />
      </section>

      <section style={{ display: "grid", gap: 14 }}>
        <h2>A hostile contract cannot drain a pass</h2>
        <p className="muted">
          With standard NEP-171, <span className="mono">nft_transfer_call</span> makes the receiving contract the owner before it is asked
          whether it wants the token. CrewPass locks the pass for that whole window. Each attempt below failed, the pass came back, and its
          Ⓝ 0.01 vault was untouched.
        </p>
        <Table rows={attackRun} />
      </section>

      <section className="panel">
        <h2>Check it yourself</h2>
        <p>
          The contract source, threat model and both test suites (36 unit, 6 sandbox) are in the repository. Run{" "}
          <span className="mono">scripts/test.sh</span> to replay every attack on a local NEAR network for free.
        </p>
      </section>
    </>
  );
}
