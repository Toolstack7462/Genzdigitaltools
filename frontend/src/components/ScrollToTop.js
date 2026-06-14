import { useLayoutEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Global scroll-to-top on route change.
 *
 * Public pages scroll on the window, but the client portal and admin panel
 * render their content inside a custom scroll container
 * (`<main className="app-main overflow-y-auto">`). Resetting only `window`
 * would leave those panels stuck at the previous scroll position, so we reset
 * the window AND every known scroll container on each pathname change.
 *
 * The jump is instant by design — a smooth animation across a long page feels
 * slow when it fires on every navigation.
 */
const ScrollToTop = () => {
  const { pathname } = useLocation();

  // useLayoutEffect (not useEffect) so the reset runs after the new route's DOM
  // is committed but BEFORE the browser paints — otherwise a heavy page paints
  // once at the inherited scroll position and visibly jumps to the top a few
  // hundred ms later.
  useLayoutEffect(() => {
    // Force a non-animated jump. NOTE: 'auto' is NOT instant — per the CSSOM
    // spec it defers to the element's CSS `scroll-behavior`, and this app sets
    // `html { scroll-behavior: smooth }`, which would make the window glide to
    // the top over ~0.5s (the page appears to open partway down, then scroll
    // up). 'instant' overrides that and jumps immediately.
    const behavior = 'instant';

    // 1. Window / document scroll (public marketing site).
    window.scrollTo({ top: 0, left: 0, behavior });
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;

    // 2. Custom scroll containers (client portal + admin panel shells).
    //    `[data-scroll-container]` is an explicit opt-in hook for any future
    //    layout that scrolls inside a nested element.
    document
      .querySelectorAll('.app-main, [data-scroll-container]')
      .forEach((el) => {
        if (typeof el.scrollTo === 'function') {
          el.scrollTo({ top: 0, left: 0, behavior });
        } else {
          el.scrollTop = 0;
          el.scrollLeft = 0;
        }
      });
    // Only react to pathname changes — not query string / hash — so in-page
    // filters and anchor links don't get yanked back to the top.
  }, [pathname]);

  return null;
};

export default ScrollToTop;
