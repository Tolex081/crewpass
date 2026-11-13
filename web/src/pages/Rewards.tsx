import { useEffect, useState } from "react";
import { v2, type ConfigV2, type ProgrammeV2 } from "../lib/v2";
import { explorerTx, near, shortAccount, when } from "../lib/format";
import { useTx } from "../lib/useTx";
import { errorText } from "../lib/wallet";

type Data = Awaited<ReturnType<typeof v2.rewards>>;

const LABEL: Record<string, string> = {
  revenue_distributed: "Distributed",
  rewards_claimed: "Paid to pass account",
  referral_paid: "Referral paid",
  ticket_purchased: "Ticket sold",
  treasury_withdrawn: "Creator withdrew",
};

export function RewardsPage({ id, config }: { id?: string; config: ConfigV2 | null }) {
  const [programmes, setProgrammes] = useState<ProgrammeV2[]>([]);
  const [selected, setSelected] = useState(id ?? "");
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const load = () => {
    if (selected) v2.rewards(selected).then(setData).catch((e) => setErr(errorText(e)));
  };
  const tx = useTx(config?.contract, load);
  useEffect(() => {
    v2.programmes().then((l) => {
      setProgrammes(l);
      if (!selected && l[0]) setSelected(String(l[0].id));
    }).catch((e) => setErr(errorText(e)));
  }, []);
  useEffect(() => {
    setData(null);
    load();
  }, [selected]);

  const p = data?.programme;
  return (
    <>
      <section className="intro">
        <h1>Rewards</h1>
        <p>
          Where every unit of programme revenue went. Each distribution splits an amount equally between the passes that exist at that moment;
          a remainder that does not divide evenly is carried to the next one. Claims pay into the pass's own account, never a person.
        </p>
      </section>
      {programmes.length > 1 && (
        <div className="field" style={{ maxWidth: 320 }}>
          <label className="label" htmlFor="prog">Programme</label>
          <select id="prog" value={selected} onChange={(e) => setSelected(e.target.value)}>
            {programmes.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </div>
      )}
      {err && <div className="note bad">{err}</div>}
      {p && (
        <section className="stats">
          <div className="hue-sun"><span className="label">Ticket revenue</span><strong className="num">Ⓝ {near(p.ticket_revenue_total)}</strong></div>
          <div className="hue-violet"><span className="label">Creator-funded</span><strong className="num">Ⓝ {near(p.funded_total)}</strong></div>
          <div className="hue-teal"><span className="label">Credited to passes</span><strong className="num">Ⓝ {near(p.distributed_total)}</strong></div>
          <div className="hue-green"><span className="label">Paid into accounts</span><strong className="num">Ⓝ {near(p.claimed_total)}</strong></div>
          <div className="hue-cobalt"><span className="label">Reserved (unclaimed)</span><strong className="num">Ⓝ {near(p.reserved)}</strong></div>
          <div className="hue-coral"><span className="label">Carried remainder</span><strong className="num">{p.carry} yocto</strong></div>
        </section>
      )}
      {data && (
        <section className="table-scroll">
          <table>
            <thead><tr><th>Pass</th><th>Account</th><th>Waiting</th><th>Paid so far</th><th>Referrals</th><th></th></tr></thead>
            <tbody>
              {data.passes.map((x) => (
                <tr key={x.token_id}>
                  <td><a href={`#/pass/${x.token_id}`}>#{x.token_id}</a></td>
                  <td className="mono">{x.account_id}</td>
                  <td className="num">Ⓝ {near(x.rewards_available)}</td>
                  <td className="num">Ⓝ {near(x.rewards_claimed)}</td>
                  <td className="num">Ⓝ {near(x.referral_earned)}</td>
                  <td>
                    <button
                      className="quiet"
                      style={{ padding: "6px 10px" }}
                      disabled={!tx.wallet.accountId || BigInt(x.rewards_available) === 0n || !!tx.busy}
                      onClick={() => tx.run(x.token_id, "claim_rewards", { token_id: x.token_id }, "0", `Paid into ${x.account_id}.`)}
                    >
                      {tx.busy === x.token_id ? "…" : "Claim"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {tx.msg && <div className={`note ${tx.msg.kind}`}>{tx.msg.text}</div>}
      {data && (
        <section className="panel">
          <div className="actions" style={{ justifyContent: "space-between" }}>
            <h2>Every movement</h2>
            <span className={`status ${data.history.complete ? "live" : "demo"}`}>{data.history.complete ? "Complete history" : "Incomplete history"}</span>
          </div>
          <ol className="timeline">
            {data.history.events.map((e, i) => {
              const d = e.data as Record<string, string>;
              return (
                <li key={`${e.txHash}-${i}`} className="hue-sun">
                  <time>{when(e.timestampMs)}</time>
                  <span className="tag">{LABEL[e.event] ?? e.event}</span>
                  <span className="what">
                    {e.event === "revenue_distributed"
                      ? <>Ⓝ {near(d.amount)} from {d.source}: Ⓝ {near(d.per_pass ?? "0")} to each of {d.passes} passes</>
                      : e.event === "ticket_purchased"
                        ? <>Event {d.event_id} ticket by <span className="mono">{shortAccount(d.buyer)}</span>: Ⓝ {near(d.member_share)} to members, Ⓝ {near(d.treasury_share)} to treasury</>
                        : e.event === "treasury_withdrawn"
                          ? <>Ⓝ {near(d.amount)} to <span className="mono">{shortAccount(d.to)}</span></>
                          : <>Ⓝ {near(d.amount)} into <span className="mono">{d.account_id}</span></>}
                  </span>
                  <a className="mono" href={explorerTx(e.txHash)} target="_blank" rel="noreferrer">{e.txHash.slice(0, 8)}…</a>
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </>
  );
}
