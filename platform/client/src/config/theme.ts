/**
 * Shared platform design tokens.
 * Utility mappings only. Color values are owned by styles/globals.css.
 * See `.impeccable.md` for their visual and semantic roles.
 *
 * The tokens model the Space Agencies mission interface in three concentric rings:
 *   1. Surface system  — five lightness levels lifting off the void.
 *   2. Signal palette  — meaning-bound accents (blue/violet/green/amber/red/white).
 *   3. Metal & motion  — mechanical chrome and timing.
 */

export interface IThemeTokens {
  colors: {
    /**
     * Background void — the page backdrop. Used by the cosmic-atmosphere
     * layer; almost never as a component fill.
     */
    background: {
      950: string;
      900: string;
      800: string;
    };
    /** Five-level surface system (see .impeccable.md §Surface System). */
    surface: {
      /** The very base, behind atmosphere. Component fill: never. */
      void: string;
      /** App chrome — top bar, side rails. First lift off the void. */
      deep: string;
      /** Default panel and card fill. The workhorse. */
      panel: string;
      /** Modals, popovers, dropdowns — floats above panels. */
      raised: string;
      /** Inset readouts; darker than its container, like a recessed display. */
      instrument: string;
      /** Legacy numbered scale — kept for the ~50 consumers still using it. */
      900: string;
      800: string;
      700: string;
    };
    text: {
      /** Phosphor white — primary readouts, labels of high importance. */
      100: string;
      200: string;
      400: string;
      /** Body copy. */
      300: string;
      /** Captions, dim labels, mission-log connective tissue. */
      500: string;
      /** Even dimmer — disabled, decorative dividers. */
      700: string;
    };
    /**
     * Signal palette — six meaning-bound accents.
     * A color earns its place by meaning, not aesthetics.
     */
    signal: {
      /** 🔷 Star Track Blue — game-state cues and informational readouts. */
      blue: { base: string; hi: string; lo: string };
      /** 🟣 Nebula Violet — discovery events, new signals, alien encounters. The 'awe' accent. */
      violet: { base: string; hi: string; lo: string };
      /** 🟢 Ion Green — confirmed / acquired / nominal. Diagnostics only, never on buttons. */
      green: { base: string; hi: string; lo: string };
      /** 🟡 Signal Amber — caution, pending action, decaying resource. Telemetry warnings. */
      amber: { base: string; hi: string; lo: string };
      /** 🔴 Plasma Red — critical failure, destructive confirm, mission abort. */
      red: { base: string; hi: string; lo: string };
      /** ⚪ Phosphor White — data readouts. Plain, mono, never another color. */
      white: string;
    };
    /** Copper orange — interactive selection and navigation. */
    accent: { 500: string; 400: string; 600: string };
    /** Destructive-only — kept as alias for signal.red.base. */
    danger: { 500: string };
    /** Metal bevel palette. */
    metal: {
      highlight: string;
      face: string;
      shadow: string;
      edge: string;
      edgeSoft: string;
    };
    /** Instrumentation / data readouts — plain near-white phosphor. */
    data: { primary: string; dim: string };
    /** Refine v2 lobby/design-system palette. */
    lobby: {
      deepSpace: string;
      starTrackBlue: string;
      energyOrange: string;
      orbitWhite: string;
      starGray: string;
      /** Legacy aliases kept for existing consumers. */
      rockGray: string;
      metalGray: string;
      groundGray: string;
      stardust: string;
      planetOrange: string;
      engineCyan: string;
    };
  };
  typography: {
    /** Lexend Deca display — screen titles, phase names, end-of-game reveals. */
    display: string;
    /** Lexend Deca body with Noto Sans SC fallback — UI chrome, buttons, labels. */
    body: string;
    /** Lexend Deca readouts — coordinates, resource counts, timestamps, logs. */
    mono: string;
  };
  effects: {
    /** Soft contact shadow for elevated panels. */
    panelShadow: string;
    /** Cosmic atmosphere — three layers (void gradient + starfield + dust lane). */
    overlayGradient: string;
  };
}

export const THEME_TOKENS: IThemeTokens = {
  colors: {
    background: {
      950: 'var(--bg-950)',
      900: 'var(--bg-900)',
      800: 'var(--bg-800)',
    },
    surface: {
      void: 'var(--surface-void)',
      deep: 'var(--surface-deep)',
      panel: 'var(--surface-panel)',
      raised: 'var(--surface-raised)',
      instrument: 'var(--surface-instrument)',
      // Legacy numeric scale
      900: 'var(--surface-900)',
      800: 'var(--surface-800)',
      700: 'var(--surface-700)',
    },
    text: {
      100: 'var(--text-100)',
      200: 'var(--text-200)',
      400: 'var(--text-400)',
      300: 'var(--text-300)',
      500: 'var(--text-500)',
      700: 'var(--text-700)',
    },
    signal: {
      blue: {
        base: 'var(--signal-blue)',
        hi: 'var(--signal-blue-hi)',
        lo: 'var(--signal-blue-lo)',
      },
      violet: {
        base: 'var(--signal-violet)',
        hi: 'var(--signal-violet-hi)',
        lo: 'var(--signal-violet-lo)',
      },
      green: {
        base: 'var(--signal-green)',
        hi: 'var(--signal-green-hi)',
        lo: 'var(--signal-green-lo)',
      },
      amber: {
        base: 'var(--signal-amber)',
        hi: 'var(--signal-amber-hi)',
        lo: 'var(--signal-amber-lo)',
      },
      red: {
        base: 'var(--signal-red)',
        hi: 'var(--signal-red-hi)',
        lo: 'var(--signal-red-lo)',
      },
      white: 'var(--signal-white)',
    },
    accent: {
      500: 'var(--accent-500)',
      400: 'var(--accent-400)',
      600: 'var(--accent-600)',
    },
    danger: { 500: 'var(--signal-red)' },
    metal: {
      highlight: 'var(--metal-highlight)',
      face: 'var(--metal-face-mid)',
      shadow: 'var(--metal-shadow)',
      edge: 'var(--metal-edge)',
      edgeSoft: 'var(--metal-edge-soft)',
    },
    data: {
      primary: 'var(--text-100)',
      dim: 'var(--text-300)',
    },
    lobby: {
      deepSpace: 'var(--lobby-deep-space)',
      starTrackBlue: 'var(--lobby-star-track)',
      energyOrange: 'var(--lobby-energy-orange)',
      orbitWhite: 'var(--lobby-orbit-white)',
      starGray: 'var(--lobby-star-gray)',
      // Legacy aliases
      rockGray: 'var(--lobby-rock-gray)',
      metalGray: 'var(--lobby-metal-gray)',
      groundGray: 'var(--lobby-ground-gray)',
      stardust: 'var(--lobby-stardust)',
      planetOrange: 'var(--lobby-planet-orange)',
      engineCyan: 'var(--lobby-engine-cyan)',
    },
  },
  typography: {
    display: 'Lexend Deca',
    body: 'Lexend Deca',
    mono: 'Lexend Deca',
  },
  effects: {
    panelShadow: '0 16px 48px oklch(0.05 0.015 260 / 0.28)',
    overlayGradient:
      'radial-gradient(ellipse 120% 80% at 38% 28%, oklch(0.16 0.035 280) 0%, oklch(0.12 0.025 265) 45%, oklch(0.08 0.018 255) 100%)',
  },
};
