import { FOOTER } from "../content.js";

export default function Footer() {
  return (
    <footer>
      <span>
        <span className="prompt">{FOOTER.promptUser}</span> {FOOTER.promptRest}
      </span>
      <span className="fam">
        family:{" "}
        {FOOTER.family.map((link, i) => (
          <span key={link.label}>
            {i > 0 ? " · " : ""}
            {link.current ? <span className="cur">{link.label}</span> : <a href={link.href}>{link.label}</a>}
          </span>
        ))}
      </span>
    </footer>
  );
}
