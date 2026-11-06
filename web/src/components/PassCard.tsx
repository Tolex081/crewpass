import type { PassInfo } from "../lib/api";
import { near, shortAccount } from "../lib/format";

/** Deterministic bar widths from the pass number and holder, like a printed laminate's code. */
function bars(seed: string): number[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const out: number[] = [];
  for (let i = 0; i < 46; i++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    out.push(1 + ((h >>> 0) % 3));
  }
  return out;
}

export function Barcode({ seed }: { seed: string }) {
  const b = bars(seed);
  return (
    <div className="barcode" aria-hidden="true">
      {b.map((w, i) => (
        <i key={i} style={{ width: `${w}px`, marginRight: `${b[(i + 7) % b.length]}px`, opacity: i % 2 ? 0 : 1 }} />
      ))}
    </div>
  );
}

export function PassCard({ pass, big = false, href }: { pass: PassInfo; big?: boolean; href?: string }) {
  const no = pass.token_id.padStart(2, "0");
  const body = (
    <>
      <div className="pass-head">
        <span className="pass-kind">Ambassador pass</span>
        <span className="pass-no num">#{no}</span>
      </div>
      <div className="pass-body">
        <div className="holder">
          <span className="label">Holder</span>
          <span className="mono" title={pass.owner_id}>{shortAccount(pass.owner_id)}</span>
        </div>
        <dl>
          <dt>Vault</dt>
          <dd className="num">Ⓝ {near(pass.vault)}</dd>
          <dt>Referrals</dt>
          <dd className="num">{pass.stats.referrals}</dd>
          <dt>Earned in total</dt>
          <dd className="num">Ⓝ {near(pass.stats.earned)}</dd>
        </dl>
        {pass.listing && <span className="chip">For sale · Ⓝ {near(pass.listing.price)}</span>}
        {pass.in_transfer_call && <span className="chip lock">Locked: transfer in progress</span>}
      </div>
      <Barcode seed={`${pass.token_id}:${pass.owner_id}`} />
    </>
  );
  const cls = `pass${big ? " big" : ""}`;
  return href ? (
    <a className={cls} href={href} aria-label={`Pass ${pass.token_id}, held by ${pass.owner_id}`}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}
