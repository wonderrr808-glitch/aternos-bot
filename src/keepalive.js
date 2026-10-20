const express = require('express');
const config = require('./config');
const log = require('./logger');

function startKeepAlive() {
  const app = express();
  app.get('/', (_req, res) => res.status(200).send('OK'));
  app.get('/healthz', (_req, res) => res.status(200).send('OK'));
  return app.listen(config.port, '0.0.0.0', () => log.info(`Keep-alive server listening on :${config.port}`));
}

module.exports = { startKeepAlive };
