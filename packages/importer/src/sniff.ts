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
		// チャンクの種類は英字。先頭が大文字（必須チャンク）で、知らないものがあれば、復号器は
		// 画像を拒む。付属のチャンク（先頭が小文字）は読み飛ばしてよい。
		if (!/^[A-Za-z]{4}$/.test(type)) return null;
		if (/^[A-Z]/.test(type) && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type))
			return null;
		if (type === 'IDAT') {
			if (idatDone || (color === 3 && !plte)) return null;
			idat.push(b.subarray(at + 8, at + 8 + len));
		} else {
			if (idat.length > 0) idatDone = true;
			if (type === 'PLTE') {
				// 色の種類が 0・4（グレー）では、PLTE を持てない。パレット画像では、深さで表せる数まで。
				if (
					plte ||
					idat.length > 0 ||
					len % 3 !== 0 ||
					len < 3 ||
					len > 768 ||
					color === 0 ||
					color === 4 ||
					(color === 3 && len / 3 > 2 ** depth)
				)
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

/**
 * GIF の LZW 符号を、画素そのものは作らずに数え上げる。辞書の各項目が出力する画素数だけを持ち、
 * 符号の幅・辞書の伸び・クリア／終了符号を規格どおりに追う。終了符号まで正しくたどれて、画素の
 * 数が width*height とちょうど合えば true。
 */
function lzwOk(data: Uint8Array, minCode: number, pixels: number): boolean {
	const clear = 1 << minCode;
	const end = clear + 1;
	const lens = new Int32Array(4096);
	let next = end + 1;
	let size = minCode + 1;
	let prev = -1;
	let total = 0;
	let acc = 0;
	let have = 0;
	for (let i = 0; i < clear; i++) lens[i] = 1;
	for (const byte of data) {
		acc |= byte << have;
		have += 8;
		while (have >= size) {
			const code = acc & ((1 << size) - 1);
			acc >>>= size;
			have -= size;
			if (code === clear) {
				next = end + 1;
				size = minCode + 1;
				prev = -1;
			} else if (code === end) {
				return total === pixels;
			} else {
				let len: number;
				if (prev === -1) {
					if (code >= clear) return false;
					len = 1;
				} else if (code < next) {
					len = lens[code];
				} else if (code === next && next < 4096) {
					len = lens[prev] + 1;
				} else return false;
				total += len;
				if (total > pixels) return false;
				if (prev !== -1 && next < 4096) {
					lens[next++] = lens[prev] + 1;
					if (next === 1 << size && size < 12) size++;
				}
				prev = code;
			}
		}
	}
	return false;
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
	// サブブロックの連なりを読み、終わりの位置（0 の次）と、つないだデータを返す。
	const blocks = (from: number): { end: number; data: Uint8Array } | null => {
		const parts: Uint8Array[] = [];
		let p = from;
		for (;;) {
			if (p >= b.length) return null;
			const n = b[p];
			if (n === 0) return { end: p + 1, data: Buffer.concat(parts) };
			if (p + 1 + n > b.length) return null;
			parts.push(b.subarray(p + 1, p + 1 + n));
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
			const ext = blocks(at + 2);
			if (!ext) return null;
			at = ext.end;
		} else if (m === 0x2c) {
			if (at + 10 > b.length) return null;
			// 画像の大きさ。論理画面とは別に、上限を守る（大きな画像を小さな画面に隠せない）。
			const w = b[at + 5] | (b[at + 6] << 8);
			const h = b[at + 7] | (b[at + 8] << 8);
			if (
				w < 1 ||
				h < 1 ||
				w > MAX_IMAGE_SIDE ||
				h > MAX_IMAGE_SIDE ||
				w * h > MAX_IMAGE_PIXELS
			)
				return null;
			const flags = b[at + 9];
			at += 10;
			if (flags & 0x80) at += 3 * 2 ** ((flags & 7) + 1);
			const minCode = b[at];
			if (minCode < 2 || minCode > 8) return null;
			const data = blocks(at + 1);
			// 圧縮された画素が、この画像の大きさ（w*h）ぴったりに復号できること。
			if (!data || !lzwOk(data.data, minCode, w * h)) return null;
			at = data.end;
			images++;
		} else return null;
	}
	return null;
}

type Huff = { counts: number[]; symbols: number[] };

/** 符号を1つ読む（JPEG の規格書 附属書 F の方法）。定義にない符号なら -1。 */
function huffDecode(t: Huff, bits: () => number): number {
	let code = 0;
	let first = 0;
	let index = 0;
	for (let len = 1; len <= 16; len++) {
		const bit = bits();
		if (bit < 0) return -1;
		code |= bit;
		const count = t.counts[len];
		if (code - count < first) return t.symbols[index + (code - first)];
		index += count;
		first += count;
		first <<= 1;
		code <<= 1;
	}
	return -1;
}

/**
 * 基本・拡張（8ビット）のハフマン符号のスキャンを、すべての MCU について復号して確かめる。
 * 画素までは作らず、符号が表にあること、直流の大きさと交流の連なりが規格の範囲に収まること、
 * MCU の数が画像の大きさと合うこと、リスタート間隔のマーカーが正しく並ぶこと、符号化データを
 * 過不足なく使い切ることを確かめる。
 */
function scanOk(
	data: Uint8Array,
	frame: {
		w: number;
		h: number;
		comps: Map<number, { h: number; v: number; tq: number }>;
	},
	scan: { id: number; dc: Huff; ac: Huff }[],
	restart: number
): boolean {
	let hmax = 1;
	let vmax = 1;
	for (const c of frame.comps.values()) {
		hmax = Math.max(hmax, c.h);
		vmax = Math.max(vmax, c.v);
	}
	// 1つの MCU に含まれるデータ単位（8×8）の並びと、MCU の数。
	const unit: number[] = []; // scan の番号
	let mcus: number;
	if (scan.length === 1) {
		const c = frame.comps.get(scan[0].id) as { h: number; v: number };
		unit.push(0);
		mcus =
			Math.ceil(Math.ceil((frame.w * c.h) / hmax) / 8) *
			Math.ceil(Math.ceil((frame.h * c.v) / vmax) / 8);
	} else {
		scan.forEach((s, k) => {
			const c = frame.comps.get(s.id) as { h: number; v: number };
			for (let n = 0; n < c.h * c.v; n++) unit.push(k);
		});
		mcus = Math.ceil(frame.w / (8 * hmax)) * Math.ceil(frame.h / (8 * vmax));
	}

	let pos = 0;
	let bitsLeft = 0;
	let cur = 0;
	/** 次の1ビット。マーカー（FF のあとが 00 以外）に当たったら -1。 */
	const bit = (): number => {
		if (bitsLeft === 0) {
			if (pos >= data.length) return -1;
			cur = data[pos];
			if (cur === 0xff) {
				if (data[pos + 1] !== 0x00) return -1;
				pos += 2;
			} else pos += 1;
			bitsLeft = 8;
		}
		bitsLeft--;
		return (cur >> bitsLeft) & 1;
	};
	const read = (n: number): boolean => {
		for (let i = 0; i < n; i++) if (bit() < 0) return false;
		return true;
	};

	let nextRst = 0;
	for (let m = 0; m < mcus; m++) {
		if (restart > 0 && m > 0 && m % restart === 0) {
			// リスタート: 残りのビットを捨て、RSTn を読む。n は 0 から 7 を繰り返す。
			bitsLeft = 0;
			if (data[pos] !== 0xff || data[pos + 1] !== 0xd0 + nextRst) return false;
			pos += 2;
			nextRst = (nextRst + 1) & 7;
		}
		for (const k of unit) {
			const { dc, ac } = scan[k];
			const s = huffDecode(dc, bit);
			if (s < 0 || s > 11 || !read(s)) return false;
			for (let i = 1; i < 64;) {
				const rs = huffDecode(ac, bit);
				if (rs < 0) return false;
				const r = rs >> 4;
				const size = rs & 15;
				if (size === 0) {
					if (r === 15) {
						i += 16;
						if (i > 64) return false;
						continue;
					}
					if (r !== 0) return false;
					break;
				}
				i += r;
				if (i > 63 || size > 10 || !read(size)) return false;
				i++;
			}
		}
	}
	// 最後のバイトの残りは、1 で埋めてあればよい。そのあとに、使われないバイトが残っていてはいけない。
	if (bitsLeft > 0 && (cur & ((1 << bitsLeft) - 1)) !== (1 << bitsLeft) - 1)
		return false;
	return pos === data.length;
}

/**
 * JPEG: セグメントを順にたどり、表（量子化・ハフマン）、フレーム（大きさと成分）、スキャンの中身を
 * 確かめ、スキャンの符号化データを MCU まで復号し、EOI が最後にあることを確かめる。扱うのは、
 * ハフマン符号の基本・拡張（SOF0/1、8ビット）だけ。プログレッシブ・算術符号・ロスレスは、受け付けない。
 */
function jpegInfo(b: Uint8Array): Sniffed | null {
	if (!startsWith(b, [0xff, 0xd8, 0xff]) || b.length < 4) return null;
	const quant = new Set<number>();
	const tables = new Map<number, Huff>(); // クラス*4 + 番号
	let frame: {
		w: number;
		h: number;
		comps: Map<number, { h: number; v: number; tq: number }>;
	} | null = null;
	let restart = 0;
	const scanned = new Set<number>(); // スキャンした成分の番号
	let at = 2;
	for (;;) {
		if (at + 2 > b.length || b[at] !== 0xff) return null;
		const m = b[at + 1];
		if (m === 0xff) {
			at += 1;
			continue;
		}
		if (m === 0xd9) {
			// すべての成分が、ちょうど1回ずつスキャンされていること（欠けた成分は、画素がない）。
			return frame !== null &&
				scanned.size === frame.comps.size &&
				at + 2 === b.length
				? { mime: 'image/jpeg', width: frame.w, height: frame.h }
				: null;
		}
		// 単独のマーカーや、スキャンの外の RST・SOI は、ここでは現れない。
		if (m === 0x00 || m === 0x01 || m === 0xd8 || (m >= 0xd0 && m <= 0xd7))
			return null;
		if (at + 4 > b.length) return null;
		const len = u16(b, at + 2);
		const end = at + 2 + len;
		if (len < 2 || end > b.length) return null;
		const body = b.subarray(at + 4, end);

		if (m === 0xdb) {
			// 量子化表: (精度 4bit | 番号 4bit) のあとに 64 または 128 バイトの値、を1つ以上。
			let p = 0;
			if (body.length === 0) return null;
			while (p < body.length) {
				const pq = body[p] >> 4;
				const tq = body[p] & 15;
				if (pq > 1 || tq > 3) return null;
				const size = 64 * (pq + 1);
				if (p + 1 + size > body.length) return null;
				// 量子化の値は 1 以上（0 は規格で使えない）。
				for (let k = 0; k < 64; k++)
					if ((pq === 0 ? body[p + 1 + k] : u16(body, p + 1 + 2 * k)) === 0)
						return null;
				p += 1 + size;
				quant.add(tq);
			}
			if (p !== body.length) return null;
		} else if (m === 0xc4) {
			// ハフマン表: (クラス 4bit | 番号 4bit)、長さ別の符号の数 16 個、符号の値、を1つ以上。
			let p = 0;
			if (body.length === 0) return null;
			while (p < body.length) {
				if (p + 17 > body.length) return null;
				const tc = body[p] >> 4;
				const th = body[p] & 15;
				if (tc > 1 || th > 3) return null;
				const counts = [0, ...Array.from(body.subarray(p + 1, p + 17))];
				const n = counts.reduce((a, c) => a + c, 0);
				if (n === 0 || n > 256 || p + 17 + n > body.length) return null;
				// 符号の数が、長さごとの空きを超えていない（符号が重ならない）こと。
				let room = 1;
				for (let k = 1; k <= 16; k++) {
					room = room * 2 - counts[k];
					if (room < 0) return null;
				}
				// 符号の値は、重複せず、使える範囲に収まること。DC は大きさ 0 から 11。AC は、走りと大きさ
				// （大きさ 1 から 10）の組か、ブロックの終わり（00）と 16 個のゼロ（F0）。
				const symbols = Array.from(body.subarray(p + 17, p + 17 + n));
				if (new Set(symbols).size !== symbols.length) return null;
				for (const v of symbols)
					if (
						tc === 0
							? v > 11
							: !((v & 15) >= 1 && (v & 15) <= 10) && v !== 0x00 && v !== 0xf0
					)
						return null;
				tables.set(tc * 4 + th, {
					counts,
					symbols
				});
				p += 17 + n;
			}
			if (p !== body.length) return null;
		} else if (m === 0xc0 || m === 0xc1) {
			// フレーム（基本・拡張のハフマン符号、8ビット）。
			if (frame !== null) return null;
			const nf = body[5];
			if (body.length !== 6 + 3 * nf || body[0] !== 8 || nf < 1 || nf > 4)
				return null;
			const w = u16(body, 3);
			const h = u16(body, 1);
			if (w < 1 || h < 1) return null;
			const comps = new Map<number, { h: number; v: number; tq: number }>();
			for (let k = 0; k < nf; k++) {
				const id = body[6 + 3 * k];
				const hv = body[7 + 3 * k];
				const tq = body[8 + 3 * k];
				if (
					comps.has(id) ||
					hv >> 4 < 1 ||
					hv >> 4 > 4 ||
					(hv & 15) < 1 ||
					(hv & 15) > 4 ||
					tq > 3
				)
					return null;
				comps.set(id, { h: hv >> 4, v: hv & 15, tq });
			}
			frame = { w, h, comps };
		} else if (
			m >= 0xc2 &&
			m <= 0xcf &&
			m !== 0xc4 &&
			m !== 0xc8 &&
			m !== 0xcc
		) {
			return null; // プログレッシブ・算術符号・ロスレス
		} else if (m === 0xdd) {
			if (body.length !== 2) return null;
			restart = u16(body, 0);
		} else if (m === 0xda) {
			if (frame === null) return null;
			const ns = body[0];
			if (
				ns < 1 ||
				ns > 4 ||
				ns > frame.comps.size ||
				body.length !== 1 + 2 * ns + 3 ||
				body[1 + 2 * ns] !== 0 ||
				body[2 + 2 * ns] !== 63 ||
				body[3 + 2 * ns] !== 0
			)
				return null;
			const scan: { id: number; dc: Huff; ac: Huff }[] = [];
			for (let k = 0; k < ns; k++) {
				const id = body[1 + 2 * k];
				const td = body[2 + 2 * k] >> 4;
				const ta = body[2 + 2 * k] & 15;
				const c = frame.comps.get(id);
				const dc = tables.get(td);
				const ac = tables.get(4 + ta);
				if (
					!c ||
					scan.some((s) => s.id === id) ||
					!quant.has(c.tq) ||
					!dc ||
					!ac
				)
					return null;
				scan.push({ id, dc, ac });
			}
			if (ns > 1) {
				// 交互のスキャンでは、1つの MCU に入るデータ単位は、合計で 10 以下。
				let units = 0;
				for (const s of scan) {
					const c = frame.comps.get(s.id) as { h: number; v: number };
					units += c.h * c.v;
				}
				if (units > 10) return null;
			}
			// 符号化データ: 次の（RST ではない）マーカーまで。FF00 はスタッフィング、RST は中身。
			let p = end;
			while (p < b.length) {
				if (b[p] !== 0xff) {
					p++;
					continue;
				}
				const n = b[p + 1];
				if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) {
					p += 2;
					continue;
				}
				if (n === 0xff) {
					p++;
					continue;
				}
				break;
			}
			if (p === end || !scanOk(b.subarray(end, p), frame, scan, restart))
				return null;
			for (const sc of scan) {
				if (scanned.has(sc.id)) return null;
				scanned.add(sc.id);
			}
			at = p;
			continue;
		}
		at = end;
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
