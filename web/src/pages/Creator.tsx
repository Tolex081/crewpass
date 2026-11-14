import { useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { v2, type ConfigV2, type ProgrammeContentV2, type ProgrammeV2, type RewardCampaignV2 } from "../lib/v2";
import { near, toYocto } from "../lib/format";
import { useTx } from "../lib/useTx";
import { useSession } from "../lib/session";
import { errorText } from "../lib/wallet";

type Dash = Awaited<ReturnType<typeof v2.creator>>;
const STORAGE = "100000000000000000000000"; // 0.1 NEAR attached for storage; the contract refunds the unused part
const SMALL_STORAGE = "10000000000000000000000"; // 0.01 NEAR for check-ins and achievements, unused part refunded

function bps(percent: string): number {
  const n = Number(percent);
  if (!Number.isFinite(n) || n < 0) throw new Error("Enter a percentage like 10");
  return Math.round(n * 100);
}

function NewProgramme({ contract, onDone }: { contract?: string; onDone: () => void }) {
  const tx = useTx(contract, onDone);
  const [f, setF] = useState({ name: "", description: "", price: "0.1", referral: "10", member: "50", supply: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  function submit() {
    try {
      const args = {
        name: f.name.trim(),
        description: f.description.trim(),
        mint_price: toYocto(f.price),
        referral_bps: bps(f.referral),
        member_share_bps: bps(f.member),
        max_supply: f.supply ? Number(f.supply) : null,
      };
      if (!args.name) throw new Error("Give the programme a name.");
      tx.run("create", "create_programme", args, STORAGE, "Programme created. It now appears on Discover.");
    } catch (e) {
      tx.setMsg({ kind: "bad", text: errorText(e) });
    }
  }
  return (
    <form className="panel" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <h2>Launch a programme</h2>
      <p className="muted">One transaction from your wallet. You become its creator; the rules below are fixed in the contract once created.</p>
      <div className="field"><label className="label" htmlFor="p-name">Name</label><input id="p-name" maxLength={64} value={f.name} onChange={set("name")} placeholder="e.g. Rust Night School" /></div>
      <div className="field"><label className="label" htmlFor="p-desc">Description</label><textarea id="p-desc" maxLength={280} rows={3} value={f.description} onChange={set("description")} /></div>
      <div className="row">
        <div className="field"><label className="label" htmlFor="p-price">Mint price (NEAR, min 0.05)</label><input id="p-price" value={f.price} onChange={set("price")} inputMode="decimal" /></div>
        <div className="field"><label className="label" htmlFor="p-ref">Referral % (max 20)</label><input id="p-ref" value={f.referral} onChange={set("referral")} inputMode="decimal" /></div>
        <div className="field"><label className="label" htmlFor="p-mem">Ticket share to members % (max 80)</label><input id="p-mem" value={f.member} onChange={set("member")} inputMode="decimal" /></div>
        <div className="field"><label className="label" htmlFor="p-sup">Max supply (blank = none)</label><input id="p-sup" value={f.supply} onChange={(e) => setF((x) => ({ ...x, supply: e.target.value.replace(/\D/g, "") }))} inputMode="numeric" /></div>
      </div>
      <button type="submit" disabled={!!tx.busy}>{tx.busy ? "Waiting for your wallet…" : "Create programme"}</button>
      {tx.msg && <div className={`note ${tx.msg.kind}`}>{tx.msg.text}</div>}
    </form>
  );
}

const TIER_NAMES = ["Bronze", "Silver", "Gold", "Platinum"];
const CAMPAIGN_STORAGE_BUFFER = "100000000000000000000000"; // 0.1 NEAR; unused deposit is refunded

function Dashboard({ programme, token, contract, config }: { programme: ProgrammeV2; token: string; contract?: string; config: ConfigV2 | null }) {
  const [d, setD] = useState<Dash | null>(null);
  const [campaigns, setCampaigns] = useState<RewardCampaignV2[]>([]);
  const [contentDraft, setContentDraft] = useState<ProgrammeContentV2 | null>(null);
  const [err, setErr] = useState("");
  const load = () => Promise.all([v2.creator(token, programme.id), v2.rewards(programme.id)]).then(([dashboard, rewardData]) => {
    setD(dashboard);
    setCampaigns(rewardData.campaigns);
    setContentDraft(dashboard.content);
  }).catch((e) => setErr(e instanceof ApiError ? e.message : errorText(e)));
  const tx = useTx(contract, load);
  const [ev, setEv] = useState({ title: "", price: "0.05", capacity: "50", points: "20", starts: "" });
  const [award, setAward] = useState({ token: "", code: "", points: "10" });
  const [fund, setFund] = useState("0.1");
  const [campaign, setCampaign] = useState({ title: "", reward: "0.01", claims: "10", tier: "0", starts: "", ends: "" });
  const defaultContent: ProgrammeContentV2 = {
    label: `Programme ${programme.id}`,
    summary: programme.description,
    companion_name: `${programme.name} companion`,
    companion_tone: "Friendly, concise and practical.",
    benefits: [{ text: "Members area and holder-scoped AI companion", min_tier: 0 }],
    posts: [{ title: `Welcome to ${programme.name}`, body: programme.description, min_tier: 0 }],
    knowledge: [{ title: programme.name, body: programme.description }],
  };
  useEffect(() => {
    load();
  }, [programme.id, token]);

  if (err) return <div className="note bad">{err}</div>;
  if (!d) return <p className="muted">Opening the dashboard (checked against the chain)…</p>;
  const p = d.programme;
  const content = d.content ?? defaultContent;
  const editable = contentDraft ?? content;
  const pending = d.passTickets.filter((t) => !t.checked_in);
  const guard = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      tx.setMsg({ kind: "bad", text: errorText(e) });
    }
  };

  return (
    <section className="panel" style={{ gap: 20 }}>
      <div className="actions" style={{ justifyContent: "space-between" }}>
        <h2>{p.name} · programme {p.id}</h2>
        <a href={`#/programme/${p.id}`}>Public page →</a>
      </div>
      <section className="stats">
        <div className="hue-sun"><span className="label">Treasury</span><strong className="num">Ⓝ {near(p.treasury)}</strong></div>
        <div className="hue-teal"><span className="label">Passes</span><strong className="num">{p.active_passes}</strong></div>
        <div className="hue-violet"><span className="label">Ticket revenue</span><strong className="num">Ⓝ {near(p.ticket_revenue_total)}</strong></div>
        <div className="hue-green"><span className="label">Reserved for passes</span><strong className="num">Ⓝ {near(p.reserved)}</strong></div>
      </section>
      {tx.msg && <div className={`note ${tx.msg.kind}`}>{tx.msg.text}</div>}

      <div className="grid-cards">
        <div className="panel">
          <h3>Treasury</h3>
          <p className="muted">Your share of mints and tickets. Only you can withdraw it, never more than it holds.</p>
          <button disabled={BigInt(p.treasury) === 0n || !!tx.busy} onClick={() => tx.run("wd", "withdraw_treasury", { programme_id: p.id }, "0", `Withdrew Ⓝ ${near(p.treasury)}.`)}>
            Withdraw Ⓝ {near(p.treasury)}
          </button>
        </div>
        <div className="panel">
          <h3>Fund rewards</h3>
          <p className="muted">Split equally between the {p.active_passes} passes now; each holder claims into the pass account.</p>
          <div className="row">
            <div className="field"><label className="label" htmlFor="fund">Amount (NEAR)</label><input id="fund" value={fund} onChange={(e) => setFund(e.target.value)} inputMode="decimal" /></div>
            <button disabled={p.active_passes === 0 || !!tx.busy} onClick={() => guard(() => tx.run("fund", "fund_rewards", { programme_id: p.id }, toYocto(fund), "Rewards distributed to every pass."))}>Fund</button>
          </div>
        </div>
      </div>

      <section className="panel">
        <h3>Reward campaigns</h3>
        <p className="muted">Set a reward per pass, claim cap, minimum tier and expiry. Eligible passes can claim once; unused funds can be reclaimed after expiry.</p>
        <form onSubmit={(e) => {
          e.preventDefault();
          guard(() => {
            const maxClaims = Number(campaign.claims);
            const reward = BigInt(toYocto(campaign.reward));
            if (!campaign.title.trim() || !Number.isInteger(maxClaims) || maxClaims < 1 || maxClaims > 1000) throw new Error("Enter a title and a claim cap from 1 to 1000.");
            const starts = campaign.starts ? new Date(campaign.starts).getTime() : Date.now();
            const ends = campaign.ends ? new Date(campaign.ends).getTime() : starts + 7 * 24 * 60 * 60 * 1000;
            if (!Number.isFinite(starts) || !Number.isFinite(ends) || ends <= starts) throw new Error("Choose an expiry after the start date.");
            const budget = reward * BigInt(maxClaims);
            const storage = BigInt(config?.storage_byte_cost ?? "0") * BigInt(config?.campaign_claim_storage_bytes ?? 512) * BigInt(maxClaims);
            const deposit = (budget + storage + BigInt(CAMPAIGN_STORAGE_BUFFER)).toString();
            tx.run("campaign", "create_reward_campaign", {
              programme_id: p.id, title: campaign.title.trim(), reward_per_pass: reward.toString(), max_claims: maxClaims,
              min_tier: Number(campaign.tier), starts_at_ms: String(starts), ends_at_ms: String(ends),
            }, deposit, "Campaign created and funded.");
          });
        }}>
          <div className="row">
            <div className="field"><label className="label" htmlFor="campaign-title">Campaign title</label><input id="campaign-title" maxLength={80} value={campaign.title} onChange={(e) => setCampaign({ ...campaign, title: e.target.value })} /></div>
            <div className="field"><label className="label" htmlFor="campaign-reward">Reward per pass (NEAR)</label><input id="campaign-reward" value={campaign.reward} onChange={(e) => setCampaign({ ...campaign, reward: e.target.value })} inputMode="decimal" /></div>
            <div className="field"><label className="label" htmlFor="campaign-count">Maximum claims</label><input id="campaign-count" value={campaign.claims} onChange={(e) => setCampaign({ ...campaign, claims: e.target.value.replace(/\D/g, "") })} inputMode="numeric" /></div>
            <div className="field"><label className="label" htmlFor="campaign-tier">Minimum tier</label><select id="campaign-tier" value={campaign.tier} onChange={(e) => setCampaign({ ...campaign, tier: e.target.value })}>{TIER_NAMES.map((name, index) => <option key={name} value={index}>{name}</option>)}</select></div>
          </div>
          <div className="row">
            <div className="field"><label className="label" htmlFor="campaign-start">Starts</label><input id="campaign-start" type="datetime-local" value={campaign.starts} onChange={(e) => setCampaign({ ...campaign, starts: e.target.value })} /></div>
            <div className="field"><label className="label" htmlFor="campaign-end">Expires</label><input id="campaign-end" type="datetime-local" value={campaign.ends} onChange={(e) => setCampaign({ ...campaign, ends: e.target.value })} /></div>
          </div>
          <p className="muted">Funding includes the reward budget and claim storage. The contract returns unused excess to you.</p>
          <button type="submit" disabled={!!tx.busy || !config}>Create campaign</button>
        </form>
        {campaigns.map((x) => <div key={x.id} className="proof-line" style={{ justifyContent: "space-between" }}>
          <span><strong>{x.title}</strong> · {x.claimed}/{x.max_claims} claims · {TIER_NAMES[x.min_tier]}+ · Ⓝ {near(x.remaining_budget)} remaining{x.closed ? " · closed" : ""}</span>
          {!x.closed && (Date.now() >= Number(x.ends_at_ms) || x.claimed === x.max_claims) && <button className="quiet" disabled={!!tx.busy} onClick={() => tx.run(`close-${x.id}`, "close_reward_campaign", { programme_id: p.id, campaign_id: x.id }, "0", "Unused campaign funding returned.")}>Close and reclaim</button>}
        </div>)}
      </section>

      <section className="panel">
        <h3>Member content</h3>
        <p className="muted">Choose the member space name, benefits and posts. Each item can be available to all members or unlocked at a higher pass tier.</p>
        <div className="row">
          <div className="field"><label className="label" htmlFor="content-label">Member space name</label><input id="content-label" maxLength={80} value={editable.label} onChange={(e) => setContentDraft({ ...editable, label: e.target.value })} /></div>
          <div className="field"><label className="label" htmlFor="companion-name">Companion name</label><input id="companion-name" maxLength={64} value={editable.companion_name} onChange={(e) => setContentDraft({ ...editable, companion_name: e.target.value })} /></div>
        </div>
        <div className="field"><label className="label" htmlFor="content-summary">Member space introduction</label><textarea id="content-summary" maxLength={1000} rows={3} value={editable.summary} onChange={(e) => setContentDraft({ ...editable, summary: e.target.value })} /></div>
        <div className="field"><label className="label" htmlFor="companion-tone">Companion style</label><input id="companion-tone" maxLength={280} value={editable.companion_tone} onChange={(e) => setContentDraft({ ...editable, companion_tone: e.target.value })} /></div>

        <h4>Benefits</h4>
        {editable.benefits.map((benefit, index) => <div className="row" key={`benefit-${index}`}>
          <div className="field" style={{ flex: "2 1 240px" }}><label className="label" htmlFor={`benefit-${index}`}>Benefit {index + 1}</label><input id={`benefit-${index}`} maxLength={280} value={benefit.text} onChange={(e) => setContentDraft({ ...editable, benefits: editable.benefits.map((x, i) => i === index ? { ...x, text: e.target.value } : x) })} /></div>
          <div className="field"><label className="label" htmlFor={`benefit-tier-${index}`}>Available from</label><select id={`benefit-tier-${index}`} value={benefit.min_tier} onChange={(e) => setContentDraft({ ...editable, benefits: editable.benefits.map((x, i) => i === index ? { ...x, min_tier: Number(e.target.value) } : x) })}>{TIER_NAMES.map((name, tier) => <option key={name} value={tier}>{name}</option>)}</select></div>
          <button type="button" className="quiet" aria-label={`Remove benefit ${index + 1}`} onClick={() => setContentDraft({ ...editable, benefits: editable.benefits.filter((_, i) => i !== index) })}>Remove</button>
        </div>)}
        <button type="button" className="quiet" disabled={editable.benefits.length >= 20} onClick={() => setContentDraft({ ...editable, benefits: [...editable.benefits, { text: "", min_tier: 0 }] })}>Add a benefit</button>

        <h4>Member posts</h4>
        {editable.posts.map((post, index) => <article className="panel" key={`post-${index}`}>
          <div className="row">
            <div className="field" style={{ flex: "2 1 240px" }}><label className="label" htmlFor={`post-title-${index}`}>Post title</label><input id={`post-title-${index}`} maxLength={120} value={post.title} onChange={(e) => setContentDraft({ ...editable, posts: editable.posts.map((x, i) => i === index ? { ...x, title: e.target.value } : x) })} /></div>
            <div className="field"><label className="label" htmlFor={`post-tier-${index}`}>Available from</label><select id={`post-tier-${index}`} value={post.min_tier} onChange={(e) => setContentDraft({ ...editable, posts: editable.posts.map((x, i) => i === index ? { ...x, min_tier: Number(e.target.value) } : x) })}>{TIER_NAMES.map((name, tier) => <option key={name} value={tier}>{name}</option>)}</select></div>
            <button type="button" className="quiet" aria-label={`Remove post ${index + 1}`} onClick={() => setContentDraft({ ...editable, posts: editable.posts.filter((_, i) => i !== index) })}>Remove</button>
          </div>
          <div className="field"><label className="label" htmlFor={`post-body-${index}`}>Post text</label><textarea id={`post-body-${index}`} maxLength={10000} rows={4} value={post.body} onChange={(e) => setContentDraft({ ...editable, posts: editable.posts.map((x, i) => i === index ? { ...x, body: e.target.value } : x) })} /></div>
        </article>)}
        <button type="button" className="quiet" disabled={editable.posts.length >= 50} onClick={() => setContentDraft({ ...editable, posts: [...editable.posts, { title: "", body: "", min_tier: 0 }] })}>Add a post</button>

        <h4>Companion knowledge</h4>
        {editable.knowledge.map((item, index) => <article className="panel" key={`knowledge-${index}`}>
          <div className="row">
            <div className="field" style={{ flex: "2 1 240px" }}><label className="label" htmlFor={`knowledge-title-${index}`}>Topic</label><input id={`knowledge-title-${index}`} maxLength={120} value={item.title} onChange={(e) => setContentDraft({ ...editable, knowledge: editable.knowledge.map((x, i) => i === index ? { ...x, title: e.target.value } : x) })} /></div>
            <button type="button" className="quiet" aria-label={`Remove knowledge topic ${index + 1}`} onClick={() => setContentDraft({ ...editable, knowledge: editable.knowledge.filter((_, i) => i !== index) })}>Remove</button>
          </div>
          <div className="field"><label className="label" htmlFor={`knowledge-body-${index}`}>What should the companion know?</label><textarea id={`knowledge-body-${index}`} maxLength={4000} rows={3} value={item.body} onChange={(e) => setContentDraft({ ...editable, knowledge: editable.knowledge.map((x, i) => i === index ? { ...x, body: e.target.value } : x) })} /></div>
        </article>)}
        <button type="button" className="quiet" disabled={editable.knowledge.length >= 50} onClick={() => setContentDraft({ ...editable, knowledge: [...editable.knowledge, { title: "", body: "" }] })}>Add a knowledge topic</button>

        <p className="muted">Member posts over a holder’s tier show the title and required tier, but not the post text. The contract caps benefits at 20 and posts and knowledge topics at 50 each.</p>
        <button disabled={!!tx.busy} onClick={() => tx.run("content", "set_programme_content", { programme_id: p.id, content: editable }, STORAGE, "Member content saved on chain.")}>Save member content</button>
      </section>

      <form className="panel" onSubmit={(e) => {
        e.preventDefault();
        guard(() => tx.run("ev", "create_event", {
          programme_id: p.id, title: ev.title.trim(), price: toYocto(ev.price), capacity: Number(ev.capacity), points: Number(ev.points),
          starts_at_ms: ev.starts ? String(new Date(ev.starts).getTime()) : "0",
        }, STORAGE, "Event created."));
      }}>
        <h3>Create an event</h3>
        <div className="row">
          <div className="field" style={{ flex: "2 1 220px" }}><label className="label" htmlFor="e-title">Title</label><input id="e-title" maxLength={80} value={ev.title} onChange={(e) => setEv({ ...ev, title: e.target.value })} /></div>
          <div className="field"><label className="label" htmlFor="e-price">Ticket (NEAR, min 0.02)</label><input id="e-price" value={ev.price} onChange={(e) => setEv({ ...ev, price: e.target.value })} /></div>
          <div className="field"><label className="label" htmlFor="e-cap">Seats</label><input id="e-cap" value={ev.capacity} onChange={(e) => setEv({ ...ev, capacity: e.target.value.replace(/\D/g, "") })} /></div>
          <div className="field"><label className="label" htmlFor="e-pts">Points (max 50)</label><input id="e-pts" value={ev.points} onChange={(e) => setEv({ ...ev, points: e.target.value.replace(/\D/g, "") })} /></div>
          <div className="field"><label className="label" htmlFor="e-start">Starts</label><input id="e-start" type="datetime-local" value={ev.starts} onChange={(e) => setEv({ ...ev, starts: e.target.value })} /></div>
        </div>
        <button type="submit" disabled={!ev.title.trim() || !!tx.busy}>Create event</button>
      </form>

      <div className="panel">
        <h3>Check-ins waiting ({pending.length})</h3>
        <p className="muted">Passes whose holders bought a ticket with the pass attached. Checking in adds the event's points on chain.</p>
        {pending.length === 0 && <p className="muted">Nobody to check in.</p>}
        {pending.map((t) => {
          const e = d.events.find((x) => x.id === t.event_id);
          return (
            <div key={`${t.event_id}-${t.token_id}`} className="actions">
              <span>Pass #{t.token_id} · {e?.title ?? `event ${t.event_id}`} (+{e?.points ?? 0})</span>
              <button className="quiet" style={{ padding: "6px 10px" }} disabled={!!tx.busy}
                onClick={() => tx.run(`ci${t.event_id}-${t.token_id}`, "check_in", { event_id: t.event_id, token_id: t.token_id }, SMALL_STORAGE, `Pass #${t.token_id} checked in.`)}>
                Check in
              </button>
            </div>
          );
        })}
      </div>

      <form className="panel" onSubmit={(e) => {
        e.preventDefault();
        tx.run("aw", "award_achievement", { token_id: award.token, code: award.code.trim(), points: Number(award.points) }, SMALL_STORAGE, `Achievement awarded to pass #${award.token}.`);
      }}>
        <h3>Award an achievement</h3>
        <div className="row">
          <div className="field">
            <label className="label" htmlFor="a-pass">Pass</label>
            <select id="a-pass" value={award.token} onChange={(e) => setAward({ ...award, token: e.target.value })}>
              <option value="">Choose…</option>
              {d.passes.map((x) => <option key={x.token_id} value={x.token_id}>#{x.token_id} · {x.tier} · {x.points} pts</option>)}
            </select>
          </div>
          <div className="field"><label className="label" htmlFor="a-code">Code (unique per pass)</label><input id="a-code" maxLength={32} value={award.code} onChange={(e) => setAward({ ...award, code: e.target.value })} placeholder="first-project" /></div>
          <div className="field"><label className="label" htmlFor="a-pts">Points (1–50)</label><input id="a-pts" value={award.points} onChange={(e) => setAward({ ...award, points: e.target.value.replace(/\D/g, "") })} /></div>
        </div>
        <button type="submit" disabled={!award.token || !award.code.trim() || !!tx.busy}>Award</button>
      </form>
    </section>
  );
}

export function CreatorPage({ config }: { config: ConfigV2 | null }) {
  const session = useSession();
  const [programmes, setProgrammes] = useState<ProgrammeV2[] | null>(null);
  const tx = useTx(config?.contract);
  const load = () => v2.programmes().then(setProgrammes).catch(() => setProgrammes([]));
  useEffect(() => {
    load();
  }, []);
  const mine = programmes?.filter((p) => p.creator === tx.wallet.accountId) ?? [];

  return (
    <>
      <section className="intro">
        <h1>Creator dashboard</h1>
        <p>
          Run your programme: edit member content, schedule tier-based reward campaigns, manage events and check-ins, award achievements,
          fund rewards and withdraw your treasury. Every button is checked by the contract; only the verified creator can open this dashboard.
        </p>
      </section>
      {!tx.wallet.accountId ? (
        <div className="panel" style={{ maxWidth: 520 }}>
          <h2>Connect your wallet</h2>
          <button onClick={() => tx.wallet.connect().catch(() => undefined)}>Connect a testnet wallet</button>
        </div>
      ) : (
        <>
          <NewProgramme contract={config?.contract} onDone={load} />
          {mine.length > 0 && !session.token && (
            <div className="panel" style={{ maxWidth: 600 }}>
              <h2>Open your dashboards</h2>
              <p className="muted">Sign a one-time message (no funds move) so the server can confirm you are the creator.</p>
              <button onClick={session.signIn} disabled={session.busy}>{session.busy ? "Waiting…" : "Sign in"}</button>
              {session.error && <div className="note bad">{session.error}</div>}
            </div>
          )}
          {programmes && mine.length === 0 && <p className="muted">You have not created a programme with this account yet.</p>}
          {session.token && mine.map((p) => <Dashboard key={p.id} programme={p} token={session.token!} contract={config?.contract} config={config} />)}
        </>
      )}
    </>
  );
}
