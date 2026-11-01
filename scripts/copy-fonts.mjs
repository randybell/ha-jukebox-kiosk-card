// Copies the self-hosted OFL fonts next to the bundle: dist/fonts/*.woff2 (plus their OFL texts and the notices)
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
const out = 'dist/fonts';
mkdirSync(out, { recursive: true });
const files = [
  ['@fontsource/inter/files/inter-latin-400-normal.woff2', 'inter-400.woff2'],
  ['@fontsource/inter/files/inter-latin-600-normal.woff2', 'inter-600.woff2'],
  ['@fontsource/inter/files/inter-latin-700-normal.woff2', 'inter-700.woff2'],
  ['@fontsource/inter/files/inter-latin-800-normal.woff2', 'inter-800.woff2'],
  ['@fontsource/plus-jakarta-sans/files/plus-jakarta-sans-latin-700-normal.woff2', 'plus-jakarta-sans-700.woff2'],
  ['@fontsource/plus-jakarta-sans/files/plus-jakarta-sans-latin-800-normal.woff2', 'plus-jakarta-sans-800.woff2'],
];
for (const [src, dst] of files) {
  const p = `node_modules/${src}`;
  if (!existsSync(p)) { console.warn('font missing, system fallback will be used:', p); continue; }
  copyFileSync(p, `${out}/${dst}`);
}
copyFileSync('node_modules/@fontsource/inter/LICENSE', `${out}/LICENSE-Inter.txt`);
copyFileSync('node_modules/@fontsource/plus-jakarta-sans/LICENSE', `${out}/LICENSE-PlusJakartaSans.txt`);
// Ship the third-party notices (written by the rollup build) inside jukebox-card-fonts.zip too.
if (existsSync('dist/THIRD_PARTY_NOTICES.md')) copyFileSync('dist/THIRD_PARTY_NOTICES.md', `${out}/THIRD_PARTY_NOTICES.md`);
else console.warn('dist/THIRD_PARTY_NOTICES.md missing; run rollup -c first');
console.log('fonts copied to', out);
