import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWork } from '../../../src/lib/domain/work.ts';
import { CONVERTER_VERSION } from '../../converter/src/index.ts';
import { decodeBody } from './body.ts';
import {
	CommitRefused,
	commitRun,
	readCurrent,
	runImport,
	type RunOptions
} from './run.ts';
import { sha256 } from './store.ts';
import { makeZip } from './test-zip.ts';
import type { CatalogWork, Manifest, WorkRecord } from './types.ts';

const DASH = '-'.repeat(55);
const BIB = '底本：「テスト」\n入力：作業者';

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
const textZip = (body: string) =>
	makeZip([
		{
			name: 'a.txt',
			data: `題\n著者\n\n${DASH}\n【テキスト中に現れる記号について】\n${DASH}\n${body}\n${BIB}\n`
		}
	]);

type Route = { body: Uint8Array | string; etag?: string; fail?: number };
let server: Server;
let origin = '';
let routes = new Map<string, Route>();
let hits: string[] = [];
let onHit: (path: string, count: number) => void = () => {};
let delay = 0;
let open = 0;
let peak = 0;
let root = '';

beforeEach(async () => {
	routes = new Map();
	hits = [];
	onHit = () => {};
	delay = 0;
	open = 0;
	peak = 0;
	root = await mkdtemp(join(tmpdir(), 'aozora-importer-'));
	server = createServer((req, res) => {
		const path = req.url ?? '';
		hits.push(path);
		onHit(path, hits.length);
		peak = Math.max(peak, ++open);
		res.on('close', () => open--);
		const r = routes.get(path);
		if (!r) return void res.writeHead(404).end();
		if (r.fail !== undefined && r.fail > 0) {
			r.fail--;
			return void res.writeHead(503).end();
		}
		if (r.etag && req.headers['if-none-match'] === r.etag)
			return void res.writeHead(304).end();
		const send = () =>
			res.writeHead(200, r.etag ? { etag: r.etag } : {}).end(r.body);
		if (delay > 0) setTimeout(send, delay);
		else send();
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	server.closeAllConnections();
	await new Promise((r) => server.close(r));
	await rm(root, { recursive: true, force: true });
});

const work = (
	n: number,
	extra: Partial<CatalogWork> = {},
	updated = '2020-01-01'
): CatalogWork => {
	const id = String(n).padStart(6, '0');
	return {
		id,
		title: `作品${n}`,
		titleReading: '',
		sortReading: '',
		orthography: '新字新仮名',
		workCopyright: 'なし',
		published: '2020-01-01',
		updated,
		cardUrl: `https://www.aozora.gr.jp/cards/000879/card${n}.html`,
		people: [{ id: '000879', role: 'author', name: '著者' }],
		xhtml: { url: `${OFFICIAL}${htmlPath(n)}`, updated, encoding: 'UTF-8' },
		text: { url: `${OFFICIAL}${zipPath(n)}`, updated, encoding: 'UTF-8' },
		...extra
	};
};

const htmlPath = (n: number) => `/cards/000879/files/${n}.html`;
const zipPath = (n: number) => `/cards/000879/files/${n}_ruby_1.zip`;
const serveXhtml = (n: number, body = '本文です。<br />', etag?: string) =>
	routes.set(htmlPath(n), { body: xhtml(body), etag });
const serveText = (n: number, body = '本文です。', etag?: string) =>
	routes.set(zipPath(n), { body: textZip(body), etag });

const OFFICIAL = 'https://www.aozora.gr.jp';
/** 公式のURLへの取得を、手元のサーバーへ向ける。来歴には公式のURLが残り、公式サイトへは通信しない。 */
const local: typeof fetch = (url, init) =>
	fetch(`${origin}${new URL(String(url)).pathname}`, init);
const fast: RunOptions['fetchOptions'] = {
	retryDelayMs: 1,
	timeoutMs: 2000,
	fetch: local
};
const run = (
	runId: string,
	works: CatalogWork[],
	extra: Partial<RunOptions> = {}
) =>
	runImport({
		root,
		runId,
		works,
		concurrency: 1,
		minIntervalMs: 0,
		fetchOptions: fast,
		...extra
	});
const manifest = async (runId: string) =>
	JSON.parse(
		await readFile(join(root, 'runs', runId, 'manifest.json'), 'utf-8')
	) as Manifest;
/** converted の記録だけを取り出す。 */
const conv = (r: WorkRecord) => {
	if (r.status !== 'converted') throw new Error('converted ではありません');
	return r;
};
const manifestText = (runId: string) =>
	readFile(join(root, 'runs', runId, 'manifest.json'), 'utf-8');

describe('runImport', () => {
	it('XHTML と、テキストだけの作品を変換し、作品ごとの記録と作品を作る。著作権が「あり」の作品は取りに行かない', async () => {
		serveXhtml(1);
		serveText(2);
		serveXhtml(3);
		const works = [
			work(1),
			work(2, { xhtml: undefined }),
			work(3, { workCopyright: 'あり' })
		];
		const r = await run('r1', works);
		expect(r).toMatchObject({
			complete: true,
			counts: { total: 2, converted: 2, failed: 0 }
		});
		expect(hits.sort()).toEqual([htmlPath(1), zipPath(2)]);

		const m = await manifest('r1');
		expect(m.records.map((x) => [x.id, x.status])).toEqual([
			['000001', 'converted'],
			['000002', 'converted']
		]);
		for (const rec of m.records) {
			if (rec.status !== 'converted') throw new Error();
			const json = await readFile(
				join(root, 'runs', 'r1', 'works', `${rec.id}.json`),
				'utf-8'
			);
			expect(sha256(json)).toBe(rec.workSha256);
			const parsed = readWork(json);
			expect(parsed.ok && parsed.work.provenance.converter).toEqual(
				rec.converter
			);
			expect(rec.converter.version).toBe(CONVERTER_VERSION);
		}
		expect(
			m.records.map((x) => x.status === 'converted' && x.converter.path)
		).toEqual(['xhtml', 'text']);
		// 取得した本文は、内容の名前で残る。
		const first = m.records[0];
		if (first.status !== 'converted') throw new Error();
		expect(await readdir(join(root, 'raw'))).toContain(first.source.rawSha256);
	});

	it('XHTML が変換できなければテキストへ移り、移った理由を記録に残す', async () => {
		serveXhtml(1, '<script>x</script><marquee>流れる</marquee>');
		serveText(1, '本文です。');
		await run('r1', [work(1)]);
		const [rec] = (await manifest('r1')).records;
		expect(rec).toMatchObject({
			status: 'converted',
			converter: { path: 'text' },
			attempts: [{ path: 'xhtml', code: expect.stringMatching(/^convert-/) }]
		});
		expect(hits).toEqual([htmlPath(1), zipPath(1)]);
	});

	it('どの経路も使えない作品は失敗として記録し、ほかの作品は続ける', async () => {
		serveXhtml(2);
		const r = await run('r1', [work(1), work(2)]);
		expect(r.counts).toEqual({ total: 2, converted: 1, failed: 1 });
		const failed = (await manifest('r1')).records[0];
		expect(failed).toMatchObject({
			id: '000001',
			status: 'failed',
			attempts: [
				{ path: 'xhtml', code: 'fetch-status' },
				{ path: 'text', code: 'fetch-status' }
			]
		});
	});

	it('503 は再試行して取得できる', async () => {
		serveXhtml(1);
		routes.get(htmlPath(1))!.fail = 2;
		const r = await run('r1', [work(1)], {
			fetchOptions: { ...fast, retries: 2 }
		});
		expect(r.counts.converted).toBe(1);
		expect(hits).toEqual([htmlPath(1), htmlPath(1), htmlPath(1)]);
	});

	it('復号できない本文は、その経路を使わない', async () => {
		routes.set(htmlPath(1), { body: new Uint8Array([0xff, 0xfe, 0x82]) });
		serveText(1);
		await run('r1', [work(1)]);
		const [rec] = (await manifest('r1')).records;
		expect(rec).toMatchObject({
			status: 'converted',
			attempts: [{ path: 'xhtml', code: 'decode-error' }]
		});
	});

	it('同時に取る数と、始める間隔を守る', async () => {
		for (const n of [1, 2, 3, 4]) serveXhtml(n);
		delay = 30;
		await run(
			'r1',
			[1, 2, 3, 4].map((n) => work(n)),
			{ concurrency: 2 }
		);
		expect(peak).toBe(2);

		delay = 0;
		const t0 = Date.now();
		await run(
			'r2',
			[1, 2, 3].map((n) => work(n)),
			{ minIntervalMs: 40 }
		);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(75);
	});

	it('同じ実行を2回終えようとしたり、使えない runId は、拒む', async () => {
		serveXhtml(1);
		await run('r1', [work(1)]);
		await expect(run('r1', [work(1)])).rejects.toThrow();
		await expect(run('../x', [work(1)])).rejects.toThrow();
	});
});

describe('再開', () => {
	it('止めた実行を同じ runId でやり直すと、終えた作品は取り直さず、続きから進む', async () => {
		const works = [1, 2, 3, 4].map((n) => work(n));
		for (const n of [1, 2, 3, 4]) serveXhtml(n);
		const stop = new AbortController();
		onHit = (_, count) => count === 2 && stop.abort();
		const first = await run('r1', works, { signal: stop.signal });
		expect(first.complete).toBe(false);
		expect(first.counts.total).toBe(2);
		await expect(manifestText('r1')).rejects.toThrow();

		onHit = () => {};
		hits = [];
		const second = await run('r1', works);
		expect(second).toMatchObject({
			complete: true,
			counts: { total: 4, converted: 4 }
		});
		expect(second.stats.resumed).toBe(2);
		expect(hits.sort()).toEqual([htmlPath(3), htmlPath(4)]);
	});

	it('通信の失敗は、再開のときにもう一度試す', async () => {
		serveXhtml(1);
		routes.get(htmlPath(1))!.fail = 99;
		serveXhtml(2);
		const works = [work(1, { text: undefined }), work(2)];
		const stop = new AbortController();
		onHit = () => stop.abort();
		const first = await run('r1', works, {
			signal: stop.signal,
			fetchOptions: { ...fast, retries: 0 }
		});
		expect(first).toMatchObject({
			complete: false,
			counts: { total: 1, failed: 1 }
		});

		routes.get(htmlPath(1))!.fail = 0;
		onHit = () => {};
		hits = [];
		const second = await run('r1', works);
		expect(second.counts).toEqual({ total: 2, converted: 2, failed: 0 });
		expect(hits.sort()).toEqual([htmlPath(1), htmlPath(2)]);
	});

	it('変換の失敗は、再開のときに取り直さない', async () => {
		serveXhtml(1, '<marquee>流れる</marquee>');
		serveText(1, '［＃未知の記法］');
		serveXhtml(2);
		const works = [work(1), work(2)];
		const stop = new AbortController();
		onHit = (path) => path === zipPath(1) && stop.abort();
		await run('r1', works, { signal: stop.signal });

		onHit = () => {};
		hits = [];
		const second = await run('r1', works);
		expect(second.counts).toEqual({ total: 2, converted: 1, failed: 1 });
		expect(hits).toEqual([htmlPath(2)]);
	});

	it('壊れた記録は、なかったことにして、取り直す', async () => {
		serveXhtml(1);
		serveXhtml(2);
		const works = [work(1), work(2)];
		const stop = new AbortController();
		onHit = (_, count) => count === 1 && stop.abort();
		await run('r1', works, { signal: stop.signal });
		await writeFile(
			join(root, 'runs', 'r1', 'records', '000001.json'),
			'{"id":"000001","status":"converted"'
		);
		hits = [];
		const r = await run('r1', works);
		expect(r.counts).toEqual({ total: 2, converted: 2, failed: 0 });
		expect(hits.sort()).toEqual([htmlPath(1), htmlPath(2)]);
	});
});

describe('差分取得と再利用', () => {
	const works = [work(1), work(2, { xhtml: undefined })];
	const setup = async () => {
		serveXhtml(1, '本文です。<br />', '"v1"');
		serveText(2, '本文です。', '"t1"');
		await run('r1', works);
		await commitRun(root, 'r1');
		hits = [];
	};

	it('目録の更新日も変換器も同じなら、取得せずに前回の作品を引き継ぎ、記録は前回と同じになる', async () => {
		await setup();
		const r = await run('r2', works);
		expect(hits).toEqual([]);
		expect(r.stats).toMatchObject({ catalogUnchanged: 2, requests: 0 });
		expect(await manifestText('r2')).toBe(await manifestText('r1'));
		expect(
			await readFile(join(root, 'runs', 'r2', 'works', '000001.json'), 'utf-8')
		).toBe(
			await readFile(join(root, 'runs', 'r1', 'works', '000001.json'), 'utf-8')
		);
	});

	it('取り直すよう指定すると、検証子つきで取得し、変わっていなければ本文を受け取らず、記録は同じになる', async () => {
		await setup();
		const r = await run('r2', works, { revalidate: true });
		expect(r.stats).toMatchObject({ notModified: 2, fetched: 0, requests: 2 });
		expect(await manifestText('r2')).toBe(await manifestText('r1'));
	});

	it('更新日だけが進み、本文が同じなら、変換し直さず、新しい更新日を記録する', async () => {
		await setup();
		const bumped = [
			work(1, {}, '2020-02-02'),
			work(2, { xhtml: undefined }, '2020-02-02')
		];
		const r = await run('r2', bumped);
		expect(r.stats).toMatchObject({ notModified: 2 });
		const m = await manifest('r2');
		expect(
			m.records.map((x) => x.status === 'converted' && x.source.catalogUpdated)
		).toEqual(['2020-02-02', '2020-02-02']);
		expect(conv(m.records[0]).workSha256).toBe(
			conv((await manifest('r1')).records[0]).workSha256
		);
	});

	it('本文が変わったら取り込み直し、変わっていない作品は引き継ぐ', async () => {
		await setup();
		serveXhtml(1, '書き換わった本文です。<br />', '"v2"');
		const bumped = [work(1, {}, '2020-02-02'), works[1]];
		const r = await run('r2', bumped);
		expect(r.stats).toMatchObject({ fetched: 1, catalogUnchanged: 1 });
		expect(hits).toEqual([htmlPath(1)]);
		const [a, b] = (await manifest('r2')).records;
		const before = (await manifest('r1')).records;
		expect(conv(a).workSha256).not.toBe(conv(before[0]).workSha256);
		expect(b).toEqual(before[1]);
	});

	it('同じ内容が検証子なしで返っても、変換し直さない', async () => {
		serveXhtml(1);
		await run('r1', [work(1)]);
		await commitRun(root, 'r1');
		hits = [];
		const r = await run('r2', [work(1, {}, '2020-02-02')]);
		expect(r.stats).toMatchObject({ fetched: 1, contentUnchanged: 1 });
		expect(
			await readFile(join(root, 'runs', 'r2', 'works', '000001.json'), 'utf-8')
		).toBe(
			await readFile(join(root, 'runs', 'r1', 'works', '000001.json'), 'utf-8')
		);
	});

	it('前回の変換器のバージョンが違う、または作品のファイルが記録と合わないときは、引き継がず変換し直す', async () => {
		await setup();
		const rec = join(root, 'runs', 'r1', 'records', '000001.json');
		const old = JSON.parse(await readFile(rec, 'utf-8'));
		old.converter.version = '0.0.1';
		await writeFile(rec, JSON.stringify(old));
		await writeFile(join(root, 'runs', 'r1', 'works', '000002.json'), '改ざん');
		const r = await run('r2', works);
		expect(r.stats.catalogUnchanged).toBe(0);
		expect(hits.sort()).toEqual([htmlPath(1), zipPath(2)]);
		const m = await manifest('r2');
		expect(m.records[0]).toMatchObject({
			converter: { version: CONVERTER_VERSION }
		});
	});

	it('取得した本文の控えが消えていれば、検証子を付けずに取り直す', async () => {
		await setup();
		await rm(join(root, 'raw'), { recursive: true });
		const r = await run('r2', works, { revalidate: true });
		expect(r.stats).toMatchObject({ fetched: 2, notModified: 0 });
	});
});

describe('失敗しても、最後に正常な実行を壊さない', () => {
	it('全部の取得が失敗した実行は、確定を拒まれ、current も前回の記録も変わらない', async () => {
		serveXhtml(1);
		serveXhtml(2);
		const works = [work(1), work(2)];
		await run('r1', works);
		await commitRun(root, 'r1');
		const before = await manifestText('r1');

		routes.clear();
		const bumped = works.map((w) => ({
			...w,
			updated: '2020-03-03',
			xhtml: { ...w.xhtml!, updated: '2020-03-03' },
			text: { ...w.text!, updated: '2020-03-03' }
		}));
		const bad = await run('r2', bumped);
		expect(bad).toMatchObject({
			complete: true,
			counts: { total: 2, converted: 0, failed: 2 }
		});
		await expect(commitRun(root, 'r2')).rejects.toThrow(CommitRefused);
		expect(await readCurrent(root)).toBe('r1');
		expect(await manifestText('r1')).toBe(before);
	});

	it('終わっていない実行、1件もない実行、失敗が多い実行は確定できない。少なければ確定できる', async () => {
		serveXhtml(1);
		await expect(commitRun(root, 'none')).rejects.toThrow(CommitRefused);
		await run('empty', []);
		await expect(commitRun(root, 'empty')).rejects.toThrow(/1件もありません/);

		const stop = new AbortController();
		stop.abort();
		await run('partial', [work(1)], { signal: stop.signal });
		await expect(commitRun(root, 'partial')).rejects.toThrow(CommitRefused);
		expect(await readCurrent(root)).toBeNull();

		const many = [1, 2, 3, 4].map((n) => work(n));
		for (const n of [1, 2, 3]) serveXhtml(n);
		await run('some', many);
		await expect(
			commitRun(root, 'some', { maxFailureRatio: 0.2 })
		).rejects.toThrow(/失敗が多すぎます/);
		await commitRun(root, 'some', { maxFailureRatio: 0.3 });
		expect(await readCurrent(root)).toBe('some');
	});
});

describe('再現性', () => {
	it('同じ入力から、別々の作業領域で、同じ記録と同じ作品ができる。一時ファイルは残らない', async () => {
		serveXhtml(1, '本文です。<br />', '"v1"');
		serveText(2);
		const works = [work(2, { xhtml: undefined }), work(1)];
		await run('r1', works);
		const other = await mkdtemp(join(tmpdir(), 'aozora-importer-'));
		try {
			await runImport({
				root: other,
				runId: 'r1',
				works: [...works].reverse(),
				concurrency: 3,
				minIntervalMs: 0,
				fetchOptions: fast
			});
			expect(
				await readFile(join(other, 'runs', 'r1', 'manifest.json'), 'utf-8')
			).toBe(await manifestText('r1'));
			for (const id of ['000001', '000002'])
				expect(
					await readFile(
						join(other, 'runs', 'r1', 'works', `${id}.json`),
						'utf-8'
					)
				).toBe(
					await readFile(
						join(root, 'runs', 'r1', 'works', `${id}.json`),
						'utf-8'
					)
				);
			const files = (await readdir(root, { recursive: true })).filter((f) =>
				f.endsWith('.tmp')
			);
			expect(files).toEqual([]);
		} finally {
			await rm(other, { recursive: true, force: true });
		}
	});
});

describe('decodeBody', () => {
	it('Shift_JIS と UTF-8 を復号し、読めない並びは失敗にする', () => {
		expect(
			decodeBody('xhtml', 'ShiftJIS', new Uint8Array([0x82, 0xa0, 0x41]))
		).toEqual({ ok: true, text: 'あA' });
		expect(
			decodeBody('xhtml', 'UTF-8', new TextEncoder().encode('あ'))
		).toEqual({ ok: true, text: 'あ' });
		expect(
			decodeBody('xhtml', 'ShiftJIS', new Uint8Array([0x82]))
		).toMatchObject({ ok: false, code: 'decode-error' });
		expect(decodeBody('xhtml', 'UTF-8', new Uint8Array([0xff]))).toMatchObject({
			ok: false
		});
	});

	it('テキストは zip の中の .txt が1つのときだけ読む', () => {
		const one = makeZip([
			{ name: 'a.txt', data: new Uint8Array([0x82, 0xa0]) }
		]);
		expect(decodeBody('text', 'ShiftJIS', one)).toEqual({
			ok: true,
			text: 'あ'
		});
		const two = makeZip([
			{ name: 'a.txt', data: 'x' },
			{ name: 'b.txt', data: 'y' }
		]);
		expect(decodeBody('text', 'UTF-8', two)).toMatchObject({ ok: false });
		expect(
			decodeBody('text', 'UTF-8', makeZip([{ name: 'a.csv', data: 'x' }]))
		).toMatchObject({ ok: false });
		expect(
			decodeBody('text', 'UTF-8', new TextEncoder().encode('zipではない'))
		).toMatchObject({ ok: false, code: 'decode-error' });
	});
});
