import { BrowserRouter, Routes, Route } from 'react-router-dom';
import "@/App.css";

// Redirect /login, /client/*, /admin/* to app subdomain when on main domain
(function domainGuard() {
  const host = window.location.hostname;
  if (host !== 'genzdigitalstore.com' && host !== 'www.genzdigitalstore.com') return;
  const path = window.location.pathname;
  if (path === '/login') {
    window.location.replace('https://app.genzdigitalstore.com/client/login');
  } else if (path.startsWith('/client/') || path.startsWith('/admin/')) {
    window.location.replace('https://app.genzdigitalstore.com' + path + window.location.search);
  }
}());
import PublicNavbar from './components/public/PublicNavbar';
import PublicFooter from './components/public/PublicFooter';
import WhatsAppButton from './components/WhatsAppButton';
import { ToastProvider } from './components/Toast';

// Public Pages (existing)
import Home from './pages/Home';
import Pricing from './pages/Pricing';
import Blog from './pages/Blog';
import BlogDetail from './pages/BlogDetail';
import About from './pages/About';
import Contact from './pages/Contact';
import Login from './pages/Login';
import Join from './pages/Join';
import NotFound from './pages/NotFound';
import ExtensionSetup from './pages/ExtensionSetup';
import ChromeExtensionPage from './pages/ChromeExtensionPage';
import Tools from './pages/Tools';

// New Public Service Pages
import Services from './pages/public/Services';
import ServiceDigitalTools from './pages/public/ServiceDigitalTools';
import ServiceSocialMedia from './pages/public/ServiceSocialMedia';
import ServiceWriting from './pages/public/ServiceWriting';
import ServiceWebDesign from './pages/public/ServiceWebDesign';
import ServiceAppDev from './pages/public/ServiceAppDev';
import ServiceBranding from './pages/public/ServiceBranding';
import ServiceSEO from './pages/public/ServiceSEO';
import Portfolio from './pages/public/Portfolio';

// Admin Pages
import AdminRoute from './components/AdminRoute';
import ErrorBoundary from './components/ErrorBoundary';
import AdminLogin from './pages/admin/AdminLogin';
import AdminDashboardEnhanced from './pages/admin/AdminDashboardEnhanced';
import AdminToolsEnhanced from './pages/admin/AdminToolsEnhanced';
import AdminToolForm from './pages/admin/AdminToolForm';
import AdminClientsEnhanced from './pages/admin/AdminClientsEnhanced';
import AdminClientForm from './pages/admin/AdminClientForm';
import AdminBulkAssign from './pages/admin/AdminBulkAssign';
import AdminActivity from './pages/admin/AdminActivity';
import AdminBlog from './pages/admin/AdminBlog';
import AdminBlogForm from './pages/admin/AdminBlogForm';
import AdminContacts from './pages/admin/AdminContacts';
import AdminAnalytics from './pages/admin/AdminAnalytics';
import AdminSecurityAlerts from './pages/admin/AdminSecurityAlerts';
import AdminToolWizard from './pages/admin/AdminToolWizard';

// Client Pages
import ClientRoute from './components/ClientRoute';
import ClientLogin from './pages/client/ClientLogin';
import ClientDashboardEnhanced from './pages/client/ClientDashboardEnhanced';
import ClientToolsEnhanced from './pages/client/ClientToolsEnhanced';
import ClientToolDetail from './pages/client/ClientToolDetail';
import ClientProfile from './pages/client/ClientProfile';

// Public layout wrapper
const PublicPage = ({ children }) => (
  <>
    <PublicNavbar />
    {children}
    <PublicFooter />
    <WhatsAppButton />
  </>
);

function App() {
  return (
    <ToastProvider>
      <div className="App min-h-screen" style={{ background: '#000820' }}>
        <BrowserRouter>
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
            <Route path="/extension"     element={<PublicPage><ExtensionSetup /></PublicPage>} />
            <Route path="/chrome-extension" element={<PublicPage><ChromeExtensionPage /></PublicPage>} />

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
            <Route path="/admin/assign"  element={<ErrorBoundary><AdminRoute><AdminBulkAssign /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/activity" element={<ErrorBoundary><AdminRoute><AdminActivity /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/blog"    element={<ErrorBoundary><AdminRoute><AdminBlog /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/blog/new" element={<ErrorBoundary><AdminRoute><AdminBlogForm /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/blog/:id/edit" element={<ErrorBoundary><AdminRoute><AdminBlogForm /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/contacts" element={<ErrorBoundary><AdminRoute><AdminContacts /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/analytics" element={<ErrorBoundary><AdminRoute><AdminAnalytics /></AdminRoute></ErrorBoundary>} />
            <Route path="/admin/security" element={<ErrorBoundary><AdminRoute><AdminSecurityAlerts /></AdminRoute></ErrorBoundary>} />

            {/* ── Client Routes (untouched) ────────────────────── */}
            <Route path="/client/login"  element={<ClientLogin />} />
            <Route path="/client/dashboard" element={<ErrorBoundary><ClientRoute><ClientDashboardEnhanced /></ClientRoute></ErrorBoundary>} />
            <Route path="/client/tools"  element={<ErrorBoundary><ClientRoute><ClientToolsEnhanced /></ClientRoute></ErrorBoundary>} />
            <Route path="/client/tools/:id" element={<ErrorBoundary><ClientRoute><ClientToolDetail /></ClientRoute></ErrorBoundary>} />
            <Route path="/client/profile" element={<ErrorBoundary><ClientRoute><ClientProfile /></ClientRoute></ErrorBoundary>} />

            {/* ── 404 ─────────────────────────────────────────── */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </div>
    </ToastProvider>
  );
}

export default App;
