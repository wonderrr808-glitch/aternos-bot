const fs = require('fs');
const log = require('../logger');

/** Container memory usage (what Render actually enforces), e.g. "431/512MB". Falls back to Node's RSS. */
function memInfo() {
  const mb = (n) => Math.round(Number(n) / 1048576);
  const read = (f) => fs.readFileSync(f, 'utf8').trim();
  try { // cgroup v2
    const cur = read('/sys/fs/cgroup/memory.current');
    const max = read('/sys/fs/cgroup/memory.max');
    // "total" includes reclaimable file cache; "apps" (anon) is what can really cause an out-of-memory crash
    let apps = '';
    try { apps = `, apps ${mb(read('/sys/fs/cgroup/memory.stat').match(/^anon (\d+)/m)[1])}MB`; } catch { /* no stat */ }
    return (max === 'max' ? `${mb(cur)}MB` : `${mb(cur)}/${mb(max)}MB`) + apps;
  } catch { /* try v1 */ }
  try { // cgroup v1
    const cur = read('/sys/fs/cgroup/memory/memory.usage_in_bytes');
    const max = Number(read('/sys/fs/cgroup/memory/memory.limit_in_bytes'));
    return max < 1e12 ? `${mb(cur)}/${mb(max)}MB` : `${mb(cur)}MB`;
  } catch { /* not in a container */ }
  return `${mb(process.memoryUsage().rss)}MB(node only)`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const humanDelay = (min = 300, max = 900) => sleep(min + Math.random() * (max - min));

/** Rejects if `promise` doesn't settle in `ms`. The original promise is kept from causing unhandled rejections. */
function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const p = Promise.resolve(promise);
  p.catch(() => {}); // late failure after we gave up must not crash/spam
  return Promise.race([
    p,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const FRAME_OP_TIMEOUT_MS = 6000;

// What the automation is doing right now (used by the heartbeat / stall watchdog).
const currentStep = { label: null, since: 0 };
const getCurrentStep = () => ({ ...currentStep });

class AternosError extends Error {
  constructor(message, { screenshot = null, cause = null } = {}) {
    super(message);
    this.name = 'AternosError';
    this.screenshot = screenshot;
    this.cause = cause;
  }
}

/** Wrap one automation step: log it, and re-throw with context on failure. */
async function step(label, fn) {
  log.info(`▶ ${label} [mem ${memInfo()}]`);
  currentStep.label = label;
  currentStep.since = Date.now();
  try {
    const res = await fn();
    log.info(`✔ ${label} (${Math.round((Date.now() - currentStep.since) / 1000)}s) [mem ${memInfo()}]`);
    return res;
  } catch (err) {
    log.error(`✖ ${label}: ${err.message}`);
    if (err instanceof AternosError) throw err;
    throw new AternosError(`${label} failed: ${err.message}`, { cause: err });
  } finally {
    currentStep.label = null;
  }
}

async function screenshot(page) {
  try {
    if (page && !page.isClosed()) return await withTimeout(page.screenshot({ type: 'png', fullPage: false }), 10_000, 'screenshot');
  } catch (e) {
    log.warn('Could not take screenshot:', e.message);
  }
  return null;
}

/** Click the first visible button whose text exactly matches one of `texts` (inside `scope`). */
async function clickByText(page, texts, scope = 'body') {
  const wanted = texts.map((t) => t.toLowerCase());
  const handle = await withTimeout(page.evaluateHandle((wanted, scope) => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    for (const root of document.querySelectorAll(scope)) {
      for (const el of root.querySelectorAll('button, a, .btn, [role="button"]')) {
        const t = (el.textContent || '').trim().toLowerCase();
        if (wanted.includes(t) && visible(el)) return el;
      }
    }
    return null;
  }, wanted, scope), FRAME_OP_TIMEOUT_MS, 'scan for buttons');
  const el = handle.asElement();
  if (!el) { await handle.dispose(); return null; }
  const label = await withTimeout(el.evaluate((e) => e.textContent.trim()), FRAME_OP_TIMEOUT_MS, 'read button text');
  await withTimeout(el.click(), FRAME_OP_TIMEOUT_MS, 'click button');
  return label;
}

/** Click a selector if it exists and is visible. Returns true if clicked. */
async function clickIfPresent(page, selector) {
  try {
    const el = await page.$(selector);
    if (!el) return false;
    const box = await el.boundingBox();
    if (!box) return false;
    await el.click();
    return true;
  } catch {
    return false;
  }
}

module.exports = { withTimeout, getCurrentStep, FRAME_OP_TIMEOUT_MS, memInfo, sleep, humanDelay, AternosError, step, screenshot, clickByText, clickIfPresent };