const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const config = require('../config');
const log = require('../logger');

puppeteer.use(StealthPlugin());

function findChrome() {
  const candidates = [
    config.browser.chromePath,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

// A crashed container can leave stale lock files that make Chromium refuse to start.
function clearProfileLocks(dir) {
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* ignore */ }
  }
}

async function launchBrowser() {
  const executablePath = findChrome();
  if (!executablePath) {
    throw new Error('Chrome/Chromium not found. Set CHROME_PATH (the Docker image installs /usr/bin/chromium).');
  }
  fs.mkdirSync(config.browser.profileDir, { recursive: true });
  clearProfileLocks(config.browser.profileDir);

  log.info(`Launching Chromium (${config.browser.headless ? 'headless' : 'headed'}) from ${executablePath}`);
  const lowMemoryArgs = config.browser.lowMemory
    ? [
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-sync',
        '--mute-audio',
        '--renderer-process-limit=2',
        '--js-flags=--max-old-space-size=256',
      ]
    : [];
  const browser = await puppeteer.launch({
    executablePath,
    headless: config.browser.headless, // puppeteer-core >=22: true == new headless
    userDataDir: config.browser.profileDir, // persists cookies => fewer logins/challenges
    defaultViewport: null,
    protocolTimeout: config.limits.protocolTimeoutMs,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=Translate,MediaRouter',
      '--lang=en-US,en',
      '--window-size=1366,768',
      ...lowMemoryArgs,
    ],
  });

  // Ad scripts love opening extra tabs. Each one costs RAM (and we only ever need the main tab), so close them.
  browser.on('targetcreated', async (target) => {
    try {
      if (target.type() !== 'page' || !browser.mainPage) return; // ignore until our own tab exists
      const popup = await target.page();
      if (popup && popup !== browser.mainPage && !popup.isClosed()) {
        log.info(`Closing popup tab: ${target.url().slice(0, 80)}`);
        await popup.close();
      }
    } catch { /* tab already gone */ }
  });
  return browser;
}

async function preparePage(browser) {
  const page = await browser.newPage();
  browser.mainPage = page; // anything else that opens later is an ad popup / popunder
  if (config.browser.userAgent) await page.setUserAgent(config.browser.userAgent);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.setViewport({ width: 1366, height: 768 });
  page.setDefaultTimeout(config.limits.elementTimeoutMs);
  page.setDefaultNavigationTimeout(config.limits.navigationTimeoutMs);
  page.on('pageerror', (e) => log.debug('pageerror:', e.message));

  if (config.browser.liteMode) {
    // Skip images and fonts: far less data to decode on a weak CPU. Cloudflare's own requests are left alone.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      try {
        if (req.isInterceptResolutionHandled()) return;
        const type = req.resourceType();
        if ((type === 'image' || type === 'font') && !/cloudflare/i.test(req.url())) return void req.abort();
        return void req.continue();
      } catch { /* request already handled / page closed */ }
    });
    log.info('LITE_MODE on: blocking images and fonts');
  }
  return page;
}

module.exports = { launchBrowser, preparePage };