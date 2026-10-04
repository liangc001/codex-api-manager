import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
await fs.copyFile(path.join(root, 'node_modules/lucide/dist/umd/lucide.js'), path.join(root, 'public/lucide.js'));
