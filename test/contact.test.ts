import { afterEach, describe, expect, it, vi } from 'vitest';
import { contactPlaceholders, type ContactProfile } from '../src/ia/cv_factory';
import { replacePlaceholders } from '../src/gdocs';

const profile: ContactProfile = {
  phone_ca: '+1-604-555-0001', phone_co: '+57-300-555-0002',
  location_ca: 'Vancouver, BC, Canada', location_co: 'Medellín, Colombia',
  address_ca: '123 CA St', address_co: 'Calle 10 CO',
};

describe('contactPlaceholders (per-track fill)', () => {
  it('canada_coop -> Canadian phone + Vancouver', () => {
    expect(contactPlaceholders('canada_coop', profile)).toEqual({
      '{{phone}}': '+1-604-555-0001', '{{location}}': 'Vancouver, BC, Canada',
    });
  });

  it('colombia_perm -> Colombian phone + Medellín', () => {
    expect(contactPlaceholders('colombia_perm', profile)).toEqual({
      '{{phone}}': '+57-300-555-0002', '{{location}}': 'Medellín, Colombia',
    });
  });

  it('contractor_usd -> Colombian values (LATAM orientation)', () => {
    expect(contactPlaceholders('contractor_usd', profile)).toEqual({
      '{{phone}}': '+57-300-555-0002', '{{location}}': 'Medellín, Colombia',
    });
  });

  it('never leaks a raw {{...}}: unset values resolve to empty string', () => {
    const map = contactPlaceholders('canada_coop', {});
    expect(map).toEqual({ '{{phone}}': '', '{{location}}': '' });
  });

  it('address is NOT among the CV placeholders (forms-only)', () => {
    const keys = Object.keys(contactPlaceholders('colombia_perm', profile));
    expect(keys).toEqual(['{{phone}}', '{{location}}']);
  });
});

describe('replacePlaceholders (Docs batchUpdate)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends one replaceAllText request per placeholder, matchCase true', async () => {
    let sentBody: unknown;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      return new Response('{}', { status: 200 });
    });
    await replacePlaceholders('tok', 'docId', { '{{phone}}': '123', '{{location}}': 'Medellín' }, fetchMock);
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = sentBody as { requests: Array<{ replaceAllText: { containsText: { text: string; matchCase: boolean }; replaceText: string } }> };
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0]!.replaceAllText.containsText).toEqual({ text: '{{phone}}', matchCase: true });
    expect(body.requests[0]!.replaceAllText.replaceText).toBe('123');
    expect(body.requests[1]!.replaceAllText.replaceText).toBe('Medellín');
  });

  it('empty map makes no request', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    await replacePlaceholders('tok', 'docId', {}, fetchMock);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
