import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	collectImageUrls,
	missingImages,
	parseAsset,
	parseAssetPart,
	type AssetImage
} from '../../../src/lib/domain/asset.ts';
import { readWork, type Work } from '../../../src/lib/domain/work.ts';
import { MAX_FILE_BYTES, PackError, packRun, packWork } from './pack.ts';
import { commitRun, runImport } from './run.ts';
import { sha256 } from './store.ts';
import { gif, jpeg, png } from './test-images.ts';
import type { CatalogWork } from './types.ts';

const OFFICIAL = 'https://www.aozora.gr.jp';
const G1 = `${OFFICIAL}/gaiji/1-87/1-87-71.png`;
const G2 = `${OFFICIAL}/gaiji/1-88/1-88-81.png`;
const FIG = `${OFFICIAL}/cards/000879/files/fig1_01.png`;

const xhtml = (body: string) => `<?xml version="1.0" encoding="Shift_JIS"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja"><head><title>t</title></head>
<body>
<div class="metadata"><h1 class="title">題</h1><h2 class="author">著者</h2></div>
<div id="contents" style="display:none"></div><div class="main_text">${body}</div>
<div class="bibliographical_information"><hr /><br />底本：「テスト」<br />入力：作業者<br /></div>
<div class="notation_notes"><hr /><br />●表記について<br /><ul><li>このファイルは W3C 勧告 XHTML1.1 にそった形式で作成されています。</li></ul></div>
<div id="card"><hr /><br /><a href="JavaScript:goLibCard();" id="goAZLibCard">●図書カード</a></div>
</body></html>
`;
const gaijiImg = (men: string, name: string) =>
	`<img src="../../../gaiji/${men}/${name}.png" alt="※(x、第3水準${name.replace(/-/g, '-')})" class="gaiji" />`;

let server: Server;
let origin = '';
let root = '';
let out = '';
let routes = new Map<string, Uint8Array | string>();
let hits: string[] = [];

beforeEach(async () => {
	routes = new Map();
	hits = [];
	root = await mkdtemp(join(tmpdir(), 'aozora-pack-'));
	out = join(root, 'out');
	server = createServer((req, res) => {
		hits.push(req.url ?? '');
		const body = routes.get(req.url ?? '');
		if (body === undefined) return void res.writeHead(404).end();
		res.writeHead(200).end(body);
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
const fast = { fetch: local, retries: 0, timeoutMs: 2000, retryDelayMs: 1 };

const catalog = (n: number): CatalogWork => ({
	id: String(n).padStart(6, '0'),
	title: `作品${n}`,
	titleReading: '',
	sortReading: '',
	orthography: '新字新仮名',
	workCopyright: 'なし',
	published: '2020-01-01',
	updated: '2020-01-01',
	cardUrl: `${OFFICIAL}/cards/000879/card${n}.html`,
	people: [{ id: '000879', role: 'author', name: '著者' }],
	xhtml: {
		url: `${OFFICIAL}/cards/000879/files/${n}.html`,
		updated: '2020-01-01',
		encoding: 'UTF-8'
	}
});
const serveWork = (n: number, body: string) =>
	routes.set(`/cards/000879/files/${n}.html`, xhtml(body));

/** 作品を取り込んで、確定した実行を作る。 */
async function importRun(works: CatalogWork[]) {
	await runImport({
		root,
		runId: 'r1',
		works,
		concurrency: 1,
		minIntervalMs: 0,
		fetchOptions: fast
	});
	await commitRun(root, 'r1', { maxFailureRatio: 1 });
}
const pack = (extra: Partial<Parameters<typeof packRun>[0]> = {}) =>
	packRun({
		root,
		runId: 'r1',
		outDir: out,
		minIntervalMs: 0,
		fetchOptions: fast,
		...extra
	});

const readAsset = async (path: string) => {
	const r = parseAsset(
		JSON.parse(gunzipSync(await readFile(join(out, path))).toString('utf-8'))
	);
	if (!r.ok) throw new Error(r.error);
	return r.asset;
};

const image = (n = 16): AssetImage => ({
	mime: 'image/png',
	width: n,
	height: n,
	data: Buffer.from(png(n, n)).toString('base64')
});

/** 圧縮してもほとんど小さくならない、決まった並びのバイト列。 */
const noise = (n: number, seed: number): string => {
	const out: Buffer[] = [];
	for (let i = 0; out.reduce((a, b) => a + b.length, 0) < n; i++)
		out.push(createHash('sha256').update(`${seed}:${i}`).digest());
	return Buffer.concat(out).subarray(0, n).toString('base64');
};

/** 画像を参照する作品（パックの試験用）。 */
async function workWith(imageUrls: string[]): Promise<Work> {
	serveWork(1, '本文です。<br />');
	await importRun([catalog(1)]);
	const text = await readFile(
		join(root, 'runs', 'r1', 'works', '000001.json'),
		'utf-8'
	);
	const r = readWork(text);
	if (!r.ok) throw new Error('作品が読めない');
	const inline = imageUrls.map((url) => ({
		kind: 'gaiji' as const,
		description: '※(x)',
		image: { url }
	}));
	return {
		...r.work,
		blocks: [{ kind: 'paragraph', id: 'p-1', layout: { kind: 'none' }, inline }]
	};
}

describe('packWork', () => {
	it('1つのファイルに収まれば、作品と画像を1つの圧縮ファイルにする。同じ入力から同じバイト列になる', async () => {
		const w = await workWith([G1, G2]);
		const images = new Map([
			[G1, image()],
			[G2, image(20)]
		]);
		const files = packWork(w, images);
		expect(files.map((f) => f.path)).toEqual(['works/000001.json.gz']);
		expect(files).toEqual(packWork(w, new Map([...images].reverse())));

		const asset = parseAsset(
			JSON.parse(gunzipSync(files[0].bytes).toString('utf-8'))
		);
		expect(asset.ok && asset.asset.imageParts).toEqual([]);
		expect(asset.ok && Object.keys(asset.asset.images).sort()).toEqual([
			G1,
			G2
		]);
		expect(asset.ok && missingImages(asset.asset, [])).toEqual([]);
	});

	it('参照する画像が足りなければ、断る', async () => {
		const w = await workWith([G1, G2]);
		expect(() => packWork(w, new Map([[G1, image()]]))).toThrow(PackError);
	});

	it('上限を超えるときだけ、画像を別のファイルに分け、すべて上限に収める。参照は解決できる', async () => {
		const urls = Array.from(
			{ length: 6 },
			(_, i) => `${OFFICIAL}/gaiji/1-87/1-87-${70 + i}.png`
		);
		const w = await workWith(urls);
		const images = new Map(
			urls.map((u, i): [string, AssetImage] => [
				u,
				{ ...image(), data: noise(3000, i) }
			])
		);
		const max = 6000;
		const files = packWork(w, images, { maxFileBytes: max });
		expect(files.length).toBeGreaterThan(2);
		for (const f of files) expect(f.bytes.length).toBeLessThanOrEqual(max);
		expect(files[0].path).toBe('works/000001.json.gz');

		const main = parseAsset(
			JSON.parse(gunzipSync(files[0].bytes).toString('utf-8'))
		);
		if (!main.ok) throw new Error(main.error);
		expect(main.asset.images).toEqual({});
		expect(main.asset.imageParts).toEqual(files.slice(1).map((f) => f.path));
		const parts = files.slice(1).map((f) => {
			const p = parseAssetPart(
				JSON.parse(gunzipSync(f.bytes).toString('utf-8')),
				new Set(collectImageUrls(main.asset.work))
			);
			if (!p.ok) throw new Error(p.error);
			return p.part;
		});
		expect(missingImages(main.asset, parts)).toEqual([]);
		// 同じ画像が2つの分け先に入らない。
		const all = parts.flatMap((p) => Object.keys(p.images));
		expect(new Set(all).size).toBe(urls.length);
		expect(all).toHaveLength(urls.length);
	});

	it('分けても収まらない（1枚が大きすぎる・本文が大きすぎる・分け先が多すぎる）ときは、理由つきで断る', async () => {
		const w = await workWith([G1]);
		const code = (fn: () => unknown) => {
			try {
				fn();
			} catch (e) {
				return e instanceof PackError ? e.code : 'other';
			}
			return 'ok';
		};
		const big = { ...image(), data: noise(4000, 1) };
		expect(
			code(() => packWork(w, new Map([[G1, big]]), { maxFileBytes: 2000 }))
		).toBe('image-too-large');
		// 画像がなくても、本文だけで上限を超える。
		const bare = { ...w, blocks: [] };
		expect(code(() => packWork(bare, new Map(), { maxFileBytes: 50 }))).toBe(
			'work-too-large'
		);
		// 分け先が、決めた数より多くなる。
		const many = Array.from(
			{ length: 1001 },
			(_, i) => `${OFFICIAL}/gaiji/1-87/1-87-${String(i).padStart(3, '0')}.png`
		);
		const manyWork = {
			...w,
			blocks: [
				{
					kind: 'paragraph' as const,
					id: 'p-1',
					layout: { kind: 'none' as const },
					inline: many.map((url) => ({
						kind: 'gaiji' as const,
						description: '※',
						image: { url }
					}))
				}
			]
		};
		const tiny = new Map(
			many.map((u): [string, AssetImage] => [u, { ...image(), data: 'AAAA' }])
		);
		expect(code(() => packWork(manyWork, tiny, { maxFileBytes: 200 }))).toBe(
			'too-many-parts'
		);
	});
});

describe('packRun', () => {
	it('実行の作品を、画像つきの圧縮ファイルにして出力先へ書く。画像は、作品をまたいで1回だけ取得する', async () => {
		routes.set('/gaiji/1-87/1-87-71.png', png(16, 16));
		routes.set('/gaiji/1-88/1-88-81.png', gif(16, 16));
		routes.set('/cards/000879/files/fig1_01.png', jpeg(40, 20));
		serveWork(1, `甲${gaijiImg('1-87', '1-87-71')}乙<br />`);
		serveWork(
			2,
			`甲${gaijiImg('1-87', '1-87-71')}${gaijiImg('1-88', '1-88-81')}<br />`
		);
		serveWork(3, '画像なし。<br />');
		await importRun([catalog(1), catalog(2), catalog(3)]);
		hits = [];

		const r = await pack();
		expect(r.failed).toEqual([]);
		expect(
			r.packed.map((p) => [p.id, p.images, p.files.map((f) => f.path)])
		).toEqual([
			['000001', 1, ['works/000001.json.gz']],
			['000002', 2, ['works/000002.json.gz']],
			['000003', 0, ['works/000003.json.gz']]
		]);
		expect(hits.sort()).toEqual([
			'/gaiji/1-87/1-87-71.png',
			'/gaiji/1-88/1-88-81.png'
		]);

		const a2 = await readAsset('works/000002.json.gz');
		expect(Object.keys(a2.images).sort()).toEqual([G1, G2]);
		expect(a2.images[G2]).toMatchObject({ mime: 'image/gif' });
		for (const p of r.packed)
			for (const f of p.files) {
				const bytes = await readFile(join(out, f.path));
				expect(bytes.length).toBe(f.bytes);
				expect(sha256(bytes)).toBe(f.sha256);
			}
		// ロックの一時ファイルは残らない。
		expect((await readdir(out)).sort()).toEqual(['works']);
	});

	it('1つの作品に画像が多くても、同時に通信する数は、設定した数を超えない', async () => {
		const names = Array.from({ length: 8 }, (_, i) => `1-87-${70 + i}`);
		for (const n of names) routes.set(`/gaiji/1-87/${n}.png`, png());
		serveWork(1, `${names.map((n) => gaijiImg('1-87', n)).join('')}<br />`);
		await importRun([catalog(1)]);
		let open = 0;
		let peak = 0;
		const slow: typeof fetch = async (url, init) => {
			peak = Math.max(peak, ++open);
			await new Promise((r) => setTimeout(r, 15));
			open--;
			return local(url, init);
		};
		const r = await pack({
			concurrency: 2,
			fetchOptions: { ...fast, fetch: slow }
		});
		expect(r.packed[0].images).toBe(8);
		expect(peak).toBe(2);
	});

	it('画像が取得できない・読めない作品は、失敗として返し、ほかの作品は書く', async () => {
		routes.set('/gaiji/1-87/1-87-71.png', '<html>not an image</html>');
		serveWork(1, `甲${gaijiImg('1-87', '1-87-71')}<br />`);
		serveWork(2, `甲${gaijiImg('1-88', '1-88-81')}<br />`);
		serveWork(3, '画像なし。<br />');
		await importRun([catalog(1), catalog(2), catalog(3)]);

		const r = await pack();
		expect(r.packed.map((p) => p.id)).toEqual(['000003']);
		expect(r.failed).toEqual([
			{
				id: '000001',
				code: 'image-invalid-image',
				message: expect.any(String),
				url: G1
			},
			{
				id: '000002',
				code: 'image-fetch-status',
				message: expect.any(String),
				url: G2
			}
		]);
		expect(await readdir(join(out, 'works'))).toEqual(['000003.json.gz']);
	});

	it('同時に取る数・間隔・ファイルの上限に使えない値を渡すと、何かを書く前に断る', async () => {
		serveWork(1, '本文。<br />');
		await importRun([catalog(1)]);
		const bad: Partial<Parameters<typeof packRun>[0]>[] = [
			{ concurrency: Number.NaN },
			{ concurrency: 65 },
			{ minIntervalMs: Number.NaN },
			{ minIntervalMs: -1 },
			{ minIntervalMs: Infinity },
			{ minIntervalMs: 2 ** 31 },
			{ maxFileBytes: Number.NaN },
			{ maxFileBytes: Infinity },
			{ maxFileBytes: 0 },
			{ maxFileBytes: 1.5 },
			{ maxFileBytes: MAX_FILE_BYTES + 1 }
		];
		for (const [i, o] of bad.entries())
			await expect(pack(o), String(i)).rejects.toThrow(RangeError);
		await expect(
			pack({ fetchOptions: { ...fast, maxBytes: Number.NaN } })
		).rejects.toThrow(RangeError);
		expect(await readdir(root)).not.toContain('out');
	});

	it('1ファイルの上限は、配信先の上限（25MiB）を超えられない', async () => {
		const w = await workWith([G1]);
		const images = new Map([[G1, image()]]);
		for (const maxFileBytes of [Number.NaN, Infinity, 0, MAX_FILE_BYTES + 1])
			expect(
				() => packWork(w, images, { maxFileBytes }),
				String(maxFileBytes)
			).toThrow(RangeError);
		expect(packWork(w, images, { maxFileBytes: MAX_FILE_BYTES })).toHaveLength(
			1
		);
	});

	it('出力先が空でない、実行の作品のファイルが記録と合わない、設定が使えないときは、書く前に断る', async () => {
		serveWork(1, '本文。<br />');
		await importRun([catalog(1)]);
		await expect(pack({ concurrency: 0 })).rejects.toThrow(RangeError);

		await writeFile(join(root, 'stray'), 'x');
		const dirty = join(root, 'dirty');
		await rm(dirty, { recursive: true, force: true });
		await import('node:fs/promises').then((fs) =>
			fs.mkdir(dirty).then(() => fs.writeFile(join(dirty, 'old.json.gz'), 'x'))
		);
		await expect(pack({ outDir: dirty })).rejects.toThrow(/空ではありません/);
		expect(await readdir(dirty)).toEqual(['old.json.gz']);

		await writeFile(join(root, 'runs', 'r1', 'works', '000001.json'), '{}');
		await expect(pack()).rejects.toThrow(/記録と合いません/);
		await expect(pack({ runId: 'none' })).rejects.toThrow(/終わっていません/);
	});

	it('同じ入力から、別の出力先に、同じバイト列を書く', async () => {
		routes.set('/gaiji/1-87/1-87-71.png', png());
		serveWork(1, `甲${gaijiImg('1-87', '1-87-71')}<br />`);
		serveWork(2, '画像なし。<br />');
		await importRun([catalog(1), catalog(2)]);
		const a = await pack();
		const b = await pack({ outDir: join(root, 'out2') });
		expect(a).toEqual(b);
		for (const id of ['000001', '000002'])
			expect(
				await readFile(join(root, 'out2', 'works', `${id}.json.gz`))
			).toEqual(await readFile(join(out, 'works', `${id}.json.gz`)));
	});
});
