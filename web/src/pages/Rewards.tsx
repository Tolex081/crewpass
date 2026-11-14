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
  reward_campaign_created: "Campaign funded",
  campaign_claimed: "Campaign paid to pass account",
  reward_campaign_closed: "Campaign closed",
};
const TIER_NAMES = ["Bronze", "Silver", "Gold", "Platinum"];

export function RewardsPage({ id, config }: { id?: string; config: ConfigV2 | null }) {
  const [programmes, setProgrammes] = useState<ProgrammeV2[]>([]);
  const [selected, setSelected] = useState(id ?? "");
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const load = () => {
    if (selected) v2.rewards(selected, tx.wallet.accountId ?? undefined).then(setData).catch((e) => setErr(errorText(e)));
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
  }, [selected, tx.wallet.accountId]);

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
      {data && data.campaigns.length > 0 && (
        <section className="panel" style={{ display: "grid", gap: 14 }}>
          <h2>Reward campaigns</h2>
          <p className="muted">Each eligible pass can claim once before the campaign expires. The reward always goes to that pass's account.</p>
          {data.campaigns.map((campaign) => {
            const active = !campaign.closed && Date.now() >= Number(campaign.starts_at_ms) && Date.now() < Number(campaign.ends_at_ms) && campaign.claimed < campaign.max_claims;
            return <article key={campaign.id} className="panel">
              <div className="actions" style={{ justifyContent: "space-between" }}>
                <div><h3>{campaign.title}</h3><p className="muted">Ⓝ {near(campaign.reward_per_pass)} per pass · {TIER_NAMES[campaign.min_tier]}+ · {campaign.claimed}/{campaign.max_claims} claimed · Ⓝ {near(campaign.remaining_budget)} reserved</p></div>
                <span className={`status ${active ? "live" : "demo"}`}>{campaign.closed ? "Closed" : active ? "Active" : "Not active"}</span>
              </div>
              {campaign.passes.filter((x) => !x.claimed).map((pass) => {
                const eligible = TIER_NAMES.indexOf(pass.tier) >= campaign.min_tier;
                return <div key={pass.token_id} className="proof-line" style={{ justifyContent: "space-between" }}>
                  <span>Pass #{pass.token_id} · {pass.tier} · {shortAccount(pass.owner_id)} · {pass.claimed ? "claimed" : eligible ? "eligible" : `requires ${TIER_NAMES[campaign.min_tier]}`}</span>
                  <button className="quiet" style={{ padding: "6px 10px" }} disabled={!tx.wallet.accountId || !!tx.busy || !active || !eligible || pass.claimed}
                    onClick={() => tx.run(`campaign-${campaign.id}-${pass.token_id}`, "claim_campaign", { programme_id: data.programme.id, campaign_id: campaign.id, token_id: pass.token_id }, "0", `Ⓝ ${near(campaign.reward_per_pass)} sent to pass #${pass.token_id}'s account.`)}>
                    Claim
                  </button>
                </div>;
              })}
            </article>;
          })}
        </section>
      )}
      {data && data.passes.some((x) => BigInt(x.campaign_owed) > 0n) && (
        <section className="panel">
          <h2>Failed campaign payouts</h2>
          {data.passes.filter((x) => BigInt(x.campaign_owed) > 0n).map((x) => <div key={x.token_id} className="proof-line" style={{ justifyContent: "space-between" }}>
            <span>Pass #{x.token_id}: Ⓝ {near(x.campaign_owed)} still owed to its account</span>
            <button className="quiet" disabled={!tx.wallet.accountId || !!tx.busy} onClick={() => tx.run(`retry-${x.token_id}`, "claim_campaign_owed", { token_id: x.token_id }, "0", `Campaign reward sent to ${x.account_id}.`)}>Retry payout</button>
          </div>)}
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
