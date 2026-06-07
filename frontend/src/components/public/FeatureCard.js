const FeatureCard = ({ icon: Icon, title, description, accentColor = '#06B6D4' }) => (
  <div className="gz-card flex gap-4 p-6">
    <div
      className="w-11 h-11 rounded-2xl flex-shrink-0 flex items-center justify-center mt-0.5"
      style={{ background: `${accentColor}14`, border: `1px solid ${accentColor}26`, color: accentColor }}
    >
      {Icon && <Icon size={19} />}
    </div>
    <div>
      <h4 className="text-genz-navy font-bold text-[16px] mb-1.5">{title}</h4>
      <p className="text-genz-muted text-[15px] leading-relaxed">{description}</p>
    </div>
  </div>
);

export default FeatureCard;
