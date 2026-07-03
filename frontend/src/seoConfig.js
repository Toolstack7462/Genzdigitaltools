// Per-route SEO metadata for the PUBLIC pages. Applied at runtime by components/RouteSeo.js
// (dependency-free — no react-helmet). Only public marketing routes are listed; auth/admin/client
// routes are intentionally omitted (they set their own titles / are noindex via robots.txt).
export const SITE_ORIGIN = 'https://genzdigitalstore.com';
const BRAND = 'Gen Z Digital Store';

export const SEO_BY_PATH = {
  '/': {
    title: `${BRAND} | All-in-One AI & Digital Tools Hub`,
    description: 'Access AI, academic, SEO, design, productivity, marketing, and business tools from one secure Gen Z Digital Store dashboard.',
  },
  '/services': {
    title: `Services — AI Tools, Web, Writing, SEO & Branding | ${BRAND}`,
    description: 'Explore Gen Z Digital Store services: premium digital tools, web design, writing, social media, app development, branding, and SEO growth.',
  },
  '/services/digital-tools': {
    title: `Premium Digital & AI Tools | ${BRAND}`,
    description: 'One secure dashboard for premium AI, SEO, academic, productivity, and business tools — shared safely without exposing logins.',
  },
  '/services/social-media-management': {
    title: `Social Media Management | ${BRAND}`,
    description: 'Grow your brand with managed content, scheduling, and engagement across every major social platform.',
  },
  '/services/writing-services': {
    title: `Writing & Content Services | ${BRAND}`,
    description: 'Human-quality, undetectable writing — articles, essays, copy, and content that ranks and converts.',
  },
  '/services/web-design-development': {
    title: `Web Design & Development | ${BRAND}`,
    description: 'Animated, SEO-ready websites, dashboards, and web apps built for speed, conversion, and scale.',
  },
  '/services/app-development': {
    title: `App Development | ${BRAND}`,
    description: 'Custom mobile and web app development — from idea to launch, built to perform.',
  },
  '/services/branding-design': {
    title: `Branding & Design | ${BRAND}`,
    description: 'Logos, identity systems, and visual design that make your brand memorable and premium.',
  },
  '/services/seo-digital-growth': {
    title: `SEO & Digital Growth | ${BRAND}`,
    description: 'Technical SEO, content strategy, and growth marketing to rank higher and win more customers.',
  },
  '/portfolio': {
    title: `Portfolio | ${BRAND}`,
    description: 'A selection of websites, brands, and digital work delivered by Gen Z Digital Store.',
  },
  '/pricing': {
    title: `Pricing & Plans | ${BRAND}`,
    description: 'Simple, transparent pricing for premium tools and digital services. Find the plan that fits.',
  },
  '/about': {
    title: `About Us | ${BRAND}`,
    description: 'Who we are and why we built a secure, all-in-one hub for premium AI and digital tools.',
  },
  '/contact': {
    title: `Contact Us | ${BRAND}`,
    description: 'Questions or a project in mind? Get in touch with the Gen Z Digital Store team.',
  },
  '/blog': {
    title: `Blog | ${BRAND}`,
    description: 'Guides, tips, and updates on AI tools, SEO, productivity, and digital growth.',
  },
  '/tools': {
    title: `Tools Catalog | ${BRAND}`,
    description: 'Browse the full catalog of AI, SEO, academic, and productivity tools available on Gen Z Digital Store.',
  },
  '/login': {
    title: `Sign In | ${BRAND}`,
    description: 'Sign in to your Gen Z Digital Store account to access your tools and dashboard.',
  },
  '/join': {
    title: `Get Started | ${BRAND}`,
    description: 'Create your Gen Z Digital Store account and unlock premium AI and digital tools.',
  },
};
