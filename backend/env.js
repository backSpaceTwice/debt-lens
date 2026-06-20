// env.js — zero-dependency .env loader.
//
// Imported first by index.js so environment variables (GITHUB_TOKEN,
// ANTHROPIC_API_KEY, ...) are available before any other module reads them.
// Uses Node's built-in process.loadEnvFile (Node >= 20.6); the .env is
// resolved relative to this file so it works no matter where you run from.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '.env');

try {
  process.loadEnvFile(envPath);
  console.log(`🔑 Loaded environment from ${envPath}`);
} catch {
  // No .env file (or unreadable) — that's fine, env vars may be set inline.
}
