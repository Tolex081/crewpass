import { useState } from "react";
import { errorText, useWallet } from "./wallet";

/** Send one registry transaction from the connected wallet, with busy and result state. */
export function useTx(contract: string | undefined, after?: () => unknown) {
  const wallet = useWallet();
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  async function run(label: string, method: string, args: object, deposit: string, done: string) {
    if (!contract) {
      setMsg({ kind: "bad", text: "The V2 contract is not reachable right now." });
      return false;
    }
    setBusy(label);
    setMsg(null);
    try {
      await wallet.call(contract, method, args, deposit);
      setMsg({ kind: "ok", text: done });
      await after?.();
      return true;
    } catch (e) {
      setMsg({ kind: "bad", text: errorText(e) });
      return false;
    } finally {
      setBusy("");
    }
  }

  return { run, busy, msg, setMsg, wallet };
}
