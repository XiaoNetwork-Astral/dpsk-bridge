#!/usr/bin/env node
// dsv — DeepSeek Harness session viewer. Command handling lives in
// lib/viewer/cli.mjs; this file is only the executable entry point.
import { main } from '../lib/viewer/cli.mjs';

const code = await main(process.argv.slice(2));
if (Number.isInteger(code) && code !== 0) process.exitCode = code;
