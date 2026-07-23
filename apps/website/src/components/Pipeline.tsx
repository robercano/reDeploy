import { PIPELINE_HEADING, PIPELINE_NOTE, PIPELINE_STAGES } from "../content.js";
import RichText from "./RichText.js";

export default function Pipeline() {
  return (
    <section id="pipeline">
      <div className="mh">
        <b>{PIPELINE_HEADING.label}</b>
        {PIPELINE_HEADING.rest}
      </div>
      <div className="pipe">
        {PIPELINE_STAGES.map((stage) => (
          <div className="stage" key={stage.id}>
            <span className="num">{stage.num}</span>
            <h3>
              <RichText segments={stage.title} />
            </h3>
            <p>
              <RichText segments={stage.description} />
            </p>
          </div>
        ))}
      </div>
      <p className="pipeNote">
        <RichText segments={PIPELINE_NOTE} />
      </p>
    </section>
  );
}
