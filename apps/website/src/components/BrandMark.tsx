// The full reDeploy product mark (brand v1.9, iter32 frame): amber corporate frame +
// lime ^^ glyph, verbatim from thesolidchain.com brand/products/tsc-redeploy.svg.
// Lives in the hero — the sticky header intentionally carries only the family mark
// and the ASCII product row (see Topbar.tsx).
export default function BrandMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 120 120" role="img" aria-label="reDeploy logo">
      <path
        fill="#F5A524"
        fillRule="evenodd"
        d="M 107.28 55.23 L 100.12 55.23 A 2.39 2.39 0 0 1 97.73 52.84 L 97.73 51.78 A 17.66 17.66 0 0 0 80.07 34.12 L 39.63 34.12 A 17.66 17.66 0 0 0 21.97 51.78 L 21.97 52.84 A 2.39 2.39 0 0 1 19.58 55.23 L 12.42 55.23 L 12.42 51.78 A 27.21 27.21 0 0 1 39.63 24.57 L 80.07 24.57 A 27.21 27.21 0 0 1 107.28 51.78 L 107.28 55.23 Z M 80.07 95.2 L 39.63 95.2 A 27.21 27.21 0 0 1 12.42 67.99 L 12.42 64.78 L 19.58 64.78 A 2.39 2.39 0 0 1 21.97 67.17 L 21.97 67.99 A 17.66 17.66 0 0 0 39.63 85.65 L 80.07 85.65 A 17.66 17.66 0 0 0 97.73 67.99 L 97.73 67.17 A 2.39 2.39 0 0 1 100.12 64.78 L 107.28 64.78 L 107.28 67.99 A 27.21 27.21 0 0 1 80.07 95.2 Z"
      />
      <g stroke="#D6FF7A" strokeWidth="7.21" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path d="M47 57 L60 45 L73 57" />
        <path d="M47 75 L60 63 L73 75" />
      </g>
    </svg>
  );
}
