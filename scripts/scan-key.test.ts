import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STATE_KEY } from '../apps/factory/src/vulnerabilities/state.ts';
import { SCAN_KEY_NAME } from './scan-key.ts';

const HERE = import.meta.dirname;
const source = (file: string) => readFileSync(join(HERE, file), 'utf-8');
/** A module's import statements, in order, as it writes them. */
const imports = (text: string) => text.split('\n').filter((line) => /^import\b/.test(line));

describe('the scan’s state key leaves the environment before any dependency runs', () => {
  it('is read by a module that imports nothing, under the name the state’s key has', () => {
    expect(SCAN_KEY_NAME).toBe(STATE_KEY);
    expect(imports(source('scan-key.ts'))).toEqual([]);
    expect(source('scan-key.ts')).not.toMatch(/\b(import|require)\(/);
  });

  it('is the first import of each script that takes the key, which reads the environment nowhere else', () => {
    for (const script of ['moves.ts', 'pins.ts']) {
      const text = source(script);
      expect(imports(text)[0], script).toBe("import './scan-key.ts';");
      expect(text, script).not.toMatch(/process\.env\[STATE_KEY\]|process\.env\.SCAN_STATE_KEY/);
    }
  });

  it('is gone from the environment when the next module imported is evaluated, and kept for the script', () => {
    const key = pathToFileURL(join(HERE, 'scan-key.ts')).href;
    // A dependency, evaluated after the key's module: it says what the environment holds for it.
    const dependency = `data:text/javascript,console.log(process.env.${STATE_KEY} ?? 'gone')`;
    const script = `import ${JSON.stringify(key)};\nimport ${JSON.stringify(dependency)};\nconst { SCAN_KEY } = await import(${JSON.stringify(key)});\nconsole.log(SCAN_KEY);`;
    const said = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, [STATE_KEY]: 'a-key' },
      encoding: 'utf-8',
    });
    expect(said.trim().split('\n')).toEqual(['gone', 'a-key']);
  });
});
