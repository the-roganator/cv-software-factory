/**
 * The console's small glyphs: one per category, and a few for controls. Drawn on a 16 × 16 grid in the text colour.
 */
import type { Category } from '@software-factory/events';

const PATHS = {
  improvement: 'M8 1.75a6.25 6.25 0 1 0 0 12.5 6.25 6.25 0 1 0 0-12.5M8 5v6M5 8h6',
  functional:
    'M5.5 6.5a2.5 2.5 0 0 1 5 0V10a2.5 2.5 0 0 1-5 0z M8 7v5.5 M2.75 8.5h2.75 M10.5 8.5h2.75 M3.5 12.5l2-1.25 M12.5 12.5l-2-1.25 M6.25 4.5 5 2.75 M9.75 4.5 11 2.75',
  content: 'M3 3.5h10 M3 6.5h10 M3 9.5h7 M3 12.5h5',
  navigation: 'M6.5 9.5 9.5 6.5 M7 4.5l1.5-1.5a2.5 2.5 0 0 1 3.5 3.5L10.5 8 M9 11.5 7.5 13a2.5 2.5 0 0 1-3.5-3.5L5.5 8',
  errors: 'M8 2.25 14 13H2z M8 6.5v3 M8 11.25v.25',
  performance: 'M2.25 11.5a5.75 5.75 0 1 1 11.5 0 M8 11.5l3.25-3.75',
  security: 'M8 1.75 13 3.5v4c0 3.2-2.1 5.6-5 6.75C5.1 13.1 3 10.7 3 7.5v-4z M5.75 8.25 7.25 9.75 10.25 6.5',
  accessibility: 'M8 2a1.25 1.25 0 1 0 0 2.5A1.25 1.25 0 1 0 8 2 M3 6h10 M8 6v4 M8 10l-2.5 4 M8 10l2.5 4',
  observability: 'M1.5 8.5h3l1.5-4 3 8 1.5-4h4',
  dependency: 'M2.5 5 8 2.25 13.5 5v6L8 13.75 2.5 11z M2.5 5 8 7.75 13.5 5 M8 7.75v6',
  'red-team': 'M8 1.75 13 3.5v4c0 3.2-2.1 5.6-5 6.75C5.1 13.1 3 10.7 3 7.5v-4z M6 6.25l4 4 M10 6.25l-4 4',
  'not-a-defect': 'M5.5 8.25l1.75 1.75 3.5-3.75',
  check: 'M3.5 8.5 6.5 11.5 12.5 4.5',
  cross: 'M4 4l8 8M12 4l-8 8',
  dash: 'M4 8h12',
  ring: 'M8 3.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 1 0 0-9',
  left: 'M10 3 5 8l5 5',
  right: 'm6 3 5 5-5 5',
  arrows: 'M5.5 4.5 2 8l3.5 3.5 M10.5 4.5 14 8l-3.5 3.5',
  back: 'M13 11V8a4 4 0 0 0-4-4H3 M6 1 3 4l3 3',
  /** A key: an action that asks for Martin's passkey, and signing in with one. */
  key: 'M4.5 5.25a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 1 0 0-5.5 M7.25 8H14.25 M11.75 8v2.5 M14 8v2',
  /** A pull cord: Stop the line, as a cord along a line stops it. */
  cord: 'M8 1.5v7.5 M8 10a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5',
  /** A person: an admin action, in the audit log. */
  person: 'M8 2.5a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 1 0 0-5.5 M2.75 14c.7-2.9 2.8-4.5 5.25-4.5s4.55 1.6 5.25 4.5',
  /** A chip: a model call, in the audit log. */
  chip: 'M5.5 4h5A1.5 1.5 0 0 1 12 5.5v5a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 4 10.5v-5A1.5 1.5 0 0 1 5.5 4 M6.5 1.75V4 M9.5 1.75V4 M6.5 12v2.25 M9.5 12v2.25 M1.75 6.5H4 M1.75 9.5H4 M12 6.5h2.25 M12 9.5h2.25',
  /** A flag: an improvement's feature flag, on its card. */
  flag: 'M3.75 14.25V2.25 M3.75 2.75h8.5l-2 3 2 3h-8.5',
  /** An eye: preview a flag on the app. */
  eye: 'M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z M8 6a2 2 0 1 0 0 4 2 2 0 1 0 0-4',
  /** Two corners drawn apart: open a picture at full size. */
  expand: 'M9.5 2.5h4v4 M13.5 2.5 9.25 6.75 M6.5 13.5h-4v-4 M2.5 13.5l4.25-4.25',
  /** A laptop: a model run on Martin's own machine, where what matters is where it ran, not whose model it is. */
  local: 'M3 4h10v6.5H3z M1.5 12.5h13',
} satisfies Record<Category | string, string>;

export type GlyphName = keyof typeof PATHS;

export function Glyph({ name, className = 'glyph' }: { name: GlyphName; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      {name === 'not-a-defect' && <circle cx="8" cy="8" r="6.25" strokeDasharray="2.2 2" />}
      <path d={PATHS[name]} />
    </svg>
  );
}

export const CATEGORY_NAME: Record<Category, string> = {
  content: 'Content',
  navigation: 'Navigation',
  functional: 'Functional',
  errors: 'Errors',
  performance: 'Performance',
  accessibility: 'Accessibility',
  security: 'Security',
  observability: 'Observability',
  improvement: 'Improvement',
  dependency: 'Dependency',
  'red-team': 'Red team',
  'not-a-defect': 'Not a defect',
};
