// 試験用の、小さな正しい画像（PNG・GIF・JPEG）を作る。中身は表示用ではないが、構造は正しい。

import { crc32, deflateSync } from 'node:zlib';

const be32 = (n: number) => [
	(n >>> 24) & 255,
	(n >>> 16) & 255,
	(n >>> 8) & 255,
	n & 255
];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** PNG のチャンク（長さ・種類・データ・CRC）。 */
export const chunk = (type: string, data: number[] | Uint8Array): number[] => {
	const body = [...ascii(type), ...data];
	return [...be32(data.length), ...body, ...be32(crc32(Uint8Array.from(body)))];
};
export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const ihdr = (
	w: number,
	h: number,
	depth = 8,
	color = 0,
	interlace = 0
) => chunk('IHDR', [...be32(w), ...be32(h), depth, color, 0, 0, interlace]);
export const iend = () => chunk('IEND', []);

/** 画像データ（行ごとにフィルタ0の1バイトと、画素）を、すべて 0 で作って圧縮する。 */
export const idatFor = (w: number, h: number, bits = 8, interlace = false) => {
	const passes = interlace
		? [
				[0, 0, 8, 8],
				[4, 0, 8, 8],
				[0, 4, 4, 8],
				[2, 0, 4, 4],
				[0, 2, 2, 4],
				[1, 0, 2, 2],
				[0, 1, 1, 2]
			].map(([x0, y0, dx, dy]) => [
				Math.ceil((w - x0) / dx),
				Math.ceil((h - y0) / dy)
			])
		: [[w, h]];
	let size = 0;
	for (const [pw, ph] of passes)
		if (pw > 0 && ph > 0) size += ph * (1 + Math.ceil((pw * bits) / 8));
	return chunk('IDAT', deflateSync(new Uint8Array(size)));
};

/** グレースケール8ビットの PNG。 */
export const png = (w = 16, h = 16): Uint8Array =>
	Uint8Array.from([
		...PNG_SIGNATURE,
		...ihdr(w, h),
		...idatFor(w, h),
		...iend()
	]);

/** GIF89a。色表2色、画像1枚。大きさは論理画面と画像の両方に入れる。 */
export const gif = (w = 16, h = 16): Uint8Array =>
	Uint8Array.from([
		...ascii('GIF89a'),
		w & 255,
		w >> 8,
		h & 255,
		h >> 8,
		0x80,
		0,
		0,
		0,
		0,
		0,
		0xff,
		0xff,
		0xff,
		0x2c,
		0,
		0,
		0,
		0,
		w & 255,
		w >> 8,
		h & 255,
		h >> 8,
		0,
		2,
		2,
		0x44,
		0x01,
		0,
		0x3b
	]);

/** JPEG: 量子化表・ハフマン表・フレーム・スキャン・符号化データ・EOI を、順に持つ。 */
export const jpegParts = (w = 16, h = 16) => ({
	soi: [0xff, 0xd8],
	dqt: [0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array(64).fill(1)],
	sof: [
		0xff,
		0xc0,
		0x00,
		0x0b,
		8,
		h >> 8,
		h & 255,
		w >> 8,
		w & 255,
		1,
		1,
		0x11,
		0
	],
	dht: [0xff, 0xc4, 0x00, 0x15, 0x00, 0, 1, ...new Array(14).fill(0), 0, 1],
	sos: [0xff, 0xda, 0x00, 0x08, 1, 1, 0x00, 0, 0x3f, 0],
	data: [0x7f, 0xff, 0x00, 0x12],
	eoi: [0xff, 0xd9]
});
export const jpeg = (w = 16, h = 16): Uint8Array => {
	const p = jpegParts(w, h);
	return Uint8Array.from([
		...p.soi,
		...p.dqt,
		...p.sof,
		...p.dht,
		...p.sos,
		...p.data,
		...p.eoi
	]);
};
