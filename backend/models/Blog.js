'use strict';
const { createModel } = require('../db/mysqlAdapter');

const Blog = createModel('Blog', {
  preSave: async (data, original) => {
    if (data.title && (!data.slug || !original || data.title !== original.title)) {
      if (!data.slug) {
        data.slug = String(data.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Date.now().toString(36);
      }
    }
    if (data.status === 'published' && !data.publishedAt) data.publishedAt = new Date();
    return data;
  }
});
module.exports = Blog;
