import { HERO } from "../content.js";

export default function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-headline">
      <p className="hero__eyebrow">{HERO.eyebrow}</p>
      <h1 id="hero-headline" className="hero__headline">
        {HERO.headline}
      </h1>
      <p className="hero__subhead">{HERO.subhead}</p>
      <a className="hero__cta" href={HERO.ctaHref} target="_blank" rel="noreferrer">
        {HERO.ctaLabel}
      </a>
    </section>
  );
}
