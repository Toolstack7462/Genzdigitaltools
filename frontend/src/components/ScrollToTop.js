import { useEffect } from 'react';
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
 * Behavior is instant ("auto") by design — a smooth animation across a long
 * page feels slow when it fires on every navigation.
 */
const ScrollToTop = () => {
  const { pathname } = useLocation();

  useEffect(() => {
    const behavior = 'auto';

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
