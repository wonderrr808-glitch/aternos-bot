require('dotenv').config();
const path = require('path');

const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));
const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));

const config = {
  port: num(process.env.PORT, 3000),
  discord: {
    token: process.env.DISCORD_TOKEN,
    allowedChannelId: process.env.ALLOWED_CHANNEL_ID || null,
    allowedRoleId: process.env.ALLOWED_ROLE_ID || null,
    cooldownMs: num(process.env.COOLDOWN_SECONDS, 120) * 1000,
    announceRestart: bool(process.env.ANNOUNCE_RESTART, false), // post a note in ALLOWED_CHANNEL_ID whenever the bot (re)starts
  },
  aternos: {
    username: process.env.ATERNOS_USERNAME,
    password: process.env.ATERNOS_PASSWORD,
    serverId: process.env.ATERNOS_SERVER_ID || null,
  },
  browser: {
    headless: bool(process.env.HEADLESS, true),
    chromePath: process.env.CHROME_PATH || null,
    liteMode: bool(process.env.LITE_MODE, false),   // block images + fonts (less CPU/RAM on weak hosts)
    lowMemory: bool(process.env.LOW_MEMORY, false), // extra Chromium flags that trim memory use
    liteAllowAdVideo: bool(process.env.LITE_ALLOW_AD_VIDEO, false), // LITE_MODE normally blocks video even during the ad
    trimAds: bool(process.env.TRIM_ADS, false), // remove ad iframes before Start / after the ad to free RAM (experimental)
    dumpio: bool(process.env.CHROME_DEBUG, false), // pipe Chromium's own stderr into the logs (crash / GPU messages)
    extraArgs: (process.env.EXTRA_CHROME_ARGS || '').split(/\s+/).filter(Boolean), // extra Chromium flags without redeploying code
    userAgent: process.env.USER_AGENT || null,
    profileDir: path.resolve(process.env.PROFILE_DIR || './.browser-profile'),
  },
  limits: {
    maxWaitMs: num(process.env.MAX_WAIT_MINUTES, 15) * 60 * 1000,
    // All waits are adjustable from the environment (handy on slow hosts like Render's free tier)
    cloudflareTimeoutMs: num(process.env.CLOUDFLARE_TIMEOUT_SECONDS, 60) * 1000, // how long to wait for "Verifying..." to finish
    loginTimeoutMs: num(process.env.LOGIN_TIMEOUT_SECONDS, 45) * 1000,
    elementTimeoutMs: num(process.env.ELEMENT_TIMEOUT_SECONDS, 30) * 1000,       // waiting for buttons / inputs / status
    navigationTimeoutMs: num(process.env.NAVIGATION_TIMEOUT_SECONDS, 60) * 1000, // page loads
    // Finish (and close the browser) as soon as Aternos reports "Starting" instead of waiting for "Online" - frees RAM.
    earlyFinish: bool(process.env.EARLY_FINISH, false),
    // Any single browser command that takes longer than this fails instead of hanging silently (default Puppeteer: 180s)
    protocolTimeoutMs: num(process.env.PROTOCOL_TIMEOUT_SECONDS, 60) * 1000,
    // If one step makes no progress for this long, abort with a screenshot instead of freezing forever
    stepStallMs: num(process.env.STEP_STALL_SECONDS, 300) * 1000,
    startVerifyTimeoutMs: num(process.env.START_VERIFY_TIMEOUT_SECONDS, 120) * 1000, // after clicking Start: wait for status to change (ads!)
    // Ad handling (patience!)
    adMinWatchMs: num(process.env.AD_MIN_WATCH_SECONDS, 10) * 1000,          // never close an ad earlier than this after pressing Start
    adCloseSettleMs: num(process.env.AD_CLOSE_SETTLE_SECONDS, 3) * 1000,      // a Close button must stay visible this long before we click it
    adIframeFallbackMs: num(process.env.AD_IFRAME_FALLBACK_SECONDS, 45) * 1000, // only then also consider Close buttons INSIDE ad iframes
  },
  validate() {
    const missing = [
      ['DISCORD_TOKEN', this.discord.token],
      ['ATERNOS_USERNAME', this.aternos.username],
      ['ATERNOS_PASSWORD', this.aternos.password],
    ].filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  },
};

module.exports = config;