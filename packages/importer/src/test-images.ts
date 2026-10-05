// 試験用の、ヘッダーだけの最小の画像。中身は表示できないが、形式と大きさは読める。

const be32 = (n: number) => [
	(n >>> 24) & 255,
	(n >>> 16) & 255,
	(n >>> 8) & 255,
	n & 255
];

export const png = (w = 16, h = 16): Uint8Array =>
	new Uint8Array([
		0x89,
		0x50,
		0x4e,
		0x47,
		0x0d,
		0x0a,
		0x1a,
		0x0a,
		...be32(13),
		0x49,
		0x48,
		0x44,
		0x52,
		...be32(w),
		...be32(h),
		8,
		2,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0x49,
		0x45,
		0x4e,
		0x44,
		0xae,
		0x42,
		0x60,
		0x82
	]);

export const gif = (w = 16, h = 16): Uint8Array =>
	new Uint8Array([
		0x47,
		0x49,
		0x46,
		0x38,
		0x39,
		0x61,
		w & 255,
		w >> 8,
		h & 255,
		h >> 8,
		0,
		0,
		0,
		0x3b
	]);

export const jpeg = (w = 16, h = 16): Uint8Array =>
	new Uint8Array([
		0xff,
		0xd8,
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
		0,
		0xff,
		0xd9
	]);
