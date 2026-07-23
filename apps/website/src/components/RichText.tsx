import { Fragment } from "react";
import type { RichSegment } from "../content.js";

/** Renders an array of RichSegment as inline nodes: code/em/b elements or a lime `<span>`. */
export default function RichText({ segments }: { segments: RichSegment[] }) {
  return (
    <>
      {segments.map((seg, i) => {
        switch (seg.as) {
          case "code":
            return <code key={i}>{seg.text}</code>;
          case "em":
            return <em key={i}>{seg.text}</em>;
          case "b":
            return <b key={i}>{seg.text}</b>;
          case "hl":
            return (
              <span key={i} className="hl">
                {seg.text}
              </span>
            );
          default:
            return <Fragment key={i}>{seg.text}</Fragment>;
        }
      })}
    </>
  );
}
