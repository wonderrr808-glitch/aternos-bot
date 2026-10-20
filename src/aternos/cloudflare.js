const log = require('../logger');
const { sleep, AternosError, screenshot } = require('./helpers');
const config = require('../config');

async function isChallengePage(page) {
  try {
    const title = await page.title();
    if (/just a moment|attention required|un instant|checking your browser/i.test(title)) return true;
    // Challenge widget present AND none of Aternos' real UI present yet
    return await page.evaluate(() => {
      const challenge = document.querySelector(
        '#challenge-running, #challenge-form, #cf-challenge-running, .cf-turnstile, iframe[src*="challenges.cloudflare.com"]'
      );
      const realUi = document.querySelector('input.username, #start, .server-body, .servercard');
      return !!challenge && !realUi;
    });
  } catch {
    return false; // navigation in progress / context destroyed
  }
}

/** Best effort: click the Turnstile checkbox with a human-ish mouse path. */
async function tryClickTurnstile(page) {
  for (const frame of page.frames()) {
    if (!frame.url().includes('challenges.cloudflare.com')) continue;
    try {
      const host = await frame.frameElement();
      const box = host && (await host.boundingBox());
      if (!box) continue;
      const x = box.x + 28 + Math.random() * 6;
      const y = box.y + box.height / 2 + (Math.random() * 4 - 2);
      await page.mouse.move(x - 120, y - 40, { steps: 12 });
      await page.mouse.move(x, y, { steps: 18 });
      await sleep(150 + Math.random() * 200);
      await page.mouse.click(x, y, { delay: 60 + Math.random() * 60 });
      log.info('Clicked Turnstile checkbox');
      return true;
    } catch (e) {
      log.debug('Turnstile click failed:', e.message);
    }
  }
  return false;
}

/** Wait until any Cloudflare interstitial / Turnstile has cleared, or time out. */
async function waitForCloudflare(page, notify = async () => {}) {
  const deadline = Date.now() + config.limits.cloudflareTimeoutMs;
  let announced = false;
  let lastClick = 0;

  while (Date.now() < deadline) {
    if (!(await isChallengePage(page))) return;
    if (!announced) {
      announced = true;
      log.warn('Cloudflare challenge detected');
      await notify('🛡️ Cloudflare challenge detected, trying to pass it...');
    }
    if (Date.now() - lastClick > 8000) {
      lastClick = Date.now();
      await tryClickTurnstile(page);
    }
    await sleep(1500);
  }
  throw new AternosError(
    'Blocked by Cloudflare (challenge did not clear). Try HEADLESS=false, a residential IP, or wait and retry.',
    { screenshot: await screenshot(page) }
  );
}

module.exports = { waitForCloudflare, isChallengePage };
