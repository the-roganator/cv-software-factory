/**
 * The third red-team attack again, in flight as the samples end: Martin launched it from Guardrails, and the GitHub
 * worker's pull request waits for the app's gates before the review check judges it. Until it ends, or 45 minutes pass,
 * every other Launch waits for it.
 */
import { Item } from '../build.ts';

export default new Item('1335', '2026-10-06T14:50:00+01:00')
  .at('0:00', 'work-item.opened', 'martin', 'Martin launched a red-team attack from the console', {
    kind: 'red-team',
    title: 'Red-team attack by Martin',
    sample: true,
    category: 'red-team',
  })
  .at('0:00', 'attack.launched', 'martin', 'Martin launched an attack: A pull request that deletes the failing test', {
    attack: 'test',
  });
