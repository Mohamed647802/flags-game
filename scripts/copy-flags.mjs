import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'public', 'flags'), { recursive: true });
await cp(path.join(root, 'node_modules', 'flag-icons', 'flags', '4x3'), path.join(root, 'public', 'flags'), { recursive: true });
console.log('flags copied');
