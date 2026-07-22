import { NAV_LINKS } from "../content.js";

export default function Topbar() {
  return (
    <div className="topbar">
      <svg className="mark" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path
          fill="#F5A524"
          fillRule="evenodd"
          d="M 107.1 55.23 L 97.58 55.23 L 97.58 51.84 A 17.59 17.59 0 0 0 80.12 34.12 L 39.81 34.12 A 17.7 17.7 0 0 0 22.12 51.84 L 22.12 55.23 L 12.79 55.23 L 12.79 48.6 A 27.21 27.21 0 0 1 38.1 24.68 L 81.75 24.68 A 27.21 27.21 0 0 1 106.99 47.55 L 106.99 55.23 Z M 81.75 95.18 L 38.1 95.18 A 27.21 27.21 0 0 1 12.82 72.3 L 12.82 64.78 L 22.16 64.78 L 22.16 68.02 A 17.58 17.58 0 0 0 39.69 85.65 L 80.04 85.65 A 17.65 17.65 0 0 0 97.72 68.02 L 97.72 64.78 L 107.06 64.78 L 107.06 71.25 A 27.21 27.21 0 0 1 81.75 95.18 Z"
        />
        <g stroke="#D6FF7A" strokeWidth="7.21" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M47 57 L60 45 L73 57" />
          <path d="M47 75 L60 63 L73 75" />
        </g>
      </svg>
      <b>
        <span className="re">re</span>Deploy
      </b>{" "}
      <span className="chev hl">^^</span>
      <nav>
        {NAV_LINKS.map((link) => (
          <a key={link.label} href={link.href}>
            {link.label}
          </a>
        ))}
      </nav>
    </div>
  );
}
