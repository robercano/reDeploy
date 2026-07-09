import { FEATURES } from "../content.js";
import ScreenshotPlaceholder from "./ScreenshotPlaceholder.js";

export default function Features() {
  return (
    <section className="features" aria-labelledby="features-heading">
      <h2 id="features-heading">Studio, at a glance</h2>
      <p className="section-lede">
        The visual studio (@redeploy/studio) authors and inspects your deployment graph. Screenshots below
        are placeholders — see caption on each for what the real capture will show.
      </p>
      <ul className="features__list">
        {FEATURES.map((feature) => (
          <li key={feature.id} className="features__item">
            <div className="features__text">
              <h3>{feature.title}</h3>
              <p>{feature.description}</p>
            </div>
            <ScreenshotPlaceholder caption={feature.screenshotCaption} />
          </li>
        ))}
      </ul>
    </section>
  );
}
