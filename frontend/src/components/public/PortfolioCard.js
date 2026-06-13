const PortfolioCard = ({ title, category, description, tags = [], colorAccent = '#06B6D4', visual }) => (
  <div className="gz-card group overflow-hidden flex flex-col">
    {/* Visual area */}
    <div
      className="relative h-44 flex items-center justify-center overflow-hidden"
      style={{ background: `linear-gradient(135deg, ${colorAccent}14 0%, #ffffff 100%)` }}
    >
      {/* Decorative grid */}
      <div
        className="absolute inset-0 opacity-50"
        style={{
          backgroundImage: `linear-gradient(${colorAccent}12 1px, transparent 1px), linear-gradient(90deg, ${colorAccent}12 1px, transparent 1px)`,
          backgroundSize: '30px 30px',
        }}
      />
      {/* Central mock UI */}
      <div className="relative z-10 flex flex-col items-center gap-2">
        {visual || (
          <div className="flex gap-2">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="rounded-xl"
                style={{
                  width: i === 2 ? 56 : 40,
                  height: i === 2 ? 56 : 40,
                  background: `${colorAccent}26`,
                  border: `1px solid ${colorAccent}40`,
                }}
              />
            ))}
          </div>
        )}
        <div className="w-20 h-2 rounded-full mt-2" style={{ background: `${colorAccent}30` }} />
        <div className="w-14 h-1.5 rounded-full" style={{ background: `${colorAccent}20` }} />
      </div>

      {/* Category badge */}
      <span
        className="absolute top-3 right-3 px-2.5 py-1 rounded-full text-xs font-semibold"
        style={{ background: `${colorAccent}18`, color: colorAccent, border: `1px solid ${colorAccent}38` }}
      >
        {category}
      </span>
    </div>

    {/* Content */}
    <div className="p-5 flex flex-col flex-1">
      <h3 className="text-genz-navy font-bold text-base mb-2 group-hover:text-genz-blue transition-colors">
        {title}
      </h3>
      <p className="text-genz-muted text-sm leading-relaxed mb-4 flex-1">{description}</p>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="px-2.5 py-1 rounded-lg text-xs text-genz-muted"
              style={{ background: 'var(--brand-surface-soft)', border: '1px solid var(--brand-border)' }}
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  </div>
);

export default PortfolioCard;
