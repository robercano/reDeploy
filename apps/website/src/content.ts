// Marketing copy for the reDeploy site.
//
// Source of truth: repo-root CLAUDE.md ("What this project is" + package
// descriptions under "Key directories"). Keep this file in sync with that —
// do not claim anything reDeploy does not do today.

export const REPO_URL = "https://github.com/robercano/reDeploy";
// Placeholder — no docs site exists yet. Swap for a real URL once published.
export const DOCS_URL = "https://github.com/robercano/reDeploy#readme";

export const HERO = {
  eyebrow: "Built on Hardhat Ignition",
  headline: "Declarative, idempotent, resumable smart-contract deployments.",
  subhead:
    "reDeploy lets smart-contract teams declaratively define multi-contract deployments — constructor " +
    "args, inter-contract links, ordering — deploy them idempotently and resumably, apply resumable " +
    "post-deployment configuration, verify source and on-chain state, and read deployment state from " +
    "external systems. A visual studio authors and inspects it all.",
  ctaLabel: "View on GitHub",
  ctaHref: REPO_URL,
};

export interface Benefit {
  id: string;
  packageName: string;
  title: string;
  description: string;
}

export const BENEFITS: Benefit[] = [
  {
    id: "idempotent-resumable",
    packageName: "@redeploy/core",
    title: "Idempotent, resumable deployments",
    description:
      "A contract that's already deployed is never re-deployed. Journal-based resume means an " +
      "interrupted multi-contract deployment picks up exactly where it left off.",
  },
  {
    id: "resumable-config",
    packageName: "@redeploy/config",
    title: "Resumable post-deployment configuration",
    description:
      "Declarative configuration steps applied after deployment, with config-state idempotency — " +
      "partial configuration runs resume cleanly instead of re-running steps that already succeeded.",
  },
  {
    id: "verification",
    packageName: "@redeploy/verify",
    title: "Source and on-chain verification",
    description:
      "Verify contract source and bytecode via Etherscan/Sourcify, and assert that live on-chain " +
      "configuration actually matches your declared spec.",
  },
  {
    id: "typed-reader",
    packageName: "@redeploy/reader",
    title: "Typed read-only access for external systems",
    description:
      "A read-only library exposing deployment and configuration state through a typed API, so other " +
      "systems can query what's deployed and how it's configured without touching the deploy path.",
  },
  {
    id: "visual-studio",
    packageName: "@redeploy/studio",
    title: "Visual Studio",
    description:
      "Drag-and-drop authoring of the connection and configuration graph, emitting spec files, plus a " +
      "live deployment inspector — all in one visual tool.",
  },
];

export interface Feature {
  id: string;
  title: string;
  description: string;
  screenshotCaption: string;
}

export const FEATURES: Feature[] = [
  {
    id: "canvas",
    title: "Graph authoring canvas",
    description:
      "Drag contracts onto a canvas, wire constructor arguments and inter-contract links, and let " +
      "reDeploy resolve dependency ordering. The graph is the spec — Studio emits spec files directly " +
      "from what you draw.",
    screenshotCaption: "Studio canvas — drag-and-drop contract graph authoring",
  },
  {
    id: "inspector",
    title: "Deployment inspector",
    description:
      "Load an existing deployment and inspect its live contract graph and configuration state, powered " +
      "by the same typed reader API available to external systems.",
    screenshotCaption: "Deployment inspector — live contract graph and state",
  },
  {
    id: "templates",
    title: "Template gallery",
    description:
      "Start from a built-in or saved template instead of an empty canvas — reusable starting points for " +
      "common multi-contract topologies.",
    screenshotCaption: "Template gallery — start from a reusable deployment template",
  },
  {
    id: "deploy-flow",
    title: "Simulate, then deploy",
    description:
      "Review a deployment plan and simulate it before executing, so you see what would happen before it " +
      "happens on chain.",
    screenshotCaption: "Deploy flow — simulate a plan before executing it",
  },
];

export const FOOTER_LINKS = [
  { label: "GitHub", href: REPO_URL },
  { label: "Docs", href: DOCS_URL },
];
