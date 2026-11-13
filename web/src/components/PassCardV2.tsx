import type { PassV2 } from "../lib/v2";
import { tierClass } from "../lib/v2";
import { hueFor, near, shortAccount } from "../lib/format";
import { Barcode } from "./PassCard";

/** The V2 laminate: lanyard colour by number, a tier band, and the pass's own NEAR account. */
export function PassCardV2({ pass, programme, balance, big = false, href }: { pass: PassV2; programme?: string; balance?: string | null; big?: boolean; href?: string }) {
  const no = pass.token_id.padStart(2, "0");
  const body = (
    <>
      <div className="pass-head">
        <span className="pass-kind">{programme ?? `Programme ${pass.programme_id}`}</span>
        <span className="pass-no num">#{no}</span>
      </div>
      <div className={`tier-band ${tierClass(pass.tier)}`}>
        <strong>{pass.tier}</strong>
        <span className="num">{pass.points} pts{pass.next_tier ? ` · ${pass.points_to_next_tier} to ${pass.next_tier}` : ""}</span>
      </div>
      <div className="pass-body">
        <div className="holder">
          <span className="label">Holder</span>
          <span className="mono" title={pass.owner_id}>{shortAccount(pass.owner_id)}</span>
        </div>
        <div className="holder">
          <span className="label">Its own account</span>
          <span className="mono" title={pass.account_id}>{pass.account_id}</span>
        </div>
        <dl>
          {balance !== undefined && (
            <>
              <dt>Account balance</dt>
              <dd className="num">{balance === null ? "…" : `Ⓝ ${near(balance)}`}</dd>
            </>
          )}
          <dt>Rewards to claim</dt>
          <dd className="num">Ⓝ {near(pass.rewards_available)}</dd>
          <dt>Referral earnings</dt>
          <dd className="num">Ⓝ {near(pass.referral_earned)}</dd>
        </dl>
        {pass.listing && <span className="chip">For sale · Ⓝ {near(pass.listing.price)}</span>}
        {pass.lock && (
          <span className="chip lock">{pass.lock.kind === "AccountOp" ? "Locked: account operation running" : "Locked: transfer in progress"}</span>
        )}
      </div>
      <Barcode seed={`${pass.token_id}:${pass.owner_id}:${pass.owner_epoch}`} />
    </>
  );
  const cls = `pass hue-${hueFor(pass.token_id)}${big ? " big" : ""}`;
  return href ? (
    <a className={cls} href={href} aria-label={`Pass ${pass.token_id}, ${pass.tier}, held by ${pass.owner_id}`}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}
