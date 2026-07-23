import { GRAPH_PANE } from "../content.js";

/** The dependency graph the example spec (SPEC_JSON) compiles to. */
export default function DependencyGraph() {
  return (
    <svg
      viewBox="0 0 380 250"
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: "100%", maxWidth: 420 }}
      role="img"
      aria-label={GRAPH_PANE.svgLabel}
    >
      <defs>
        <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0 L8 4 L0 8 z" fill="#f5a524" />
        </marker>
        <marker id="arrL" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0 L8 4 L0 8 z" fill="#D6FF7A" />
        </marker>
      </defs>
      {/* edges */}
      <path
        d="M118 62 C170 62 190 100 232 116"
        fill="none"
        stroke="#f5a524"
        strokeWidth="1.6"
        markerEnd="url(#arr)"
      />
      <path
        d="M118 190 C170 190 190 152 232 136"
        fill="none"
        stroke="#f5a524"
        strokeWidth="1.6"
        strokeDasharray="5 4"
        markerEnd="url(#arr)"
      />
      <path
        d="M96 176 C140 150 200 84 244 108"
        fill="none"
        stroke="#D6FF7A"
        strokeWidth="1.4"
        strokeDasharray="2 4"
        markerEnd="url(#arrL)"
      />
      {/* nodes */}
      <g fontFamily="ui-monospace,monospace">
        <rect x="18" y="40" width="100" height="44" rx="7" fill="#121008" stroke="#292112" />
        <text x="68" y="59" fill="#f7eed9" fontSize="13" textAnchor="middle" fontWeight="600">
          Token
        </text>
        <text x="68" y="75" fill="#8a7b5c" fontSize="9" textAnchor="middle">
          0x9f1a…c44e ✓
        </text>
        <rect x="18" y="168" width="100" height="44" rx="7" fill="#121008" stroke="#292112" />
        <text x="68" y="187" fill="#f7eed9" fontSize="13" textAnchor="middle" fontWeight="600">
          Registry
        </text>
        <text x="68" y="203" fill="#8a7b5c" fontSize="9" textAnchor="middle">
          0x27b3…08d1 ✓
        </text>
        <rect x="238" y="100" width="118" height="52" rx="7" fill="#121008" stroke="#D6FF7A" />
        <text x="297" y="119" fill="#D6FF7A" fontSize="13" textAnchor="middle" fontWeight="600">
          Vault ^^
        </text>
        <text x="297" y="136" fill="#8a7b5c" fontSize="9" textAnchor="middle">
          CREATE · pending
        </text>
        {/* legend */}
        <text x="20" y="21" fill="#8a7b5c" fontSize="9">
          {GRAPH_PANE.legendTop}
        </text>
        <text x="20" y="240" fill="#8a7b5c" fontSize="9">
          {GRAPH_PANE.legendBottom}
        </text>
      </g>
    </svg>
  );
}
