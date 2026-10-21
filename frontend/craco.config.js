// craco.config.js
const path = require("path");
require("dotenv").config();

// Check if we're in development/preview mode (not production build)
// Craco sets NODE_ENV=development for start, NODE_ENV=production for build
const isDevServer = process.env.NODE_ENV !== "production";

// Environment variable overrides
const config = {
  enableHealthCheck: process.env.ENABLE_HEALTH_CHECK === "true",
  enableVisualEdits: isDevServer, // Only enable during dev server
};

// Conditionally load visual edits modules only in dev mode
let setupDevServer;
let babelMetadataPlugin;

if (config.enableVisualEdits) {
  setupDevServer = require("./plugins/visual-edits/dev-server-setup");
  babelMetadataPlugin = require("./plugins/visual-edits/babel-metadata-plugin");
}

// Conditionally load health check modules only if enabled
let WebpackHealthPlugin;
let setupHealthEndpoints;
let healthPluginInstance;

if (config.enableHealthCheck) {
  WebpackHealthPlugin = require("./plugins/health-check/webpack-health-plugin");
  setupHealthEndpoints = require("./plugins/health-check/health-endpoints");
  healthPluginInstance = new WebpackHealthPlugin();
}

const webpackConfig = {
  eslint: {
    configure: {
      extends: ["plugin:react-hooks/recommended"],
      rules: {
        "react-hooks/rules-of-hooks": "error",
        "react-hooks/exhaustive-deps": "warn",
      },
    },
  },
  webpack: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
    configure: (webpackConfig) => {

      // Add ignored patterns to reduce watched directories
        webpackConfig.watchOptions = {
          ...webpackConfig.watchOptions,
          ignored: [
            '**/node_modules/**',
            '**/.git/**',
            '**/build/**',
            '**/dist/**',
            '**/coverage/**',
            '**/public/**',
        ],
      };

      // Add health check plugin to webpack if enabled
      if (config.enableHealthCheck && healthPluginInstance) {
        webpackConfig.plugins.push(healthPluginInstance);
      }
      return webpackConfig;
    },
  },
};

// Only add babel metadata plugin during dev server
if (config.enableVisualEdits && babelMetadataPlugin) {
  webpackConfig.babel = {
    plugins: [babelMetadataPlugin],
  };
}

webpackConfig.devServer = (devServerConfig) => {
  // Apply visual edits dev server setup only if enabled
  if (config.enableVisualEdits && setupDevServer) {
    devServerConfig = setupDevServer(devServerConfig);
  }

  // Add health check endpoints if enabled
  if (config.enableHealthCheck && setupHealthEndpoints && healthPluginInstance) {
    const originalSetupMiddlewares = devServerConfig.setupMiddlewares;

    devServerConfig.setupMiddlewares = (middlewares, devServer) => {
      // Call original setup if exists
      if (originalSetupMiddlewares) {
        middlewares = originalSetupMiddlewares(middlewares, devServer);
      }

      // Setup health endpoints
      setupHealthEndpoints(devServer, healthPluginInstance);

      return middlewares;
    };
  }

  return devServerConfig;
};

// ── jest: make the INSTALLED router resolvable in tests ────────────────────────────────────────
// react-router-dom 7.16's package.json has "main": "./dist/main.js", which does not exist - only
// dist/index.js (CJS) and dist/index.mjs ship. Jest's resolver reads "main" and ignores the
// "exports" map, so `require('react-router-dom')` throws "Cannot find module" in tests while
// webpack, which does read "exports", resolves it correctly. That is why the CRM and assistant
// tests had to stub the router instead of exercising it.
//
// Mapping it to the real CJS build lets tests use the actual router. This affects jest only; the
// production webpack build resolves through "exports" exactly as before.
// react-router ships the same way, and react-router-dom's CJS build re-exports `react-router/dom`.
const routerDomDir = path.dirname(require.resolve('react-router-dom/package.json'));
const routerCoreDir = path.dirname(require.resolve('react-router/package.json'));
const routerCjsEntry = path.join(routerDomDir, 'dist', 'index.js');
const routerCoreEntry = path.join(routerCoreDir, 'dist', 'development', 'index.js');
const routerCoreDomEntry = path.join(routerCoreDir, 'dist', 'development', 'dom-export.js');

webpackConfig.jest = {
  configure: (jestConfig) => {
    jestConfig.moduleNameMapper = {
      ...(jestConfig.moduleNameMapper || {}),
      '^react-router-dom$': routerCjsEntry,
      '^react-router/dom$': routerCoreDomEntry,
      '^react-router$': routerCoreEntry,
    };
    return jestConfig;
  },
};

module.exports = webpackConfig;
