/**
 * Pure helpers around the library: how a cartridge is recognised and how a
 * save's age is described.
 */

import { describe, expect, it } from 'vitest';
import { ALL_ROM_EXTENSIONS, SYSTEMS, systemForFileName } from '../../src/core/systems';
import { isLikelyGbaRom, parseGbaRom } from '../../src/core/gbaRom';
import { formatAge } from '../../src/app/SaveSlots';
import { fletcher32 } from '../../src/storage/library';

describe('systemForFileName', () => {
  it('recognises every supported extension, whatever the case', () => {
    expect(systemForFileName('Tetris.gb')?.id).toBe('gb');
    expect(systemForFileName('Zelda.GBC')?.id).toBe('gb');
    expect(systemForFileName('Feuerrot.gba')?.id).toBe('gba');
    expect(systemForFileName('Feuerrot.GBA')?.id).toBe('gba');
  });

  it('rejects anything else', () => {
    expect(systemForFileName('notes.txt')).toBeNull();
    expect(systemForFileName('no-extension')).toBeNull();
    expect(systemForFileName('archive.zip')).toBeNull();
  });

  it('offers every extension to the file picker', () => {
    expect(ALL_ROM_EXTENSIONS).toContain('.gb');
    expect(ALL_ROM_EXTENSIONS).toContain('.gbc');
    expect(ALL_ROM_EXTENSIONS).toContain('.gba');
  });

  it('only claims depth support where the renderer actually has it', () => {
    // Both consoles expose their layers as tile maps, which is what the depth
    // renderer needs; the DS does not have a decoder.
    expect(SYSTEMS.gb.supportsDepth).toBe(true);
    expect(SYSTEMS.gba.supportsDepth).toBe(true);
    expect(SYSTEMS.nds.supportsDepth).toBe(false);
  });
});

describe('GBA header parsing', () => {
  /** A header with the fixed byte and a title, which is all we read. */
  function header(title: string, code = 'BPRD', fixed = 0x96): Uint8Array {
    const bytes = new Uint8Array(0x200);
    for (let i = 0; i < title.length; i++) bytes[0xa0 + i] = title.charCodeAt(i);
    for (let i = 0; i < code.length; i++) bytes[0xac + i] = code.charCodeAt(i);
    bytes[0xb2] = fixed;
    return bytes;
  }

  it('accepts a cartridge and reads its title and code', () => {
    const bytes = header('POKEMON FIRE');
    expect(isLikelyGbaRom(bytes)).toBe(true);
    expect(parseGbaRom(bytes, 'fallback')).toMatchObject({
      title: 'POKEMON FIRE',
      gameCode: 'BPRD',
      headerValid: true,
    });
  });

  it('rejects a file without the fixed header byte', () => {
    expect(isLikelyGbaRom(header('X', 'AAAA', 0x00))).toBe(false);
    expect(isLikelyGbaRom(new Uint8Array(16))).toBe(false);
  });

  it('falls back to the file name when the title field is empty', () => {
    expect(parseGbaRom(header(''), 'Mein Spiel').title).toBe('Mein Spiel');
  });
});

describe('formatAge', () => {
  const now = Date.UTC(2026, 5, 15, 12, 0, 0);

  it('describes recent saves loosely', () => {
    expect(formatAge(now - 5_000, now)).toBe('gerade eben');
    expect(formatAge(now - 90_000, now)).toBe('vor 2 min');
    expect(formatAge(now - 3 * 3600_000, now)).toBe('vor 3 h');
  });

  it('switches to days, then to a date', () => {
    expect(formatAge(now - 26 * 3600_000, now)).toBe('gestern');
    expect(formatAge(now - 3 * 86400_000, now)).toBe('vor 3 Tagen');
    expect(formatAge(now - 40 * 86400_000, now)).toMatch(/\d{2}\.\d{2}\.\d{2}/);
  });

  it('never reports a negative age from a slightly skewed clock', () => {
    expect(formatAge(now + 5_000, now)).toBe('gerade eben');
  });
});

describe('fletcher32', () => {
  it('changes when a single byte changes', () => {
    const a = new Uint8Array(4096).fill(7);
    const b = new Uint8Array(4096).fill(7);
    b[2048] = 8;
    expect(fletcher32(a)).not.toBe(fletcher32(b));
  });

  it('is stable and unsigned for long inputs', () => {
    // Longer than the 359-word deferral block, so the folding path runs.
    const bytes = new Uint8Array(100_000).map((_, i) => i & 0xff);
    const sum = fletcher32(bytes);
    expect(sum).toBe(fletcher32(bytes));
    expect(sum).toBeGreaterThanOrEqual(0);
  });

  it('notices content moving within a save of the same length', () => {
    const a = new Uint8Array(64);
    const b = new Uint8Array(64);
    a[10] = 0x5a;
    b[40] = 0x5a;
    expect(fletcher32(a)).not.toBe(fletcher32(b));
  });

  it('cannot tell runs of zeroes apart, which is why length is compared too', () => {
    // A documented property of Fletcher sums. saveBatteryIfChanged never
    // relies on the checksum alone for exactly this reason.
    expect(fletcher32(new Uint8Array(8))).toBe(fletcher32(new Uint8Array(9)));
  });
});
