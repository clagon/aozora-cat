// 画像の中身の検証。拡張子や応答の種類は信用せず、形式ごとに、構造をたどって確かめる。
// 画素まで復号はしないが、ヘッダーだけの壊れた画像・途中で切れた画像・つぎはぎの画像を、受け付けない。

import { crc32, inflateSync } from 'node:zlib';
import type { ImageMime } from '../../../src/lib/domain/asset.ts';
import { MAX_IMAGE_SIDE } from '../../../src/lib/domain/work.ts';

/** 1枚の大きさの上限（バイト）と、画素数の上限。端末で展開するときの負荷を抑える。 */
export const MAX_IMAGE_BYTES = 8 * 2 ** 20;
export const MAX_IMAGE_PIXELS = 16_000_000;

export type Sniffed = { mime: ImageMime; width: number; height: number };

const u16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u32 = (b: Uint8Array, at: number) =>
	((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const startsWith = (b: Uint8Array, sig: number[]) =>
	sig.every((x, i) => b[i] === x);
const ascii = (b: Uint8Array, at: number, n: number) =>
	String.fromCharCode(...b.subarray(at, at + n));

/** 色の種類ごとの、使える深さと、1画素あたりのチャンネル数。 */
const PNG_COLOR: Record<number, { depths: number[]; channels: number }> = {
	0: { depths: [1, 2, 4, 8, 16], channels: 1 },
	2: { depths: [8, 16], channels: 3 },
	3: { depths: [1, 2, 4, 8], channels: 1 },
	4: { depths: [8, 16], channels: 2 },
	6: { depths: [8, 16], channels: 4 }
};
/** Adam7 の、パスごとの開始位置と間隔（x, y）。 */
const ADAM7 = [
	[0, 0, 8, 8],
	[4, 0, 8, 8],
	[0, 4, 4, 8],
	[2, 0, 4, 4],
	[0, 2, 2, 4],
	[1, 0, 2, 2],
	[0, 1, 1, 2]
];
const MAX_RAW_BYTES = 128 * 2 ** 20;

/** PNG: チャンネル構造・CRC・IDAT の連なり・展開した大きさ（行ごとのフィルタ）まで確かめる。 */
function pngInfo(b: Uint8Array): Sniffed | null {
	if (!startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		return null;
	if (b.length < 8 + 25 + 12 || u32(b, 8) !== 13 || ascii(b, 12, 4) !== 'IHDR')
		return null;
	const width = u32(b, 16);
	const height = u32(b, 20);
	const [depth, color, compression, filter, interlace] = [
		b[24],
		b[25],
		b[26],
		b[27],
		b[28]
	];
	const spec = PNG_COLOR[color];
	if (
		!spec ||
		!spec.depths.includes(depth) ||
		compression !== 0 ||
		filter !== 0 ||
		(interlace !== 0 && interlace !== 1) ||
		width < 1 ||
		height < 1 ||
		width > MAX_IMAGE_SIDE ||
		height > MAX_IMAGE_SIDE ||
		width * height > MAX_IMAGE_PIXELS
	)
		return null;

	const idat: Uint8Array[] = [];
	let at = 8;
	let plte = false;
	let idatDone = false;
	let ended = false;
	while (at + 12 <= b.length) {
		const len = u32(b, at);
		const type = ascii(b, at + 4, 4);
		const next = at + 12 + len;
		if (len > 0x7fffffff || next > b.length) return null;
		if (crc32(b.subarray(at + 4, at + 8 + len)) !== u32(b, at + 8 + len))
			return null;
		if (at === 8 && type !== 'IHDR') return null;
		if (type === 'IDAT') {
			if (idatDone || (color === 3 && !plte)) return null;
			idat.push(b.subarray(at + 8, at + 8 + len));
		} else {
			if (idat.length > 0) idatDone = true;
			if (type === 'PLTE') {
				if (plte || idat.length > 0 || len % 3 !== 0 || len < 3 || len > 768)
					return null;
				plte = true;
			} else if (type === 'IHDR') {
				if (at !== 8) return null;
			} else if (type === 'IEND') {
				if (len !== 0 || next !== b.length) return null;
				ended = true;
			}
		}
		at = next;
		if (ended) break;
	}
	if (!ended || idat.length === 0) return null;

	// 展開した大きさが、行ごとの「フィルタ1バイト + 画素」の合計と一致し、フィルタの種類が正しいこと。
	const bits = spec.channels * depth;
	const passes =
		interlace === 0
			? [[width, height]]
			: ADAM7.map(([x0, y0, dx, dy]) => [
					Math.ceil((width - x0) / dx),
					Math.ceil((height - y0) / dy)
				]);
	const rows: number[] = [];
	let expected = 0;
	for (const [pw, ph] of passes) {
		if (pw <= 0 || ph <= 0) continue;
		const row = 1 + Math.ceil((pw * bits) / 8);
		for (let y = 0; y < ph; y++) rows.push(row);
		expected += row * ph;
	}
	if (expected > MAX_RAW_BYTES) return null;
	let raw: Uint8Array;
	try {
		raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 });
	} catch {
		return null;
	}
	if (raw.length !== expected) return null;
	let pos = 0;
	for (const row of rows) {
		if (raw[pos] > 4) return null;
		pos += row;
	}
	return { mime: 'image/png', width, height };
}

/** GIF: ヘッダー・論理画面・色表・ブロック（拡張・画像）の連なりをたどり、終わりの印が最後にあること。 */
function gifInfo(b: Uint8Array): Sniffed | null {
	if (
		!(
			startsWith(b, [0x47, 0x49, 0x46, 0x38]) &&
			(b[4] === 0x37 || b[4] === 0x39) &&
			b[5] === 0x61
		) ||
		b.length < 14
	)
		return null;
	const width = b[6] | (b[7] << 8);
	const height = b[8] | (b[9] << 8);
	let at = 13;
	if (b[10] & 0x80) at += 3 * 2 ** ((b[10] & 7) + 1);
	// サブブロックの連なりを読み飛ばして、終わりの位置（0 の次）を返す。
	const skip = (from: number): number => {
		let p = from;
		for (;;) {
			if (p >= b.length) return -1;
			const n = b[p];
			if (n === 0) return p + 1;
			p += 1 + n;
		}
	};
	let images = 0;
	while (at < b.length) {
		const m = b[at];
		if (m === 0x3b) {
			if (at !== b.length - 1 || images === 0) return null;
			return { mime: 'image/gif', width, height };
		}
		if (m === 0x21) {
			if (at + 2 > b.length) return null;
			at = skip(at + 2);
		} else if (m === 0x2c) {
			if (at + 10 > b.length) return null;
			const flags = b[at + 9];
			at += 10;
			if (flags & 0x80) at += 3 * 2 ** ((flags & 7) + 1);
			const minCode = b[at];
			if (minCode < 2 || minCode > 8) return null;
			at = skip(at + 1);
			images++;
		} else return null;
		if (at < 0) return null;
	}
	return null;
}

/** JPEG: セグメントの連なりをたどり、量子化表・フレーム（大きさ）・スキャンの順を確かめ、終わりの印が最後にあること。 */
function jpegInfo(b: Uint8Array): Sniffed | null {
	if (!startsWith(b, [0xff, 0xd8, 0xff]) || b.length < 4) return null;
	let at = 2;
	let size: Sniffed | null = null;
	let dqt = false;
	for (;;) {
		if (at + 4 > b.length || b[at] !== 0xff) return null;
		const m = b[at + 1];
		if (m === 0xff) {
			at += 1;
			continue;
		}
		if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
			at += 2;
			continue;
		}
		if (m === 0xd8 || m === 0xd9) return null;
		const len = u16(b, at + 2);
		if (len < 2 || at + 2 + len > b.length) return null;
		if (m === 0xdb) dqt = true;
		if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
			if (size !== null || len < 8) return null;
			size = {
				mime: 'image/jpeg',
				width: u16(b, at + 7),
				height: u16(b, at + 5)
			};
		}
		if (m === 0xda) {
			// スキャン。フレームと量子化表が先にあり、そのあとの符号化データが EOI まで続く。
			if (size === null || !dqt || len < 6) return null;
			let p = at + 2 + len;
			let data = 0;
			while (p < b.length) {
				if (b[p] !== 0xff) {
					p++;
					data++;
					continue;
				}
				const n = b[p + 1];
				if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) {
					p += 2;
					data += 1;
					continue;
				}
				if (n === 0xff) {
					p++;
					continue;
				}
				// 次のスキャンや表のセグメント。
				if (n === 0xd9) return p + 2 === b.length && data > 0 ? size : null;
				const l = u16(b, p + 2);
				if (p + 4 > b.length || l < 2 || p + 2 + l > b.length) return null;
				p += 2 + l;
			}
			return null;
		}
		at += 2 + len;
	}
}

/**
 * 画像の形式と大きさを、中身から読む。読めない・壊れている・大きすぎるものは null。
 * PNG・JPEG・GIF だけを扱う。
 */
export function sniffImage(b: Uint8Array): Sniffed | null {
	if (b.length > MAX_IMAGE_BYTES) return null;
	const found = pngInfo(b) ?? gifInfo(b) ?? jpegInfo(b);
	if (
		found === null ||
		found.width < 1 ||
		found.height < 1 ||
		found.width > MAX_IMAGE_SIDE ||
		found.height > MAX_IMAGE_SIDE ||
		found.width * found.height > MAX_IMAGE_PIXELS
	)
		return null;
	return found;
}
