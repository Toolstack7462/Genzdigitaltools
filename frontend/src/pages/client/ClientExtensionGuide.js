import ClientLayoutEnhanced from '../../components/ClientLayoutEnhanced';
import { PlayCircle } from 'lucide-react';

/**
 * ClientExtensionGuide — dedicated tutorial page reached from the sidebar
 * "Setup Guide" item. Embeds the extension setup video. Purely presentational:
 * no auth, extension, proxy, API or business logic.
 */
const ClientExtensionGuide = () => {
  return (
    <ClientLayoutEnhanced>
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-5">
          <h1 className="font-heading text-2xl font-extrabold text-genz-navy flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-xl flex items-center justify-center text-white"
                  style={{ background: 'linear-gradient(135deg, #2563EB, #06B6D4)' }}>
              <PlayCircle size={20} />
            </span>
            Extension Setup Guide
          </h1>
          <p className="text-sm text-genz-muted mt-1">
            Watch this quick tutorial to download, install, and configure the browser extension.
          </p>
        </div>

        {/* Video */}
        <div className="ds-card p-3 sm:p-4">
          <div className="relative w-full overflow-hidden rounded-xl"
               style={{ aspectRatio: '16 / 9', background: '#000' }}>
            <iframe
              className="absolute inset-0 w-full h-full"
              src="https://www.youtube.com/embed/hEhtT9xGeH8"
              title="Extension Setup Guide"
              loading="lazy"
              frameBorder="0"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
            />
          </div>
        </div>
      </div>
    </ClientLayoutEnhanced>
  );
};

export default ClientExtensionGuide;
