const config = require('./config');
const log = require('./logger');

try {
  config.validate();
} catch (e) {
  log.error(e.message);
  process.exit(1);
}

const { startKeepAlive } = require('./keepalive');
const { startBot } = require('./discord/bot');

const server = startKeepAlive();
const client = startBot();

process.on('unhandledRejection', (r) => {
  const msg = String((r && r.message) || r);
  // A tab/browser closed while a library was still talking to it (ad popups, !stop, crashes). Not fatal.
  if (/Target closed|Session closed|Protocol error|Connection closed|Navigating frame was detached/i.test(msg)) {
    log.warn(`Ignored browser-closed rejection: ${msg.split('\n')[0]}`);
    return;
  }
  log.error('Unhandled rejection:', r);
});
process.on('uncaughtException', (e) => log.error('Uncaught exception:', e));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log.info(`${sig} received, shutting down`);
    client.destroy();
    server.close(() => process.exit(0));
  });
}
