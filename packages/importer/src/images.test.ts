import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	ImageLoader,
	MAX_IMAGE_BYTES,
	MAX_IMAGE_PIXELS,
	sniffImage
} from './images.ts';
import { deflateSync } from 'node:zlib';
import { REAL_IMAGES } from './real-images.ts';
import {
	PNG_SIGNATURE,
	chunk,
	gif,
	idatFor,
	lzw,
	subBlocks,
	ihdr,
	iend,
	jpeg,
	jpegParts,
	png
} from './test-images.ts';

describe('sniffImage: 本物のエンコーダーの画像', () => {
	it('実在の符号化（グレー・パレット・インターレース・標本化・プログレッシブ）を、読む', () => {
		for (const [name, { mime, bytes }] of Object.entries(REAL_IMAGES))
			expect(sniffImage(bytes), name).toEqual({ mime, width: 24, height: 16 });
	});

	it('どの画像も、途中で切れたものと、余りのついたもの、中ほどを壊したものは、読まない', () => {
		for (const [name, { bytes }] of Object.entries(REAL_IMAGES)) {
			// 先頭から途中まで（すべての長さ）。
			for (let n = 0; n < bytes.length; n++)
				expect(
					sniffImage(bytes.subarray(0, n)),
					`${name} を ${n} バイトで切る`
				).toBeNull();
			expect(
				sniffImage(Uint8Array.from([...bytes, 0])),
				`${name} に余り`
			).toBeNull();
		}
	});

	it('圧縮データの中を壊した PNG・GIF は、読まない', () => {
		const flip = (bytes: Uint8Array, at: number) => {
			const c = Uint8Array.from(bytes);
			c[at] ^= 0xff;
			return c;
		};
		// PNG は CRC、GIF は復号できない符号で、拒む。
		for (const name of ['base.png', 'pal.png', 'ilace.png']) {
			const { bytes } = REAL_IMAGES[name];
			expect(
				sniffImage(flip(bytes, Math.floor(bytes.length / 2))),
				name
			).toBeNull();
		}
		const gifBytes = REAL_IMAGES['pal.gif'].bytes;
		let rejected = 0;
		for (let at = 6; at < gifBytes.length; at++)
			if (sniffImage(flip(gifBytes, at)) === null) rejected++;
		// 色表や画面の情報を壊しても読めるものがあるので、すべてではないが、多くを拒む。
		expect(rejected).toBeGreaterThan(gifBytes.length / 2);
	});
});

describe('sniffImage: 構造', () => {
	const U = (...n: ArrayLike<number>[]) =>
		Uint8Array.from(n.flatMap((x) => Array.from(x)));
	const enc = (v: string) => [...v].map((c) => c.charCodeAt(0));

	it('PNG: 色の種類と深さの組み合わせ・インターレース・IDAT の分割は、構造が正しければ読む', () => {
		const ok = (bytes: Uint8Array) => expect(sniffImage(bytes)).not.toBeNull();
		ok(U(PNG_SIGNATURE, ihdr(5, 3, 16, 6), idatFor(5, 3, 64), iend()));
		ok(U(PNG_SIGNATURE, ihdr(5, 3, 1, 0), idatFor(5, 3, 1), iend()));
		ok(U(PNG_SIGNATURE, ihdr(13, 9, 8, 0, 1), idatFor(13, 9, 8, true), iend()));
		ok(
			U(
				PNG_SIGNATURE,
				ihdr(3, 2, 8, 3),
				chunk('PLTE', [0, 0, 0, 255, 255, 255]),
				idatFor(3, 2),
				iend()
			)
		);
		// IDAT は連続していれば、いくつに分かれていてもよい。
		const z = deflateSync(new Uint8Array(2 * (1 + 4)));
		ok(
			U(
				PNG_SIGNATURE,
				ihdr(4, 2),
				chunk('IDAT', z.subarray(0, 3)),
				chunk('IDAT', z.subarray(3)),
				iend()
			)
		);
		// 知らなくても、付属のチャンク（種類の先頭が小文字）は、読み飛ばせる。
		ok(
			U(PNG_SIGNATURE, ihdr(4, 2), chunk('abCD', [1, 2]), idatFor(4, 2), iend())
		);
		// 付属のチャンク（テキスト）が IDAT の前後にあっても読む。
		ok(
			U(
				PNG_SIGNATURE,
				ihdr(4, 2),
				chunk('tEXt', enc('k\0v')),
				idatFor(4, 2),
				chunk('tEXt', enc('k\0v')),
				iend()
			)
		);
	});

	it('PNG: 画像データがない・CRC が合わない・終わりのあとに続きがある・展開した大きさが合わない画像は読まない', () => {
		const bad = (bytes: Uint8Array, why: string) =>
			expect(sniffImage(bytes), why).toBeNull();
		bad(U(PNG_SIGNATURE, ihdr(4, 4), iend()), 'IDAT がない');
		const corrupt = png(8, 8);
		corrupt[corrupt.length - 20] ^= 0xff;
		bad(corrupt, 'CRC');
		bad(U(png(), [0]), 'IEND のあとの余り');
		bad(U(png(), chunk('tEXt', enc('k\0v'))), 'IEND のあとのチャンク');
		bad(U(PNG_SIGNATURE, ihdr(4, 4), idatFor(4, 5), iend()), '行が多い');
		bad(U(PNG_SIGNATURE, ihdr(4, 4), idatFor(4, 3), iend()), '行が足りない');
		bad(
			U(PNG_SIGNATURE, ihdr(4, 4), chunk('IDAT', [1, 2, 3]), iend()),
			'展開できない'
		);
		const badFilter = deflateSync(
			Uint8Array.from({ length: 4 * 5 }, (_, i) => (i % 5 === 0 ? 9 : 0))
		);
		bad(
			U(PNG_SIGNATURE, ihdr(4, 4), chunk('IDAT', badFilter), iend()),
			'フィルタの種類'
		);
		bad(
			U(
				PNG_SIGNATURE,
				ihdr(4, 2),
				chunk('IDAT', deflateSync(new Uint8Array(5))),
				chunk('tEXt', enc('k\0v')),
				chunk('IDAT', deflateSync(new Uint8Array(5))),
				iend()
			),
			'IDAT が離れている'
		);
		bad(
			U(
				PNG_SIGNATURE,
				ihdr(4, 2),
				chunk('ABCD', [1, 2]),
				idatFor(4, 2),
				iend()
			),
			'知らない必須チャンク'
		);
		bad(
			U(PNG_SIGNATURE, ihdr(4, 2), idatFor(4, 2), chunk('1234', [1]), iend()),
			'種類が英字でないチャンク'
		);
		bad(
			U(PNG_SIGNATURE, ihdr(3, 2, 8, 3), idatFor(3, 2), iend()),
			'PLTE がない'
		);
		bad(
			U(
				PNG_SIGNATURE,
				ihdr(3, 2, 8, 3),
				idatFor(3, 2),
				chunk('PLTE', [0, 0, 0]),
				iend()
			),
			'PLTE が IDAT のあと'
		);
		bad(
			U(
				PNG_SIGNATURE,
				ihdr(3, 2, 8, 3),
				chunk('PLTE', [0, 0]),
				idatFor(3, 2),
				iend()
			),
			'PLTE の長さ'
		);
		bad(U(PNG_SIGNATURE, ihdr(4, 4, 7, 0), idatFor(4, 4), iend()), '深さ');
		bad(U(PNG_SIGNATURE, ihdr(4, 4, 8, 1), idatFor(4, 4), iend()), '色の種類');
		bad(
			U(PNG_SIGNATURE, ihdr(4, 4, 8, 2, 2), idatFor(4, 4, 24), iend()),
			'インターレースの種類'
		);
		bad(
			U(PNG_SIGNATURE, ihdr(13, 9, 8, 0, 1), idatFor(13, 9), iend()),
			'インターレースなのに平らなデータ'
		);
	});

	it('GIF: 規格書に載る最小の 1×1 の画像（符号 4・0・5）を、読む', () => {
		const known = Uint8Array.from(
			'47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b'.match(
				/../g
			) ?? [],
			(h) => parseInt(h, 16)
		);
		expect(sniffImage(known)).toEqual({
			mime: 'image/gif',
			width: 1,
			height: 1
		});
	});

	it('GIF: ブロックの連なりが正しければ読み、画像がない・途中で切れた・終わりの印がない・続きがある画像は読まない', () => {
		expect(sniffImage(gif(7, 9))).toEqual({
			mime: 'image/gif',
			width: 7,
			height: 9
		});
		const g = Array.from(gif());
		const bad = (bytes: number[], why: string) =>
			expect(sniffImage(Uint8Array.from(bytes)), why).toBeNull();
		bad(g.slice(0, g.length - 1), '終わりの印がない');
		bad([...g, 0], '終わりの印のあとの余り');
		bad([...g.slice(0, 19), 0x3b], '画像がない');
		bad([...g.slice(0, 30), 5, 1, 1, 0x3b], 'サブブロックが途中で終わる');
		bad(
			g.map((v, i) => (i === 29 ? 1 : v)),
			'LZW の最小符号長が小さい'
		);
		bad(
			g.map((v, i) => (i === 29 ? 9 : v)),
			'LZW の最小符号長が大きい'
		);
		bad([...g.slice(0, 19), 0x99, ...g.slice(20)], '未知のブロック');
		bad(
			g.map((v, i) => (i === 10 ? 0x87 : v)),
			'色表が長すぎて足りない'
		);
		// 画像の大きさがゼロ・大きすぎる（論理画面が小さくても）・画素のデータが空の画像は読まない。
		const frame = (w: number, h: number) =>
			g.map((v, i) =>
				i === 24
					? w & 255
					: i === 25
						? w >> 8
						: i === 26
							? h & 255
							: i === 27
								? h >> 8
								: v
			);
		bad(frame(0, 4), '画像の幅がゼロ');
		bad(frame(4, 0), '画像の高さがゼロ');
		bad(frame(65535, 65535), '画像が大きすぎる');
		bad(frame(10001, 1), '画像の辺が長すぎる');
		expect(sniffImage(Uint8Array.from(frame(16, 16)))).not.toBeNull();
		bad([...g.slice(0, 30), 0, 0x3b], '画素のデータが空');
		bad(
			[...g.slice(0, 30), 0, ...g.slice(30)],
			'空のブロックのあとに本体が来ても、終わりの印が続かない'
		);
		// 圧縮された画素が、規格どおりに復号できて、画像の大きさとぴったり合うこと。
		const withData = (data: number[], w = 16, h = 16) =>
			Uint8Array.from([...gif(w, h).slice(0, 30), ...subBlocks(data), 0x3b]);
		expect(sniffImage(withData(lzw(256)))).not.toBeNull();
		expect(sniffImage(withData(lzw(255)))).toBeNull(); // 画素が足りない
		expect(sniffImage(withData(lzw(257)))).toBeNull(); // 画素が多い
		expect(sniffImage(withData([0x4c]))).toBeNull(); // 1バイトでは、クリア・画素・終了が入らない
		expect(sniffImage(withData(lzw(256).slice(0, -2)))).toBeNull(); // 終了符号がない
		expect(sniffImage(withData([0x0c]))).toBeNull(); // クリア符号のあとに、すぐ終了
		// 辞書にない符号（next より先）や、最初の符号が文字の範囲外のものは、復号できない。
		expect(sniffImage(withData([0b00_111_100, 0b0000_0111]))).toBeNull();
		// 実際に辞書が伸びて、符号の幅が増える長い列（256画素を連続して符号化）も復号できる。
		const noClear: number[] = [];
		let acc = 0;
		let have = 0;
		let width = 3;
		let next = 6;
		const put = (code: number) => {
			acc |= code << have;
			have += width;
			while (have >= 8) {
				noClear.push(acc & 255);
				acc >>>= 8;
				have -= 8;
			}
		};
		put(4);
		for (let i = 0; i < 256; i++) {
			put(0);
			if (i > 0) {
				next++;
				if (next === 1 << width && width < 12) width++;
			}
		}
		put(5);
		if (have > 0) noClear.push(acc & 255);
		expect(sniffImage(withData(noClear))).not.toBeNull();
		// 拡張ブロックの連なりも、読み飛ばせる。
		expect(
			sniffImage(
				Uint8Array.from([
					...g.slice(0, 19),
					0x21,
					0xfe,
					3,
					0x61,
					0x62,
					0x63,
					0,
					...g.slice(19)
				])
			)
		).not.toBeNull();
	});

	it('JPEG: 量子化表・フレーム・スキャンの順で、EOI が最後にあれば読み、欠けた・順が違う・空・続きがある画像は読まない', () => {
		const p = jpegParts(30, 20);
		const make = (...parts: number[][]) => Uint8Array.from(parts.flat());
		expect(
			sniffImage(make(p.soi, p.dqt, p.sof, p.dht, p.sos, p.data, p.eoi))
		).toEqual({ mime: 'image/jpeg', width: 30, height: 20 });
		const bad = (bytes: Uint8Array, why: string) =>
			expect(sniffImage(bytes), why).toBeNull();
		bad(make(p.soi, p.sof, p.sos, p.data, p.eoi), '量子化表がない');
		bad(make(p.soi, p.dqt, p.sos, p.data, p.eoi), 'フレームがない');
		bad(
			make(p.soi, p.dqt, p.sos, p.sof, p.data, p.eoi),
			'フレームがスキャンのあと'
		);
		bad(make(p.soi, p.dqt, p.sof, p.dht, p.data, p.eoi), 'スキャンがない');
		bad(make(p.soi, p.dqt, p.sof, p.dht, p.sos, p.eoi), '符号化データがない');
		bad(make(p.soi, p.dqt, p.sof, p.dht, p.sos, p.data), 'EOI がない');
		bad(
			make(p.soi, p.dqt, p.sof, p.dht, p.sos, p.data, p.eoi, [0]),
			'EOI のあとの余り'
		);
		bad(
			make(p.soi, p.dqt, p.sof, p.sof, p.dht, p.sos, p.data, p.eoi),
			'フレームが2つ'
		);
		bad(
			make(p.soi, [0xff, 0xdb, 0xff, 0xff], p.sof, p.sos, p.data, p.eoi),
			'セグメントの長さが範囲外'
		);
		const ok = (...parts: number[][]) => make(p.soi, ...parts, p.eoi);
		// 中身のない・形の合わない表や成分の定義は、マーカーがあっても読まない。
		bad(ok([0xff, 0xdb, 0, 2], p.sof, p.dht, p.sos, p.data), '空の量子化表');
		bad(
			ok(p.dqt, [0xff, 0xc0, 0, 8, 8, 0, 1, 0, 1, 0], p.dht, p.sos, p.data),
			'成分のないフレーム'
		);
		bad(
			ok(p.dqt, p.sof, p.dht, [0xff, 0xda, 0, 6, 0, 0, 0x3f, 0], p.data),
			'成分のないスキャン'
		);
		bad(
			ok(p.dqt, p.sof, p.dht, [0xff, 0xda, 0, 8, 1, 9, 0, 0, 0x3f, 0], p.data),
			'フレームにない成分'
		);
		bad(ok(p.dqt, p.sof, [0xff, 0xc4, 0, 2], p.sos, p.data), '空のハフマン表');
		bad(ok(p.dqt, p.sof, p.sos, p.data), 'ハフマン表がない');
		bad(
			ok(p.dqt, p.sof, p.dht.slice(0, 22), p.sos, p.data),
			'ハフマン表の長さが合わない'
		);
		const sofTq = [...p.sof];
		sofTq[12] = 2; // 量子化表 2 は定義されていない
		bad(ok(p.dqt, sofTq, p.dht, p.sos, p.data), '未定義の量子化表');
		const sofHv = [...p.sof];
		sofHv[11] = 0x51; // 標本化比 5
		bad(ok(p.dqt, sofHv, p.dht, p.sos, p.data), '標本化比が範囲外');
		const arithmetic = [...p.sof];
		arithmetic[1] = 0xc9; // 算術符号
		bad(ok(p.dqt, arithmetic, p.dht, p.sos, p.data), '算術符号は扱わない');
		const progressive = [...p.sof];
		progressive[1] = 0xc2;
		expect(
			sniffImage(ok(p.dqt, progressive, p.dht, p.sos, p.data))
		).not.toBeNull();
		const twoTables = [
			0xff,
			0xdb,
			0,
			131,
			0,
			...new Array(64).fill(1),
			1,
			...new Array(64).fill(1)
		];
		bad(
			ok(twoTables, p.sof, p.dht, p.sos, p.data),
			'精度1の表の長さが合わない'
		);
		bad(
			make(p.soi, p.dqt, p.sof, p.dht, p.sos, [0xff, 0xd0], p.eoi),
			'RST だけの符号化データ'
		);
	});
});

describe('sniffImage', () => {
	it('PNG・GIF・JPEG の形式と大きさを、中身から読む', () => {
		expect(sniffImage(png(20, 30))).toEqual({
			mime: 'image/png',
			width: 20,
			height: 30
		});
		expect(sniffImage(gif(300, 2))).toEqual({
			mime: 'image/gif',
			width: 300,
			height: 2
		});
		expect(sniffImage(jpeg(640, 480))).toEqual({
			mime: 'image/jpeg',
			width: 640,
			height: 480
		});
	});

	it('形式の印がない・途中で切れた・終わりの印がない・IHDR が壊れた画像は読まない', () => {
		const bytes = (...n: number[]) => new Uint8Array(n);
		expect(sniffImage(new Uint8Array())).toBeNull();
		expect(
			sniffImage(
				new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
			)
		).toBeNull();
		expect(sniffImage(new TextEncoder().encode('<html>404</html>'))).toBeNull();
		expect(sniffImage(png().subarray(0, 30))).toBeNull();
		expect(sniffImage(png().subarray(0, png().length - 1))).toBeNull();
		const badIhdr = png();
		badIhdr[12] = 0x58; // IHDR の名前を壊す
		expect(sniffImage(badIhdr)).toBeNull();
		expect(sniffImage(gif().subarray(0, 8))).toBeNull();
		expect(sniffImage(gif().subarray(0, gif().length - 1))).toBeNull();
		expect(sniffImage(jpeg().subarray(0, jpeg().length - 2))).toBeNull();
		// SOF より前に画像データ（SOS）が来る JPEG は、大きさが読めない。
		expect(
			sniffImage(bytes(0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9))
		).toBeNull();
		// 別の形式の署名のあとに、PNG のような本文が続くものは読まない。
		expect(sniffImage(bytes(0x50, 0x4b, 3, 4, ...png()))).toBeNull();
	});

	it('大きさがゼロ・辺が長すぎる・画素数が多すぎる・ファイルが大きすぎる画像は読まない', () => {
		expect(sniffImage(png(0, 10))).toBeNull();
		expect(sniffImage(png(10, 0))).toBeNull();
		expect(sniffImage(png(10001, 10))).toBeNull();
		expect(sniffImage(gif(0, 5))).toBeNull();
		expect(sniffImage(jpeg(10001, 5))).toBeNull();
		const side = Math.floor(Math.sqrt(MAX_IMAGE_PIXELS)) + 1;
		expect(sniffImage(png(side, side))).toBeNull();
		expect(sniffImage(png(side - 1, side - 1))).not.toBeNull();
		const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
		big.set(png());
		expect(sniffImage(big)).toBeNull();
	});
});

const G = 'https://www.aozora.gr.jp/gaiji/1-87/1-87-71.png';
let server: Server;
let origin = '';
let root = '';
let hits: { url: string; headers: Record<string, unknown> }[] = [];
let routes = new Map<string, { body: Uint8Array | string; etag?: string }>();

beforeEach(async () => {
	hits = [];
	routes = new Map();
	root = await mkdtemp(join(tmpdir(), 'aozora-images-'));
	server = createServer((req, res) => {
		hits.push({ url: req.url ?? '', headers: req.headers });
		const r = routes.get(req.url ?? '');
		if (!r) return void res.writeHead(404).end();
		if (r.etag && req.headers['if-none-match'] === r.etag)
			return void res.writeHead(304).end();
		res.writeHead(200, r.etag ? { etag: r.etag } : {}).end(r.body);
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
	server.closeAllConnections();
	await new Promise((r) => server.close(r));
	await rm(root, { recursive: true, force: true });
});

const local: typeof fetch = (url, init) =>
	fetch(`${origin}${new URL(String(url)).pathname}`, init);
const loader = (
	extra: Partial<ConstructorParameters<typeof ImageLoader>[0]> = {}
) =>
	new ImageLoader({
		root,
		fetchOptions: {
			fetch: local,
			retries: 0,
			timeoutMs: 2000,
			retryDelayMs: 1
		},
		...extra
	});

describe('ImageLoader', () => {
	it('画像を取得して検証し、base64 にして返す。同じURLは1回だけ取得する', async () => {
		routes.set('/gaiji/1-87/1-87-71.png', { body: png(16, 16) });
		const l = loader();
		const [a, b] = await Promise.all([l.load(G), l.load(G)]);
		expect(a).toEqual(b);
		expect(a.ok && a.image).toMatchObject({
			mime: 'image/png',
			width: 16,
			height: 16
		});
		expect(a.ok && Buffer.from(a.image.data, 'base64')).toEqual(
			Buffer.from(png(16, 16))
		);
		expect(hits).toHaveLength(1);
	});

	it('読めた画像は控えに残し、次の実行では取得せずに使う。取り直しを指定すると、検証子つきで確かめる', async () => {
		routes.set('/gaiji/1-87/1-87-71.png', { body: png(), etag: '"v1"' });
		await loader().load(G);
		hits = [];
		const again = await loader().load(G);
		expect(again.ok).toBe(true);
		expect(hits).toHaveLength(0);

		const revalidated = await loader({ revalidate: true }).load(G);
		expect(revalidated.ok).toBe(true);
		expect(hits).toHaveLength(1);
		expect(hits[0].headers['if-none-match']).toBe('"v1"');
	});

	it('読めない画像・見つからない画像・取り込めないURLは、理由を返し、控えを残さない', async () => {
		routes.set('/gaiji/1-87/1-87-71.png', {
			body: '<html>not an image</html>'
		});
		const l = loader();
		expect(await l.load(G)).toMatchObject({ ok: false, code: 'invalid-image' });
		expect(
			await l.load('https://www.aozora.gr.jp/gaiji/0-0/none.png')
		).toMatchObject({
			ok: false,
			code: 'fetch-status'
		});
		hits = [];
		for (const url of [
			'https://example.com/gaiji/1-87/1-87-71.png',
			'http://www.aozora.gr.jp/gaiji/1-87/1-87-71.png',
			'https://www.aozora.gr.jp/gaiji/../x.png',
			'https://www.aozora.gr.jp/cards/000879/files/../../x.png',
			'https://www.aozora.gr.jp/gaiji/1-87/1-87-71.svg',
			`${origin}/gaiji/1-87/1-87-71.png`
		])
			expect(await l.load(url), url).toMatchObject({
				ok: false,
				code: 'invalid-url'
			});
		expect(hits).toHaveLength(0);
		expect(await readdir(root).catch(() => [])).not.toContain('images');
	});

	it('大きすぎる画像は、受け取らずに断る', async () => {
		const huge: typeof fetch = async () =>
			new Response(null, {
				status: 200,
				headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) }
			});
		const l = loader({ fetchOptions: { fetch: huge, retries: 0 } });
		expect(await l.load(G)).toMatchObject({
			ok: false,
			code: 'fetch-too-large'
		});
	});

	it('同時に通信する数を、設定した数までに抑える', async () => {
		let open = 0;
		let peak = 0;
		const slow: typeof fetch = async (url, init) => {
			peak = Math.max(peak, ++open);
			await new Promise((r) => setTimeout(r, 20));
			open--;
			return local(url, init);
		};
		const urls = Array.from(
			{ length: 10 },
			(_, i) => `https://www.aozora.gr.jp/gaiji/1-87/1-87-${70 + i}.png`
		);
		for (const [i] of urls.entries())
			routes.set(`/gaiji/1-87/1-87-${70 + i}.png`, { body: png(16 + i, 16) });
		const l = loader({
			concurrency: 2,
			fetchOptions: { fetch: slow, retries: 0, timeoutMs: 2000 }
		});
		const results = await Promise.all(urls.map((u) => l.load(u)));
		expect(results.every((r) => r.ok)).toBe(true);
		expect(peak).toBe(2);
		for (const concurrency of [0, 65, Number.NaN, 1.5])
			expect(() => loader({ concurrency })).toThrow(RangeError);
	});

	it('成功した結果は覚えず、失敗だけを覚える。取り直しの指定でも、確かめるのは URL ごとに1回', async () => {
		routes.set('/gaiji/1-87/1-87-71.png', { body: png(), etag: '"v1"' });
		const l = loader({ revalidate: true });
		for (let i = 0; i < 3; i++) expect((await l.load(G)).ok).toBe(true);
		expect(hits).toHaveLength(1);
		expect(l.retained).toBe(0);

		const missing = 'https://www.aozora.gr.jp/gaiji/0-0/none.png';
		expect((await l.load(missing)).ok).toBe(false);
		expect((await l.load(missing)).ok).toBe(false);
		expect(hits).toHaveLength(2);
		expect(l.retained).toBe(1);
	});

	it('控えの読み書きが予期しない理由で失敗しても、未処理の拒否を出さず、失敗を覚えず、次は取り直せる', async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (e: unknown) => unhandled.push(e);
		process.on('unhandledRejection', onUnhandled);
		try {
			routes.set('/gaiji/1-87/1-87-71.png', { body: png() });
			// 控えの置き場所を、ファイルにしておく（ディレクトリとして読めない）。
			await writeFile(join(root, 'images'), 'x');
			const l = loader();
			await expect(l.load(G)).rejects.toThrow();
			await new Promise((r) => setTimeout(r, 20));
			expect(unhandled).toEqual([]);
			expect(l.retained).toBe(0);
			// 置き場所を直せば、同じローダーで取り直せる。
			await rm(join(root, 'images'));
			expect((await l.load(G)).ok).toBe(true);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});

	it('使えない設定は、通信の前に断る', () => {
		expect(() => loader({ fetchOptions: { maxBytes: Number.NaN } })).toThrow(
			RangeError
		);
	});
});
