import { PACKAGES, PACKAGES_HEADING } from "../content.js";

export default function Packages() {
  return (
    <section id="packages">
      <div className="mh">
        <b>{PACKAGES_HEADING.label}</b>
        {PACKAGES_HEADING.rest}
      </div>
      <div className="pkgs">
        {PACKAGES.map((pkg) => (
          <div className="pkg" key={pkg.name}>
            <div className="n">{pkg.name}</div>
            <div className="d">{pkg.description}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
