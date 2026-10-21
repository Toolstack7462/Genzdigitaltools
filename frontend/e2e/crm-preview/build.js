const path = require('path');
const webpack = require(path.join(process.env.CRM_NM, 'webpack'));
const config = require('./webpack.config.js');
webpack(config, (err, stats) => {
  if (err) { console.error('FATAL', err.message); process.exit(1); }
  if (stats.hasErrors()) {
    console.error(stats.toString({ all: false, errors: true, errorDetails: false, colors: false }).slice(0, 1800));
    process.exit(1);
  }
  console.log('built in', stats.endTime - stats.startTime, 'ms');
});
