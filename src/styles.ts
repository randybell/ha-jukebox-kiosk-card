import { css } from 'lit';

/**
 * Black Frame Mono design tokens. Every token can be overridden from an HA theme or card-mod by
 * setting the public `--jb-*` property; the card reads them through private `--_*` aliases.
 */
export const tokens = css`
  :host {
    --_active: var(--jb-active, #ffffff);
    --_inactive: var(--jb-inactive, rgba(255, 255, 255, 0.45));
    --_track: var(--jb-track, rgba(255, 255, 255, 0.2));
    --_accent: var(--jb-accent, var(--_active));
    --_on-accent: var(--jb-on-accent, #000000);
    --_fg: var(--jb-fg, #ffffff);
    --_muted: var(--jb-muted, #ffffffb8);
    --_bg: var(--jb-bg, #000000);
    --_hairline: var(--jb-hairline, #ffffff1f);
    --_surface: var(--jb-surface, #0000006b);
    --_surface-border: var(--jb-surface-border, #ffffff1f);
    --_divider: var(--jb-divider, #ffffff1f);
    --_prov-fg: var(--jb-prov-fg, #ffffff);
    --_prov-bg: var(--jb-prov-bg, #000000a6);
    --_prov-border: var(--jb-prov-border, rgba(255, 255, 255, 0.35));
    --_thumb-ring: var(--jb-thumb-ring, 0 0 0 4px rgba(255, 255, 255, 0.18));
    --_backdrop-blur: var(--jb-backdrop-blur, 38px);
    --_backdrop-saturate: var(--jb-backdrop-saturate, 1.15);
    --_shade: var(
      --jb-shade,
      linear-gradient(180deg, #000000b8 0%, #00000085 35%, #0000009e 70%, #000000e0 100%)
    );
    --_vignette: var(--jb-vignette, radial-gradient(120% 90% at 50% 50%, transparent 30%, #0000008c 100%));
    --_font-body: var(--jb-font-body, 'Inter', 'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif);
    --_font-display: var(--jb-font-display, 'Plus Jakarta Sans', 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif);
    --_pad: var(--jb-pad, clamp(14px, 3vw, 36px));
    --_radius: var(--jb-radius, 18px);
    --_radius-s: var(--jb-radius-s, 12px);
  }
`;

export const base = css`
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  button {
    font: inherit; color: inherit; border: 0; background: none; cursor: pointer;
    -webkit-tap-highlight-color: transparent; touch-action: manipulation;
  }
  button:focus { outline: none; }
  button:focus-visible { outline: 2px solid var(--_active); outline-offset: 2px; }
  .i { width: 24px; height: 24px; fill: currentColor; flex: none; display: block; }
  .i.xs { width: 16px; height: 16px; }
`;
