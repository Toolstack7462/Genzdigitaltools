import {
  DashboardMock, SaaSLandingMock, ToolsPlatformMock, BrandKitMock,
  ExtensionMock, PricingMock, AdminPanelMock, WhatsAppPortalMock,
} from './ShowcaseMocks';

/**
 * Canonical Showcase items — used by the Portfolio page and the
 * Home Featured Work preview. Order matters; first 4 appear on Home.
 */
const SHOWCASE_ITEMS = [
  {
    id: 'client-dashboard-ui',
    title: 'Premium Client Dashboard UI',
    tag: 'Dashboard UI',
    description: 'Multi-tool member dashboard with real-time tool usage chart, assigned-tool grid and secure access indicators.',
    accent: '#06B6D4',
    tags: ['React', 'Tailwind', 'Dashboard', 'UI/UX'],
    Mock: DashboardMock,
    ctaLabel: 'Explore Work',
  },
  {
    id: 'saas-landing',
    title: 'Digital Tools SaaS Landing Page',
    tag: 'SaaS',
    description: 'High-conversion SaaS landing for the Gen Z platform — animated hero, gradient CTAs, feature grid and trust band.',
    accent: '#2563EB',
    tags: ['React', 'Tailwind', 'Marketing', 'Animation'],
    Mock: SaaSLandingMock,
    ctaLabel: 'View Concept',
  },
  {
    id: 'ai-tools-platform',
    title: 'AI Tools Access Platform',
    tag: 'Platform',
    description: 'A unified 90+ tools marketplace — members-only access, category filters, and live tool access status.',
    accent: '#14B8A6',
    tags: ['Full-Stack', 'Access', 'Auth', 'CRM'],
    Mock: ToolsPlatformMock,
    ctaLabel: 'Explore Work',
  },
  {
    id: 'brand-kit',
    title: 'Social Media Brand Kit',
    tag: 'Branding',
    description: 'Complete identity system — Instagram feed concept, brand colour palette, typography pair and template grid.',
    accent: '#0891B2',
    tags: ['Branding', 'Social', 'Design System'],
    Mock: BrandKitMock,
    ctaLabel: 'View Concept',
  },
  {
    id: 'chrome-extension-workflow',
    title: 'Secure Tool Access Flow',
    tag: 'Workflow',
    description: 'A premium member access flow — one-click tool launch, live connection status and a clean, secure experience.',
    accent: '#06B6D4',
    tags: ['UX', 'Security', 'Workflow'],
    Mock: ExtensionMock,
    ctaLabel: 'Explore Work',
  },
  {
    id: 'pricing-design',
    title: 'Pricing / Membership Page Design',
    tag: 'Web Design',
    description: 'Conversion-tuned pricing layout with a glowing recommended tier, branded plan cards and clear feature contrast.',
    accent: '#2563EB',
    tags: ['Conversion', 'UI', 'Pricing'],
    Mock: PricingMock,
    ctaLabel: 'View Concept',
  },
  {
    id: 'admin-panel',
    title: 'Admin Panel Concept',
    tag: 'Web App',
    description: 'Internal admin console — KPI strip, recent activity table, role-aware sidebar and live-status indicators.',
    accent: '#14B8A6',
    tags: ['Admin', 'Tables', 'Permissions'],
    Mock: AdminPanelMock,
    ctaLabel: 'Explore Work',
  },
  {
    id: 'whatsapp-portal',
    title: 'WhatsApp Support / Client Portal Flow',
    tag: 'Client Portal',
    description: 'End-to-end client support journey — WhatsApp first-touch, portal sync, secure access and resolution log.',
    accent: '#10B981',
    tags: ['Support', 'Workflow', 'WhatsApp API'],
    Mock: WhatsAppPortalMock,
    ctaLabel: 'View Concept',
  },
];

export default SHOWCASE_ITEMS;
