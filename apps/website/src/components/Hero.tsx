import { HERO } from "../content.js";
import RichText from "./RichText.js";

export default function Hero() {
  return (
    <div className="heroText">
      <h1>
        <RichText segments={HERO.headline} />
      </h1>
      <p>
        <RichText segments={HERO.subhead} />
      </p>
    </div>
  );
}
