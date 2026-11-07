/**
 * Launching a red-team attack, from its guardrail's row in Guardrails: what it does, in a ruled box; what should refuse
 * it, and that its refusal goes on its card; that if nothing refuses it his phone hears and the guardrail reads "did
 * not hold"; and what it costs. Its code arrives when the dialog first opens.
 *
 * For Martin, **Launch** is one write, `POST /admin/attacks/<attack>`, with no passkey: an attack loosens nothing and
 * asks the line for no work (`attack.launch` in `policy/access.ts`). The admin service opens the attack's work item and
 * records his launch on it, and the attack's card arrives with those events; the dialog closes. Attacks run one at a
 * time, so while one is in flight Launch is disabled here too, and the service's refusal (a 409, when another got there
 * first) is shown in its words.
 *
 * For a visitor it is the same dialog, read-only: Launch a label, saying Martin launches it, signed in, and that
 * milestone 8 opens the attacks to visitors, with only Close.
 */
import type { Attack } from '@software-factory/events';
import type { Admin } from '../admin.ts';
import { ATTACK_RULES, REFUSED_BY } from '../projection/attacks.ts';
import type { GuardrailsView } from '../projection/index.ts';
import { Dialog } from './Dialog.tsx';
import { Glyph } from './Glyph.tsx';
import { Refusal } from './Words.tsx';
import { useWrite } from './Write.tsx';

/** What each attack costs to launch. */
const COST: Record<Attack, string> = {
  report: 'Jev’s calls, a fraction of a cent: they are the mechanism.',
  workflow: 'Nothing: no model is called, and nothing reaches the repository.',
  test: 'Nothing: no model is called. The pull request is real, and the GitHub worker closes it and deletes its branch afterwards.',
  egress: 'Nothing: a pod of the attack’s own, gone when it ends.',
  image: 'Nothing: the pod is refused before it is made.',
};

interface AttackDialogProps {
  guardrail: number;
  attack: Attack;
  /** The attack in flight, if one is: Launch waits for it. */
  running: GuardrailsView['running'];
  admin: Admin;
  onClose: () => void;
}

/** What the attack does, and what it should meet: the same for Martin and for everyone else. */
function About({ attack, guardrail, martin }: { attack: Attack; guardrail: number; martin: boolean }) {
  return (
    <>
      <div className="dialog-what">
        <p>{ATTACK_RULES[attack].tries}</p>
      </div>
      <ul className="dialog-what plain">
        <li>
          What should refuse it: {REFUSED_BY[attack]}. Its refusal, in its own words, goes on the work item’s card.
        </li>
        <li>
          If nothing refuses it, that is a failure: {martin ? 'your' : 'Martin’s'} phone hears, and guardrail{' '}
          {guardrail} reads “did not hold”.
        </li>
        <li>What it costs: {COST[attack]}</li>
      </ul>
    </>
  );
}

const kicker = (guardrail: number) => (
  <>
    <Glyph name="red-team" />
    <span className="label">A red-team attack · guardrail {guardrail}</span>
  </>
);

export function AttackDialog({ guardrail, attack, running, admin, onClose }: AttackDialogProps) {
  return admin.kind === 'martin' ? (
    <MartinsLaunch
      token={admin.session.token}
      guardrail={guardrail}
      attack={attack}
      running={running}
      onClose={onClose}
    />
  ) : (
    <Dialog title={ATTACK_RULES[attack].name} kicker={kicker(guardrail)} onClose={onClose}>
      <About attack={attack} guardrail={guardrail} martin={false} />
      <div className="answers">
        <div className="answer">
          <span className="ro">Launch</span>
          <p>Martin launches it, signed in. Milestone 8 opens this menu to visitors.</p>
        </div>
      </div>
    </Dialog>
  );
}

function MartinsLaunch({
  token,
  guardrail,
  attack,
  running,
  onClose,
}: Omit<AttackDialogProps, 'admin'> & { token: string }) {
  const writes = useWrite(token);
  const launch = () =>
    writes.send(
      `/admin/attacks/${attack}`,
      {},
      {
        // Launched: its card arrives with its events, and its row reads Running. Nothing else announces it.
        done: () => {
          onClose();
          return undefined;
        },
      },
    );
  return (
    <Dialog
      title={ATTACK_RULES[attack].name}
      kicker={kicker(guardrail)}
      onClose={onClose}
      actions={
        <button
          type="button"
          className="btn primary"
          disabled={running !== undefined}
          aria-disabled={writes.busy || undefined}
          onClick={() => void launch()}
        >
          Launch
        </button>
      }
    >
      <About attack={attack} guardrail={guardrail} martin />
      <p className="help">
        {running
          ? `One at a time: #${running.workItem} is running. Launch this once it ends.`
          : 'No passkey: an attack loosens nothing, and asks the line for no work. One runs at a time.'}
      </p>
      <Refusal text={writes.refusal} />
    </Dialog>
  );
}
