import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import AdminLayout from '../../components/AdminLayout';
import { Plus, Search, Edit2, Trash2, Eye, EyeOff, FileText, Star, StarOff } from 'lucide-react';
import api from '../../services/api';
import { useToast } from '../../components/Toast';
import ConfirmModal from '../../components/ConfirmModal';

const AdminBlog = () => {
  const navigate = useNavigate();
  const { showSuccess, showError } = useToast();
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [deleteModal, setDeleteModal] = useState({ open: false, post: null });

  useEffect(() => {
    loadPosts();
  }, [statusFilter]);

  const loadPosts = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (statusFilter) params.append('status', statusFilter);
      
      const res = await api.get(`/admin/blog?${params}`);
      setPosts(res.data.posts || []);
    } catch (error) {
      showError('Failed to load blog posts');
    } finally {
      setLoading(false);
    }
  };

  const toggleStatus = async (post) => {
    try {
      const newStatus = post.status === 'published' ? 'draft' : 'published';
      await api.put(`/admin/blog/${post._id}`, { status: newStatus });
      setPosts(posts.map(p => p._id === post._id ? { ...p, status: newStatus } : p));
      showSuccess(`Post ${newStatus === 'published' ? 'published' : 'unpublished'}`);
    } catch (error) {
      showError('Failed to update status');
    }
  };

  const toggleFeatured = async (post) => {
    try {
      const newFeatured = !post.featured;
      await api.put(`/admin/blog/${post._id}`, { featured: newFeatured });
      setPosts(posts.map(p => p._id === post._id ? { ...p, featured: newFeatured } : p));
      showSuccess(`Post ${newFeatured ? 'featured' : 'unfeatured'}`);
    } catch (error) {
      showError('Failed to update featured status');
    }
  };

  const handleDelete = async () => {
    if (!deleteModal.post) return;
    try {
      await api.delete(`/admin/blog/${deleteModal.post._id}`);
      setPosts(posts.filter(p => p._id !== deleteModal.post._id));
      showSuccess('Post deleted successfully');
      setDeleteModal({ open: false, post: null });
    } catch (error) {
      showError('Failed to delete post');
    }
  };

  const filteredPosts = posts.filter(post =>
    post.title?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    post.excerpt?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const getStatusBadge = (status) => {
    switch (status) {
      case 'published':
        return 'bg-green-500/20 text-green-400';
      case 'draft':
        return 'bg-yellow-500/20 text-yellow-400';
      case 'archived':
        return 'bg-gray-500/20 text-gray-400';
      default:
        return 'bg-gray-500/20 text-gray-400';
    }
  };

  if (loading) {
    return (
      <AdminLayout>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8" aria-busy="true" aria-label="Loading posts">
          <div className="flex justify-between items-center gap-4 mb-8 animate-pulse">
            <div className="space-y-2">
              <div className="h-7 w-40 rounded bg-white/10" />
              <div className="h-4 w-52 rounded bg-white/[0.07]" />
            </div>
            <div className="h-11 w-32 rounded-full bg-white/10" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden animate-pulse">
                <div className="h-40 bg-white/[0.07]" />
                <div className="p-5 space-y-3">
                  <div className="h-5 w-20 rounded-full bg-white/10" />
                  <div className="h-4 w-4/5 rounded bg-white/10" />
                  <div className="h-3 w-full rounded bg-white/[0.07]" />
                  <div className="h-3 w-2/3 rounded bg-white/[0.07]" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-white mb-2">Blog Posts</h1>
            <p className="text-genz-muted">Manage your blog content</p>
          </div>
          <button
            onClick={() => navigate('/admin/blog/new')}
            className="flex items-center gap-2 px-6 py-3 bg-gradient-orange text-white rounded-full font-medium hover:opacity-90 transition-opacity"
            data-testid="create-post-btn"
          >
            <Plus size={20} />
            New Post
          </button>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4 mb-6">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-genz-muted pointer-events-none" size={20} />
            <input
              type="text"
              placeholder="Search posts..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-12 pr-4 py-3 bg-[#000c20] border border-white/10 rounded-lg text-white placeholder-genz-muted focus:outline-none focus:ring-2 focus:ring-genz-teal/30 focus:border-genz-teal transition-all hover:border-genz-muted"
              data-testid="search-posts-input"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-4 py-3 bg-[#000c20] border border-white/10 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-genz-teal/30 focus:border-genz-teal transition-all appearance-none cursor-pointer hover:border-genz-muted min-w-[160px]"
            style={{ backgroundImage: "url('data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%278%27 viewBox=%270 0 12 8%27%3E%3Cpath fill=%27%23999%27 d=%27M6 8L0 0h12z%27/%3E%3C/svg%3E')", backgroundRepeat: 'no-repeat', backgroundPosition: 'right 1rem center', backgroundSize: '0.75rem' }}
            data-testid="status-filter"
          >
            <option value="" className="bg-[#000c20] text-white">All Status</option>
            <option value="published" className="bg-[#000c20] text-white">Published</option>
            <option value="draft" className="bg-[#000c20] text-white">Draft</option>
            <option value="archived" className="bg-[#000c20] text-white">Archived</option>
          </select>
        </div>

        {/* Posts Grid */}
        {filteredPosts.length === 0 ? (
          <div className="bg-white/[0.04] border border-white/10 rounded-xl p-12 text-center">
            <FileText size={48} className="mx-auto mb-4 text-genz-muted opacity-50" />
            <h3 className="text-lg font-medium text-white mb-2">
              {searchTerm ? 'No posts found' : 'No blog posts yet'}
            </h3>
            <p className="text-genz-muted mb-4">
              {searchTerm ? 'Try a different search term' : 'Create your first blog post'}
            </p>
            {!searchTerm && (
              <button
                onClick={() => navigate('/admin/blog/new')}
                className="px-6 py-2 bg-gradient-orange text-white rounded-full font-medium hover:opacity-90"
              >
                Create Post
              </button>
            )}
          </div>
        ) : (
          <div className="grid gap-4">
            {filteredPosts.map((post) => (
              <div
                key={post._id}
                className="bg-white/[0.04] border border-white/10 rounded-xl p-6 hover:border-genz-teal/50 transition-all duration-300"
                data-testid={`post-card-${post._id}`}
              >
                <div className="flex flex-col sm:flex-row justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2 flex-wrap">
                      <h3 className="text-lg font-semibold text-white">{post.title}</h3>
                      <span className={`px-2 py-0.5 text-xs rounded-full ${getStatusBadge(post.status)}`}>
                        {post.status}
                      </span>
                      {post.featured && (
                        <span className="px-2 py-0.5 text-xs rounded-full bg-genz-teal/20 text-genz-teal">
                          Featured
                        </span>
                      )}
                    </div>
                    <p className="text-genz-muted text-sm mb-3 line-clamp-2">{post.excerpt || 'No excerpt'}</p>
                    <div className="flex items-center gap-4 text-xs text-genz-muted">
                      <span className="bg-white/5 px-2 py-1 rounded">{post.category}</span>
                      <span>{post.views || 0} views</span>
                      <span>Created: {new Date(post.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 sm:flex-col sm:items-end">
                    <button
                      onClick={() => toggleStatus(post)}
                      className="p-2 text-genz-muted hover:text-white transition-colors"
                      title={post.status === 'published' ? 'Unpublish' : 'Publish'}
                      data-testid={`toggle-status-${post._id}`}
                    >
                      {post.status === 'published' ? (
                        <Eye size={20} className="text-green-400" />
                      ) : (
                        <EyeOff size={20} />
                      )}
                    </button>
                    <button
                      onClick={() => toggleFeatured(post)}
                      className="p-2 text-genz-muted hover:text-yellow-400 transition-colors"
                      title={post.featured ? 'Unfeature' : 'Feature'}
                      data-testid={`toggle-featured-${post._id}`}
                    >
                      {post.featured ? (
                        <Star size={20} className="text-yellow-400 fill-yellow-400" />
                      ) : (
                        <StarOff size={20} />
                      )}
                    </button>
                    <button
                      onClick={() => navigate(`/admin/blog/${post._id}/edit`)}
                      className="p-2 text-genz-muted hover:text-genz-teal transition-colors"
                      title="Edit"
                      data-testid={`edit-post-${post._id}`}
                    >
                      <Edit2 size={20} />
                    </button>
                    <button
                      onClick={() => setDeleteModal({ open: true, post })}
                      className="p-2 text-genz-muted hover:text-red-400 transition-colors"
                      title="Delete"
                      data-testid={`delete-post-${post._id}`}
                    >
                      <Trash2 size={20} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmModal
        isOpen={deleteModal.open}
        onClose={() => setDeleteModal({ open: false, post: null })}
        onConfirm={handleDelete}
        title="Delete Post"
        message={`Are you sure you want to delete "${deleteModal.post?.title}"? This action cannot be undone.`}
        confirmText="Delete"
        confirmStyle="danger"
      />
    </AdminLayout>
  );
};

export default AdminBlog;
