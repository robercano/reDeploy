import { render, screen } from "@testing-library/react";
import ScreenshotPlaceholder from "../src/components/ScreenshotPlaceholder.js";

describe("ScreenshotPlaceholder", () => {
  it("shows the placeholder badge and the intended caption", () => {
    render(<ScreenshotPlaceholder caption="Studio canvas — drag-and-drop contract graph authoring" />);

    expect(screen.getByText("Placeholder — Studio screenshot")).toBeInTheDocument();
    expect(
      screen.getByText("Studio canvas — drag-and-drop contract graph authoring"),
    ).toBeInTheDocument();
  });
});
