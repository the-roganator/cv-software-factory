/** The design system's custom elements, as JSX knows them. */
import type { HTMLAttributes } from 'preact';
import type { Beacon, BeltEnd, Kind, Status } from '../../../../docs/design/system/station.ts';

declare module 'preact' {
  namespace JSX {
    interface IntrinsicElements {
      'sf-station': HTMLAttributes<HTMLElement> & {
        kind: Kind;
        status: Status;
        beacon?: Beacon | undefined;
        belt?: BeltEnd | undefined;
        motion?: 'off' | undefined;
        bird?: 'out' | undefined;
        decorative?: boolean | undefined;
        label?: string | undefined;
      };
    }
  }
}
