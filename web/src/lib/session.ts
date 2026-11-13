// One NEP-413 sign-in for the whole site (members area, events, creator dashboard). The session only
// proves who you are; every access decision is still made from the chain on each request.
import { useCallback, useState } from "react";
import { api } from "./api";
import { errorText, useWallet } from "./wallet";

const KEY = "crewpass.session";

function saved(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}
function save(t: string | null) {
  try {
    if (t) sessionStorage.setItem(KEY, t);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the session lasts until the tab reloads */
  }
}

export function useSession() {
  const wallet = useWallet();
  const [token, setToken] = useState<string | null>(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const signIn = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const c = await api.challenge();
      const nonce = Uint8Array.from(atob(c.nonce), (ch) => ch.charCodeAt(0));
      const signed = await wallet.signMessage(c.message, c.recipient, nonce);
      const t = await api.session({ accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: c.nonce });
      save(t);
      setToken(t);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }, [wallet]);

  const signOut = useCallback(() => {
    save(null);
    setToken(null);
  }, []);

  return { token, busy, error, signIn, signOut, setError };
}
