import { describe, it, expect } from 'vitest';
import { loadBuiltSpaHtml } from '../src/spa-html.js';

describe('loadBuiltSpaHtml', () => {
  it('never throws, regardless of whether dist/index.html has been built', () => {
    expect(() => loadBuiltSpaHtml()).not.toThrow();
  });

  it('returns a string containing the app root div when dist/ has been built, else undefined', () => {
    const html = loadBuiltSpaHtml();
    if (html === undefined) return; // acceptable in an environment that hasn't run `npm run build`
    expect(html).toContain('id="root"');
  });
});
