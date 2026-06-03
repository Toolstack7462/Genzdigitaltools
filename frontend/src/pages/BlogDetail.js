import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Calendar, Clock, Tag, Eye } from 'lucide-react';
import { getBlogPost, getRelatedPosts } from '../data/blogData';
import { useEffect, useState } from 'react';
import api from '../services/api';

const BlogDetail = () => {
  const { slug } = useParams();
  const [post, setPost] = useState(null);
  const [relatedPosts, setRelatedPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [useStaticData, setUseStaticData] = useState(false);
  
  useEffect(() => {
    window.scrollTo(0, 0);
    loadPost();
  }, [slug]);
  
  const loadPost = async () => {
    try {
      setLoading(true);
      const res = await api.get(`/public/blog/${slug}`);
      
      if (res.data.post) {
        const dbPost = res.data.post;
        setPost({
          slug: dbPost.slug,
          title: dbPost.title,
          excerpt: dbPost.excerpt,
          content: dbPost.content,
          category: dbPost.category,
          tags: dbPost.tags || [],
          date: new Date(dbPost.publishedAt || dbPost.createdAt).toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
          }),
          readTime: `${Math.ceil((dbPost.content?.length || 0) / 1000)} min read`,
          coverImage: dbPost.coverImage,
          coverGradient: dbPost.coverImage ? null : `linear-gradient(135deg, hsl(${Math.random() * 360}, 70%, 50%), hsl(${Math.random() * 360}, 70%, 30%))`,
          views: dbPost.views,
          author: dbPost.author?.fullName || 'Gen Z Digital Store Team'
        });
        
        // Set related posts from API
        if (res.data.relatedPosts) {
          setRelatedPosts(res.data.relatedPosts.map(rp => ({
            slug: rp.slug,
            title: rp.title,
            category: rp.category || 'Other',
            readTime: `${Math.ceil((rp.content?.length || 0) / 1000)} min read`,
            coverImage: rp.coverImage,
            coverGradient: rp.coverImage ? null : `linear-gradient(135deg, hsl(${Math.random() * 360}, 70%, 50%), hsl(${Math.random() * 360}, 70%, 30%))`
          })));
        }
        
        document.title = `${dbPost.title} | Gen Z Digital Store Blog`;
        setUseStaticData(false);
      }
    } catch (error) {
      console.log('Trying static data:', error);
      // Fallback to static data
      const staticPost = getBlogPost(slug);
      const staticRelated = getRelatedPosts(slug, 3);
      
      if (staticPost) {
        setPost(staticPost);
        setRelatedPosts(staticRelated);
        document.title = `${staticPost.title} | Gen Z Digital Store Blog`;
        setUseStaticData(true);
      } else {
        setPost(null);
      }
    } finally {
      setLoading(false);
    }
  };
  
  if (loading) {
    return (
      <div className="text-white min-h-screen pt-24 pb-16 px-4">
        <div className="max-w-4xl mx-auto flex items-center justify-center min-h-[60vh]">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-genz-teal border-t-transparent"></div>
        </div>
      </div>
    );
  }
  
  if (!post) {
    return (
      <div className="text-white min-h-screen pt-24 pb-16 px-4">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="text-4xl font-bold mb-4">Article Not Found</h1>
          <p className="text-genz-muted mb-8">The article you're looking for doesn't exist.</p>
          <Link to="/blog" className="inline-block px-6 py-3 bg-gradient-orange text-white rounded-full hover:opacity-90 transition-opacity">
            Back to Blog
          </Link>
        </div>
      </div>
    );
  }
  
  // Render markdown/HTML content
  const renderContent = (content) => {
    // Simple markdown to HTML conversion for basic formatting
    if (!content) return '';
    
    // If content already has HTML tags, render as-is
    if (content.includes('<') && content.includes('>')) {
      return content;
    }
    
    // Otherwise, convert basic markdown
    let html = content
      .replace(/^### (.*$)/gm, '<h3>$1</h3>')
      .replace(/^## (.*$)/gm, '<h2>$1</h2>')
      .replace(/^# (.*$)/gm, '<h1>$1</h1>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br/>');
    
    return `<p>${html}</p>`;
  };
  
  return (
    <div className="text-white min-h-screen pt-24 pb-16 px-4">
      <div className="max-w-4xl mx-auto">
        {/* Back Button */}
        <Link 
          to="/blog" 
          className="inline-flex items-center gap-2 text-genz-muted hover:text-genz-teal transition-colors mb-8"
          data-testid="back-to-blog"
        >
          <ArrowLeft size={20} />
          <span>Back to Blog</span>
        </Link>
        
        {/* Article Header */}
        <article>
          {/* Category Tag */}
          <div className="mb-4 flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1 px-3 py-1 bg-genz-teal/20 text-genz-teal text-sm rounded-full">
              <Tag size={14} />
              {post.category}
            </span>
            {post.tags?.map(tag => (
              <span key={tag} className="px-3 py-1 bg-white/10 text-genz-muted text-sm rounded-full">
                {tag}
              </span>
            ))}
          </div>
          
          {/* Title */}
          <h1 className="text-4xl md:text-5xl font-bold mb-6 leading-tight" data-testid="blog-title">
            {post.title}
          </h1>
          
          {/* Meta */}
          <div className="flex items-center gap-6 text-genz-muted mb-8 pb-8 border-b border-white/10 flex-wrap">
            <div className="flex items-center gap-2">
              <Calendar size={18} />
              <span>{post.date}</span>
            </div>
            <div className="flex items-center gap-2">
              <Clock size={18} />
              <span>{post.readTime}</span>
            </div>
            {post.views > 0 && (
              <div className="flex items-center gap-2">
                <Eye size={18} />
                <span>{post.views} views</span>
              </div>
            )}
            {post.author && (
              <div className="text-white">
                By <span className="font-medium">{post.author}</span>
              </div>
            )}
          </div>
          
          {/* Cover Image or Gradient */}
          <div 
            className="h-64 md:h-96 w-full rounded-2xl mb-12"
            style={post.coverImage ? {
              backgroundImage: `url(${post.coverImage})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center'
            } : { background: post.coverGradient }}
          ></div>
          
          {/* Excerpt */}
          {post.excerpt && (
            <div className="text-xl text-genz-muted mb-8 italic border-l-4 border-genz-teal pl-4">
              {post.excerpt}
            </div>
          )}
          
          {/* Article Content */}
          <div 
            className="prose prose-invert prose-lg max-w-none mb-16"
            style={{
              '--tw-prose-body': '#A1A1AA',
              '--tw-prose-headings': '#FFFFFF',
              '--tw-prose-links': '#F47A20',
              '--tw-prose-bold': '#FFFFFF',
              '--tw-prose-quotes': '#A1A1AA'
            }}
            dangerouslySetInnerHTML={{ __html: renderContent(post.content) }}
          />
        </article>
        
        {/* Related Posts */}
        {relatedPosts.length > 0 && (
          <div className="mt-16 pt-16 border-t border-white/10">
            <h2 className="text-2xl font-bold mb-8">Related Articles</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {relatedPosts.map(relatedPost => (
                <Link
                  key={relatedPost.slug}
                  to={`/blog/${relatedPost.slug}`}
                  className="group bg-white/[0.04] border border-white/10 rounded-xl overflow-hidden transition-all duration-300 hover:-translate-y-1 hover:border-genz-teal"
                  data-testid={`related-post-${relatedPost.slug}`}
                >
                  <div 
                    className="h-32 w-full"
                    style={relatedPost.coverImage ? {
                      backgroundImage: `url(${relatedPost.coverImage})`,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center'
                    } : { background: relatedPost.coverGradient }}
                  ></div>
                  <div className="p-4">
                    <span className="inline-block px-2 py-1 bg-genz-teal/20 text-genz-teal text-xs rounded-full mb-2">
                      {relatedPost.category}
                    </span>
                    <h3 className="text-sm font-semibold mb-2 line-clamp-2 group-hover:text-genz-teal transition-colors">
                      {relatedPost.title}
                    </h3>
                    <div className="text-xs text-genz-muted">
                      {relatedPost.readTime}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
        
        {/* CTA Section */}
        <div className="mt-16 bg-gradient-orange rounded-2xl p-8 text-center">
          <h3 className="text-2xl font-bold mb-3">Get Access to All Tools Mentioned</h3>
          <p className="text-lg mb-6 opacity-90">
            Subscribe to Gen Z Digital Store and unlock 90+ premium tools with one simple subscription.
          </p>
          <Link 
            to="/join" 
            className="inline-block px-8 py-3 bg-white text-genz-teal rounded-full font-medium hover:bg-gray-100 transition-colors"
          >
            Get Started Today
          </Link>
        </div>
      </div>
    </div>
  );
};

export default BlogDetail;
