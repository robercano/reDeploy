import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import App from "../src/App.js";

describe("App", () => {
  it("renders a React Flow canvas", () => {
    render(<App />);
    // React Flow renders a container with class "react-flow"
    const canvas = document.querySelector(".react-flow");
    expect(canvas).not.toBeNull();
  });

  it("renders the React Flow pane", () => {
    render(<App />);
    // React Flow renders a pane element with class "react-flow__pane"
    const pane = document.querySelector(".react-flow__pane");
    expect(pane).not.toBeNull();
  });

  it("renders with empty nodes and edges", () => {
    const { container } = render(<App />);
    // Should render the outer container
    expect(container.firstChild).not.toBeNull();
    // React Flow viewport should be present
    const viewport = document.querySelector(".react-flow__viewport");
    expect(viewport).not.toBeNull();
  });
});
