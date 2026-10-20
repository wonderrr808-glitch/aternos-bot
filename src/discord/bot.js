const { Client, GatewayIntentBits, Events, AttachmentBuilder } = require('discord.js');
const config = require('../config');
const log = require('../logger');
const { AternosController } = require('../aternos/controller');

const COMMANDS = { START: '!start', STOP: '!stop' };

/** Edits one Discord message with a rolling progress log (serialised to respect rate limits). */
function makeNotifier(statusMessage) {
  const lines = [];
  let chain = Promise.resolve();
  return (text) => {
    log.info(`[discord] ${text}`);
    lines.push(text);
    const body = lines.slice(-6).join('\n');
    chain = chain
      .then(() => statusMessage.edit(body.slice(0, 1900)))
      .catch((e) => log.warn('Discord edit failed:', e.message));
    return chain;
  };
}

function startBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent, // must also be enabled in the Developer Portal
    ],
  });
  const controller = new AternosController();
  let lastRunAt = 0;

  /** !start -> run the automation */
  async function handleStart(message) {
    if (controller.running) {
      return void (await message.reply('⏳ A start attempt is already in progress. If it looks stuck, use `!stop` to reset it.'));
    }
    const remaining = lastRunAt + config.discord.cooldownMs - Date.now();
    if (remaining > 0) {
      return void (await message.reply(`🕒 Cooldown active, try again in ${Math.ceil(remaining / 1000)}s (or use \`!stop\` to reset).`));
    }
    lastRunAt = Date.now();

    const statusMessage = await message.reply('🔄 Starting automation...');
    const notify = makeNotifier(statusMessage);

    try {
      const result = await controller.start(notify);
      log.info('Start finished:', result);
    } catch (err) {
      if (err.cancelled) {
        log.info('Start run was cancelled with !stop');
        lastRunAt = 0;
        await notify('🛑 Stopped.');
        return;
      }
      log.error('Start failed:', err.stack || err.message);
      lastRunAt = 0; // allow immediate retry after a failure
      const payload = { content: `❌ **Failed:** ${String(err.message).slice(0, 1500)}\nUse \`!start\` to try again.` };
      if (err.screenshot) payload.files = [new AttachmentBuilder(err.screenshot, { name: 'failure.png' })];
      await message.channel.send(payload).catch((e) => log.error('Could not report failure:', e.message));
    }
  }

  /** !stop -> abort the running automation, kill the browser, reset cooldown/state */
  async function handleStop(message) {
    log.info(`!stop requested by ${message.author.tag}`);
    const wasRunning = await controller.cancel();
    lastRunAt = 0; // sent back to the start: !start works immediately
    await message.reply(
      wasRunning
        ? '🛑 Automation stopped and browser closed. Everything is reset — type `!start` to begin again.'
        : 'ℹ️ Nothing was running. State is reset — type `!start` whenever you want.'
    );
  }

  client.once(Events.ClientReady, async (c) => {
    log.info(`Discord ready as ${c.user.tag}`);
    const { announceRestart, allowedChannelId } = config.discord;
    if (announceRestart && allowedChannelId) {
      try {
        const ch = await c.channels.fetch(allowedChannelId);
        await ch.send('♻️ Bot (re)started. If a `!start` was in progress it was lost — just type `!start` again.');
      } catch (e) {
        log.warn('Could not send restart notice:', e.message);
      }
    }
  });
  client.on(Events.Error, (e) => log.error('Discord client error:', e));

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.author.bot || !message.guild) return;
      const cmd = message.content.trim().toLowerCase();
      if (cmd !== COMMANDS.START && cmd !== COMMANDS.STOP) return;

      const { allowedChannelId, allowedRoleId } = config.discord;
      if (allowedChannelId && message.channel.id !== allowedChannelId) return;
      if (allowedRoleId && !message.member?.roles.cache.has(allowedRoleId)) {
        return void (await message.reply('🚫 You do not have permission to use this command.'));
      }

      if (cmd === COMMANDS.START) await handleStart(message);
      else await handleStop(message);
    } catch (e) {
      log.error('messageCreate handler error:', e);
    }
  });

  client.login(config.discord.token).catch((e) => {
    log.error('Discord login failed:', e.message);
    process.exit(1);
  });
  return client;
}

module.exports = { startBot };