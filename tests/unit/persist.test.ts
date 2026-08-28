import { describe, expect, it } from 'vitest';
import { formatBytes } from '../../src/storage/persist';

describe('formatBytes', () => {
  it('renders an em dash when the browser reports nothing', () => {
    expect(formatBytes(undefined)).toBe('—');
  });

  it('keeps small values in bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('steps up units and keeps one decimal below ten', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(20 * 1024)).toBe('20 KB');
  });

  it('handles ROM- and quota-sized values', () => {
    // A DS card image.
    expect(formatBytes(128 * 1024 * 1024)).toBe('128 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });
});
