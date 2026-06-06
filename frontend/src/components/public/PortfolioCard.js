import { ExternalLink } from 'lucide-react';

const PortfolioCard = ({ title, category, description, tags = [], colorAccent = '#00AFC1', visual }) => (
  <div
    className="group rounded-2xl overflow-hidden transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl flex flex-col"
    style={{
      background: 'rgba(255,255,255,0.04)',
      border: '1px solid rgba(255,255,255,0.08)',
    }}
  >
    {/* Visual area */}
    <div
      className="relative h-44 flex items-center justify-center overflow-hidden"
      style={{ background: `linear-gradient(135deg, ${colorAccent}15 0%, rgba(0,8,32,0.8) 100%)` }}
    >
      {/* Decorative grid */}
      <div
        className="absolute inset-0 opacity-20"
        style={{
          backgroundImage: `linear-gradient(${colorAccent}20 1px, transparent 1px), linear-gradient(90deg, ${colorAccent}20 1px, transparent 1px)`,
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
                  background: `${colorAccent}${i === 2 ? '30' : '18'}`,
                  border: `1px solid ${colorAccent}40`,
                }}
              />
            ))}
          </div>
        )}
        <div
          className="w-20 h-2 rounded-full mt-2"
          style={{ background: `${colorAccent}30` }}
        />
        <div
          className="w-14 h-1.5 rounded-full"
          style={{ background: `${colorAccent}20` }}
        />
      </div>

      {/* Category badge */}
      <span
        className="absolute top-3 right-3 px-2.5 py-1 rounded-full text-xs font-semibold"
        style={{ background: `${colorAccent}22`, color: colorAccent, border: `1px solid ${colorAccent}40` }}
      >
        {category}
      </span>
    </div>

    {/* Content */}
    <div className="p-5 flex flex-col flex-1">
      <h3 className="text-white font-semibold text-base mb-2 group-hover:text-genz-teal transition-colors">
        {title}
      </h3>
      <p className="text-white/45 text-sm leading-relaxed mb-4 flex-1">{description}</p>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="px-2.5 py-1 rounded-lg text-xs"
              style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.45)' }}
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
