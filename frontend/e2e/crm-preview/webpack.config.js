const path = require('path');
const HtmlWebpackPlugin = require(require('path').join(process.env.CRM_NM, 'html-webpack-plugin'));
const SRC = require('path').resolve(process.env.CRM_SRC);  // normalise: Windows separators must match webpack's
const NM = process.env.CRM_NM;
const STUB = (f) => path.resolve(__dirname, 'stubs', f);
module.exports = {
  mode: 'development', devtool: false,
  entry: path.resolve(__dirname, 'entry.js'),
  output: { path: path.resolve(__dirname, 'dist'), filename: 'preview.js', clean: true },
  resolve: {
    modules: [NM, 'node_modules'],
    extensions: ['.js', '.jsx'],
    alias: {
      crm: SRC,
      [path.join(SRC, 'features/business-crm/api')]: STUB('api.js'),
      [path.join(SRC, 'features/business-crm/BusinessCrmContext')]: STUB('context.js'),
      [path.join(SRC, 'features/business-crm/offline/db')]: STUB('offlinedb.js'),
      [path.join(SRC, 'features/business-crm/offline/queue')]: STUB('queue.js'),
    },
  },
  module: {
    rules: [
      { test: /\.m?jsx?$/, include: [SRC, path.resolve(__dirname)], exclude: /node_modules/,
        use: { loader: path.join(NM, 'babel-loader'), options: { presets: [[path.join(NM, 'babel-preset-react-app'), { runtime: 'automatic' }]], babelrc: false, configFile: false } } },
      { test: /\.css$/, use: [path.join(NM, 'style-loader'), path.join(NM, 'css-loader')] },
      { test: /\.(png|svg|jpe?g|webp)$/, type: 'asset/inline' },
    ],
  },
  plugins: [new HtmlWebpackPlugin({
    templateContent: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CRM preview</title></head><body style="margin:0"><div id="root"></div></body></html>',
  })],
  stats: 'errors-warnings',
};
