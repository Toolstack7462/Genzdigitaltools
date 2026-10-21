# CRM interactive preview + modal-isolation regression

A real-browser harness for the Business CRM sale form, built from the REAL components with the
API, CRM context and offline modules aliased to synthetic stubs. No network, no production data.

## Why it exists

`modalIsolation.cjs` catches something jsdom cannot. A `dispatchEvent(new KeyboardEvent('keydown',
{key:'Enter'}))` does not trigger a browser's **implicit form submission**, so a jsdom test reported
the quick-create modal as safe while, in Chromium, pressing Enter in the modal's name field
submitted the PARENT SALE. The fix is in `components/ui.jsx` (`Modal` swallows Enter for non-textarea
targets, and its Close control is `type="button"`).

The suite also runs a **control**: the same complete sale is deliberately saved at the end and must
submit. Without it a passing run could simply mean the parent form was invalid and refusing anyway.

## Run

```sh
# 1. build the preview bundle (webpack Node API - webpack-cli is NOT required/installed)
cd frontend/e2e/crm-preview
NODE_ENV=development BABEL_ENV=development \
  CRM_SRC=../../src CRM_NM=../../node_modules \
  node build.js

# 2. drive it
CRM_PREVIEW=. ZEE_CHROMIUM=/path/to/chromium node modalIsolation.cjs
```

Notes that cost time when this was written:
* `babel-preset-react-app` requires `BABEL_ENV`/`NODE_ENV` to be set.
* the babel-loader `include` path must be `path.resolve()`d, or on Windows the separators never
  match and JSX is silently left untransformed.
* `HtmlWebpackPlugin`'s default template has no `#root`, so the app mounts nowhere.
* the installed Chromium is a Playwright build; Chrome 155 stable ignores `--load-extension`.

This is synthetic-data evidence. It is **not** authenticated acceptance against production.
