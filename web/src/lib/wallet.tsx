// Wallet connection through NEAR Connect (@hot-labs/near-connect), testnet only.
import { NearConnector } from "@hot-labs/near-connect";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

const GAS = "300000000000000"; // 300 Tgas

type Wallet = Awaited<ReturnType<NearConnector["wallet"]>>;

interface WalletState {
  accountId: string | null;
  ready: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Call a CrewPass method from the connected account. Deposit in yoctoNEAR. */
  call(contract: string, methodName: string, args: object, deposit: string): Promise<void>;
  signMessage(message: string, recipient: string, nonce: Uint8Array): Promise<{ accountId: string; publicKey: string; signature: string }>;
}

const Ctx = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const connector = useRef<NearConnector | null>(null);
  const wallet = useRef<Wallet | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const c = new NearConnector({ network: "testnet", features: { signMessage: true } });
    connector.current = c;
    c.on("wallet:signIn", async (e) => {
      wallet.current = e.wallet;
      setAccountId(e.accounts[0]?.accountId ?? null);
    });
    c.on("wallet:signOut", () => {
      wallet.current = null;
      setAccountId(null);
    });
    c.getConnectedWallet()
      .then(({ wallet: w, accounts }) => {
        wallet.current = w;
        setAccountId(accounts[0]?.accountId ?? null);
      })
      .catch(() => undefined)
      .finally(() => setReady(true));
  }, []);

  const connect = useCallback(async () => {
    if (!connector.current) return;
    const w = await connector.current.connect();
    wallet.current = w;
    const accounts = await w.getAccounts({ network: "testnet" });
    setAccountId(accounts[0]?.accountId ?? null);
  }, []);

  const disconnect = useCallback(async () => {
    if (connector.current && wallet.current) await connector.current.disconnect(wallet.current);
    wallet.current = null;
    setAccountId(null);
  }, []);

  const call = useCallback(
    async (contract: string, methodName: string, args: object, deposit: string) => {
      if (!wallet.current || !accountId) throw new Error("Connect a wallet first.");
      await wallet.current.signAndSendTransaction({
        network: "testnet",
        signerId: accountId,
        receiverId: contract,
        actions: [{ type: "FunctionCall", params: { methodName, args, gas: GAS, deposit } }],
      });
    },
    [accountId],
  );

  const signMessage = useCallback(
    async (message: string, recipient: string, nonce: Uint8Array) => {
      if (!wallet.current) throw new Error("Connect a wallet first.");
      return wallet.current.signMessage({ message, recipient, nonce, network: "testnet", signerId: accountId ?? undefined });
    },
    [accountId],
  );

  const value = useMemo(() => ({ accountId, ready, connect, disconnect, call, signMessage }), [accountId, ready, connect, disconnect, call, signMessage]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}

/** Turn wallet/chain errors into one readable line. */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
  const panic = raw.match(/Smart contract panicked: ([^"\\}]+)/);
  if (panic) return `The contract refused: ${panic[1]}`;
  if (/reject|cancel|closed/i.test(raw)) return "You cancelled the request in your wallet.";
  return raw.length > 220 ? `${raw.slice(0, 220)}…` : raw;
}
