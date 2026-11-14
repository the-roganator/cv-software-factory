import { describe, expect, it } from 'vitest';
import { askedSheet } from '../web/src/sheets.ts';

const asked = (search: string) => askedSheet(new URLSearchParams(search));

describe('the sheet the address asks for', () => {
  it('is none with nothing asked', () => {
    expect(asked('')).toBeUndefined();
    expect(asked('?item=1312')).toBeUndefined();
    expect(asked('?attack=failed&patching=none')).toBeUndefined();
  });

  it('is a work item’s for `?item=<n>&sheet`, with no value, as before', () => {
    expect(asked('?item=1312&sheet')).toEqual({ kind: 'item', item: '1312' });
    expect(asked('?sheet&item=1312')).toEqual({ kind: 'item', item: '1312' });
    // A sheet with no work item to open is none.
    expect(asked('?sheet')).toBeUndefined();
  });

  it('is a panel’s, at its top, for `?sheet=patching` or `?sheet=guardrails`, whatever work item is named', () => {
    expect(asked('?sheet=patching')).toEqual({ kind: 'patching' });
    expect(asked('?sheet=guardrails')).toEqual({ kind: 'guardrails' });
    expect(asked('?item=1312&sheet=guardrails')).toEqual({ kind: 'guardrails' });
  });

  it('is Patching’s at a row for `?move=`, and Guardrails’ at one for `?open=`, with or without the panel named', () => {
    const key = 'the-roganator/cv-software-factory example-logs';
    expect(asked(`?move=${encodeURIComponent(key)}`)).toEqual({ kind: 'patching', row: key });
    expect(asked(`?sheet=patching&move=${encodeURIComponent(key)}`)).toEqual({ kind: 'patching', row: key });
    expect(asked('?open=5')).toEqual({ kind: 'guardrails', row: 5 });
    expect(asked('?attack=failed&open=5&sheet=guardrails')).toEqual({ kind: 'guardrails', row: 5 });
  });

  it('follows the panel `?sheet=` names when a row of the other is asked for too', () => {
    expect(asked('?move=k3s&open=5&sheet=guardrails')).toEqual({ kind: 'guardrails', row: 5 });
    expect(asked('?move=k3s&open=5&sheet=patching')).toEqual({ kind: 'patching', row: 'k3s' });
    expect(asked('?move=k3s&open=5')).toEqual({ kind: 'patching', row: 'k3s' });
  });

  it('opens a panel at its top for a row that is not one', () => {
    expect(asked('?open=12')).toEqual({ kind: 'guardrails', row: undefined });
    expect(asked('?open=two')).toEqual({ kind: 'guardrails', row: undefined });
    expect(asked('?move=')).toEqual({ kind: 'patching', row: undefined });
  });
});
