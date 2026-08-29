/**
 * Unpacking a cartridge out of an archive.
 *
 * The zip cases build their fixtures here rather than committing binaries, so
 * what each test packs is visible next to what it expects. The RAR and 7z
 * readers are covered only at the format-detection level: no free tool can
 * *create* a RAR archive, so there is no way to build a fixture for one that
 * would still be reproducible on another machine. That reader was verified
 * against real RAR4, RAR5 and solid archives by hand; see docs in archive.ts.
 */

import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { archiveKind, unpackRom } from '../../src/storage/archive';

/** A byte pattern long enough to look like a small cartridge. */
function fakeRom(size = 1024, fill = 0x42): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

describe('archiveKind', () => {
  it('recognises the formats it can unpack, by their header', () => {
    expect(archiveKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('zip');
    // An empty zip and a spanned one carry different third bytes.
    expect(archiveKind(new Uint8Array([0x50, 0x4b, 0x05, 0x06]))).toBe('zip');
    expect(archiveKind(new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]))).toBe(
      'rar',
    );
    // RAR5 differs from RAR4 only after the signature.
    expect(
      archiveKind(new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])),
    ).toBe('rar');
    expect(archiveKind(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))).toBe('7z');
  });

  it('leaves a bare cartridge alone', () => {
    // A GBA header starts with a branch instruction, not an archive signature.
    expect(archiveKind(new Uint8Array([0x7f, 0x00, 0x00, 0xea]))).toBeNull();
    expect(archiveKind(new Uint8Array(4))).toBeNull();
    // Too short to hold any signature at all.
    expect(archiveKind(new Uint8Array([0x50]))).toBeNull();
  });
});

describe('unpackRom', () => {
  it('pulls the cartridge out from beside the files a release ships with', async () => {
    const rom = fakeRom();
    const zip = zipSync({
      'Rising Sun/liesmich.txt': new TextEncoder().encode('Changelog …'),
      'Rising Sun/Feuerrot Rising Sun.gba': rom,
      'Rising Sun/screenshots/titel.png': new Uint8Array([0x89, 0x50]),
    });

    const unpacked = await unpackRom(zip, 'zip', '/');
    expect(unpacked.name).toBe('Feuerrot Rising Sun.gba');
    expect(unpacked.bytes).toEqual(rom);
    expect(unpacked.note).toBeNull();
  });

  it('ignores the metadata a Mac adds when it makes a zip', async () => {
    const rom = fakeRom();
    const zip = zipSync({
      '__MACOSX/._Spiel.gba': new Uint8Array([0, 1, 2, 3]),
      '.DS_Store': new Uint8Array([4, 5]),
      'Spiel.gba': rom,
    });

    const unpacked = await unpackRom(zip, 'zip', '/');
    expect(unpacked.name).toBe('Spiel.gba');
    expect(unpacked.bytes).toEqual(rom);
  });

  it('takes the largest of several cartridges and says that it did', async () => {
    const zip = zipSync({
      'hack.gba': fakeRom(4096, 0x11),
      'original.gba': fakeRom(1024, 0x22),
    });

    const unpacked = await unpackRom(zip, 'zip', '/');
    expect(unpacked.name).toBe('hack.gba');
    expect(unpacked.note).toContain('2 ROMs');
    expect(unpacked.note).toContain('hack.gba');
  });

  it('carries cartridges of different systems out of one archive', async () => {
    const zip = zipSync({ 'Tetris.gb': fakeRom(512) });
    expect((await unpackRom(zip, 'zip', '/')).name).toBe('Tetris.gb');

    const dsZip = zipSync({ 'Spiel.nds': fakeRom(512) });
    expect((await unpackRom(dsZip, 'zip', '/')).name).toBe('Spiel.nds');
  });

  it('explains itself when the archive holds no cartridge', async () => {
    const zip = zipSync({ 'liesmich.txt': new TextEncoder().encode('nur Text') });
    await expect(unpackRom(zip, 'zip', '/')).rejects.toThrow(/keine ROM/);
  });

  it('reports a damaged archive rather than throwing something opaque', async () => {
    const broken = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xff, 0xff, 0xff]);
    await expect(unpackRom(broken, 'zip', '/')).rejects.toThrow(/nicht lesbar/);
  });
});
