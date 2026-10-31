'use strict';
// Phone-size screenshots (light + dark) of the app on the local dev server.
// Requires Playwright (npm i -D playwright && npx playwright install chromium).
// Run: node test/screenshot.js  -> writes screenshots/light.png and screenshots/dark.png
process.env.PORT = process.env.PORT || '3457';
const path = require('path'), fs = require('fs');
const server = require('./dev-server');
const { chromium } = require('playwright');

(async () => {
  const out = path.join(__dirname, '..', 'screenshots');
  fs.mkdirSync(out, { recursive: true });
  const b = await chromium.launch();
  for (const scheme of ['light', 'dark']) {
    const p = await b.newPage({ viewport: { width: 400, height: 900 }, colorScheme: scheme });
    await p.goto('http://127.0.0.1:' + process.env.PORT);
    await p.waitForTimeout(1500);
    await p.screenshot({ path: path.join(out, scheme + '.png'), fullPage: true });
    await p.close();
  }
  await b.close(); server.close();
  console.log('Saved screenshots/light.png and screenshots/dark.png');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
