import { Link } from 'react-router-dom';
import { Chrome, ShieldCheck, Download, CheckCircle2, ArrowLeft } from 'lucide-react';

const ExtensionSetup = () => {
  return (
    <main className="min-h-screen px-4 py-16 text-genz-navy">
      <div className="max-w-3xl mx-auto rounded-3xl border border-genz-teal/20 bg-white p-8 shadow-2xl">
        <Link to="/client/dashboard" className="inline-flex items-center gap-2 text-sm text-genz-teal hover:underline mb-6">
          <ArrowLeft size={16} /> Back to dashboard
        </Link>
        <div className="flex items-center gap-4 mb-6">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: 'linear-gradient(135deg,#06B6D4,#0891B2)' }}>
            <Chrome className="text-genz-deep-navy" size={30} />
          </div>
          <div>
            <h1 className="text-3xl font-black">Gen Z Digital Store Extension</h1>
            <p className="text-genz-muted">Install and connect the browser helper to open tools from your dashboard.</p>
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-4 mb-8">
          {[
            ['Install', 'Load the Chrome extension provided by admin or from the Chrome Web Store when published.'],
            ['Connect', 'Login to the dashboard. The extension pairs automatically using your secure website session.'],
            ['Access', 'Go back to your dashboard and press Access on any assigned tool.'],
          ].map(([title, desc], i) => (
            <div key={title} className="rounded-2xl border border-genz-border bg-white p-5">
              <div className="w-8 h-8 rounded-full bg-genz-teal text-genz-deep-navy flex items-center justify-center font-bold mb-3">{i + 1}</div>
              <h3 className="font-bold mb-2">{title}</h3>
              <p className="text-sm text-genz-muted leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>

        <div className="rounded-2xl border border-genz-teal/20 bg-genz-teal/10 p-5 mb-6">
          <div className="flex items-start gap-3">
            <ShieldCheck className="text-genz-teal flex-shrink-0 mt-0.5" size={20} />
            <div>
              <h3 className="font-semibold mb-1">Security note</h3>
              <p className="text-sm text-genz-muted leading-relaxed">
                The website never receives tool passwords, cookies, or session bundles. The dashboard only sends a short-lived open token to the installed extension, and the extension verifies access with the backend before opening the tool.
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <a href="/chrome-extension" className="inline-flex items-center gap-2 px-5 py-3 rounded-xl font-semibold text-genz-deep-navy" style={{ background: 'linear-gradient(135deg,#06B6D4,#0891B2)' }}>
            <Download size={17} /> Download / Install Extension
          </a>
          <Link to="/client/dashboard" className="inline-flex items-center gap-2 px-5 py-3 rounded-xl border border-genz-border hover:border-genz-teal/40">
            <CheckCircle2 size={17} /> Open Dashboard
          </Link>
        </div>
      </div>
    </main>
  );
};

export default ExtensionSetup;
