import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import "@/App.css";

// ── Domain routing guard ─────────────────────────────────────────────────
// Main domain (genzdigitalstore.com)  → public marketing site only.
//   App-only paths (/login, /client/*, /admin/*) are bounced to the app subdomain.
// App subdomain (app.genzdigitalstore.com) → portal/dashboard only.
//   Public marketing paths are bounced to the client login.
// Both directions skip API/static assets and guard against redirect loops.
(function domainGuard() {
  const MAIN_HOSTS = ['genzdigitalstore.com', 'www.genzdigitalstore.com'];
  const APP_HOST   = 'app.genzdigitalstore.com';
  const host = window.location.hostname;
  const path = window.location.pathname;
  const search = window.location.search;

  // Never touch API calls, build assets, or static files (any path with a file extension).
  const isInfraPath = (p) =>
    p.startsWith('/api/') ||
    p.startsWith('/_next/') ||
    p.startsWith('/static/') ||
    p.startsWith('/assets/') ||
    p.startsWith('/images/') ||
    /\.[a-zA-Z0-9]+$/.test(p); // e.g. .js .css .png .svg .ico .json .map
  if (isInfraPath(path)) return;

  const isAppPath = (p) =>
    p === '/login' || p.startsWith('/client') || p.startsWith('/admin') ||
    // Public auth pages opened from emailed links — must NOT be bounced to the
    // login on the app subdomain, or the reset/forgot flows can't be used.
    p === '/reset-password' || p === '/forgot-password' ||
    // Member-only extension install/setup pages — reached from the logged-in
    // dashboard (opened in a new tab). Allow them on the app subdomain so the
    // fresh tab load is not bounced to /client/login.
    p === '/chrome-extension' || p === '/extension';

  // ── On the MAIN domain: send app-only paths to the app subdomain ──
  if (MAIN_HOSTS.includes(host)) {
    if (path === '/login') {
      window.location.replace('https://' + APP_HOST + '/client/login');
    } else if (path.startsWith('/client') || path.startsWith('/admin')) {
      window.location.replace('https://' + APP_HOST + path + search);
    }
    return;
  }

  // ── On the APP subdomain: send public marketing paths to client login ──
  if (host === APP_HOST) {
    // Already an app path → leave it alone (prevents redirect loops on /client/login).
    if (isAppPath(path)) return;
    // Any non-app path (incl. "/") is marketing → bounce to the login.
    window.location.replace('https://' + APP_HOST + '/client/login');
  }
}());
// Layout / guards / providers are kept EAGER so the shell paints instantly and route
// guards run without waiting on a chunk; everything else is code-split (React.lazy)
// so a given entry point only downloads the JS it actually needs — the public site no
// longer ships the admin panel + client dashboard + every tool form in one bundle.
import PublicNavbar from './components/public/PublicNavbar';
import PublicFooter from './components/public/PublicFooter';
import WhatsAppButton from './components/WhatsAppButton';
import ScrollProgress from './components/public/ScrollProgress';
import ScrollToTop from './components/ScrollToTop';
import { ToastProvider } from './components/Toast';
import AdminRoute from './components/AdminRoute';
import ClientRoute from './components/ClientRoute';
import ErrorBoundary from './components/ErrorBoundary';
import PageLoader from './components/PageLoader';

// Public Pages (existing) — code-split
const Home = lazy(() => import('./pages/Home'));
const Pricing = lazy(() => import('./pages/Pricing'));
const Blog = lazy(() => import('./pages/Blog'));
const BlogDetail = lazy(() => import('./pages/BlogDetail'));
const About = lazy(() => import('./pages/About'));
const Contact = lazy(() => import('./pages/Contact'));
const Login = lazy(() => import('./pages/Login'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const ResetPassword = lazy(() => import('./pages/ResetPassword'));
const Join = lazy(() => import('./pages/Join'));
const NotFound = lazy(() => import('./pages/NotFound'));
const ExtensionSetup = lazy(() => import('./pages/ExtensionSetup'));
const ChromeExtensionPage = lazy(() => import('./pages/ChromeExtensionPage'));
const Tools = lazy(() => import('./pages/Tools'));

// New Public Service Pages — code-split
const Services = lazy(() => import('./pages/public/Services'));
const ServiceDigitalTools = lazy(() => import('./pages/public/ServiceDigitalTools'));
const ServiceSocialMedia = lazy(() => import('./pages/public/ServiceSocialMedia'));
const ServiceWriting = lazy(() => import('./pages/public/ServiceWriting'));
const ServiceWebDesign = lazy(() => import('./pages/public/ServiceWebDesign'));
const ServiceAppDev = lazy(() => import('./pages/public/ServiceAppDev'));
const ServiceBranding = lazy(() => import('./pages/public/ServiceBranding'));
const ServiceSEO = lazy(() => import('./pages/public/ServiceSEO'));
const Portfolio = lazy(() => import('./pages/public/Portfolio'));

// Admin Pages — code-split
const AdminLogin = lazy(() => import('./pages/admin/AdminLogin'));
const AdminDashboardEnhanced = lazy(() => import('./pages/admin/AdminDashboardEnhanced'));
const AdminToolsEnhanced = lazy(() => import('./pages/admin/AdminToolsEnhanced'));
const AdminToolForm = lazy(() => import('./pages/admin/AdminToolForm'));
const AdminClientsEnhanced = lazy(() => import('./pages/admin/AdminClientsEnhanced'));
const AdminClientForm = lazy(() => import('./pages/admin/AdminClientForm'));
const AdminBulkAssign = lazy(() => import('./pages/admin/AdminBulkAssign'));
const AdminAssignments = lazy(() => import('./pages/admin/AdminAssignments'));
const AdminActivity = lazy(() => import('./pages/admin/AdminActivity'));
const AdminBlog = lazy(() => import('./pages/admin/AdminBlog'));
const AdminBlogForm = lazy(() => import('./pages/admin/AdminBlogForm'));
const AdminContacts = lazy(() => import('./pages/admin/AdminContacts'));
const AdminAnnouncements = lazy(() => import('./pages/admin/AdminAnnouncements'));
const AdminAnalytics = lazy(() => import('./pages/admin/AdminAnalytics'));
const AdminSecurityAlerts = lazy(() => import('./pages/admin/AdminSecurityAlerts'));
const AdminToolWizard = lazy(() => import('./pages/admin/AdminToolWizard'));
const AdminStealthWriter = lazy(() => import('./pages/admin/AdminStealthWriter'));
const AdminProxyTools = lazy(() => import('./pages/admin/AdminProxyTools'));
const AdminExtension = lazy(() => import('./pages/admin/AdminExtension'));

// Client Pages — code-split
const ClientLogin = lazy(() => import('./pages/client/ClientLogin'));
const ClientDashboardEnhanced = lazy(() => import('./pages/client/ClientDashboardEnhanced'));
const ClientToolsEnhanced = lazy(() => import('./pages/client/ClientToolsEnhanced'));
const ClientToolDetail = lazy(() => import('./pages/client/ClientToolDetail'));
const ClientProfile = lazy(() => import('./pages/client/ClientProfile'));
const ClientActivity = lazy(() => import('./pages/client/ClientActivity'));
const ClientStealthWriter = lazy(() => import('./pages/client/ClientStealthWriter'));

// Public layout wrapper
const PublicPage = ({ children }) => (
  <>
    <a href="#main-content" className="skip-link">Skip to content</a>
    <ScrollProgress />
    <PublicNavbar />
    <main id="main-content">{children}</main>
    <PublicFooter />
    <WhatsAppButton />
  </>
);

function App() {
  return (
    <ToastProvider>
      <div className="App min-h-screen" style={{ background: 'var(--brand-soft)' }}>
        <BrowserRouter>
          <ScrollToTop />
          <Suspense fallback={<PageLoader />}>
          <Routes>

            {/* ── Public Routes ───────────────────────────────── */}
            <Route path="/"              element={<PublicPage><Home /></PublicPage>} />
            <Route path="/services"      element={<PublicPage><Services /></PublicPage>} />
            <Route path="/services/digital-tools"           element={<PublicPage><ServiceDigitalTools /></PublicPage>} />
            <Route path="/services/social-media-management" element={<PublicPage><ServiceSocialMedia /></PublicPage>} />
            <Route path="/services/writing-services"        element={<PublicPage><ServiceWriting /></PublicPage>} />
            <Route path="/services/web-design-development"  element={<PublicPage><ServiceWebDesign /></PublicPage>} />
            <Route path="/services/app-development"         element={<PublicPage><ServiceAppDev /></PublicPage>} />
            <Route path="/services/branding-design"         element={<PublicPage><ServiceBranding /></PublicPage>} />
            <Route path="/services/seo-digital-growth"      element={<PublicPage><ServiceSEO /></PublicPage>} />
            <Route path="/portfolio"     element={<PublicPage><Portfolio /></PublicPage>} />
            <Route path="/pricing"       element={<PublicPage><Pricing /></PublicPage>} />
            <Route path="/about"         element={<PublicPage><About /></PublicPage>} />
            <Route path="/contact"       element={<PublicPage><Contact /></PublicPage>} />
            <Route path="/blog"          element={<PublicPage><Blog /></PublicPage>} />
            <Route path="/blog/:slug"    element={<PublicPage><BlogDetail /></PublicPage>} />
            <Route path="/tools"         element={<PublicPage><Tools /></PublicPage>} />
            <Route path="/login"         element={<PublicPage><Login /></PublicPage>} />
            <Route path="/join"          element={<PublicPage><Join /></PublicPage>} />
            <Route path="/forgot-password" element={<PublicPage><ForgotPassword /></PublicPage>} />
            <Route path="/reset-password"  element={<PublicPage><ResetPassword /></PublicPage>} />
            <Route path="/client/signup"   element={<PublicPage><Join /></PublicPage>} />
            <Route path="/client/register" element={<PublicPage><Join /></PublicPage>} />
            {/* Extension install/setup pages are MEMBER-ONLY — hard-gated behind
                ClientRoute so anonymous visitors who type the URL are redirected
                to the client login. Reached from the logged-in dashboard banner. */}
            <Route path="/extension"     element={<ErrorBoundary><ClientRoute><PublicPage><ExtensionSetup /></PublicPage></ClientRoute></ErrorBoundary>} />
            <Route path="/chrome-extension" element={<ErrorBoundary><ClientRoute><PublicPage><ChromeExtensionPage /></PublicPage></ClientRoute></ErrorBoundary>} />

            {/* ── Admin Routes (untouched) ─────────────────────── */}
            <Route path="/admin/login"   element={<AdminLogin />} />
            <Route path="/admin/dashboard" element={<ErrorBoundary><AdminRoute><AdminDashboardEnhanced /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/tools"   element={<ErrorBoundary><AdminRoute><AdminToolsEnhanced /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/tools/new" element={<ErrorBoundary><AdminRoute><AdminToolForm /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/tools/wizard" element={<ErrorBoundary><AdminRoute><AdminToolWizard /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/tools/:id/edit" element={<ErrorBoundary><AdminRoute><AdminToolForm /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/clients" element={<ErrorBoundary><AdminRoute><AdminClientsEnhanced /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/clients/new" element={<ErrorBoundary><AdminRoute><AdminClientForm /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/clients/:id/edit" element={<ErrorBoundary><AdminRoute><AdminClientForm /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/clients/:clientId/assign" element={<ErrorBoundary><AdminRoute><AdminBulkAssign /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/assignments" element={<ErrorBoundary><AdminRoute><AdminAssignments /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/assign"  element={<ErrorBoundary><AdminRoute><AdminBulkAssign /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/activity" element={<ErrorBoundary><AdminRoute><AdminActivity /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/blog"    element={<ErrorBoundary><AdminRoute><AdminBlog /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/blog/new" element={<ErrorBoundary><AdminRoute><AdminBlogForm /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/blog/:id/edit" element={<ErrorBoundary><AdminRoute><AdminBlogForm /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/contacts" element={<ErrorBoundary><AdminRoute><AdminContacts /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/announcements" element={<ErrorBoundary><AdminRoute><AdminAnnouncements /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/analytics" element={<ErrorBoundary><AdminRoute><AdminAnalytics /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/security" element={<ErrorBoundary><AdminRoute><AdminSecurityAlerts /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/stealthwriter" element={<ErrorBoundary><AdminRoute><AdminStealthWriter /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/proxy-tools" element={<ErrorBoundary><AdminRoute><AdminProxyTools /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/extension" element={<ErrorBoundary><AdminRoute><AdminExtension /></AdminRoute></ErrorBoundary>} />

            {/* ── Client Routes (untouched) ────────────────────── */}
            <Route path="/client/login"  element={<ClientLogin />} />
            <Route path="/client/dashboard" element={<ErrorBoundary><ClientRoute><ClientDashboardEnhanced /></ClientRoute></ErrorBoundary>} />
            <Route path="/client/tools"  element={<ErrorBoundary><ClientRoute><ClientToolsEnhanced /></ClientRoute></ErrorBoundary>} />
            <Route path="/client/tools/:id" element={<ErrorBoundary><ClientRoute><ClientToolDetail /></ClientRoute></ErrorBoundary>} />
            <Route path="/client/stealthwriter" element={<ErrorBoundary><ClientRoute><ClientStealthWriter /></ClientRoute></ErrorBoundary>} />
            <Route path="/client/profile" element={<ErrorBoundary><ClientRoute><ClientProfile /></ClientRoute></ErrorBoundary>} />
            <Route path="/client/activity" element={<ErrorBoundary><ClientRoute><ClientActivity /></ClientRoute></ErrorBoundary>} />

            {/* ── 404 ─────────────────────────────────────────── */}
            <Route path="*" element={<NotFound />} />
          </Routes>
          </Suspense>
        </BrowserRouter>
      </div>
    </ToastProvider>
  );
}

export default App;
