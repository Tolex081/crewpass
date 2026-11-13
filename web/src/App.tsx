import { useEffect, useState } from "react";
import { api, type Config } from "./lib/api";
import { v2, type ConfigV2 } from "./lib/v2";
import { shortAccount } from "./lib/format";
import { errorText, useWallet } from "./lib/wallet";
import { LandingPage } from "./pages/Landing";
import { DiscoverPage } from "./pages/Discover";
import { ProgrammePage } from "./pages/Programme";
import { MyPassesPage } from "./pages/MyPasses";
import { PassV2Page } from "./pages/PassV2";
import { EventsPage } from "./pages/Events";
import { RewardsPage } from "./pages/Rewards";
import { MembersV2Page } from "./pages/MembersV2";
import { CreatorPage } from "./pages/Creator";
import { ProofPage } from "./pages/Proof";
import { PassesPage } from "./pages/Passes";
import { PassPage } from "./pages/Pass";
import { MembersPage } from "./pages/Members";
import { ThemeToggle } from "./components/ThemeToggle";

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

const NAV: [string, string][] = [
  ["discover", "Discover"],
  ["my", "My passes"],
  ["events", "Events"],
  ["rewards", "Rewards"],
  ["members", "Members"],
  ["creator", "Creator"],
  ["proof", "Proof"],
];

export function App() {
  const route = useRoute();
  const wallet = useWallet();
  const [config, setConfig] = useState<ConfigV2 | null>(null);
  const [v1config, setV1Config] = useState<Config | null>(null);
  const [configError, setConfigError] = useState("");

  useEffect(() => {
    v2.config().then(setConfig).catch((e) => setConfigError(errorText(e)));
  }, []);
  const isV1 = route.startsWith("#/v1");
  useEffect(() => {
    if (isV1 && !v1config) api.config().then(setV1Config).catch(() => undefined);
  }, [isV1]);

  const parts = route.replace(/^#\/?/, "").split(/[/?]/);
  const [head, arg] = parts;
  const section = isV1 ? "v1" : head === "pass" ? "my" : head === "programme" ? "discover" : head || "home";

  let page;
  if (isV1) {
    const v1pass = route.match(/^#\/v1\/pass\/(\d+)$/);
    page = v1pass ? <PassPage id={v1pass[1]} config={v1config} /> : route.startsWith("#/v1/members") ? <MembersPage /> : <PassesPage config={v1config} />;
  } else if (head === "discover") page = <DiscoverPage />;
  else if (head === "programme" && arg) page = <ProgrammePage id={arg} config={config} />;
  else if (head === "my") page = <MyPassesPage />;
  else if (head === "pass" && arg) page = <PassV2Page id={arg} config={config} />;
  else if (head === "events") page = <EventsPage config={config} />;
  else if (head === "rewards") page = <RewardsPage id={arg} config={config} />;
  else if (head === "members") page = <MembersV2Page />;
  else if (head === "creator") page = <CreatorPage config={config} />;
  else if (head === "proof") page = <ProofPage />;
  else page = <LandingPage />;

  return (
    <>
      <header className="top">
        <div className="wrap">
          <a className="brand" href="#/">Crew<span>Pass</span></a>
          <nav aria-label="Main">
            {NAV.map(([key, label]) => (
              <a key={key} href={`#/${key}`} aria-current={section === key ? "page" : undefined}>{label}</a>
            ))}
          </nav>
          <span className="net">testnet</span>
          <ThemeToggle />
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
          {configError && !isV1 && <div className="note bad">The V2 registry could not be reached: {configError}</div>}
          {isV1 && (
            <div className="note">
              <strong>V1 archive.</strong> These pages use <span className="mono">crewpass.testnet</span>, where vaults are balances inside one
              contract. They stay live as evidence. V2, where every pass owns a real account, is the <a href="#/">main site</a>.{" "}
              <a href="#/v1">Passes</a> · <a href="#/v1/members">Members</a>
            </div>
          )}
          {page}
        </div>
      </main>

      <footer>
        <div className="wrap muted">
          CrewPass V2 runs on NEAR testnet at <span className="mono">{config?.contract ?? "crewpass-v2.testnet"}</span>. Not audited. Testnet NEAR has
          no value. <a href="#/v1">V1 archive</a> · <a href="https://github.com/Tolex081/crewpass" target="_blank" rel="noreferrer">Source</a>
        </div>
      </footer>
    </>
  );
}
