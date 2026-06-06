const FeatureCard = ({ icon: Icon, title, description, accentColor = '#00AFC1' }) => (
  <div
    className="flex gap-4 p-5 rounded-2xl transition-all duration-300 hover:-translate-y-0.5"
    style={{
      background: 'rgba(255,255,255,0.03)',
      border: '1px solid rgba(255,255,255,0.07)',
    }}
  >
    <div
      className="w-10 h-10 rounded-xl flex-shrink-0 flex items-center justify-center mt-0.5"
      style={{ background: `${accentColor}18`, border: `1px solid ${accentColor}30` }}
    >
      {Icon && <Icon size={18} style={{ color: accentColor }} />}
    </div>
    <div>
      <h4 className="text-white font-semibold text-sm mb-1.5">{title}</h4>
      <p className="text-white/45 text-sm leading-relaxed">{description}</p>
    </div>
  </div>
);

export default FeatureCard;
