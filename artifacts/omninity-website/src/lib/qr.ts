/**
 * Pure-TypeScript QR code generator.
 *
 * Implements the QR Code algorithm (ISO/IEC 18004) end-to-end with no
 * external dependencies — we only need byte-mode encoding at error
 * correction level M, sized dynamically to the payload (versions 1-20).
 *
 * Adapted from Project Nayuki's public-domain QR Code generator
 * (https://www.nayuki.io/page/qr-code-generator-library) and trimmed to
 * the encoder paths the Mobile Companion pairing UI actually uses.
 */

const ECC_CODEWORDS_PER_BLOCK_M: ReadonlyArray<number> = [
  10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
];

const NUM_ERROR_CORRECTION_BLOCKS_M: ReadonlyArray<number> = [
  1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
];

interface QrData {
  size: number;
  modules: boolean[][];
}

function getNumDataCodewords(version: number): number {
  return getNumRawDataModules(version) / 8 - ECC_CODEWORDS_PER_BLOCK_M[version - 1]! * NUM_ERROR_CORRECTION_BLOCKS_M[version - 1]!;
}

function getNumRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function reedSolomonComputeDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = reedSolomonMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j] ^= result[j + 1]!;
    }
    root = reedSolomonMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonComputeRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    for (let i = 0; i < divisor.length; i++) {
      result[i] ^= reedSolomonMultiply(divisor[i]!, factor);
    }
  }
  return result;
}

function reedSolomonMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function getAlignmentPatternPositions(ver: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result: number[] = [6];
  for (let pos = ver * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function encodeBytes(data: Uint8Array): QrData {
  // Find smallest version that fits.
  let version = 1;
  let dataCapacityBits = 0;
  for (; version <= 20; version++) {
    const capacityBits = getNumDataCodewords(version) * 8;
    const headerBits = 4 + (version < 10 ? 8 : 16);
    if (capacityBits >= headerBits + data.length * 8) {
      dataCapacityBits = capacityBits;
      break;
    }
  }
  if (version > 20) throw new Error("QR data too long");

  const bits: number[] = [];
  const append = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  append(0b0100, 4); // byte mode
  append(data.length, version < 10 ? 8 : 16);
  for (const b of data) append(b, 8);
  // Terminator + bit padding.
  append(0, Math.min(4, dataCapacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  // Pad bytes.
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]!;
    codewords.push(b);
  }
  for (let pad = 0xec; codewords.length * 8 < dataCapacityBits; pad ^= 0xec ^ 0x11) {
    codewords.push(pad);
  }

  // Split into blocks and add ECC.
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS_M[version - 1]!;
  const eccLen = ECC_CODEWORDS_PER_BLOCK_M[version - 1]!;
  const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const blocks: number[][] = [];
  const divisor = reedSolomonComputeDivisor(eccLen);
  let k = 0;
  for (let i = 0; i < numBlocks; i++) {
    const dataLen = shortBlockLen - eccLen + (i < numShortBlocks ? 0 : 1);
    const dat = codewords.slice(k, k + dataLen);
    k += dataLen;
    const ecc = reedSolomonComputeRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0); // placeholder, removed during interleave
    blocks.push([...dat, ...ecc]);
  }
  const interleaved: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortBlockLen - eccLen || j >= numShortBlocks) {
        interleaved.push(blocks[j]![i]!);
      }
    }
  }

  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));

  // Finder patterns.
  const drawFinder = (x: number, y: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || xx >= size || yy < 0 || yy >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        modules[yy]![xx] = dist !== 2 && dist !== 4;
        isFunction[yy]![xx] = true;
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  // Timing patterns.
  for (let i = 0; i < size; i++) {
    if (!isFunction[6]![i]) {
      modules[6]![i] = i % 2 === 0;
      isFunction[6]![i] = true;
    }
    if (!isFunction[i]![6]) {
      modules[i]![6] = i % 2 === 0;
      isFunction[i]![6] = true;
    }
  }

  // Alignment patterns.
  const alignPositions = getAlignmentPatternPositions(version);
  for (let i = 0; i < alignPositions.length; i++) {
    for (let j = 0; j < alignPositions.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === alignPositions.length - 1) || (i === alignPositions.length - 1 && j === 0)) continue;
      const cx = alignPositions[i]!;
      const cy = alignPositions[j]!;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          modules[cy + dy]![cx + dx] = dist !== 1;
          isFunction[cy + dy]![cx + dx] = true;
        }
      }
    }
  }

  // Reserve format info area.
  for (let i = 0; i < 9; i++) isFunction[8]![i] = true;
  for (let i = 0; i < 8; i++) isFunction[i]![8] = true;
  for (let i = size - 8; i < size; i++) isFunction[8]![i] = true;
  for (let i = size - 7; i < size; i++) isFunction[i]![8] = true;
  modules[size - 8]![8] = true; // dark module
  isFunction[size - 8]![8] = true;

  // Reserve version info area for version >= 7.
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        isFunction[size - 11 + j]![i] = true;
        isFunction[i]![size - 11 + j] = true;
      }
    }
  }

  // Place data bits using the zig-zag pattern.
  let bitIdx = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y]![x] && bitIdx < interleaved.length * 8) {
          const dat = interleaved[bitIdx >>> 3]!;
          modules[y]![x] = ((dat >>> (7 - (bitIdx & 7))) & 1) !== 0;
          bitIdx++;
        }
      }
    }
    upward = !upward;
  }

  // Apply best mask (try all 8, pick lowest penalty).
  let bestMask = 0;
  let bestPenalty = Infinity;
  let bestModules: boolean[][] = modules;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = modules.map((row) => row.slice());
    applyMask(candidate, isFunction, mask);
    drawFormatBits(candidate, isFunction, mask);
    const p = computePenalty(candidate);
    if (p < bestPenalty) {
      bestPenalty = p;
      bestMask = mask;
      bestModules = candidate;
    }
  }
  void bestMask;

  if (version >= 7) drawVersion(bestModules, version, size);

  return { size, modules: bestModules };
}

function applyMask(modules: boolean[][], isFunction: boolean[][], mask: number): void {
  const size = modules.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isFunction[y]![x]) continue;
      let invert = false;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (invert) modules[y]![x] = !modules[y]![x]!;
    }
  }
}

function drawFormatBits(modules: boolean[][], _isFunction: boolean[][], mask: number): void {
  // ECC level M = 0b00.
  const data = (0b00 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const size = modules.length;
  for (let i = 0; i <= 5; i++) modules[8]![i] = ((bits >>> i) & 1) !== 0;
  modules[8]![7] = ((bits >>> 6) & 1) !== 0;
  modules[8]![8] = ((bits >>> 7) & 1) !== 0;
  modules[7]![8] = ((bits >>> 8) & 1) !== 0;
  for (let i = 9; i < 15; i++) modules[14 - i]![8] = ((bits >>> i) & 1) !== 0;
  for (let i = 0; i < 8; i++) modules[size - 1 - i]![8] = ((bits >>> i) & 1) !== 0;
  for (let i = 8; i < 15; i++) modules[8]![size - 15 + i] = ((bits >>> i) & 1) !== 0;
  modules[size - 8]![8] = true;
}

function drawVersion(modules: boolean[][], version: number, size: number): void {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) !== 0;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    modules[a]![b] = bit;
    modules[b]![a] = bit;
  }
}

function computePenalty(modules: boolean[][]): number {
  // Tier 1 — only need a relative ordering, so use a simple heuristic
  // (count adjacent same-color modules in rows). Good enough for clean
  // codes at the sizes the pairing flow generates.
  let penalty = 0;
  const size = modules.length;
  for (let y = 0; y < size; y++) {
    let runColor = modules[y]![0];
    let runX = 1;
    for (let x = 1; x < size; x++) {
      if (modules[y]![x] === runColor) {
        runX++;
        if (runX === 5) penalty += 3;
        else if (runX > 5) penalty++;
      } else {
        runColor = modules[y]![x];
        runX = 1;
      }
    }
  }
  return penalty;
}

/**
 * Render the QR code for `text` as an inline SVG string. Quiet zone of 4
 * modules is included per spec.
 */
export function qrToSvg(text: string, opts: { scale?: number; dark?: string; light?: string } = {}): string {
  const data = new TextEncoder().encode(text);
  const qr = encodeBytes(data);
  const scale = opts.scale ?? 6;
  const border = 4;
  const dim = (qr.size + border * 2) * scale;
  const dark = opts.dark ?? "#0A0A0B";
  const light = opts.light ?? "#FFFFFF";
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" shape-rendering="crispEdges">`,
  );
  parts.push(`<rect width="100%" height="100%" fill="${light}"/>`);
  parts.push(`<g fill="${dark}">`);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y]![x]) {
        const px = (x + border) * scale;
        const py = (y + border) * scale;
        parts.push(`<rect x="${px}" y="${py}" width="${scale}" height="${scale}"/>`);
      }
    }
  }
  parts.push(`</g></svg>`);
  return parts.join("");
}
