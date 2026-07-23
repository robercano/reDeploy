import studioCanvas from "../assets/studio-canvas.png";
import { STUDIO_SECTION } from "../content.js";
import RichText from "./RichText.js";

export default function Studio() {
  return (
    <section className="studio" id="studio">
      <div>
        <h2>
          <RichText segments={STUDIO_SECTION.title} />
        </h2>
        <p>{STUDIO_SECTION.body}</p>
        <a className="btn" href={STUDIO_SECTION.ctaPrimary.href}>
          {STUDIO_SECTION.ctaPrimary.label}
        </a>
        <a className="btn amber" href={STUDIO_SECTION.ctaSecondary.href}>
          {STUDIO_SECTION.ctaSecondary.label}
        </a>
      </div>
      <div className="shot">
        <img src={studioCanvas} alt={STUDIO_SECTION.screenshotAlt} width={1600} height={1000} loading="lazy" />
      </div>
    </section>
  );
}
