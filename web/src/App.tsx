import { useEffect, useState } from "react";
import { api, type Config } from "./lib/api";
import { shortAccount } from "./lib/format";
import { errorText, useWallet } from "./lib/wallet";
import { PassesPage } from "./pages/Passes";
import { PassPage } from "./pages/Pass";
import { MembersPage } from "./pages/Members";
import { ProofPage } from "./pages/Proof";

function useRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash || "#/");
  useEffect(() => {
    const on = () => {
      setHash(window.location.hash || "#/");
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export function App() {
  const route = useRoute();
  const wallet = useWallet();
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState("");

  useEffect(() => {
    api.config().then(setConfig).catch((e) => setConfigError(errorText(e)));
  }, []);

  const passMatch = route.match(/^#\/pass\/(\d+)$/);
  const section = passMatch ? "passes" : route.startsWith("#/members") ? "members" : route.startsWith("#/proof") ? "proof" : "passes";

  return (
    <>
      <header className="top">
        <div className="wrap">
          <a className="brand" href="#/">Crew<span>Pass</span></a>
          <nav aria-label="Main">
            <a href="#/" aria-current={section === "passes" ? "page" : undefined}>Passes</a>
            <a href="#/members" aria-current={section === "members" ? "page" : undefined}>Members</a>
            <a href="#/proof" aria-current={section === "proof" ? "page" : undefined}>Proof</a>
          </nav>
          <span className="net">testnet</span>
          {wallet.accountId ? (
            <button className="quiet" onClick={() => wallet.disconnect()} title="Disconnect wallet">
              <span className="mono">{shortAccount(wallet.accountId)}</span>
            </button>
          ) : (
            <button className="quiet" onClick={() => wallet.connect().catch(() => undefined)} disabled={!wallet.ready}>
              Connect wallet
            </button>
          )}
        </div>
      </header>

      <main>
        <div className="wrap">
          {configError && <div className="note bad">The contract could not be reached: {configError}</div>}
          {passMatch ? (
            <PassPage id={passMatch[1]} config={config} />
          ) : section === "members" ? (
            <MembersPage />
          ) : section === "proof" ? (
            <ProofPage />
          ) : (
            <PassesPage config={config} />
          )}
        </div>
      </main>

      <footer>
        <div className="wrap muted">
          CrewPass runs on NEAR testnet at <span className="mono">{config?.contract ?? "crewpass.testnet"}</span>. Not audited. Testnet NEAR has no value.
        </div>
      </footer>
    </>
  );
}
