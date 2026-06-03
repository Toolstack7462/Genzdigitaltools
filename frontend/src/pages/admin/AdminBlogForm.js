import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import AdminLayout from '../../components/AdminLayout';
import { ArrowLeft, Save, Eye, Image } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';

const categories = ['AI Tools', 'Productivity', 'Tips & Tricks', 'Industry News', 'Tutorials', 'Case Studies', 'Updates', 'Other'];

const AdminBlogForm = () => {
  const navigate = useNavigate();
  const { id } = useParams();
  const { showSuccess, showError } = useToast();
  const isEditing = Boolean(id);
  
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState({
    title: '',
    slug: '',
    excerpt: '',
    content: '',
    coverImage: '',
    category: 'Other',
    tags: '',
    status: 'draft',
    featured: false
  });

  useEffect(() => {
    if (isEditing) {
      loadPost();
    }
  }, [id]);

  const loadPost = async () => {
    try {
      setLoading(true);
      const res = await api.get(`/admin/blog/${id}`);
      const post = res.data.post;
      setFormData({
        title: post.title || '',
        slug: post.slug || '',
        excerpt: post.excerpt || '',
        content: post.content || '',
        coverImage: post.coverImage || '',
        category: post.category || 'Other',
        tags: post.tags?.join(', ') || '',
        status: post.status || 'draft',
        featured: post.featured || false
      });
    } catch (error) {
      showError('Failed to load post');
      navigate('/admin/blog');
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
  };

  const generateSlug = () => {
    const slug = formData.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    setFormData(prev => ({ ...prev, slug }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formData.title.trim()) {
      showError('Title is required');
      return;
    }
    
    if (!formData.content.trim()) {
      showError('Content is required');
      return;
    }
    
    try {
      setSaving(true);
      
      const data = {
        ...formData,
        tags: formData.tags.split(',').map(t => t.trim()).filter(Boolean)
      };
      
      if (isEditing) {
        await api.put(`/admin/blog/${id}`, data);
        showSuccess('Post updated successfully');
      } else {
        await api.post('/admin/blog', data);
        showSuccess('Post created successfully');
      }
      
      navigate('/admin/blog');
    } catch (error) {
      showError(error.response?.data?.error || 'Failed to save post');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <AdminLayout>
        <div className="flex items-center justify-center min-h-[80vh]">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-genz-teal border-t-transparent"></div>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <button
            onClick={() => navigate('/admin/blog')}
            className="p-2 text-genz-muted hover:text-white transition-colors"
          >
            <ArrowLeft size={24} />
          </button>
          <div>
            <h1 className="text-3xl font-bold text-white">
              {isEditing ? 'Edit Post' : 'Create Post'}
            </h1>
            <p className="text-genz-muted">Fill in the details below</p>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="bg-white/[0.04] border border-white/10 rounded-xl p-6 space-y-6">
            {/* Title */}
            <div>
              <label className="block text-sm font-medium text-white mb-2">Title *</label>
              <input
                type="text"
                name="title"
                value={formData.title}
                onChange={handleChange}
                className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                placeholder="Enter post title"
                data-testid="post-title"
              />
            </div>

            {/* Slug */}
            <div>
              <label className="block text-sm font-medium text-white mb-2">Slug</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  name="slug"
                  value={formData.slug}
                  onChange={handleChange}
                  className="flex-1 px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                  placeholder="post-url-slug"
                  data-testid="post-slug"
                />
                <button
                  type="button"
                  onClick={generateSlug}
                  className="px-4 py-2 bg-white/5 border border-white/10 rounded-xl text-white hover:border-genz-teal transition-colors"
                >
                  Generate
                </button>
              </div>
            </div>

            {/* Excerpt */}
            <div>
              <label className="block text-sm font-medium text-white mb-2">Excerpt</label>
              <textarea
                name="excerpt"
                value={formData.excerpt}
                onChange={handleChange}
                rows={2}
                maxLength={300}
                className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors resize-none"
                placeholder="Brief description for previews (max 300 chars)"
                data-testid="post-excerpt"
              />
              <p className="text-xs text-genz-muted mt-1">{formData.excerpt.length}/300</p>
            </div>

            {/* Cover Image */}
            <div>
              <label className="block text-sm font-medium text-white mb-2">Cover Image URL</label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Image className="absolute left-4 top-1/2 -translate-y-1/2 text-genz-muted" size={18} />
                  <input
                    type="url"
                    name="coverImage"
                    value={formData.coverImage}
                    onChange={handleChange}
                    className="w-full pl-12 pr-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                    placeholder="https://example.com/image.jpg"
                    data-testid="post-cover-image"
                  />
                </div>
              </div>
              {formData.coverImage && (
                <div className="mt-2 rounded-lg overflow-hidden h-32 w-full bg-black/20">
                  <img 
                    src={formData.coverImage} 
                    alt="Cover preview" 
                    className="w-full h-full object-cover"
                    onError={(e) => e.target.style.display = 'none'}
                  />
                </div>
              )}
            </div>

            {/* Content */}
            <div>
              <label className="block text-sm font-medium text-white mb-2">Content *</label>
              <textarea
                name="content"
                value={formData.content}
                onChange={handleChange}
                rows={12}
                className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors font-mono text-sm"
                placeholder="Write your post content here... (Markdown supported)"
                data-testid="post-content"
              />
            </div>

            {/* Category & Tags */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-white mb-2">Category</label>
                <select
                  name="category"
                  value={formData.category}
                  onChange={handleChange}
                  className="w-full px-4 py-3 bg-[#000c20] border border-white/10 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-genz-teal/30 focus:border-genz-teal transition-all appearance-none cursor-pointer hover:border-genz-muted"
                  style={{ backgroundImage: "url('data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%278%27 viewBox=%270 0 12 8%27%3E%3Cpath fill=%27%23999%27 d=%27M6 8L0 0h12z%27/%3E%3C/svg%3E')", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 1rem center', backgroundSize: '0.75rem' }}
                  data-testid="post-category"
                >
                  {categories.map(cat => (
                    <option key={cat} value={cat} className="bg-[#000c20] text-white">{cat}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-white mb-2">Tags</label>
                <input
                  type="text"
                  name="tags"
                  value={formData.tags}
                  onChange={handleChange}
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-genz-muted focus:outline-none focus:border-genz-teal transition-colors"
                  placeholder="tag1, tag2, tag3"
                  data-testid="post-tags"
                />
              </div>
            </div>

            {/* Status & Featured */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-white mb-2">Status</label>
                <select
                  name="status"
                  value={formData.status}
                  onChange={handleChange}
                  className="w-full px-4 py-3 bg-[#000c20] border border-white/10 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-genz-teal/30 focus:border-genz-teal transition-all appearance-none cursor-pointer hover:border-genz-muted"
                  style={{ backgroundImage: "url('data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%278%27 viewBox=%270 0 12 8%27%3E%3Cpath fill=%27%23999%27 d=%27M6 8L0 0h12z%27/%3E%3C/svg%3E')", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 1rem center', backgroundSize: '0.75rem' }}
                  data-testid="post-status"
                >
                  <option value="draft" className="bg-[#000c20] text-white">Draft</option>
                  <option value="published" className="bg-[#000c20] text-white">Published</option>
                  <option value="archived" className="bg-[#000c20] text-white">Archived</option>
                </select>
              </div>
              <div className="flex items-center">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    name="featured"
                    checked={formData.featured}
                    onChange={handleChange}
                    className="w-5 h-5 rounded border-white/10 bg-white/5 text-genz-teal focus:ring-genz-teal focus:ring-offset-0"
                    data-testid="post-featured"
                  />
                  <span className="text-white">Feature this post</span>
                </label>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-4">
            <button
              type="button"
              onClick={() => navigate('/admin/blog')}
              className="px-6 py-3 bg-white/[0.04] border border-white/10 rounded-full text-white font-medium hover:border-genz-teal transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 px-6 py-3 bg-gradient-orange text-white rounded-full font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              data-testid="save-post-btn"
            >
              <Save size={18} />
              {saving ? 'Saving...' : (isEditing ? 'Update Post' : 'Create Post')}
            </button>
          </div>
        </form>
      </div>
    </AdminLayout>
  );
};

export default AdminBlogForm;
