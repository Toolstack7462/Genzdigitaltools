import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Search, Filter, Bot, BookOpen, BarChart3, Palette, Code2, Globe,
  Video, Briefcase, Zap, Star, ArrowRight, CheckCircle2, ExternalLink
} from 'lucide-react';

const TOOL_CATEGORIES = [
  { id: 'all',          label: 'All Tools',         icon: Zap,        count: 90  },
  { id: 'ai-writing',   label: 'AI Writing',        icon: Bot,        count: 12  },
  { id: 'ai-seo',       label: 'AI SEO',            icon: BarChart3,  count: 8   },
  { id: 'ai-design',    label: 'AI Design',         icon: Palette,    count: 10  },
  { id: 'ai-video',     label: 'AI Video',          icon: Video,      count: 6   },
  { id: 'ai-coding',    label: 'AI Coding',         icon: Code2,      count: 9   },
  { id: 'academic',     label: 'Academic',          icon: BookOpen,   count: 15  },
  { id: 'business',     label: 'Business',          icon: Briefcase,  count: 11  },
  { id: 'marketing',    label: 'Marketing',         icon: Globe,      count: 13  },
];

const SAMPLE_TOOLS = [
  { name: 'ChatGPT Premium',    cat: 'ai-writing', badge: 'Popular', desc: 'Advanced AI writing, coding, and analysis assistant',           status: 'active'    },
  { name: 'Claude AI Pro',      cat: 'ai-writing', badge: 'AI',      desc: 'Powerful AI assistant with long context window',               status: 'active'    },
  { name: 'Grammarly Business', cat: 'ai-writing', badge: 'AI',      desc: 'Professional grammar, tone, and style enhancement',           status: 'active'    },
  { name: 'Jasper AI',          cat: 'ai-writing', badge: 'Popular', desc: 'AI content marketing and copywriting platform',               status: 'active'    },
  { name: 'Copy.ai',            cat: 'ai-writing', badge: 'New',     desc: 'AI-powered copywriting and marketing content',                status: 'active'    },
  { name: 'Wordtune',           cat: 'ai-writing', badge: null,      desc: 'AI writing companion for rewrites and paraphrasing',          status: 'active'    },
  { name: 'Semrush Pro',        cat: 'ai-seo',     badge: 'Popular', desc: 'Complete SEO suite for keyword research and competitor analysis', status: 'active' },
  { name: 'Ahrefs',             cat: 'ai-seo',     badge: null,      desc: 'SEO toolset for backlink analysis and site audits',            status: 'active'    },
  { name: 'Surfer SEO',         cat: 'ai-seo',     badge: 'AI',      desc: 'AI-driven SEO content optimization platform',                 status: 'active'    },
  { name: 'Mangools',           cat: 'ai-seo',     badge: null,      desc: 'Keyword research, SERP analysis and rank tracking',           status: 'active'    },
  { name: 'Midjourney',         cat: 'ai-design',  badge: 'Popular', desc: 'Generate stunning AI art and images from text prompts',       status: 'active'    },
  { name: 'Canva Pro',          cat: 'ai-design',  badge: 'AI',      desc: 'Professional design platform with AI-powered features',       status: 'active'    },
  { name: 'Adobe Firefly',      cat: 'ai-design',  badge: 'New',     desc: 'Adobe\'s generative AI for creative design workflows',        status: 'active'    },
  { name: 'Leonardo AI',        cat: 'ai-design',  badge: 'AI',      desc: 'AI image generation for gaming assets and creative work',     status: 'active'    },
  { name: 'Invideo AI',         cat: 'ai-video',   badge: 'AI',      desc: 'AI-powered video creation and editing platform',              status: 'active'    },
  { name: 'Loom',               cat: 'ai-video',   badge: 'Popular', desc: 'Async video messaging and screen recording tool',             status: 'active'    },
  { name: 'GitHub Copilot',     cat: 'ai-coding',  badge: 'Popular', desc: 'AI pair programmer that writes code suggestions in realtime', status: 'active'    },
  { name: 'Tabnine',            cat: 'ai-coding',  badge: 'AI',      desc: 'AI code completion assistant for all major IDEs',             status: 'active'    },
  { name: 'Notion AI',          cat: 'academic',   badge: 'AI',      desc: 'AI-powered workspace for notes, docs, and project management',status: 'active'    },
  { name: 'Grammarly Business', cat: 'academic',   badge: null,      desc: 'Academic writing assistance and plagiarism checker',          status: 'active'    },
  { name: 'Zotero',             cat: 'academic',   badge: null,      desc: 'Research management and citation organizer',                  status: 'active'    },
  { name: 'Perplexity AI',      cat: 'academic',   badge: 'AI',      desc: 'AI-powered research and Q&A search engine',                   status: 'active'    },
  { name: 'HubSpot CRM',        cat: 'business',   badge: 'Popular', desc: 'Full CRM platform for sales, marketing, and customer service',status: 'active'    },
  { name: 'Monday.com',         cat: 'business',   badge: null,      desc: 'Work management and project collaboration platform',          status: 'active'    },
  { name: 'Mailchimp',          cat: 'marketing',  badge: 'Popular', desc: 'Email marketing platform with automation workflows',          status: 'active'    },
  { name: 'Buffer',             cat: 'marketing',  badge: null,      desc: 'Social media scheduling and analytics platform',              status: 'active'    },
];

const BADGE_STYLES = {
  Popular:  'bg-genz-teal/20 text-genz-teal',
  AI:       'bg-purple-500/20 text-purple-300',
  New:      'bg-green-500/20 text-green-300',
  Featured: 'bg-yellow-500/20 text-yellow-300',
};

const Tools = () => {
  const [activeCategory, setActiveCategory] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredTools = SAMPLE_TOOLS.filter(tool => {
    const matchesCat    = activeCategory === 'all' || tool.cat === activeCategory;
    const matchesSearch = !searchQuery ||
      tool.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      tool.desc.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCat && matchesSearch;
  });

  return (
    <div className="min-h-screen pt-20 pb-20 px-4"
         style={{ background: 'linear-gradient(180deg, #000820 0%, #001030 100%)' }}>
      <div className="max-w-7xl mx-auto">

        {/* Header */}
        <div className="text-center mb-12 pt-8">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border mb-6"
               style={{ background: 'rgba(0,175,193,0.1)', borderColor: 'rgba(0,175,193,0.3)' }}>
            <Zap size={14} className="text-genz-teal" />
            <span className="text-genz-teal text-sm font-medium">90+ Premium Tools Available</span>
          </div>
          <h1 className="text-5xl font-black text-white mb-4">
            Browse <span className="text-genz-teal">All Tools</span>
          </h1>
          <p className="text-genz-muted text-lg max-w-2xl mx-auto mb-8">
            Access all your premium AI, academic, SEO, design, and business tools in one place.
          </p>

          {/* Search */}
          <div className="relative max-w-xl mx-auto">
            <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-genz-muted" />
            <input
              type="text"
              placeholder="Search tools..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-12 pr-4 py-3.5 rounded-2xl text-white placeholder-genz-muted focus:outline-none transition-all text-base"
              style={{ background: 'rgba(0,175,193,0.08)', border: '1px solid rgba(0,175,193,0.2)' }}
            />
          </div>
        </div>

        {/* Category Tabs */}
        <div className="flex flex-wrap gap-3 justify-center mb-10">
          {TOOL_CATEGORIES.map(({ id, label, icon: Icon, count }) => (
            <button key={id}
                    onClick={() => setActiveCategory(id)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all border ${
                      activeCategory === id
                        ? 'text-genz-deep-navy border-transparent'
                        : 'text-genz-muted border-genz-border/30 hover:border-genz-teal/40 hover:text-genz-teal'
                    }`}
                    style={activeCategory === id ? { background: 'linear-gradient(135deg, #00AFC1, #008EA3)' } : {}}>
              <Icon size={15} />
              {label}
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                activeCategory === id ? 'bg-genz-deep-navy/20 text-genz-deep-navy' : 'bg-white/5 text-genz-muted'
              }`}>{count}</span>
            </button>
          ))}
        </div>

        {/* Tools Grid */}
        {filteredTools.length === 0 ? (
          <div className="text-center py-20">
            <Search size={40} className="text-genz-muted mx-auto mb-3 opacity-40" />
            <p className="text-genz-muted">No tools match your search.</p>
            <button onClick={() => { setSearchQuery(''); setActiveCategory('all'); }}
                    className="mt-3 text-genz-teal hover:underline text-sm">
              Clear filters
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {filteredTools.map((tool) => (
              <div key={tool.name}
                   className="group p-5 rounded-2xl border transition-all hover:-translate-y-1 hover:shadow-xl"
                   style={{ background: 'rgba(0,175,193,0.04)', borderColor: 'rgba(0,175,193,0.10)' }}>
                {/* Tool icon */}
                <div className="flex items-start justify-between mb-3">
                  <div className="w-11 h-11 rounded-xl flex items-center justify-center font-black text-white"
                       style={{ background: 'linear-gradient(135deg, #001030, #00AFC1)' }}>
                    {tool.name.charAt(0)}
                  </div>
                  {tool.badge && (
                    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${BADGE_STYLES[tool.badge] || ''}`}>
                      {tool.badge}
                    </span>
                  )}
                </div>
                <h3 className="font-bold text-white text-sm mb-1 group-hover:text-genz-teal transition-colors">{tool.name}</h3>
                <p className="text-xs text-genz-muted mb-3 leading-relaxed line-clamp-2">{tool.desc}</p>
                <Link to="/join"
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-genz-teal hover:underline">
                  <CheckCircle2 size={12} /> Included in membership
                </Link>
              </div>
            ))}
          </div>
        )}

        {/* CTA */}
        <div className="mt-16 text-center">
          <div className="inline-block p-8 rounded-3xl border"
               style={{ background: 'rgba(0,175,193,0.06)', borderColor: 'rgba(0,175,193,0.2)' }}>
            <h3 className="text-2xl font-black text-white mb-2">Ready to access all tools?</h3>
            <p className="text-genz-muted mb-6">Get your Gen Z Digital Store membership today</p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link to="/join"
                    className="inline-flex items-center gap-2 px-8 py-3 rounded-2xl font-semibold text-genz-deep-navy transition-all hover:opacity-90 hover:scale-105"
                    style={{ background: 'linear-gradient(135deg, #00AFC1, #008EA3)' }}>
                <Zap size={18} /> Start Membership
              </Link>
              <Link to="/pricing"
                    className="inline-flex items-center gap-2 px-8 py-3 rounded-2xl font-medium border border-genz-teal/40 text-genz-teal hover:bg-genz-teal/10 transition-all">
                View Pricing <ArrowRight size={16} />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Tools;
