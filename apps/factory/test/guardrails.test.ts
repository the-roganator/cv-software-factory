/**
 * The guardrail catalogue (`policy/guardrails.ts`) is spec 6's eleven, in its words, each proof in it once, and each
 * attack against one guardrail.
 */
import { readFileSync } from 'node:fs';
import { GUARDRAIL_COUNT } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import {
  ATTACKS,
  GUARDRAILS,
  guardrailAttacked,
  guardrailsProvedBy,
  PROOFS,
  type ProofId,
} from '../../../policy/guardrails.ts';

const SPEC = new URL('../../../docs/SPECIFICATION.md', import.meta.url);

/** Spec 6's guardrails, by number, as its list writes each. */
function specified(): Map<number, string> {
  const text = readFileSync(SPEC, 'utf-8');
  const section = text.slice(text.indexOf('\n## 6. Guardrails\n'), text.indexOf('\n## 7.'));
  return new Map([...section.matchAll(/^(\d+)\. (.+)$/gm)].map(([, n, line]) => [Number(n), line as string]));
}

describe('the guardrail catalogue', () => {
  it('is spec 6’s eleven, in order, each in spec 6’s words', () => {
    const spec = specified();
    expect(spec.size).toBe(GUARDRAIL_COUNT);
    expect(GUARDRAILS.map(({ n }) => n)).toEqual([...spec.keys()]);
    for (const guardrail of GUARDRAILS) {
      const line = spec.get(guardrail.n) ?? '';
      // Its name in bold, with the punctuation that follows it, then the rest.
      const [, name, rest] = /^\*\*(.+?)[.,:]?\*\*\s*(.*)$/.exec(line) ?? [];
      expect(name, `guardrail ${guardrail.n}`).toBe(guardrail.name);
      expect(rest, `guardrail ${guardrail.n}`).toBe(guardrail.rule);
      expect(guardrail.mechanism, `guardrail ${guardrail.n}`).toMatch(/^[A-Z].+\.$/);
    }
  });

  it('lists each proof under one guardrail, once, and only proofs it knows', () => {
    const listed = GUARDRAILS.flatMap(({ proofs }) => proofs as readonly string[]);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual(Object.keys(PROOFS).sort());
    for (const proof of Object.keys(PROOFS) as ProofId[]) expect(guardrailsProvedBy(proof), proof).toHaveLength(1);
    expect(guardrailsProvedBy('stop-the-line')).toEqual([9]);
    expect(guardrailsProvedBy('ci:scope-fence')).toEqual([11]);
  });

  it('names a proof read from CI by its tests, and every other by a mechanism of its own', () => {
    for (const [id, proof] of Object.entries(PROOFS)) {
      // The shapes `guardrail.proved` takes.
      expect(id, id).toMatch(/^(ci:)?[a-z][a-z0-9-]{0,62}$/);
      expect(proof.mechanism, id).toMatch(/^[a-z][a-z0-9_-]{0,62}$/);
      expect(proof.mechanism === 'ci-tests', id).toBe(id.startsWith('ci:'));
    }
    expect(
      Object.keys(PROOFS)
        .filter((id) => id.startsWith('ci:'))
        .sort(),
    ).toEqual(['ci:gates-deterministic', 'ci:one-gateway', 'ci:public-hostile', 'ci:scope-fence', 'ci:spend-caps']);
  });

  it('makes each of spec 5.3’s five attacks against one guardrail, and proves every guardrail somehow', () => {
    const attacked = GUARDRAILS.flatMap((guardrail) => ('attack' in guardrail ? [guardrail.attack] : []));
    expect([...attacked].sort()).toEqual([...ATTACKS].sort());
    expect(Object.fromEntries(ATTACKS.map((attack) => [attack, guardrailAttacked(attack)]))).toEqual({
      report: 8,
      workflow: 1,
      test: 2,
      egress: 5,
      image: 3,
    });
    for (const guardrail of GUARDRAILS) {
      expect(guardrail.proofs.length > 0 || 'attack' in guardrail, `guardrail ${guardrail.n}`).toBe(true);
    }
  });
});
