import { HERO } from "../content.js";
import BrandMark from "./BrandMark.js";
import RichText from "./RichText.js";

export default function Hero() {
  return (
    <div className="heroText">
      <BrandMark className="heroMark" />
      <h1>
        <RichText segments={HERO.headline} />
      </h1>
      <p>
        <RichText segments={HERO.subhead} />
      </p>
    </div>
  );
}
