import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { decodeTerrarium } from '../../src/data/elevation';
import { decodePng } from '../../src/data/png';

describe('png decoding', () => {
  it('returns exact greyscale bytes for every filter type', async () => {
    const w = 37, h = 23;
    const png = new PNG({ width: w, height: h, colorType: 0, inputColorType: 0, bitDepth: 8, inputHasAlpha: false });
    const src = new Uint8Array(w * h);
    for (let i = 0; i < src.length; i++) src[i] = (i * 73 + (i >> 3) * 11) & 255;
    png.data = Buffer.from(src);
    for (const filterType of [0, 1, 2, 3, 4]) {
      const buf = PNG.sync.write(png, { colorType: 0, inputColorType: 0, filterType });
      const out = await decodePng(new Uint8Array(buf));
      expect([out.width, out.height, out.channels]).toEqual([w, h, 1]);
      expect(Buffer.from(out.data).equals(Buffer.from(src))).toBe(true);
    }
  });

  it('decodes terrarium heights from RGB tiles', async () => {
    const png = new PNG({ width: 2, height: 1, colorType: 2, inputColorType: 2, inputHasAlpha: false });
    // -3.5 m (a polder) and 322.25 m (Vaalserberg)
    png.data = Buffer.from([127, 252, 128, 129, 66, 64]);
    const out = await decodePng(new Uint8Array(PNG.sync.write(png, { colorType: 2, inputColorType: 2 })));
    expect(Array.from(decodeTerrarium(out.data, out.channels))).toEqual([-3.5, 322.25]);
  });
});
