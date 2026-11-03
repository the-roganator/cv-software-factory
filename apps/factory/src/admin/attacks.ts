/**
 * Martin's launch of a red-team attack, from its guardrail's row in the console (`POST /admin/attacks/:attack`): one of
 * spec 5.3's five, by its id, and nothing else. One transaction opens a work item of kind and category `red-team`,
 * numbered by the store as triage numbers one, titled `ATTACK_TITLE`, and appends his `attack.launched` on it, so the
 * attack's card is there from the moment he launches it. The red-team harness makes the attack, against the real
 * mechanism, and records how it ended (`attack.finished`) on that work item.
 *
 * - **No passkey.** An attack loosens nothing and asks the line for no work: every attack's content is fixed in code,
 *   and the line builds nothing from it. So it is `attack.launch` in the access table, which asks for nothing more.
 * - **Only one available now** (`AVAILABLE_ATTACKS` in `policy/attacks.ts`). One that is not is refused (403) before
 *   anything is asked of the store.
 * - **One at a time.** A launch is refused (409) while the last one his roles launched has neither an `attack.finished`
 *   appended by the harness's role nor passed its limit (`policy/attacks.ts`), by the store's clock: so attacks never
 *   meet each other's refusals, and a harness that is down blocks nothing for longer than the attack it missed. Asked
 *   after the lock every append takes, so two launches at once cannot both pass.
 * - **His alone.** Only Martin's roles may launch an attack or open its work item (0045_red-team-attacks.sql), and the
 *   harness acts on a launch only when one of them appended it.
 * - **Nothing from the request** but the attack's id: the kind, category and title are the service's.
 */
import { ATTACKS, type Attack, upcast } from '@software-factory/events';
import { lockAppends, nextWorkItem } from '@software-factory/store';
import type { TransactionSql } from 'postgres';
import { z } from 'zod';
import { ATTACK_RULES, ATTACK_TITLE, attackAvailable, attackLimitMs } from '../../../../policy/attacks.ts';
import { MARTINS_ROLES } from '../../../../policy/store-grants.ts';
import { type AdminStore, adminEvent, Refused } from './store.ts';

/** What a launch sends: nothing, as the attack is in its path. */
export const LAUNCH = z.strictObject({});

/** What a launch did: the work item it opened, and the attack. */
export interface Launched {
  workItem: string;
  attack: Attack;
}

/** The last attack Martin's roles launched, whether the harness finished it, and how long ago it was launched. */
export interface LastLaunch {
  workItem: string;
  /** Its attack, as this code reads it, or what it named if this code does not know it. */
  attack: string;
  finished: boolean;
  ageMs: number;
}

const isAttack = (attack: string): attack is Attack => (ATTACKS as readonly string[]).includes(attack);

/**
 * The last attack one of Martin's roles launched, with whether the harness's role finished it, by the store's clock:
 * the one a new launch waits for. Undefined when none has been launched. In a store of samples, a sample's end counts
 * too: only the harness's role and Martin's command line may append one (0045_red-team-attacks.sql), and a store holds
 * samples or real events, never both.
 */
export async function lastLaunch(tx: TransactionSql): Promise<LastLaunch | undefined> {
  const [row] = await tx<{ work_item: string; version: number; payload: unknown; finished: boolean; age_ms: number }[]>`
    select l.work_item, l.version, l.payload,
           exists (select 1 from events f where f.work_item = l.work_item and f.type = 'attack.finished'
                   and (f.appended_by = 'factory_redteam' or f.sample)) as finished,
           (extract(epoch from clock_timestamp() - l.appended_at) * 1000)::float8 as age_ms
    from events l
    where l.type = 'attack.launched' and l.appended_by = any(${MARTINS_ROLES})
    order by l.seq desc limit 1`;
  if (!row) return undefined;
  const read = upcast({ type: 'attack.launched', version: row.version, payload: row.payload });
  const attack = read.ok ? String((read.event.payload as { attack: unknown }).attack) : 'unknown';
  return { workItem: row.work_item, attack, finished: row.finished, ageMs: row.age_ms };
}

/**
 * Opens the attack's work item and records Martin's launch of it, or refuses having opened nothing. Whether an attack
 * may be launched is the catalogue's (`attackAvailable`) unless the caller gives another, as only the tests do.
 */
export async function launchAttack(
  store: AdminStore,
  attack: string,
  available: (attack: Attack) => boolean = attackAvailable,
): Promise<Launched> {
  if (!isAttack(attack)) {
    throw new Refused('attack', 404, `There is no such attack: the attacks are ${ATTACKS.join(', ')}.`);
  }
  if (!available(attack)) throw new Refused('attack', 403, 'This attack is not available yet.');
  const { workItem } = await store.record(
    async (tx) => {
      await lockAppends(tx);
      const last = await lastLaunch(tx);
      if (last && !last.finished && last.ageMs < attackLimitMs(last.attack)) {
        const minutes = Math.ceil((attackLimitMs(last.attack) - last.ageMs) / 60_000);
        throw new Refused(
          'attack',
          409,
          `One attack at a time: #${last.workItem} has not finished. Launch another once it has, or in ` +
            `${minutes === 1 ? 'a minute' : `${minutes} minutes`}, when it counts as unfinished.`,
        );
      }
      // A store of samples takes samples alone, as every append of his does.
      const [kind] = await tx<{ sample: boolean }[]>`select sample from store`;
      return { workItem: await nextWorkItem(tx), sample: kind?.sample ?? false };
    },
    ({ workItem, sample }) => [
      adminEvent(
        'work-item.opened',
        'Martin launched a red-team attack from the console',
        { kind: 'red-team', title: ATTACK_TITLE, sample, category: 'red-team' },
        workItem,
      ),
      adminEvent('attack.launched', `Martin launched an attack: ${ATTACK_RULES[attack].name}`, { attack }, workItem),
    ],
  );
  return { workItem, attack };
}
