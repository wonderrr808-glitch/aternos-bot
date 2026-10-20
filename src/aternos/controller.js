const config = require('../config');
const log = require('../logger');
const { launchBrowser, preparePage } = require('./browser');
const { waitForCloudflare } = require('./cloudflare');
const { memInfo, sleep, humanDelay, AternosError, step, screenshot, clickByText, clickIfPresent } = require('./helpers');

const URLS = {
  login: 'https://aternos.org/go/',
  servers: 'https://aternos.org/servers/',
  server: 'https://aternos.org/server/',
};

/**
 * ⚠️ Selectors below reflect Aternos' markup at time of writing and WILL drift.
 * Keep them all here so fixing a breakage is a one-file change.
 */
const SEL = {
  username: 'input.username',
  password: 'input.password',
  loginButton: 'button.login-button',
  loginError: '.login-error, #login-error, .alert-danger',
  serverCard: '.server-body, .servercard',
  startButton: '#start',
  confirmButton: '#confirm',
  statusLabel: '.statuslabel-label',
  consentButtons: ['.fc-cta-consent', '#didomi-notice-agree-button', 'button.fc-button.fc-cta-consent'],
  dialogScope: '.alert, .alert-buttons, .modal, [class*="popup"], [class*="dialog"]',
};

// Close buttons of third-party ad overlays (matched in the page and in every iframe).
// We NEVER click anything else inside an ad (e.g. "Download"), only close/skip controls.
const AD_CLOSE_SELECTORS = [
  '#dismiss-button',
  '#close-button',
  '#ad_close_button',
  '[aria-label="Close ad"]',
  '[aria-label="Close"]',
  '[aria-label="close"]',
];
const AD_CLOSE_TEXTS = ['close', 'close ad', 'skip', 'skip ad', 'dismiss'];

const DISMISS_TEXTS = ['no', 'no thanks', 'not now', 'later', 'got it'];
const ACCEPT_TEXTS = ['accept', 'i agree', 'agree', 'confirm', 'yes', 'ok', 'continue', 'skip', 'skip ad'];
const CONSENT_TEXTS = ['accept all', 'accept', 'agree', 'i agree', 'allow all', 'consent'];

function normalizeStatus(raw) {
  const s = (raw || '').toLowerCase();
  if (!s) return 'unknown';
  if (s.includes('online') && !s.includes('offline')) return 'online';
  if (s.includes('offline')) return 'offline';
  if (s.includes('queue') || s.includes('waiting')) return 'queue';
  if (s.includes('starting') || s.includes('preparing') || s.includes('loading')) return 'starting';
  if (s.includes('stopping') || s.includes('saving')) return 'stopping';
  return 'unknown';
}

class AternosController {
  constructor() {
    this.running = false;
    this.lastAdStartClick = 0;
    this.closeSeen = null; // { key, since } of the Close button we are currently waiting on
    this.browser = null;
    this.cancelled = false;
  }

  /** Throws a "cancelled" error if !stop was requested. Called inside every wait loop. */
  throwIfCancelled() {
    if (this.cancelled) {
      const err = new AternosError('Stopped by user.');
      err.cancelled = true;
      throw err;
    }
  }

  /**
   * Aborts the current run: kills the browser (which makes every pending step throw),
   * waits until the run has fully cleaned up, and leaves the controller ready for a fresh start().
   * Returns false when nothing was running.
   */
  async cancel() {
    if (!this.running) return false;
    log.warn('Cancel requested - aborting current run');
    this.cancelled = true;

    const browser = this.browser;
    if (browser) {
      try {
        await Promise.race([browser.close(), sleep(5000).then(() => { throw new Error('close timeout'); })]);
      } catch (e) {
        log.warn(`Graceful browser close failed (${e.message}), killing process`);
        try { browser.process()?.kill('SIGKILL'); } catch { /* already dead */ }
      }
    }

    // Wait (max ~15s) for start() to unwind and release the lock
    for (let i = 0; i < 75 && this.running; i++) await sleep(200);
    if (this.running) {
      log.error('Run did not unwind after cancel - forcing reset');
      this.running = false;
      this.browser = null;
    }
    this.cancelled = false;
    return true;
  }

  /**
   * Starts the server. `notify(text)` is called with human-readable progress.
   * Resolves with { state: 'online' | 'starting' | 'already-online' | 'timeout' }.
   */
  async start(notify = async () => {}) {
    if (this.running) throw new AternosError('A start attempt is already in progress.');
    this.running = true;
    this.cancelled = false;
    this.lastAdStartClick = 0;
    this.closeSeen = null;

    let browser = null;
    let page = null;
    try {
      await notify('🌐 Launching browser...');
      browser = await step('Launch browser', () => launchBrowser());
      this.browser = browser;
      this.throwIfCancelled(); // !stop arrived while the browser was still launching
      page = await step('Prepare page', () => preparePage(browser));

      await this.openDashboard(page, notify);
      return await this.startAndMonitor(page, notify);
    } catch (err) {
      if (this.cancelled || err.cancelled) {
        const stopped = new AternosError('Stopped by user.');
        stopped.cancelled = true;
        throw stopped; // no screenshot: the browser was killed on purpose
      }
      const shot = err.screenshot || (await screenshot(page));
      if (err instanceof AternosError) {
        err.screenshot = shot;
        throw err;
      }
      throw new AternosError(err.message, { screenshot: shot, cause: err });
    } finally {
      if (browser) {
        try { await browser.close(); } catch (e) { log.warn('Browser close failed:', e.message); }
      }
      this.browser = null;
      this.running = false;
    }
  }

  // ---------- navigation / login ----------

  async openDashboard(page, notify) {
    const useExplicitServer = !!config.aternos.serverId;

    await step('Open Aternos', async () => {
      await page.goto(useExplicitServer ? URLS.servers : URLS.server, { waitUntil: 'domcontentloaded' });
      await waitForCloudflare(page, notify);
      await this.dismissOverlays(page);
    });

    if (new URL(page.url()).pathname.startsWith('/go')) {
      await this.login(page, notify);
      await step('Re-open dashboard after login', async () => {
        await page.goto(useExplicitServer ? URLS.servers : URLS.server, { waitUntil: 'domcontentloaded' });
        await waitForCloudflare(page, notify);
        await this.dismissOverlays(page);
      });
    } else {
      await notify('🍪 Reusing saved Aternos session.');
    }

    if (/^\/servers\/?$/.test(new URL(page.url()).pathname)) {
      await this.selectServer(page, notify);
    }

    await step('Wait for server dashboard', async () => {
      await page.waitForSelector(`${SEL.startButton}, ${SEL.statusLabel}`, { timeout: config.limits.elementTimeoutMs });
    });
  }

  async login(page, notify) {
    await notify('🔐 Logging into Aternos...');
    await step('Login', async () => {
      if (!page.url().includes('/go')) {
        await page.goto(URLS.login, { waitUntil: 'domcontentloaded' });
        await waitForCloudflare(page, notify);
      }
      await sleep(1500); // let the consent popup render
      await this.dismissOverlays(page);
      await sleep(1000);

      await page.waitForSelector(SEL.username, { visible: true });
      await page.click(SEL.username, { clickCount: 3 });
      await page.type(SEL.username, config.aternos.username, { delay: 60 + Math.random() * 60 });
      await humanDelay();
      await page.click(SEL.password, { clickCount: 3 });
      await page.type(SEL.password, config.aternos.password, { delay: 60 + Math.random() * 60 });
      await humanDelay();
      await this.dismissOverlays(page);
      await page.click(SEL.loginButton);

      const clickedAt = Date.now();
      let retriedWithEnter = false;
      const deadline = clickedAt + config.limits.loginTimeoutMs;
      while (Date.now() < deadline) {
        this.throwIfCancelled();
        const path = new URL(page.url()).pathname;
        if (path.startsWith('/servers') || path.startsWith('/server')) return;

        await waitForCloudflare(page, notify);

        const errText = await page
          .$eval(SEL.loginError, (el) => (el.offsetParent ? el.textContent.trim() : ''))
          .catch(() => '');
        if (errText) throw new AternosError(`Aternos rejected the login: "${errText.slice(0, 120)}"`);

        // Fallback: if the click seemingly did nothing, submit with Enter once.
        if (!retriedWithEnter && Date.now() - clickedAt > 10_000) {
          retriedWithEnter = true;
          log.warn('No reaction to login click after 10s, retrying with Enter');
          await page.click(SEL.password).catch(() => {});
          await page.keyboard.press('Enter').catch(() => {});
        }
        await sleep(1000);
      }

      // Timed out: report what the page actually shows so we can diagnose.
      const snippet = await page
        .evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 300))
        .catch(() => '(could not read page text)');
      log.error(`Login timeout. URL=${page.url()} | Page text: ${snippet}`);
      throw new AternosError(`Login timed out. URL: ${page.url()} | Page says: "${snippet}"`, {
        screenshot: await screenshot(page),
      });
    });
  }

  async selectServer(page, notify) {
    await notify('📋 Selecting server...');
    await step('Select server', async () => {
      const { serverId } = config.aternos;
      const selector = serverId
        ? `.server-body[data-id="${serverId}"], .servercard[data-id="${serverId}"]`
        : SEL.serverCard;
      await page.waitForSelector(selector, { visible: true });
      await humanDelay();
      await page.click(selector);
      await page.waitForFunction(() => /^\/server\/?$/.test(location.pathname), { timeout: config.limits.elementTimeoutMs });
      await this.dismissOverlays(page);
    });
  }

  // ---------- start + monitor ----------

  async getStatus(page) {
    try {
      const raw = await page.$eval(SEL.statusLabel, (el) => el.textContent.trim());
      return { raw, state: normalizeStatus(raw) };
    } catch {
      return { raw: '', state: 'unknown' };
    }
  }

  async startAndMonitor(page, notify) {
    let { raw, state } = await this.getStatus(page);
    log.info(`Initial status: "${raw}" (${state})`);

    if (state === 'online') {
      await notify('✅ Server is already **online**!');
      return { state: 'already-online' };
    }

    if (state === 'offline' || state === 'unknown') {
      await notify('🖱️ Clicking Start...');
      await step('Click Start', async () => {
        await page.waitForSelector(SEL.startButton, { visible: true, timeout: config.limits.elementTimeoutMs });
        await humanDelay(600, 1400);
        await page.hover(SEL.startButton).catch(() => {});
        await page.click(SEL.startButton);
        await sleep(2000);
        const clicked = await this.handleDialogs(page);
        if (clicked.length) log.info('Dialog buttons clicked:', clicked.join(', '));
      });

      // Wait for the status to leave "offline"
      const changed = await step('Verify status changed', async () => {
        const until = Date.now() + config.limits.startVerifyTimeoutMs; // ad modal + ad playback can take a while
        while (Date.now() < until) {
          this.throwIfCancelled();
          const s = await this.getStatus(page);
          if (s.state !== 'offline' && s.state !== 'unknown') return s;
          await this.handleDialogs(page);
          await sleep(1500);
        }
        throw new AternosError('Clicked Start but the status never left "Offline" within the allowed time (ad failed to load/play, a popup is blocking, or a selector changed).');
      });
      state = changed.state;
    }

    return this.monitor(page, notify, state);
  }

  async monitor(page, notify, initialState) {
    const deadline = Date.now() + config.limits.maxWaitMs;
    let last = null;

    const announce = async (state, raw) => {
      if (state === last) return;
      last = state;
      const msgs = {
        queue: `⏳ In the Aternos queue (${raw}). I'll confirm automatically when it's your turn.`,
        starting: `🚀 Server is launching! (${raw})`,
        online: '✅ Server is **online** — join now!',
      };
      if (msgs[state]) await notify(msgs[state]);
    };

    await announce(initialState, initialState);
    let lastTick = 0;
    while (Date.now() < deadline) {
      this.throwIfCancelled();
      const { raw, state } = await this.getStatus(page);
      if (Date.now() - lastTick > 30_000) {
        lastTick = Date.now();
        log.info(`monitor: status="${raw}" (${state}) [mem ${memInfo()}]`);
      }

      if (state === 'queue' && (await clickIfPresent(page, SEL.confirmButton))) {
        await notify('👍 Confirmed queue spot.');
      }
      await this.handleDialogs(page);

      await announce(state, raw);
      if (state === 'online') return { state: 'online' };
      if (state === 'starting' && config.limits.earlyFinish) {
        await notify('🧠 Launch confirmed. Closing the browser to save memory — the server should be online in a minute or two.');
        return { state: 'starting' };
      }
      await sleep(4000);
    }
    await notify('⌛ Stopped waiting (timeout). The server may still be starting — check Aternos.');
    return { state: 'timeout' };
  }

  // ---------- overlays ----------

  async dismissOverlays(page) {
    for (const sel of SEL.consentButtons) {
      if (await clickIfPresent(page, sel)) {
        log.info(`Dismissed consent via ${sel}`);
        await sleep(500);
      }
    }
    // Cookie/privacy (CMP) popup: match by button text, in the page AND in any iframe
    for (const frame of page.frames()) {
      try {
        const label = await clickByText(frame, CONSENT_TEXTS, 'body');
        if (label) {
          log.info(`Accepted consent popup via "${label}"`);
          await sleep(1000);
        }
      } catch { /* frame detached or not ready */ }
    }
    await clickByText(page, DISMISS_TEXTS, SEL.dialogScope).catch(() => {});
  }

  /**
   * The "Please watch this short advertisement to start your free server" modal has its own
   * green "Start" button. It must not be confused with the main #start button, so we skip
   * #start and only click when the "advertisement" popup text is actually on screen.
   * Rate-limited so we don't restart the ad over and over while it is playing.
   */
  async clickAdStart(page) {
    if (Date.now() - this.lastAdStartClick < 30_000) return null;
    const handle = await page.evaluateHandle(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      const popupShown = [...document.querySelectorAll('div, p, span')].some(
        (el) => visible(el) && /watch this short advertisement/i.test(el.textContent || '') && (el.textContent || '').length < 300
      );
      if (!popupShown) return null;
      const buttons = [...document.querySelectorAll('button, a, .btn, [role="button"]')];
      return (
        buttons.find(
          (el) => el.id !== 'start' && !el.closest('#start') && visible(el) && /^\s*start\s*$/i.test(el.textContent || '')
        ) || null
      );
    });
    const el = handle.asElement();
    if (!el) { await handle.dispose(); return null; }
    await humanDelay(400, 900);
    await el.click();
    this.lastAdStartClick = Date.now();
    log.info('Clicked "Start" in the advertisement popup');
    return 'ad-start';
  }

  /**
   * Closes ad overlays patiently:
   *  - does nothing until we pressed "Start" in the Aternos ad popup AND `adMinWatchMs` has passed
   *  - by default only looks at the MAIN page (the Close link that sits outside the white ad box);
   *    Close buttons inside ad iframes are only considered after `adIframeFallbackMs`
   *  - ignores dimmed / disabled / pointer-events:none buttons (countdown not finished yet)
   *  - the button must stay visible at the same spot for `adCloseSettleMs` before it is clicked
   *  - never clicks links that navigate away, and never touches Aternos' own ad popup
   */
  async closeAds(page) {
    try {
      if (!this.lastAdStartClick) return null;
      const sinceAd = Date.now() - this.lastAdStartClick;
      if (sinceAd < config.limits.adMinWatchMs) return null;

      const aternosPopup = await page
        .evaluate(() => /watch this short advertisement/i.test(document.body?.innerText || ''))
        .catch(() => false);
      if (aternosPopup) return null;

      const mainFrame = page.mainFrame();
      const frames = sinceAd >= config.limits.adIframeFallbackMs ? page.frames() : [mainFrame];

      for (const frame of frames) {
        let handle;
        try {
          handle = await frame.evaluateHandle((selectors, words) => {
            const visible = (el) => {
              const r = el.getBoundingClientRect();
              const st = getComputedStyle(el);
              return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
            };
            // effective opacity (a button that is still fading in / dimmed during a countdown is "not ready")
            const ready = (el) => {
              if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
              let op = 1;
              for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
                const st = getComputedStyle(n);
                op *= parseFloat(st.opacity || '1');
                if (n === el && st.pointerEvents === 'none') return false;
              }
              return op >= 0.9;
            };
            const safe = (el) => {
              if (el.tagName !== 'A') return true;
              const h = el.getAttribute('href') || '';
              return !h || h.startsWith('#') || /^javascript:/i.test(h);
            };
            const ok = (el) => visible(el) && ready(el) && safe(el);
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el && ok(el)) return el;
            }
            for (const el of document.querySelectorAll('button, a, div, span, [role="button"]')) {
              if (el.children.length > 1) continue; // skip containers
              const t = (el.textContent || '').trim().toLowerCase();
              if (words.includes(t) && ok(el)) return el;
            }
            return null;
          }, AD_CLOSE_SELECTORS, AD_CLOSE_TEXTS);
        } catch {
          continue; // frame detached / not ready
        }

        const el = handle.asElement();
        if (!el) { await handle.dispose(); continue; }

        const info = await el.evaluate((e) => {
          const r = e.getBoundingClientRect();
          const label = (e.textContent || e.getAttribute('aria-label') || 'close').trim().slice(0, 30);
          return { label, pos: `${Math.round(r.x / 4)}x${Math.round(r.y / 4)}` };
        });
        const where = frame === mainFrame ? 'page' : 'iframe';
        const key = `${where}|${info.label}|${info.pos}`;
        const now = Date.now();

        // First sighting (or it moved / changed): start the patience timer, don't click yet.
        if (!this.closeSeen || this.closeSeen.key !== key) {
          this.closeSeen = { key, since: now };
          log.info(`"${info.label}" button appeared (${where}), waiting ${config.limits.adCloseSettleMs}ms to be sure it's ready`);
          return null;
        }
        if (now - this.closeSeen.since < config.limits.adCloseSettleMs) return null;

        await humanDelay(300, 800);
        try {
          await el.click();
        } catch {
          await el.evaluate((e) => e.click()); // fallback when not clickable by mouse
        }
        log.info(`Closed ad overlay via "${info.label}" (${where}) after ${Math.round(sinceAd / 1000)}s`);
        this.closeSeen = null;
        return `ad-close:${info.label}`;
      }

      this.closeSeen = null; // nothing ready right now -> reset patience timer
    } catch (e) {
      log.debug('closeAds:', e.message);
    }
    return null;
  }

  /** EULA / confirmation / notification dialogs shown after pressing Start. */
  async handleDialogs(page) {
    const clicked = [];
    try {
      const d = await clickByText(page, DISMISS_TEXTS, SEL.dialogScope);
      if (d) clicked.push(d);
      const a = await clickByText(page, ACCEPT_TEXTS, SEL.dialogScope);
      if (a) clicked.push(a);
      const ad = await this.clickAdStart(page);
      if (ad) clicked.push(ad);
      const closed = await this.closeAds(page);
      if (closed) clicked.push(closed);
    } catch (e) {
      log.debug('handleDialogs:', e.message);
    }
    return clicked;
  }
}

module.exports = { AternosController };