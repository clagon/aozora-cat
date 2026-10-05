import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	ImageLoader,
	MAX_IMAGE_BYTES,
	MAX_IMAGE_PIXELS,
	sniffImage
} from './images.ts';
import { gif, jpeg, png } from './test-images.ts';

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

	it('使えない設定は、通信の前に断る', () => {
		expect(() => loader({ fetchOptions: { maxBytes: Number.NaN } })).toThrow(
			RangeError
		);
	});
});
