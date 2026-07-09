interface ScreenshotPlaceholderProps {
  caption: string;
}

/**
 * Clearly-marked stand-in for a real Studio screenshot.
 *
 * Capturing real screenshots requires a running Studio + deploy-server stack
 * and a browser automation tool (Playwright), neither of which is available
 * in this build environment. This placeholder is sized/positioned like the
 * real asset will be, so swapping it in later (see follow-up issue) is a
 * drop-in replacement rather than a layout change.
 */
export default function ScreenshotPlaceholder({ caption }: ScreenshotPlaceholderProps) {
  return (
    <figure className="screenshot-placeholder">
      <div className="screenshot-placeholder__box" role="img" aria-label={`Placeholder: ${caption}`}>
        <span className="screenshot-placeholder__badge">Placeholder — Studio screenshot</span>
      </div>
      <figcaption className="screenshot-placeholder__caption">{caption}</figcaption>
    </figure>
  );
}
