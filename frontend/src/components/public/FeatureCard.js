const FeatureCard = ({ icon: Icon, title, description, accentColor = '#00AFC1' }) => (
  <div className="card-premium flex gap-4 p-5">
    <div
      className="w-10 h-10 rounded-xl flex-shrink-0 flex items-center justify-center mt-0.5"
      style={{ background: `${accentColor}18`, border: `1px solid ${accentColor}30` }}
    >
      {Icon && <Icon size={18} style={{ color: accentColor }} />}
    </div>
    <div>
      <h4 className="text-white font-semibold text-sm mb-1.5">{title}</h4>
      <p className="text-white/55 text-sm leading-relaxed">{description}</p>
    </div>
  </div>
);

export default FeatureCard;
