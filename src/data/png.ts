// Minimal PNG decoder (8-bit greyscale, RGB or RGBA, no interlace) for data
// stored in PNGs: map bundles and terrain height. Decoding through a canvas is
// lossy on some browsers (colour management) and phones cap canvas size, so
// the bytes are inflated and unfiltered here instead.

export interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  data: Uint8Array;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodePng(buf: Uint8Array): Promise<DecodedPng> {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('not a PNG');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 8, width = 0, height = 0, channels = 0;
  const idat: Uint8Array[] = [];
  let idatLen = 0;
  while (p < buf.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(p + 8);
      height = dv.getUint32(p + 12);
      const depth = body[8], colour = body[9], interlace = body[12];
      channels = ({ 0: 1, 2: 3, 6: 4 } as Record<number, number>)[colour] ?? 0;
      if (depth !== 8 || !channels || interlace) throw new Error(`unsupported PNG (depth ${depth}, colour ${colour})`);
    } else if (type === 'IDAT') {
      idat.push(body);
      idatLen += len;
    } else if (type === 'IEND') break;
    p += 12 + len;
  }
  const z = new Uint8Array(idatLen);
  let o = 0;
  for (const c of idat) {
    z.set(c, o);
    o += c.length;
  }
  const raw = await inflate(z);
  const bpp = channels, stride = width * bpp;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride, prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? out[dst + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = y > 0 && x >= bpp ? out[prev + x - bpp] : 0;
      let r: number;
      switch (f) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad PNG filter ${f}`);
      }
      out[dst + x] = r & 255;
    }
  }
  return { width, height, channels, data: out };
}
