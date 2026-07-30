import React, { useEffect, useRef } from 'react';

/**
 * Official Trustpilot "Review Collector" TrustBox.
 *
 * The bootstrap script is loaded ONCE from public/index.html (async). It scans the document
 * for `.trustpilot-widget` elements when it loads — but this is a single-page app, so on any
 * client-side navigation to the homepage the widget element is mounted LONG AFTER that scan
 * has run. Trustpilot's supported answer for exactly this case is to hand it the element:
 * `window.Trustpilot.loadFromElement(el, true)`.
 *
 * Two ordering problems have to be handled, because either one leaves a blank space:
 *   1. Script not ready yet — on a cold load of `/` the async script may still be in flight
 *      when this mounts, so `window.Trustpilot` is undefined. We poll briefly rather than
 *      assume, and give up quietly after a bounded wait instead of polling forever.
 *   2. Script already ran — on client-side navigation the scan is long past, so nothing would
 *      ever render without the explicit call above.
 *
 * Duplicate protection: `loadFromElement`'s second argument is Trustpilot's own force-reload
 * flag, which clears any widget it previously injected into this element before rendering
 * again. Combined with the `initialised` ref (so React 18 StrictMode's double-invoked effect
 * cannot mount it twice in development) a re-render or a route change can never stack two
 * iframes. Unmounting removes the node entirely, so a later visit starts from a clean element.
 *
 * The inner <a> is Trustpilot's prescribed no-JS fallback and stays a real link to the public
 * review page. Nothing here asserts a rating or a review count — the widget renders whatever
 * Trustpilot actually returns.
 */

const POLL_MS = 150;
const GIVE_UP_MS = 10000;

const TrustpilotReviewCollector = () => {
  const boxRef = useRef(null);
  const initialised = useRef(false);

  useEffect(() => {
    let timer = null;

    const init = () => {
      if (initialised.current) return true;          // already rendered — never stack a second
      const el = boxRef.current;
      if (!el) return false;                          // unmounted mid-poll
      const tp = window.Trustpilot;
      if (!tp || typeof tp.loadFromElement !== 'function') return false;  // script still loading
      initialised.current = true;
      tp.loadFromElement(el, true);
      return true;
    };

    if (!init()) {
      let waited = 0;
      timer = setInterval(() => {
        waited += POLL_MS;
        // Stop on success, or once the script has clearly failed to arrive (offline, blocked
        // by a tracker blocker). The fallback link below remains usable either way.
        if (init() || waited >= GIVE_UP_MS) {
          clearInterval(timer);
          timer = null;
        }
      }, POLL_MS);
    }

    return () => { if (timer) clearInterval(timer); };
  }, []);

  return (
    <section className="border-t border-genz-border bg-white/70 backdrop-blur">
      <div className="gz-container py-10">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="type-section-title text-genz-navy mb-2">Reviewed by our customers</h2>
          <p className="text-genz-muted text-[15px] leading-relaxed mb-6">
            We collect feedback through Trustpilot so every review is independent and verified.
            Worked with us? We&apos;d genuinely value your review.
          </p>

          {/* TrustBox widget - Review Collector */}
          <div
            ref={boxRef}
            className="trustpilot-widget"
            data-locale="en-US"
            data-template-id="56278e9abfbbba0bdcd568bc"
            data-businessunit-id="6a6bc396e1d9af34773a806b"
            data-style-height="52px"
            data-style-width="100%"
            data-token="fa947261-4731-4a06-bd89-4d090e35a760"
          >
            <a
              href="https://www.trustpilot.com/review/genzdigitalstore.com"
              target="_blank"
              rel="noopener noreferrer"
            >
              Trustpilot
            </a>
          </div>
          {/* End TrustBox widget */}
        </div>
      </div>
    </section>
  );
};

// No props and no state: memo keeps a parent re-render from touching the subtree Trustpilot
// has replaced with its iframe.
export default React.memo(TrustpilotReviewCollector);
