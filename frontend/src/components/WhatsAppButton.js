import { MessageCircle } from 'lucide-react';

const WHATSAPP_NUMBER = '923027467462';
const DEFAULT_MESSAGE = 'Hi Gen Z Digital Store! I need help with tools/subscription.';

const WhatsAppButton = () => {
  const whatsappUrl = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(DEFAULT_MESSAGE)}`;
  
  return (
    <div 
      className="fixed z-[9999]" 
      style={{
        bottom: 'max(env(safe-area-inset-bottom, 20px), 20px)',
        right: '20px'
      }}
    >
      {/* WhatsApp floating button - always visible */}
      <a
        href={whatsappUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="group relative bg-[#25D366] hover:bg-[#20BA5A] rounded-full p-3 md:p-4 shadow-2xl transition-all hover:scale-110 block"
        aria-label="Chat on WhatsApp"
        data-testid="whatsapp-float-btn"
      >
        <MessageCircle size={24} className="text-white md:w-7 md:h-7" />
        
        {/* Tooltip */}
        <div className="absolute right-full mr-3 top-1/2 -translate-y-1/2 bg-white/[0.04] border border-white/10 rounded-lg px-4 py-2 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
          <span className="text-white text-sm font-medium">Chat with us on WhatsApp</span>
          <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-full">
            <div className="border-8 border-transparent border-l-white/10"></div>
          </div>
        </div>
        
        {/* Pulse animation */}
        <span className="absolute inset-0 rounded-full bg-[#25D366] animate-ping opacity-75"></span>
      </a>
    </div>
  );
};

export default WhatsAppButton;
