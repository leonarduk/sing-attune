import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const glPath = join(process.cwd(), 'node_modules', 'gl');

if (existsSync(glPath)) {
  rmSync(glPath, { recursive: true, force: true });
  console.log('Removed node_modules/gl to avoid native rebuild issues during Windows packaging.');
} else {
  console.log('node_modules/gl not present; continuing packaging.');
}
