import { describe, expect, it } from 'vitest';

import { mapErrorNotice } from './errors';

describe('mapErrorNotice', () => {
  it('zeigt bei einer Ablehnung einen Hinweis', () => {
    expect(mapErrorNotice({ status: 401 })).toMatch(/verweigert/);
    expect(mapErrorNotice({ status: 403 })).toMatch(/verweigert/);
  });

  it('schweigt bei einer gescheiterten Kachel ohne Status', () => {
    // So sieht ein Netzfehler aus: kein Status, aber die URL im Wortlaut —
    // und in der steht `access_token=`.
    const error = {
      message:
        'Failed to fetch https://api.mapbox.com/v4/mapbox.mapbox-incidents-v1/' +
        '5/16/10.vector.pbf?access_token=pk.eyJ1IjoiYmVpc3BpZWwifQ.XYZ',
    };
    expect(mapErrorNotice(error)).toBeNull();
  });

  it('schweigt bei allen anderen Status', () => {
    for (const status of [404, 422, 429, 500, 503]) {
      expect(mapErrorNotice({ status })).toBeNull();
    }
  });

  it('verträgt fehlende Fehlerobjekte', () => {
    expect(mapErrorNotice(undefined)).toBeNull();
    expect(mapErrorNotice(null)).toBeNull();
    expect(mapErrorNotice('kaputt')).toBeNull();
  });

  it('gibt das Token nie weiter', () => {
    const notice = mapErrorNotice({
      status: 401,
      message: 'Unauthorized: access_token=pk.eyJ1IjoiZ2VoZWltIn0.ABC',
    });
    expect(notice).not.toBeNull();
    expect(notice).not.toMatch(/pk\.|access_token/);
  });
});
