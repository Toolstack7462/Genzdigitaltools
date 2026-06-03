const express = require('express');
const router = express.Router();
const Blog = require('../models/Blog');
const Contact = require('../models/Contact');
const User = require('../models/User');
const { normalizeAuthInputs } = require('../middleware/normalize');

// POST /api/crm/public/register - Public client registration
router.post('/register', normalizeAuthInputs, async (req, res) => {
  try {
    const { fullName, email, password } = req.body;
    
    // Validation
    if (!fullName || !email || !password) {
      return res.status(400).json({ 
        error: 'Full name, email, and password are required' 
      });
    }
    
    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    
    // Password validation
    if (password.length < 6) {
      return res.status(400).json({ 
        error: 'Password must be at least 6 characters' 
      });
    }
    
    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ 
        error: 'An account with this email already exists' 
      });
    }
    
    // Create new client user
    const client = await User.create({
      fullName: fullName.trim(),
      email: email.trim().toLowerCase(),
      passwordHash: password, // Will be hashed by pre-save hook
      role: 'CLIENT',
      status: 'active',
      devicePolicy: {
        enabled: true, // Enable device binding for clients
        maxDevices: 1
      }
    });
    
    console.log(`✅ New client registered: ${client.email} (ID: ${client._id})`);
    
    res.status(201).json({
      success: true,
      message: 'Account created successfully! You can now login.',
      user: {
        id: client._id,
        email: client.email,
        fullName: client.fullName,
        role: client.role
      }
    });
  } catch (error) {
    console.error('❌ Client registration error:', error);
    
    // Handle validation errors
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({ error: errors.join(', ') });
    }
    
    // Handle duplicate key errors (shouldn't happen with pre-check, but just in case)
    if (error.code === 11000) {
      return res.status(409).json({ 
        error: 'An account with this email already exists' 
      });
    }
    
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// GET /api/crm/public/blog - Get published blog posts
router.get('/blog', async (req, res) => {
  try {
    const { 
      category, 
      tag,
      search,
      page = 1,
      limit = 10,
      featured
    } = req.query;
    
    const query = { status: 'published' };
    
    if (category) query.category = category;
    if (tag) query.tags = tag;
    if (featured === 'true') query.featured = true;
    
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { excerpt: { $regex: search, $options: 'i' } }
      ];
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [posts, totalCount] = await Promise.all([
      Blog.find(query)
        .select('title slug excerpt coverImage category tags publishedAt views featured')
        .sort({ publishedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate('author', 'fullName'),
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
    console.error('Get public blog posts error:', error);
    res.status(500).json({ error: 'Failed to fetch blog posts' });
  }
});

// GET /api/crm/public/blog/categories - Get blog categories with counts
router.get('/blog/categories', async (req, res) => {
  try {
    const categories = await Blog.aggregate([
      { $match: { status: 'published' } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    
    res.json({
      success: true,
      categories
    });
  } catch (error) {
    console.error('Get blog categories error:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// GET /api/crm/public/blog/:slug - Get single blog post by slug
router.get('/blog/:slug', async (req, res) => {
  try {
    const post = await Blog.findOne({ 
      slug: req.params.slug,
      status: 'published'
    }).populate('author', 'fullName');
    
    if (!post) {
      return res.status(404).json({ error: 'Blog post not found' });
    }
    
    // Increment view count
    post.views += 1;
    await post.save();
    
    // Get related posts
    const relatedPosts = await Blog.find({
      _id: { $ne: post._id },
      status: 'published',
      $or: [
        { category: post.category },
        { tags: { $in: post.tags } }
      ]
    })
      .select('title slug excerpt coverImage publishedAt')
      .limit(3)
      .sort({ publishedAt: -1 });
    
    res.json({
      success: true,
      post,
      relatedPosts
    });
  } catch (error) {
    console.error('Get blog post error:', error);
    res.status(500).json({ error: 'Failed to fetch blog post' });
  }
});

// POST /api/crm/public/contact - Submit contact form
router.post('/contact', async (req, res) => {
  try {
    const { name, email, phone, subject, message } = req.body;
    
    // Validation
    if (!name || !email || !subject || !message) {
      return res.status(400).json({ 
        error: 'Name, email, subject, and message are required' 
      });
    }
    
    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    
    // Get client info
    const ipAddress = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                      req.socket?.remoteAddress || 
                      'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    
    const contact = await Contact.create({
      name,
      email,
      phone,
      subject,
      message,
      ipAddress,
      userAgent,
      status: 'new',
      priority: 'medium'
    });
    
    res.status(201).json({
      success: true,
      message: 'Thank you for contacting us! We will get back to you soon.',
      contactId: contact._id
    });
  } catch (error) {
    console.error('Submit contact error:', error);
    res.status(500).json({ error: 'Failed to submit contact form' });
  }
});

// GET /api/crm/public/tools - Get public tools listing
router.get('/tools', async (req, res) => {
  try {
    const Tool = require('../models/Tool');
    
    const { category, search } = req.query;
    
    const query = { status: 'active' };
    
    if (category) query.category = category;
    
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }
    
    const tools = await Tool.find(query)
      .select('name description category targetUrl')
      .sort({ name: 1 });
    
    res.json({
      success: true,
      tools
    });
  } catch (error) {
    console.error('Get public tools error:', error);
    res.status(500).json({ error: 'Failed to fetch tools' });
  }
});

module.exports = router;
