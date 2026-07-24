import { describe, it, expect } from 'vitest';
import { parseAndNormalizeStack } from '../../src/fingerprint/normalize/stack.js';

const CWD = '/home/thiru/proj';

describe('parseAndNormalizeStack', () => {
  it('parses a named function frame', () => {
    const stack = ['Error: boom', `    at doThing (${CWD}/src/x.js:12:34)`].join('\n');

    const { frames, signature } = parseAndNormalizeStack(stack, { cwd: CWD });

    expect(frames).toEqual([
      { fn: 'doThing', file: 'src/x.js', line: 12, isNative: false, isUserCode: true },
    ]);
    expect(signature).toBe('doThing@src/x.js:12');
  });

  it('parses an anonymous frame (no fn name, just path)', () => {
    const stack = ['Error: boom', `    at ${CWD}/src/x.js:12:34`].join('\n');

    const { frames } = parseAndNormalizeStack(stack, { cwd: CWD });

    expect(frames).toEqual([
      { fn: '', file: 'src/x.js', line: 12, isNative: false, isUserCode: true },
    ]);
  });

  it('strips version suffixes from node_modules paths', () => {
    const stack = ['Error: boom', '    at run (/x/node_modules/foo@1.2.3/lib/a.js:1:1)'].join('\n');

    const { frames } = parseAndNormalizeStack(stack, { cwd: CWD });

    expect(frames[0].file).toBe('node_modules/foo/lib/a.js');
    expect(frames[0].isUserCode).toBe(false);
  });

  it('keeps @scoped node_modules package names intact', () => {
    const stack = ['Error: boom', '    at run (/x/node_modules/@org/pkg/lib/a.js:1:1)'].join('\n');

    const { frames } = parseAndNormalizeStack(stack, { cwd: CWD });

    expect(frames[0].file).toBe('node_modules/@org/pkg/lib/a.js');
    expect(frames[0].isUserCode).toBe(false);
  });

  it('converts Windows path separators to POSIX', () => {
    const stack = ['Error: boom', '    at doThing (C:\\Users\\thiru\\proj\\file.js:12:34)'].join('\n');

    const { frames } = parseAndNormalizeStack(stack, { cwd: CWD });

    expect(frames[0].file).toBe('C:/Users/thiru/proj/file.js');
  });

  it('filters out native frames', () => {
    const stack = [
      'Error: boom',
      `    at doThing (${CWD}/src/x.js:12:34)`,
      '    at process.processTicksAndRejections (node:internal/process/task_queues.js:95:5)',
    ].join('\n');

    const { frames } = parseAndNormalizeStack(stack, { cwd: CWD });

    expect(frames).toHaveLength(1);
    expect(frames[0].file).toBe('src/x.js');
    expect(frames.some((f) => f.file.includes('task_queues'))).toBe(false);
  });

  it('returns an empty result for an undefined stack, without throwing', () => {
    expect(() => parseAndNormalizeStack(undefined)).not.toThrow();
    expect(parseAndNormalizeStack(undefined)).toEqual({ frames: [], signature: '' });
  });

  it('returns an empty result for an empty stack, without throwing', () => {
    expect(() => parseAndNormalizeStack('')).not.toThrow();
    expect(parseAndNormalizeStack('')).toEqual({ frames: [], signature: '' });
  });

  it('skips malformed lines without throwing', () => {
    const stack = [
      'Error: boom',
      '    not a real frame at all !!! ()( ',
      `    at doThing (${CWD}/src/x.js:12:34)`,
      '    garbage',
    ].join('\n');

    let result;
    expect(() => {
      result = parseAndNormalizeStack(stack, { cwd: CWD });
    }).not.toThrow();
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0].fn).toBe('doThing');
  });

  it('falls back to top non-user frames when there are no user frames', () => {
    const stack = [
      'Error: boom',
      '    at run (/x/node_modules/foo/lib/a.js:1:1)',
      '    at call (/x/node_modules/bar/lib/b.js:2:2)',
    ].join('\n');

    const { frames } = parseAndNormalizeStack(stack, { cwd: CWD });

    expect(frames).toHaveLength(2);
    expect(frames.every((f) => !f.isUserCode)).toBe(true);
    expect(frames[0].file).toBe('node_modules/foo/lib/a.js');
    expect(frames[1].file).toBe('node_modules/bar/lib/b.js');
  });

  it('strips a matching cwd prefix from absolute paths', () => {
    const stack = ['Error: boom', `    at doThing (${CWD}/src/x.js:12:34)`].join('\n');

    const { frames } = parseAndNormalizeStack(stack, { cwd: CWD });

    expect(frames[0].file).toBe('src/x.js');
  });
});
