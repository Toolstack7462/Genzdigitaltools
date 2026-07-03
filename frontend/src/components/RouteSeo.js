import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { SEO_BY_PATH, SITE_ORIGIN } from '../seoConfig';

// Dependency-free per-route SEO: on every public-route change, set a unique <title>, meta description,
// canonical, and OG/Twitter title+description. Purely additive DOM head updates — touches no page
// logic and no tool functionality. Routes not in the config (auth/admin/client, dynamic /blog/:slug)
// are left alone so they keep their own title handling.
function upsertMeta(attr, key, content) {
  if (content == null) return;
  let el = document.head.querySelector(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function upsertCanonical(href) {
  let el = document.head.querySelector('link[rel="canonical"]');
  if (!el) {
    el = document.createElement('link');
    el.setAttribute('rel', 'canonical');
    document.head.appendChild(el);
  }
  el.setAttribute('href', href);
}

export default function RouteSeo() {
  const { pathname } = useLocation();

  useEffect(() => {
    const seo = SEO_BY_PATH[pathname];
    if (!seo) return; // non-marketing / dynamic routes manage their own metadata
    const url = SITE_ORIGIN + (pathname === '/' ? '' : pathname);
    if (seo.title) document.title = seo.title;
    upsertMeta('name', 'description', seo.description);
    upsertMeta('property', 'og:title', seo.title);
    upsertMeta('property', 'og:description', seo.description);
    upsertMeta('property', 'og:url', url);
    upsertMeta('name', 'twitter:title', seo.title);
    upsertMeta('name', 'twitter:description', seo.description);
    upsertCanonical(url);
  }, [pathname]);

  return null;
}
