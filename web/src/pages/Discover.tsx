import { useEffect, useState } from "react";
import { v2, type ProgrammeV2 } from "../lib/v2";
import { near, shortAccount } from "../lib/format";
import { errorText } from "../lib/wallet";

export function DiscoverPage() {
  const [list, setList] = useState<ProgrammeV2[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    v2.programmes().then(setList).catch((e) => setErr(errorText(e)));
  }, []);

  return (
    <>
      <section className="intro">
        <h1>Programmes</h1>
        <p>Every programme here is a record in the registry contract, created by its creator's own transaction. Numbers are read live.</p>
      </section>
      {err && <div className="note bad">{err}</div>}
      {!list && !err && <p className="muted">Reading programmes from the registry…</p>}
      {list && list.length === 0 && (
        <div className="panel">
          <h2>No programmes yet</h2>
          <p className="muted">Be the first: <a href="#/creator">launch a programme</a>.</p>
        </div>
      )}
      <div className="grid-cards">
        {list?.map((p) => (
          <a key={p.id} className="card-link" href={`#/programme/${p.id}`}>
            <article className="panel">
              <span className="label">Programme {p.id} · {p.content?.label ?? "on-chain"}</span>
              <h2>{p.name}</h2>
              <p className="muted">{p.content?.summary ?? p.description}</p>
              <dl className="kv">
                <dt>Mint price</dt><dd>Ⓝ {near(p.mint_price)}</dd>
                <dt>Passes</dt><dd>{p.active_passes}{p.max_supply ? ` of ${p.max_supply}` : ""}</dd>
                <dt>Ticket share to members</dt><dd>{p.member_share_bps / 100}%</dd>
                <dt>Referral</dt><dd>{p.referral_bps / 100}%</dd>
                <dt>Creator</dt><dd>{shortAccount(p.creator)}</dd>
              </dl>
            </article>
          </a>
        ))}
      </div>
    </>
  );
}
