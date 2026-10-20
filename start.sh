#!/bin/sh
# HEADLESS=false -> run real (headed) Chromium inside a virtual display.
if [ "$HEADLESS" = "false" ]; then
  exec xvfb-run -a --server-args="-screen 0 1366x768x24" node src/index.js
else
  exec node src/index.js
fi
