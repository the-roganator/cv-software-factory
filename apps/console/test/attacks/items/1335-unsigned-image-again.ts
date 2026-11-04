/**
 * The fifth red-team attack again, in flight as the samples end: Martin launched it from Guardrails, and the harness
 * has not yet asked for its pod. Until it ends, or 10 minutes pass, every other Launch waits for it.
 */
import { Item } from '../../../../../packages/samples/src/build.ts';

export default new Item('1335', '2026-10-06T15:19:00+01:00')
  .at('0:00', 'work-item.opened', 'martin', 'Martin launched a red-team attack from the console', {
    kind: 'red-team',
    title: 'Red-team attack by Martin',
    sample: true,
    category: 'red-team',
  })
  .at('0:00', 'attack.launched', 'martin', 'Martin launched an attack: Shipping an image it built itself', {
    attack: 'image',
  });
