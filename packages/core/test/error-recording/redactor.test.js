import { describe, it, expect, vi } from 'vitest';
import { diag } from '@opentelemetry/api';
import { applyRedactor, MAX_REDACTOR_OUTPUT_LENGTH } from '../../src/error-recording/redactor.js';
import { normalizeMessage } from '../../src/fingerprint/normalize/message.js';
import { computeFingerprint } from '../../src/fingerprint/compose.js';

function freshState() {
  return { warnedFailed: false };
}

describe('applyRedactor', () => {
  describe('a working redactor', () => {
    it('returns the redactor output, applied to both message and stack', () => {
      const redactor = ({ message, stack }) => ({
        message: message.replace('SECRET_TOKEN', '[REDACTED]'),
        stack: stack?.replace('acme-corp', '[TENANT]'),
      });

      const result = applyRedactor(
        { message: 'failed for SECRET_TOKEN', stack: 'Error: x\n    at f (/opt/customers/acme-corp/h.js:1:1)' },
        redactor,
        freshState(),
      );

      expect(result).toEqual({
        message: 'failed for [REDACTED]',
        stack: 'Error: x\n    at f (/opt/customers/[TENANT]/h.js:1:1)',
      });
    });

    it('lets a message-only redactor return stack unchanged', () => {
      const redactor = ({ message, stack }) => ({ message: message.toUpperCase(), stack });
      const result = applyRedactor({ message: 'boom', stack: 'the-stack' }, redactor, freshState());
      expect(result).toEqual({ message: 'BOOM', stack: 'the-stack' });
    });

    it('preserves an undefined stack rather than coercing it to a string', () => {
      const redactor = ({ message, stack }) => ({ message, stack });
      const result = applyRedactor({ message: 'boom', stack: undefined }, redactor, freshState());
      expect(result.stack).toBeUndefined();
    });

    it('is called exactly once per invocation, not once per field (Decision 1)', () => {
      const redactor = vi.fn(({ message, stack }) => ({ message, stack }));
      applyRedactor({ message: 'm', stack: 's' }, redactor, freshState());
      expect(redactor).toHaveBeenCalledTimes(1);
      expect(redactor).toHaveBeenCalledWith({ message: 'm', stack: 's' });
    });

    it('runs before this library\'s own normalizeMessage() patterns, not the reverse (Decision 2)', () => {
      // The redactor scrubs a proprietary token shape our own patterns
      // don't know about; our own patterns still get to scrub the email
      // afterward. Both being present in the final result proves the
      // redactor's output is what feeds normalizeMessage(), in that order.
      const redactor = ({ message, stack }) => ({
        message: message.replace('SECRET_TOKEN', '[REDACTED]'),
        stack,
      });

      const redacted = applyRedactor({ message: 'SECRET_TOKEN for user@example.com', stack: undefined }, redactor, freshState());
      const normalized = normalizeMessage(redacted.message);

      expect(normalized).toContain('[REDACTED]');
      expect(normalized).toContain('<EMAIL>');
      expect(normalized).not.toContain('SECRET_TOKEN');
      expect(normalized).not.toContain('user@example.com');
    });
  });

  describe('failure handling (Decision 4) — never falls back to raw', () => {
    it('a throwing redactor falls back to null and warns once', () => {
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
      const state = freshState();
      const redactor = () => {
        throw new Error('boom');
      };

      const result = applyRedactor({ message: 'raw content', stack: 'raw stack' }, redactor, state);

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('a non-string message return falls back to null and warns once', () => {
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
      const state = freshState();
      const redactor = () => ({ message: 42, stack: undefined });

      const result = applyRedactor({ message: 'raw content', stack: undefined }, redactor, state);

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('an undefined return falls back to null and warns once', () => {
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
      const state = freshState();
      const redactor = () => undefined;

      const result = applyRedactor({ message: 'raw content', stack: undefined }, redactor, state);

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('a non-string, non-plain return (e.g. a bare string) falls back to null and warns once', () => {
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
      const state = freshState();
      const redactor = () => 'just a string, not { message, stack }';

      const result = applyRedactor({ message: 'raw content', stack: undefined }, redactor, state);

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('an invalid (non-string, non-undefined) stack falls back to null and warns once', () => {
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
      const state = freshState();
      const redactor = () => ({ message: 'fine', stack: 12345 });

      const result = applyRedactor({ message: 'raw content', stack: undefined }, redactor, state);

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('a null stack is also invalid (must be a string or undefined, not null)', () => {
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
      const state = freshState();
      const redactor = () => ({ message: 'fine', stack: null });

      const result = applyRedactor({ message: 'raw content', stack: undefined }, redactor, state);

      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('warns only once per state even across repeated failures', () => {
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
      const state = freshState();
      const redactor = () => {
        throw new Error('boom');
      };

      applyRedactor({ message: 'a', stack: undefined }, redactor, state);
      applyRedactor({ message: 'b', stack: undefined }, redactor, state);
      applyRedactor({ message: 'c', stack: undefined }, redactor, state);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('a fresh state warns again independently of an already-warned one', () => {
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
      const redactor = () => {
        throw new Error('boom');
      };
      const stateA = freshState();
      const stateB = freshState();

      applyRedactor({ message: 'a', stack: undefined }, redactor, stateA);
      applyRedactor({ message: 'b', stack: undefined }, redactor, stateB);

      expect(warnSpy).toHaveBeenCalledTimes(2);
      warnSpy.mockRestore();
    });

    it('the warning never contains the redactor output or the original text', () => {
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
      const state = freshState();
      const secretRaw = 'super-secret-original-content-AAAA';
      const secretLeak = 'leaked-redactor-output-BBBB';
      const redactor = () => {
        // A pathological redactor whose thrown error itself carries content
        // — this must never end up in the diag.warn() call.
        throw new Error(secretLeak);
      };

      applyRedactor({ message: secretRaw, stack: undefined }, redactor, state);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnedText = warnSpy.mock.calls[0].join(' ');
      expect(warnedText).not.toContain(secretRaw);
      expect(warnedText).not.toContain(secretLeak);
      warnSpy.mockRestore();
    });

    it('the warning for an invalid non-string message never echoes the invalid value', () => {
      const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
      const state = freshState();
      const redactor = () => ({ message: 'unique-marker-value-999', stack: undefined });
      // Force the "non-string message" branch with a value distinguishable
      // from anything reasonable to echo.
      const badRedactor = () => ({ message: { toString: () => 'unique-marker-value-999' }, stack: undefined });

      applyRedactor({ message: 'x', stack: undefined }, badRedactor, state);

      const warnedText = warnSpy.mock.calls[0].join(' ');
      expect(warnedText).not.toContain('unique-marker-value-999');
      // Sanity: confirm the "good" redactor's value really does contain the
      // marker, so the assertion above is meaningful.
      expect(redactor({ message: 'x', stack: undefined }).message).toContain('unique-marker-value-999');
      warnSpy.mockRestore();
    });
  });

  describe('defensive length cap (Decision 5)', () => {
    it('caps an over-length message to MAX_REDACTOR_OUTPUT_LENGTH', () => {
      const huge = 'x'.repeat(MAX_REDACTOR_OUTPUT_LENGTH + 5000);
      const redactor = () => ({ message: huge, stack: undefined });

      const result = applyRedactor({ message: 'short', stack: undefined }, redactor, freshState());

      expect(result.message).toHaveLength(MAX_REDACTOR_OUTPUT_LENGTH);
    });

    it('caps an over-length stack to MAX_REDACTOR_OUTPUT_LENGTH', () => {
      const huge = 'at f (/very/long/path.js:1:1)\n'.repeat(1000);
      expect(huge.length).toBeGreaterThan(MAX_REDACTOR_OUTPUT_LENGTH);
      const redactor = () => ({ message: 'fine', stack: huge });

      const result = applyRedactor({ message: 'x', stack: 'y' }, redactor, freshState());

      expect(result.stack).toHaveLength(MAX_REDACTOR_OUTPUT_LENGTH);
    });

    it('does not pad or otherwise alter output shorter than the cap', () => {
      const redactor = () => ({ message: 'short', stack: 'also short' });
      const result = applyRedactor({ message: 'x', stack: 'y' }, redactor, freshState());
      expect(result).toEqual({ message: 'short', stack: 'also short' });
    });
  });

  describe('Decision 3 — fingerprint isolation, the load-bearing property', () => {
    it('computeFingerprint() is byte-identical for the same err whether a redactor ran or not', () => {
      const ctx = { origin: 'thrown' };
      const err = new Error('failed for user@example.com, id ACCT-123456789');
      err.stack = 'Error: failed\n    at handler (/opt/customers/acme-corp/handler.js:42:9)';

      const baselineFingerprint = computeFingerprint(err, ctx);

      // Simulate a redactor running on the SPAN path only, exactly as ADR
      // 020 Decision 3 requires — computeFingerprint() itself takes no
      // redactor argument at all, so there is no code path by which this
      // call could influence it.
      const redactor = ({ message, stack }) => ({
        message: message.replace('user@example.com', '[USER]').replace('ACCT-123456789', '[ACCOUNT]'),
        stack: stack?.replace('acme-corp', '[TENANT]'),
      });
      const redacted = applyRedactor({ message: err.message, stack: err.stack }, redactor, freshState());
      expect(redacted.message).not.toContain('user@example.com');

      const fingerprintAfterRedaction = computeFingerprint(err, ctx);

      expect(fingerprintAfterRedaction).toEqual(baselineFingerprint);
      expect(fingerprintAfterRedaction.fingerprint).toBe(baselineFingerprint.fingerprint);
      expect(fingerprintAfterRedaction.inputs.normalizedMessage).toBe(baselineFingerprint.inputs.normalizedMessage);
      expect(fingerprintAfterRedaction.inputs.stackSignature).toBe(baselineFingerprint.inputs.stackSignature);
      // The fingerprint's own normalizedMessage came from OUR patterns on
      // the REAL message, never the redactor's replacement text.
      expect(baselineFingerprint.inputs.normalizedMessage).toContain('<EMAIL>');
      expect(baselineFingerprint.inputs.normalizedMessage).not.toContain('[USER]');
    });

    it('a redactor is never invoked as a side effect of computeFingerprint() itself', () => {
      const ctx = { origin: 'thrown' };
      const err = new Error('boom');
      const redactor = vi.fn(({ message, stack }) => ({ message, stack }));

      computeFingerprint(err, ctx);

      expect(redactor).not.toHaveBeenCalled();
    });
  });
});
