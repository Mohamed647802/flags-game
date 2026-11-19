// server/flags-store.js — loads flag SVGs from public/flags into memory at startup.
// Flags are served to clients ONLY through opaque /f/<token> URLs (see index.js);
// this module never exposes a code->filename mapping to the network.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLAGS_DIR = path.resolve(__dirname, '../public/flags');

let cache = null;

/** Read every *.svg under ../public/flags into a Map<code, Buffer>. Idempotent. */
export function loadFlags() {
  if (cache) return cache;
  cache = new Map();
  let files = [];
  try {
    files = readdirSync(FLAGS_DIR);
  } catch {
    return cache;
  }
  for (const file of files) {
    if (!file.toLowerCase().endsWith('.svg')) continue;
    const code = file.slice(0, -4).toLowerCase();
    try {
      cache.set(code, readFileSync(path.join(FLAGS_DIR, file)));
    } catch {
      // Skip unreadable files; a missing flag is a 404 at serve time.
    }
  }
  return cache;
}

/** Buffer for a lowercase ISO code (e.g. 'eg'), or null when unknown. */
export function getFlag(code) {
  if (!cache) loadFlags();
  if (typeof code !== 'string') return null;
  return cache.get(code.toLowerCase()) ?? null;
}

export function hasFlag(code) {
  if (!cache) loadFlags();
  if (typeof code !== 'string') return false;
  return cache.has(code.toLowerCase());
}

export function flagCount() {
  if (!cache) loadFlags();
  return cache.size;
}
