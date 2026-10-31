import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';

const dev = process.env.ROLLUP_WATCH === 'true';
export default {
  input: 'src/jukebox-card.ts',
  output: { file: 'dist/jukebox-card.js', format: 'es', sourcemap: false, inlineDynamicImports: true },
  plugins: [
    resolve(),
    typescript({ tsconfig: './tsconfig.json', outDir: undefined, noEmitOnError: true }),
    !dev && terser({ format: { comments: false } }),
  ],
};
