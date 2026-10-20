FROM node:20-bookworm-slim

# System Chromium + Xvfb (optional headed mode) + fonts. Using the distro package
# pulls in every shared library Chromium needs, which is the #1 cause of
# "Failed to launch the browser process" on Render.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      xvfb xauth \
      fonts-liberation fonts-noto-color-emoji \
      ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Wrapper that runs Chromium at lower CPU priority, so the bot's web server and Discord connection
# keep getting CPU time even when the browser hogs the (tiny) free-tier CPU.
RUN printf '#!/bin/sh\nexec nice -n 10 /usr/bin/chromium "$@"\n' > /usr/local/bin/chromium-nice \
    && chmod +x /usr/local/bin/chromium-nice

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    CHROME_PATH=/usr/local/bin/chromium-nice \
    NODE_ENV=production

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
# strip Windows line endings (CRLF) that would break the shell script, then make it executable
RUN sed -i 's/\r$//' start.sh && chmod +x start.sh

EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["./start.sh"]
