import { describe, expect, inject, it, vi } from 'vitest';
import { createDatabase } from './postgres.ts';

const server = () => inject('databaseUrl');

describe("each test's database", () => {
  it('is a copy of the run’s template, migrated, and connects as each role', async () => {
    const db = await createDatabase(server(), 'copy', inject('databaseTemplate'));
    try {
      const [migrated] = await db.owner<{ n: number }[]>`select count(*)::int as n from schema_migrations`;
      expect(migrated?.n).toBeGreaterThan(0);
      const [me] = await db.as.line<{ me: string }[]>`select current_user as me`;
      expect(me?.me).toBe('factory_line');
    } finally {
      await db.end();
    }
  });

  it('is migrated for itself when there is no template to copy', async () => {
    const db = await createDatabase(server(), 'own');
    try {
      const [migrated] = await db.owner<{ n: number }[]>`select count(*)::int as n from schema_migrations`;
      expect(migrated?.n).toBeGreaterThan(0);
    } finally {
      await db.end();
    }
  });

  it('says, naming the cause, when making it takes longer than a copy should, and is made all the same', async () => {
    const said = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const db = await createDatabase(server(), 'slow', inject('databaseTemplate'), 0);
      try {
        const [me] = await db.as.line<{ me: string }[]>`select current_user as me`;
        expect(me?.me).toBe('factory_line');
      } finally {
        await db.end();
      }
      expect(said).toHaveBeenCalledWith(
        expect.stringMatching(
          /Making the test database slow_\d+_\d+ took \d+ ms, over the 0 ms a copy of the template takes/,
        ),
      );
    } finally {
      said.mockRestore();
    }
  });
});
