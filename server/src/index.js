#!/usr/bin/env node
import { createCli } from './cli.js';

createCli()
  .run()
  .catch((err) => {
    console.error(`[browserbuddy] fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
