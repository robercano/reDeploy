// Marketing copy & structured content for the reDeploy site (spec ⇄ graph redesign).
//
// Source of truth for narrative claims: repo-root CLAUDE.md ("What this project is" +
// package descriptions under "Key directories"). Keep this file in sync with that —
// do not claim anything reDeploy does not do today.

export const REPO_URL = "https://github.com/robercano/reDeploy";
// No public Studio instance yet — link to the source instead of a live deploy.
export const STUDIO_URL = "https://github.com/robercano/reDeploy/tree/main/apps/studio";

/**
 * A run of rich text. Plain by default; `as` wraps it in an inline element:
 * "code" -> <code>, "em" -> <em>, "b" -> <b>, "hl" -> a lime-highlighted <span>.
 */
export interface RichSegment {
  text: string;
  as?: "code" | "em" | "b" | "hl";
}

export interface NavLink {
  label: string;
  href: string;
}

export const NAV_LINKS: NavLink[] = [
  { label: "pipeline", href: "#pipeline" },
  { label: "studio", href: "#studio" },
  { label: "packages", href: "#packages" },
  { label: "github", href: REPO_URL },
];

// Product row (brand book §08): glyph + bold product name + short context, ahead of the
// site's own nav anchors. Kept short — this is a strip, not the hero subhead.
export const TOPBAR = {
  glyph: "^^",
  tagline: "declarative, idempotent, verifiable deploys",
};

export const HERO = {
  headline: [{ text: "One spec. One graph. " }, { text: "One truth.", as: "hl" }] as RichSegment[],
  subhead: [
    {
      text: "Declare your multi-contract system — args, links, ordering — and reDeploy keeps chain and spec in agreement: ",
    },
    { text: "idempotent deploys", as: "b" },
    { text: ", " },
    { text: "resumable configuration", as: "b" },
    { text: ", " },
    { text: "verified state", as: "b" },
    { text: ". Built on Hardhat Ignition." },
  ] as RichSegment[],
};

export const SPEC_PANE = {
  command: "cat protocol.spec.json",
  note: "what you write",
};

export const GRAPH_PANE = {
  command: "redeploy simulate",
  note: "what it means",
  svgLabel: "Dependency graph: Token and Registry feed Vault; config steps wire Registry to Vault",
  legendTop: "— ref arg    - - after    · · · config wire",
  legendBottom: "2 deployed · 1 planned · 2 config steps pending",
};

// The example spec rendered (and syntax-highlighted) in the left-hand pane. Kept as
// plain text — SpecCode.tsx tokenizes it for display rather than hand-authoring spans.
export const SPEC_JSON = `{
  "contracts": [
    { "id": "Token",    "args": ["Solid", "SLD"] },
    { "id": "Registry" },
    { "id": "Vault",
      "args":  [{"ref": "Token"}, {"param": "feeBps"}],
      "after": ["Registry"] }
  ],
  "config": [
    { "wire": "Registry.register", "with": {"ref": "Vault"} },
    { "grantRole": "KEEPER", "on": "Vault",
      "to": {"read": "Registry.opsAddress"} }
  ]
}`;

export const SPLIT_CAPTION: RichSegment[] = [
  { text: "the spec compiles to a dependency graph; the graph deploys in order; " },
  { text: "re-running changes only what's missing.", as: "hl" },
];

export interface SectionHeading {
  label: string;
  rest: string;
}

export const PIPELINE_HEADING: SectionHeading = {
  label: "THE PIPELINE",
  rest: " — one bar through every link, like the mark says",
};

export const PACKAGES_HEADING: SectionHeading = {
  label: "PACKAGES",
  rest: " — take only what you need",
};

export interface PipelineStage {
  id: string;
  num: string;
  title: RichSegment[];
  description: RichSegment[];
}

export const PIPELINE_STAGES: PipelineStage[] = [
  {
    id: "deploy",
    num: "01 deploy",
    title: [{ text: "Deploy " }, { text: "^^", as: "hl" }],
    description: [
      { text: "Topologically ordered from your " },
      { text: "ref", as: "code" },
      { text: "s and " },
      { text: "after", as: "code" },
      { text: "s. Idempotent by journal: deployed contracts are skipped, interrupted runs resume." },
    ],
  },
  {
    id: "configure",
    num: "02 configure",
    title: [{ text: "Configure" }],
    description: [
      { text: "Roles, wiring, setters as declarative steps — " },
      { text: "set", as: "code" },
      { text: ", " },
      { text: "grantRole", as: "code" },
      { text: ", " },
      { text: "wire", as: "code" },
      { text: " — journaled and resumable, with args " },
      { text: "read", as: "code" },
      { text: " live from deployed contracts." },
    ],
  },
  {
    id: "verify",
    num: "03 verify",
    title: [{ text: "Verify" }],
    description: [
      { text: "Source on Etherscan & Sourcify, then the rarer half: assert the " },
      { text: "live configuration", as: "em" },
      { text: " still matches the spec. Drift is a diff, not an incident." },
    ],
  },
  {
    id: "read",
    num: "04 read",
    title: [{ text: "Read" }],
    description: [
      {
        text: "A typed, read-only view of deployment + config state, with snapshots — one truth for frontends, subgraphs and ops.",
      },
    ],
  },
];

export const PIPELINE_NOTE: RichSegment[] = [
  { text: "every stage is re-runnable at any time — " },
  { text: "the pipeline converges on the spec instead of executing scripts.", as: "hl" },
];

export const STUDIO_SECTION = {
  title: [{ text: "Or skip the JSON. " }, { text: "Draw it.", as: "hl" }] as RichSegment[],
  body: "The reDeploy Studio is a drag-and-drop canvas over the same engine: author contracts and config visually, simulate the plan, deploy for real, and inspect any live deployment — it emits the exact spec files you'd write by hand, so the visual and the textual never fork.",
  ctaPrimary: { label: "launch studio ^^", href: STUDIO_URL },
  ctaSecondary: { label: "view on github", href: REPO_URL },
  screenshotAlt: "reDeploy Studio canvas — drag-and-drop contract graph authoring",
};

export interface Package {
  name: string;
  description: string;
}

export const PACKAGES: Package[] = [
  { name: "@redeploy/core", description: "spec → Ignition module · ordering · idempotent deploys" },
  { name: "@redeploy/config", description: "resumable post-deploy configuration steps" },
  { name: "@redeploy/verify", description: "source verification + on-chain drift detection" },
  { name: "@redeploy/reader", description: "typed read-only state API + snapshots" },
  { name: "@redeploy/studio", description: "visual authoring & inspection" },
];

export interface FamilyLink {
  label: string;
  href?: string;
  current?: boolean;
}

export const FOOTER = {
  promptUser: "roberto@thesolidchain:~$",
  promptRest: "a product of The Solid Chain",
  family: [
    { label: "reCode </>", href: "#" },
    { label: "reDeploy ^^", current: true },
    { label: "reDeFi <=>", href: "#" },
  ] as FamilyLink[],
};
