const ts = () => new Date().toISOString();
const fmt = (lvl, args) => [`[${ts()}] [${lvl}]`, ...args];

module.exports = {
  info: (...a) => console.log(...fmt('INFO', a)),
  warn: (...a) => console.warn(...fmt('WARN', a)),
  error: (...a) => console.error(...fmt('ERROR', a)),
  debug: (...a) => process.env.DEBUG && console.log(...fmt('DEBUG', a)),
};
