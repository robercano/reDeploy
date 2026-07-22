import { GRAPH_PANE, SPEC_JSON, SPEC_PANE, SPLIT_CAPTION } from "../content.js";
import DependencyGraph from "./DependencyGraph.js";
import RichText from "./RichText.js";
import SpecCode from "./SpecCode.js";

/** Split panel: the spec you write (left) ⇄ the dependency graph it compiles to (right). */
export default function SpecGraphSection() {
  return (
    <>
      <div className="split">
        <div className="pane">
          <div className="head">
            <span className="cmd">{SPEC_PANE.command}</span>
            <span>{SPEC_PANE.note}</span>
          </div>
          <SpecCode source={SPEC_JSON} />
        </div>
        <div className="pane">
          <div className="head">
            <span className="cmd">{GRAPH_PANE.command}</span>
            <span>{GRAPH_PANE.note}</span>
          </div>
          <div className="graphPane">
            <DependencyGraph />
          </div>
        </div>
      </div>
      <p className="caption">
        <RichText segments={SPLIT_CAPTION} />
      </p>
    </>
  );
}
