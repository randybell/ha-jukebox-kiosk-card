export { fmtTime } from '../shared';
export const prefersReducedMotionSafe = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
