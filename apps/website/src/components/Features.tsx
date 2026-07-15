import { FEATURES } from "../content.js";
import studioCanvas from "../assets/studio-canvas.png";
import studioInspector from "../assets/studio-inspector.png";
import studioTemplates from "../assets/studio-templates.png";
import studioDeployFlow from "../assets/studio-deploy-flow.png";

// Real Studio screenshots (captured from the running @redeploy/studio app),
// keyed by feature.id. See apps/website/src/assets/ for the source PNGs.
const SCREENSHOTS: Record<string, string> = {
  canvas: studioCanvas,
  inspector: studioInspector,
  templates: studioTemplates,
  "deploy-flow": studioDeployFlow,
};

export default function Features() {
  return (
    <section className="features" aria-labelledby="features-heading">
      <h2 id="features-heading">Studio, at a glance</h2>
      <p className="section-lede">
        The visual studio (@redeploy/studio) authors and inspects your deployment graph. The screenshots
        below are real captures of the running app.
      </p>
      <ul className="features__list">
        {FEATURES.map((feature) => (
          <li key={feature.id} className="features__item">
            <div className="features__text">
              <h3>{feature.title}</h3>
              <p>{feature.description}</p>
            </div>
            <figure className="feature-screenshot">
              <div className="feature-screenshot__box">
                <img
                  src={SCREENSHOTS[feature.id]}
                  alt={feature.screenshotCaption}
                  width={1600}
                  height={1000}
                  loading="lazy"
                />
              </div>
              <figcaption className="feature-screenshot__caption">{feature.screenshotCaption}</figcaption>
            </figure>
          </li>
        ))}
      </ul>
    </section>
  );
}
