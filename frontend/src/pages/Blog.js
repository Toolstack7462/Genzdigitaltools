import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Search, Calendar, Clock, FileText } from 'lucide-react';
import { blogPosts as staticBlogPosts } from '../data/blogData';
import api from '../services/api';

const Blog = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [useStaticData, setUseStaticData] = useState(false);
  
  const categories = ['All', 'AI Tools', 'Productivity', 'Tips & Tricks', 'Industry News', 'Tutorials', 'Case Studies', 'Updates'];
  
  useEffect(() => {
    loadPosts();
  }, []);
  
  const loadPosts = async () => {
    try {
      setLoading(true);
      const res = await api.get('/public/blog');
      const dbPosts = res.data.posts || [];
      
      if (dbPosts.length > 0) {
        // Transform DB posts to match UI format
        const transformedPosts = dbPosts.map(post => ({
          slug: post.slug,
          title: post.title,
          excerpt: post.excerpt || '',
          category: post.category,
          date: new Date(post.publishedAt || post.createdAt).toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
          }),
          readTime: `${Math.ceil((post.content?.length || 0) / 1000)} min read`,
          coverImage: post.coverImage,
          coverGradient: post.coverImage ? null : `linear-gradient(135deg, hsl(${Math.random() * 360}, 70%, 50%), hsl(${Math.random() * 360}, 70%, 30%))`,
          featured: post.featured,
          views: post.views
        }));
        setPosts(transformedPosts);
        setUseStaticData(false);
      } else {
        // Fallback to static data if no DB posts
        setPosts(staticBlogPosts);
        setUseStaticData(true);
      }
    } catch (error) {
      console.log('Using static blog data:', error);
      setPosts(staticBlogPosts);
      setUseStaticData(true);
    } finally {
      setLoading(false);
    }
  };
  
  const filteredPosts = posts.filter(post => {
    const matchesSearch = post.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         post.excerpt?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = selectedCategory === 'All' || post.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });
  
  // Featured post
  const featuredPost = filteredPosts.find(p => p.featured) || filteredPosts[0];
  const regularPosts = filteredPosts.filter(p => p !== featuredPost);
  
  if (loading) {
    return (
      <div className="text-white min-h-screen pt-24 pb-16 px-4">
        <div className="max-w-7xl mx-auto flex items-center justify-center min-h-[60vh]">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-genz-teal border-t-transparent"></div>
        </div>
      </div>
    );
  }
  
  return (
    <div className="text-white min-h-screen pt-24 pb-16 px-4">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-4xl md:text-5xl font-bold mb-4" data-testid="blog-page-heading">Gen Z Digital Store Blog</h1>
          <p className="text-genz-muted text-lg max-w-2xl mx-auto">
            Tips, updates, and guides for AI, academic, SEO, and productivity tools.
          </p>
        </div>
        
        {/* Search Bar */}
        <div className="max-w-2xl mx-auto mb-8">
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-genz-muted" size={20} />
            <input
              type="text"
              placeholder="Search articles..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-12 pr-4 py-4 bg-white/[0.04] border border-white/10 rounded-full text-white placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
              data-testid="blog-search-input"
            />
          </div>
        </div>
        
        {/* Category Filter */}
        <div className="flex flex-wrap justify-center gap-3 mb-12">
          {categories.map(category => (
            <button
              key={category}
              onClick={() => setSelectedCategory(category)}
              className={`px-6 py-2 rounded-full text-sm font-medium transition-all duration-300 ${
                selectedCategory === category
                  ? 'bg-gradient-orange text-white shadow-lg shadow-genz-teal/25'
                  : 'border border-white/10 text-genz-muted hover:border-genz-teal hover:text-white bg-white/[0.04]/50'
              }`}
              data-testid={`blog-category-${category.toLowerCase().replace(/ /g, '-')}`}
            >
              {category}
            </button>
          ))}
        </div>
        
        {/* Featured Post */}
        {featuredPost && filteredPosts.length > 0 && (
          <Link
            to={`/blog/${featuredPost.slug}`}
            className="block mb-12 group"
            data-testid="featured-post"
          >
            <div className="bg-white/[0.04] border border-white/10 rounded-2xl overflow-hidden transition-all duration-300 hover:border-genz-teal hover:shadow-lg hover:shadow-genz-teal/10">
              <div className="grid md:grid-cols-2 gap-0">
                {/* Image */}
                <div 
                  className="h-64 md:h-full min-h-[300px]"
                  style={featuredPost.coverImage ? { 
                    backgroundImage: `url(${featuredPost.coverImage})`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center'
                  } : { background: featuredPost.coverGradient }}
                >
                </div>
                
                {/* Content */}
                <div className="p-8 flex flex-col justify-center">
                  <div className="flex items-center gap-2 mb-4">
                    {featuredPost.featured && (
                      <span className="px-3 py-1 bg-yellow-500/20 text-yellow-400 text-xs rounded-full">
                        Featured
                      </span>
                    )}
                    <span className="px-3 py-1 bg-genz-teal/20 text-genz-teal text-xs rounded-full">
                      {featuredPost.category}
                    </span>
                  </div>
                  
                  <h2 className="text-2xl md:text-3xl font-bold mb-4 group-hover:text-genz-teal transition-colors">
                    {featuredPost.title}
                  </h2>
                  
                  <p className="text-genz-muted mb-6 line-clamp-3">
                    {featuredPost.excerpt}
                  </p>
                  
                  <div className="flex items-center gap-4 text-sm text-genz-muted">
                    <div className="flex items-center gap-1">
                      <Calendar size={14} />
                      <span>{featuredPost.date}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Clock size={14} />
                      <span>{featuredPost.readTime}</span>
                    </div>
                    {featuredPost.views > 0 && (
                      <span>{featuredPost.views} views</span>
                    )}
                  </div>
                  
                  <div className="mt-6 text-genz-teal font-medium group-hover:underline">
                    Read Article →
                  </div>
                </div>
              </div>
            </div>
          </Link>
        )}
        
        {/* Blog Posts Grid */}
        {regularPosts.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {regularPosts.map(post => (
              <Link
                key={post.slug}
                to={`/blog/${post.slug}`}
                className="group bg-white/[0.04] border border-white/10 rounded-xl overflow-hidden transition-all duration-300 hover:-translate-y-2 hover:border-genz-teal hover:shadow-lg"
                data-testid={`blog-post-${post.slug}`}
              >
                {/* Cover Image */}
                <div 
                  className="h-48 w-full"
                  style={post.coverImage ? { 
                    backgroundImage: `url(${post.coverImage})`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center'
                  } : { background: post.coverGradient }}
                ></div>
                
                {/* Content */}
                <div className="p-6">
                  {/* Category Tag */}
                  <span className="inline-block px-3 py-1 bg-genz-teal/20 text-genz-teal text-xs rounded-full mb-3">
                    {post.category}
                  </span>
                  
                  {/* Title */}
                  <h2 className="text-xl font-bold mb-3 group-hover:text-genz-teal transition-colors line-clamp-2">
                    {post.title}
                  </h2>
                  
                  {/* Excerpt */}
                  <p className="text-genz-muted text-sm mb-4 line-clamp-3">
                    {post.excerpt}
                  </p>
                  
                  {/* Meta */}
                  <div className="flex items-center gap-4 text-xs text-genz-muted">
                    <div className="flex items-center gap-1">
                      <Calendar size={14} />
                      <span>{post.date}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Clock size={14} />
                      <span>{post.readTime}</span>
                    </div>
                  </div>
                  
                  {/* Read More */}
                  <div className="mt-4 text-genz-teal font-medium text-sm group-hover:underline">
                    Read More →
                  </div>
                </div>
              </Link>
            ))}
          </div>
        ) : filteredPosts.length === 0 ? (
          <div className="text-center py-20">
            <FileText size={48} className="mx-auto mb-4 text-genz-muted opacity-50" />
            <p className="text-genz-muted text-lg mb-4">No articles found matching your criteria.</p>
            <button 
              onClick={() => { setSearchTerm(''); setSelectedCategory('All'); }}
              className="text-genz-teal hover:underline"
            >
              Clear filters
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default Blog;
