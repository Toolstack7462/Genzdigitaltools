const express = require('express');
const router = express.Router();
const Contact = require('../../models/Contact');
const ActivityLog = require('../../models/ActivityLog');
const { requireAuth, requireAdmin, getClientIp } = require('../../middleware/authEnhanced');

// Apply auth middleware
router.use(requireAuth);
router.use(requireAdmin);

// GET /api/crm/admin/contacts - List all contacts
router.get('/', async (req, res) => {
  try {
    const { 
      search, 
      status,
      priority,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;
    
    const query = {};
    
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { subject: { $regex: search, $options: 'i' } }
      ];
    }
    
    if (status) query.status = status;
    if (priority) query.priority = priority;
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };
    
    const [contacts, totalCount] = await Promise.all([
      Contact.find(query)
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .populate('repliedBy', 'fullName email'),
      Contact.countDocuments(query)
    ]);
    
    res.json({
      success: true,
      contacts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        totalCount,
        totalPages: Math.ceil(totalCount / parseInt(limit)),
        hasMore: skip + contacts.length < totalCount
      }
    });
  } catch (error) {
    console.error('Get contacts error:', error);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// GET /api/crm/admin/contacts/stats - Get contact statistics
router.get('/stats', async (req, res) => {
  try {
    const [total, newCount, read, replied, archived, byPriority] = await Promise.all([
      Contact.countDocuments(),
      Contact.countDocuments({ status: 'new' }),
      Contact.countDocuments({ status: 'read' }),
      Contact.countDocuments({ status: 'replied' }),
      Contact.countDocuments({ status: 'archived' }),
      Contact.aggregate([
        { $group: { _id: '$priority', count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ])
    ]);
    
    res.json({
      success: true,
      stats: {
        total,
        new: newCount,
        read,
        replied,
        archived,
        byPriority
      }
    });
  } catch (error) {
    console.error('Get contact stats error:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// GET /api/crm/admin/contacts/:id - Get single contact
router.get('/:id', async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id)
      .populate('repliedBy', 'fullName email');
    
    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    
    // Mark as read if new
    if (contact.status === 'new') {
      contact.status = 'read';
      await contact.save();
    }
    
    res.json({
      success: true,
      contact
    });
  } catch (error) {
    console.error('Get contact error:', error);
    res.status(500).json({ error: 'Failed to fetch contact' });
  }
});

// PUT /api/crm/admin/contacts/:id - Update contact (status, notes, priority)
router.put('/:id', async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id);
    
    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    
    const { status, adminNotes, priority } = req.body;
    
    if (status) {
      contact.status = status;
      if (status === 'replied') {
        contact.repliedAt = new Date();
        contact.repliedBy = req.userId;
      }
    }
    
    if (adminNotes !== undefined) contact.adminNotes = adminNotes;
    if (priority) contact.priority = priority;
    
    await contact.save();
    
    const ipAddress = getClientIp(req);
    
    await ActivityLog.log('ADMIN', req.userId, 'CONTACT_UPDATED', {
      contactId: contact._id,
      email: contact.email,
      status: contact.status,
      ipAddress
    });
    
    res.json({
      success: true,
      contact,
      message: 'Contact updated successfully'
    });
  } catch (error) {
    console.error('Update contact error:', error);
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// DELETE /api/crm/admin/contacts/:id - Delete contact
router.delete('/:id', async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id);
    
    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    
    const ipAddress = getClientIp(req);
    
    await ActivityLog.log('ADMIN', req.userId, 'CONTACT_DELETED', {
      contactId: contact._id,
      email: contact.email,
      ipAddress
    });
    
    await contact.deleteOne();
    
    res.json({
      success: true,
      message: 'Contact deleted successfully'
    });
  } catch (error) {
    console.error('Delete contact error:', error);
    res.status(500).json({ error: 'Failed to delete contact' });
  }
});

module.exports = router;
