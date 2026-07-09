import { FOOTER_LINKS } from "../content.js";

const currentYear = new Date().getFullYear();

export default function Footer() {
  return (
    <footer className="footer">
      <nav aria-label="Footer links" className="footer__links">
        {FOOTER_LINKS.map((link) => (
          <a key={link.label} href={link.href} target="_blank" rel="noreferrer">
            {link.label}
          </a>
        ))}
      </nav>
      <p className="footer__attribution">
        &copy; {currentYear} reDeploy. Built on{" "}
        <a href="https://hardhat.org/ignition" target="_blank" rel="noreferrer">
          Hardhat Ignition
        </a>
        .
      </p>
    </footer>
  );
}
