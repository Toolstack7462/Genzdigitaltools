const express = require('express');
const router = express.Router();
const Blog = require('../../models/Blog');
const ActivityLog = require('../../models/ActivityLog');
const { requireAuth, requireAdmin, getClientIp } = require('../../middleware/authEnhanced');

// Apply auth middleware
router.use(requireAuth);
router.use(requireAdmin);

// GET /api/crm/admin/blog - List all blog posts
router.get('/', async (req, res) => {
  try {
    const { 
      search, 
      category, 
      status,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;
    
    const query = {};
    
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { content: { $regex: search, $options: 'i' } }
      ];
    }
    
    if (category) query.category = category;
    if (status) query.status = status;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };
    
    const [posts, totalCount] = await Promise.all([
      Blog.find(query)
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .populate('author', 'fullName email'),
      Blog.countDocuments(query)
    ]);
    
    res.json({
      success: true,
      posts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        totalCount,
        totalPages: Math.ceil(totalCount / parseInt(limit)),
        hasMore: skip + posts.length < totalCount
      }
    });
  } catch (error) {
    console.error('Get blog posts error:', error);
    res.status(500).json({ error: 'Failed to fetch blog posts' });
  }
});

// GET /api/crm/admin/blog/stats - Get blog statistics
router.get('/stats', async (req, res) => {
  try {
    const [total, published, draft, archived, byCategory] = await Promise.all([
      Blog.countDocuments(),
      Blog.countDocuments({ status: 'published' }),
      Blog.countDocuments({ status: 'draft' }),
      Blog.countDocuments({ status: 'archived' }),
      Blog.aggregate([
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ])
    ]);
    
    res.json({
      success: true,
      stats: {
        total,
        published,
        draft,
        archived,
        byCategory
      }
    });
  } catch (error) {
    console.error('Get blog stats error:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// GET /api/crm/admin/blog/:id - Get single blog post
router.get('/:id', async (req, res) => {
  try {
    const post = await Blog.findById(req.params.id)
      .populate('author', 'fullName email');
    
    if (!post) {
      return res.status(404).json({ error: 'Blog post not found' });
    }
    
    res.json({
      success: true,
      post
    });
  } catch (error) {
    console.error('Get blog post error:', error);
    res.status(500).json({ error: 'Failed to fetch blog post' });
  }
});

// POST /api/crm/admin/blog - Create blog post
router.post('/', async (req, res) => {
  try {
    const { title, slug, excerpt, content, coverImage, category, tags, status, featured } = req.body;
    
    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content are required' });
    }
    
    // Check for duplicate slug
    if (slug) {
      const existing = await Blog.findOne({ slug });
      if (existing) {
        return res.status(400).json({ error: 'A post with this slug already exists' });
      }
    }
    
    const postData = {
      title,
      excerpt,
      content,
      coverImage,
      category,
      tags: tags || [],
      status: status || 'draft',
      featured: featured || false,
      author: req.userId
    };
    
    if (slug) {
      postData.slug = slug;
    }
    
    const post = await Blog.create(postData);
    
    const ipAddress = getClientIp(req);
    
    await ActivityLog.log('ADMIN', req.userId, 'BLOG_CREATED', {
      postId: post._id,
      title: post.title,
      status: post.status,
      ipAddress
    });
    
    res.status(201).json({
      success: true,
      post,
      message: 'Blog post created successfully'
    });
  } catch (error) {
    console.error('Create blog post error:', error);
    res.status(500).json({ error: 'Failed to create blog post' });
  }
});

// PUT /api/crm/admin/blog/:id - Update blog post
router.put('/:id', async (req, res) => {
  try {
    const post = await Blog.findById(req.params.id);
    
    if (!post) {
      return res.status(404).json({ error: 'Blog post not found' });
    }
    
    const { title, slug, excerpt, content, coverImage, category, tags, status, featured } = req.body;
    
    // Check for duplicate slug if changing
    if (slug && slug !== post.slug) {
      const existing = await Blog.findOne({ slug, _id: { $ne: post._id } });
      if (existing) {
        return res.status(400).json({ error: 'A post with this slug already exists' });
      }
    }
    
    // Track changes
    const changes = {};
    const fields = ['title', 'slug', 'excerpt', 'content', 'coverImage', 'category', 'status', 'featured'];
    
    fields.forEach(field => {
      if (req.body[field] !== undefined && req.body[field] !== post[field]) {
        changes[field] = { from: post[field], to: req.body[field] };
        post[field] = req.body[field];
      }
    });
    
    if (tags) {
      post.tags = tags;
    }
    
    await post.save();
    
    const ipAddress = getClientIp(req);
    
    await ActivityLog.log('ADMIN', req.userId, 'BLOG_UPDATED', {
      postId: post._id,
      title: post.title,
      changes,
      ipAddress
    });
    
    res.json({
      success: true,
      post,
      message: 'Blog post updated successfully'
    });
  } catch (error) {
    console.error('Update blog post error:', error);
    res.status(500).json({ error: 'Failed to update blog post' });
  }
});

// DELETE /api/crm/admin/blog/:id - Delete blog post
router.delete('/:id', async (req, res) => {
  try {
    const post = await Blog.findById(req.params.id);
    
    if (!post) {
      return res.status(404).json({ error: 'Blog post not found' });
    }
    
    const ipAddress = getClientIp(req);
    
    await ActivityLog.log('ADMIN', req.userId, 'BLOG_DELETED', {
      postId: post._id,
      title: post.title,
      ipAddress
    });
    
    await post.deleteOne();
    
    res.json({
      success: true,
      message: 'Blog post deleted successfully'
    });
  } catch (error) {
    console.error('Delete blog post error:', error);
    res.status(500).json({ error: 'Failed to delete blog post' });
  }
});

module.exports = router;
