import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import { readFileSync } from 'node:fs';
import thirdPartyNotices from './scripts/third-party-notices.mjs';

const dev = process.env.ROLLUP_WATCH === 'true';
const { version } = JSON.parse(readFileSync('./package.json', 'utf8'));
const banner = `/*! Jukebox Card v${version} | MIT License | Copyright (c) 2026 Randy Bell | Includes Lit (BSD-3-Clause, Copyright Google LLC); see THIRD_PARTY_NOTICES.md */`;
export default {
  input: 'src/jukebox-card.ts',
  output: { file: 'dist/jukebox-card.js', format: 'es', sourcemap: false, inlineDynamicImports: true, banner },
  plugins: [
    resolve(),
    typescript({ tsconfig: './tsconfig.json', outDir: undefined, noEmitOnError: true }),
    // Keep license comments (/*! ... */, @license, @preserve) from Lit and the banner in the minified bundle.
    !dev && terser({ format: { comments: 'some' } }),
    thirdPartyNotices(),
  ],
};
