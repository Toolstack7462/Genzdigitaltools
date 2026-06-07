import { Download, Chrome, Shield, CheckCircle, ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import GenZDigitalStoreLogo from '../components/GenZDigitalStoreLogo';

const ChromeExtensionPage = () => {
  return (
    <div className="min-h-screen px-4 py-10" style={{ background: 'linear-gradient(135deg, #000820, #FFFFFF)' }}>
      <div className="max-w-4xl mx-auto">
        <Link to="/client/dashboard" className="inline-flex items-center gap-2 text-genz-muted hover:text-genz-navy mb-8">
          <ArrowLeft size={18} /> Back to Dashboard
        </Link>
        <div className="text-center mb-10">
          <GenZDigitalStoreLogo className="h-16 justify-center mb-6" />
          <h1 className="text-4xl font-black text-genz-navy mb-3">Gen Z Digital Store Chrome Extension</h1>
          <p className="text-genz-muted max-w-2xl mx-auto">Install the browser extension to access assigned tools securely from your member dashboard.</p>
        </div>
        <div className="rounded-2xl border p-8 mb-8" style={{ background: 'rgba(0,175,193,0.05)', borderColor: 'rgba(0,175,193,0.15)' }}>
          <div className="flex items-center gap-4 mb-6">
            <div className="w-14 h-14 rounded-xl flex items-center justify-center" style={{ background: 'rgba(0,175,193,0.15)' }}>
              <Chrome className="text-genz-teal" size={30} />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-genz-navy">Download Extension</h2>
              <p className="text-genz-muted">Use this ZIP for manual Chrome installation.</p>
            </div>
          </div>
          <a href="/downloads/genz-digital-store-extension.zip" download className="inline-flex items-center justify-center gap-2 px-6 py-4 rounded-xl font-bold text-genz-deep-navy hover:opacity-90 transition-all" style={{ background: 'linear-gradient(135deg, #06B6D4, #0891B2)' }}>
            <Download size={20} /> Download Chrome Extension ZIP
          </a>
        </div>
        <div className="rounded-2xl border p-8" style={{ background: '#ffffff', borderColor: 'rgba(0,175,193,0.12)' }}>
          <h2 className="text-2xl font-bold text-genz-navy mb-6">Installation Steps</h2>
          <div className="space-y-5 text-genz-muted">
            <div className="flex gap-3"><CheckCircle className="text-genz-teal mt-1" size={20} /><p>Download the extension ZIP.</p></div>
            <div className="flex gap-3"><CheckCircle className="text-genz-teal mt-1" size={20} /><p>Extract the ZIP on your computer.</p></div>
            <div className="flex gap-3"><CheckCircle className="text-genz-teal mt-1" size={20} /><p>Open Chrome and go to <strong>chrome://extensions</strong>.</p></div>
            <div className="flex gap-3"><CheckCircle className="text-genz-teal mt-1" size={20} /><p>Enable <strong>Developer mode</strong>.</p></div>
            <div className="flex gap-3"><CheckCircle className="text-genz-teal mt-1" size={20} /><p>Click <strong>Load unpacked</strong> and select the extracted extension folder.</p></div>
            <div className="flex gap-3"><Shield className="text-genz-teal mt-1" size={20} /><p>After installation, open the client dashboard. Pairing happens automatically from the logged-in dashboard session.</p></div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChromeExtensionPage;
