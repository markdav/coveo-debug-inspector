import { createRequire } from 'node:module';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import AdmZip from 'adm-zip';

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'dist-extension');

const manifest = JSON.parse(readFileSync(resolve(source, 'manifest.json'), 'utf8'));
const slug = manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const target = resolve(root, `${slug}-${manifest.version}.zip`);

rmSync(target, { force: true });
const zip = new AdmZip();
zip.addLocalFolder(source);
zip.writeZip(target);

// The store rejects a package whose manifest is nested inside a directory.
const entries = new AdmZip(target).getEntries().map((entry) => entry.entryName);
if (!entries.includes('manifest.json')) {
  throw new Error('manifest.json must be at the zip root');
}

const size = Math.round(readFileSync(target).byteLength / 1024);
console.log(`${target}\n${entries.length} files, ${size} KB, manifest at root`);
