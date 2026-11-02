/**
 * A screenshot shown whole, at full size, with its marks: what a shot's frame, a wipe or a strip of unchanged pages
 * opens. It is the console's dialog (`Dialog.tsx`), so the page behind it cannot be reached, Escape or Close closes
 * it, and the control that opened it has focus again. The page is drawn at the dialog's width, up to its own, and a
 * tall one scrolls inside it under the title, which stays. A wipe opens both its sides, side by side, scrolling
 * together, or one above the other on a phone. Its own chunk: the first view never loads it.
 */
import type { Screenshot } from '@software-factory/events';
import { createPortal } from 'react';
import { useArtifactUrl } from '../artifacts.ts';
import { Dialog } from './Dialog.tsx';
import { placedWhole } from './marks.ts';
import type { Mark } from './Pictures.tsx';
import '../styles/viewer.css';

/** One side of what opens: a screenshot, its marks, and what it shows, in words. */
export interface Side {
  shot: Screenshot;
  marks: Mark[];
  alt: string;
  /** Which side it is, when there are two: before or after, and its version. */
  tag?: { text: string; tone: 'faint' | 'attn' | 'ok' };
}

export interface Opened {
  title: string;
  /** A line above the title: what kind of picture it is. */
  kicker: string;
  sides: Side[];
}

export function ShotViewer({ opened, onClose }: { opened: Opened; onClose: () => void }) {
  const { title, kicker, sides } = opened;
  return createPortal(
    <Dialog title={title} kicker={<span className="label">{kicker}</span>} className="viewer" onClose={onClose}>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a tall page scrolls here, and the keyboard scrolls it too */}
      <section className="viewer-scroll" tabIndex={0} aria-label="The whole page">
        <div className={`viewer-sides ${sides.length > 1 ? 'two' : ''}`}>
          {sides.map((side) => (
            <WholePage key={side.shot.hash} side={side} />
          ))}
        </div>
      </section>
    </Dialog>,
    document.body,
  );
}

function WholePage({ side }: { side: Side }) {
  const url = useArtifactUrl();
  const { shot, marks, alt, tag } = side;
  return (
    <figure className="viewer-side">
      {tag && <figcaption className={`label tone-${tag.tone} toned`}>{tag.text}</figcaption>}
      <div className="viewer-page">
        <img src={url(shot.hash)} alt={alt} width={shot.width} height={shot.height} draggable={false} />
        {marks.map((mark) => {
          const { up, ...box } = placedWhole(mark, shot);
          // At full size there is room for both a numbered mark's number and its label.
          const label = [mark.n, mark.label].filter((part) => part !== undefined && part !== '').join(' ');
          return (
            <span
              key={`${mark.x},${mark.y},${mark.kind}`}
              className={`mk ${mark.kind} ${up ? 'up' : ''}`}
              style={box}
              aria-hidden="true"
            >
              {label && <span className="mk-label">{label}</span>}
            </span>
          );
        })}
      </div>
    </figure>
  );
}
