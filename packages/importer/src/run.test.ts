import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile
} from 'node:fs/promises';
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

	it('再試行の通信も、始める間隔を守って数える', async () => {
		serveXhtml(1);
		routes.get(htmlPath(1))!.fail = 2;
		const t0 = Date.now();
		const r = await run('r1', [work(1)], {
			minIntervalMs: 40,
			fetchOptions: { ...fast, retries: 2 }
		});
		expect(r.stats.requests).toBe(3);
		expect(hits).toHaveLength(3);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(75);
	});

	it('本文の大きさの上限は、呼び出し側が下げられるが、上げられない', async () => {
		serveXhtml(1);
		// 上限を下げれば、その大きさを超える本文は受け取らない。
		await run('r1', [work(1)], {
			fetchOptions: { ...fast, maxBytes: 10, retries: 0 }
		});
		expect((await manifest('r1')).records[0]).toMatchObject({
			status: 'failed',
			attempts: [{ code: 'fetch-too-large' }, { code: 'fetch-status' }]
		});
		// 上限を外そうとしても、70MiB と申告される本文は読まない。
		const huge: typeof fetch = async () =>
			new Response(null, {
				status: 200,
				headers: { 'content-length': String(70 * 2 ** 20) }
			});
		await run('r2', [work(1)], {
			fetchOptions: { ...fast, fetch: huge, maxBytes: Infinity, retries: 0 }
		});
		expect((await manifest('r2')).records[0]).toMatchObject({
			status: 'failed',
			attempts: [{ code: 'fetch-too-large' }, { code: 'fetch-too-large' }]
		});
	});

	it('本文の大きさの上限に NaN や負の値を渡すと、通信を始める前に断る', async () => {
		serveXhtml(1);
		for (const maxBytes of [Number.NaN, -1]) {
			await expect(
				run('r1', [work(1)], { fetchOptions: { ...fast, maxBytes } })
			).rejects.toThrow(RangeError);
		}
		expect(hits).toEqual([]);
		expect(await readdir(root)).toEqual([]);
	});

	it('同時に取る数・間隔・時間切れ・再試行の設定に使えない値を渡すと、通信を始める前に断る', async () => {
		serveXhtml(1);
		const bad: Partial<RunOptions>[] = [
			{ concurrency: Number.NaN },
			{ concurrency: 0 },
			{ concurrency: 1.5 },
			{ concurrency: 65 },
			{ minIntervalMs: Number.NaN },
			{ minIntervalMs: -1 },
			{ minIntervalMs: Infinity },
			{ fetchOptions: { ...fast, timeoutMs: Number.NaN } },
			{ fetchOptions: { ...fast, timeoutMs: 0 } },
			{ fetchOptions: { ...fast, retries: -1 } },
			{ fetchOptions: { ...fast, retries: 11 } },
			{ fetchOptions: { ...fast, retryDelayMs: Number.NaN } }
		];
		for (const [i, options] of bad.entries())
			await expect(run('r1', [work(1)], options), String(i)).rejects.toThrow(
				RangeError
			);
		expect(hits).toEqual([]);
		expect(await readdir(root)).toEqual([]);
	});

	it('同じ runId を同時に2つ書かせない。落ちたロックは明示したときだけ取り直し、終えたあとは解放する', async () => {
		serveXhtml(1);
		const lock = join(root, 'runs', 'r1', 'lock');
		const both = await Promise.allSettled([
			run('r1', [work(1)]),
			run('r1', [work(1)])
		]);
		expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		const refused = both.find((r) => r.status === 'rejected');
		expect(
			refused && refused.status === 'rejected' && String(refused.reason)
		).toMatch(/使っています/);
		// 終えたら、ロックは残らない。
		expect(await readdir(join(root, 'runs', 'r1'))).not.toContain('lock');

		// 動いているプロセスのロックは拒み、終わっているプロセスのロックは取り直す。
		await rm(join(root, 'runs', 'r1', 'manifest.json'));
		await writeFile(lock, String(process.pid));
		await expect(run('r1', [work(1)])).rejects.toThrow(/使っています/);
		// 持ち主が終わっているロックは、既定では取り直さず、確かめるまで断る。
		hits = [];
		await writeFile(lock, '2147483646');
		await expect(run('r1', [work(1)])).rejects.toThrow(/動いていません/);
		expect(hits.length).toBe(0);
		// 取り直すと明示したときだけ、取り直す。
		expect(
			(await run('r1', [work(1)], { recoverStaleLock: true })).complete
		).toBe(true);
		// 失敗して終わった場合も、ロックを解放する。
		await rm(join(root, 'runs', 'r1', 'manifest.json'));
		await rm(join(root, 'runs', 'r1', 'records', '000001.json'));
		await mkdir(join(root, 'runs', 'r1', 'records', '000001.json'), {
			recursive: true
		});
		await expect(run('r1', [work(1)])).rejects.toThrow();
		expect(await readdir(join(root, 'runs', 'r1'))).not.toContain('lock');
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

	it('パスの一部や重複になる作品IDは、何も読み書きする前に拒む', async () => {
		for (const id of ['../../../current', '1', '00000a', '0000001', '']) {
			await expect(run('r1', [work(1, { id })]), id).rejects.toThrow(/作品ID/);
		}
		await expect(run('r1', [work(1), work(1)])).rejects.toThrow(/重複/);
		// 著作権が「あり」の作品でも、IDは検証する。
		await expect(
			run('r1', [work(1, { id: '../x', workCopyright: 'あり' })])
		).rejects.toThrow(/作品ID/);
		expect(await readdir(root)).toEqual([]);
	});

	it('公式以外・別の人物・別の作品を指す本文や図書カードは、通信する前に拒む', async () => {
		const w = work(1);
		const bad: CatalogWork[] = [
			{
				...w,
				xhtml: { ...w.xhtml!, url: `${origin}/cards/000879/files/1.html` }
			},
			{
				...w,
				xhtml: {
					...w.xhtml!,
					url: 'https://example.com/cards/000879/files/1.html'
				}
			},
			{
				...w,
				xhtml: { ...w.xhtml!, url: `${OFFICIAL}/cards/000999/files/1.html` }
			},
			{
				...w,
				xhtml: { ...w.xhtml!, url: `${OFFICIAL}/cards/000879/files/2.html` }
			},
			{
				...w,
				text: { ...w.text!, url: `${OFFICIAL}/cards/000879/files/1.html` }
			},
			{ ...w, xhtml: { ...w.xhtml!, encoding: 'EUC-JP' as 'UTF-8' } },
			{ ...w, xhtml: { ...w.xhtml!, updated: '2025-02-31' } },
			{ ...w, cardUrl: 'https://example.com/cards/000879/card1.html' },
			{ ...w, cardUrl: `${OFFICIAL}/cards/000879/card2.html` },
			{ ...w, people: [{ id: '000999', role: 'author', name: '別人' }] },
			{
				...w,
				workCopyright: 'あり',
				xhtml: { ...w.xhtml!, url: `${origin}/x.html` }
			}
		];
		for (const [i, one] of bad.entries())
			await expect(run('r1', [one]), String(i)).rejects.toThrow();
		expect(hits).toEqual([]);
		expect(await readdir(root)).toEqual([]);
	});

	it('作業者が予期しない失敗をしたら、ほかの作業者を止めて終わるのを待ってから、失敗を返す', async () => {
		const works = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => work(n));
		for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) serveXhtml(n);
		delay = 30;
		// 作品1の記録の置き場所を、ファイルを置けないものにして、読み書きを失敗させる。
		await mkdir(join(root, 'runs', 'r1', 'records', '000001.json'), {
			recursive: true
		});
		await expect(run('r1', works, { concurrency: 2 })).rejects.toThrow();
		const settled = hits.length;
		await new Promise((r) => setTimeout(r, 200));
		// 返ったあとに、裏で取得が続いていない。残りの作品は、取りに行っていない。
		expect(hits.length).toBe(settled);
		expect(settled).toBeLessThanOrEqual(2);
	});

	it('先の経路が今回は別の理由で失敗しても、引き継いだ作品には、今回の失敗の理由を残す', async () => {
		serveXhtml(1, '<marquee>流れる</marquee>');
		serveText(1);
		await run('r1', [work(1)]);
		await commitRun(root, 'r1');
		const [before] = (await manifest('r1')).records;
		expect(before).toMatchObject({
			attempts: [{ code: expect.stringMatching(/^convert-/) }]
		});

		routes.delete(htmlPath(1));
		hits = [];
		const r = await run('r2', [work(1)]);
		expect(r.stats.catalogUnchanged).toBe(1);
		expect(hits).toEqual([htmlPath(1)]);
		const [after] = (await manifest('r2')).records;
		expect(after).toMatchObject({
			status: 'converted',
			attempts: [{ path: 'xhtml', code: 'fetch-status' }]
		});
		expect(conv(after).workSha256).toBe(conv(before).workSha256);
	});

	it('同じ実行を2回終えようとしたり、使えない runId は、拒む', async () => {
		serveXhtml(1);
		await run('r1', [work(1)]);
		await expect(run('r1', [work(1)])).rejects.toThrow();
		for (const bad of [
			'../x',
			'..',
			'.',
			'.hidden',
			'a/b',
			'',
			'x'.repeat(65)
		]) {
			await expect(run(bad, [work(1)]), bad).rejects.toThrow();
			await expect(commitRun(root, bad), bad).rejects.toThrow(CommitRefused);
		}
		// 作業領域の外へも、作業領域の直下へも、何も書かれていない。
		expect((await readdir(root)).sort()).toEqual(['raw', 'runs']);
		expect(await readdir(join(root, 'runs'))).toEqual(['r1']);
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

	it('入力（目録の項目・変換器）が変わっていれば、止めた実行を再開せずに断る', async () => {
		serveXhtml(1);
		serveXhtml(2);
		const works = [work(1), work(2)];
		const stop = new AbortController();
		onHit = (_, count) => count === 1 && stop.abort();
		await run('r1', works, { signal: stop.signal });
		hits = [];

		// 目録の題名が直った。
		await expect(
			run('r1', [work(1, { title: '直した題名' }), works[1]])
		).rejects.toThrow(/別の入力/);
		// 変換器のバージョンが違う実行として始めていた。
		const file = join(root, 'runs', 'r1', 'run.json');
		await writeFile(file, JSON.stringify({ key: '0'.repeat(64) }));
		await expect(run('r1', works)).rejects.toThrow(/別の入力/);
		expect(hits).toEqual([]);
		// 同じ入力なら、再開できる（取得対象の並びが違っても同じ）。
		await rm(file);
		const ok = await run('r1', [...works].reverse());
		expect(ok.complete).toBe(true);
	});

	it('取り直しの指定が違う再開は、記録を飛ばして取り直しを取りこぼさないよう、断る', async () => {
		serveXhtml(1, '本文です。<br />', '"v1"');
		serveXhtml(2);
		const works = [work(1), work(2)];
		const stop = new AbortController();
		onHit = (_, count) => count === 1 && stop.abort();
		await run('r1', works, { signal: stop.signal });
		await expect(run('r1', works, { revalidate: true })).rejects.toThrow(
			/別の入力/
		);
		expect((await run('r1', works)).complete).toBe(true);
	});

	it('再開の間に別の実行が確定しても、始めたときの current を土台にし続ける', async () => {
		serveXhtml(1);
		serveXhtml(2);
		const works = [work(1), work(2)];
		await run('r0', works);
		await commitRun(root, 'r0');

		// r1 は、r0 を土台にして始めたが、1件も進まないまま止まった。
		const stop = new AbortController();
		stop.abort();
		await run('r1', works, { signal: stop.signal });

		// その間に、別の入力で r9 が確定した。
		await run('r9', [works[0], work(2, { title: '別の題名' })]);
		await commitRun(root, 'r9');
		hits = [];

		const r = await run('r1', works);
		expect(r.stats).toMatchObject({ catalogUnchanged: 2, requests: 0 });
		expect(hits).toEqual([]);
		const started = JSON.parse(
			await readFile(join(root, 'runs', 'r1', 'run.json'), 'utf-8')
		);
		expect(started.previous).toBe('r0');
	});

	it('止めた実行の作品のファイルが無い・記録と合わない・記録が別の作品のものなら、飛ばさずに作り直す', async () => {
		serveXhtml(1);
		serveXhtml(2);
		serveXhtml(3);
		const works = [work(1), work(2), work(3)];
		await run('r1', works);
		// 全部終えた実行から manifest だけ消して、途中で止まった実行に見せかける。
		const dir = (...rest: string[]) => join(root, 'runs', 'r1', ...rest);
		await rm(dir('manifest.json'));
		await rm(dir('works', '000001.json'));
		await writeFile(dir('works', '000002.json'), '{}');
		await writeFile(
			dir('records', '000003.json'),
			await readFile(dir('records', '000002.json'), 'utf-8')
		);
		hits = [];
		const r = await run('r1', works);
		expect(r.stats.resumed).toBe(0);
		expect(hits.sort()).toEqual([htmlPath(1), htmlPath(2), htmlPath(3)]);
		await commitRun(root, 'r1');
		expect(await readCurrent(root)).toBe('r1');
	});

	it('止めた実行の run.json が壊れていて、土台の指定が欠けている・型が違うときは、土台なしとして読まず、再開を断る', async () => {
		serveXhtml(1);
		serveXhtml(2);
		const works = [work(1), work(2)];
		await run('r0', works);
		await commitRun(root, 'r0');
		const stop = new AbortController();
		// 1件も進まないうちに止めた実行。
		stop.abort();
		await run('r1', works, { signal: stop.signal });
		const file = join(root, 'runs', 'r1', 'run.json');
		const saved = JSON.parse(await readFile(file, 'utf-8'));
		expect(saved.previous).toBe('r0');

		for (const broken of [
			{ key: saved.key },
			{ key: saved.key, previous: 7 },
			{ key: saved.key, previous: '../x' },
			{ key: saved.key, previous: undefined },
			[saved.key]
		]) {
			await writeFile(file, JSON.stringify(broken));
			await expect(run('r1', works), JSON.stringify(broken)).rejects.toThrow(
				/別の入力/
			);
		}
		// 土台なし（明示した null）で始めた実行は、そのまま再開できる。
		await writeFile(file, JSON.stringify({ key: saved.key, previous: null }));
		expect((await run('r1', works)).complete).toBe(true);
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

	it('更新日だけが進み、本文が同じなら、本文は受け取らず、来歴だけ新しい更新日で作り直す', async () => {
		await setup();
		const bumped = [
			work(1, {}, '2020-02-02'),
			work(2, { xhtml: undefined }, '2020-02-02')
		];
		const r = await run('r2', bumped);
		expect(r.stats).toMatchObject({ notModified: 2, fetched: 0 });
		const m = await manifest('r2');
		expect(m.records.map((x) => conv(x).source.catalogUpdated)).toEqual([
			'2020-02-02',
			'2020-02-02'
		]);
		const json = await readFile(
			join(root, 'runs', 'r2', 'works', '000001.json'),
			'utf-8'
		);
		const parsed = readWork(json);
		expect(parsed.ok && parsed.work.provenance.source.upstreamUpdated).toBe(
			'2020-02-02'
		);
	});

	it('目録の題名などが直ったら、本文と更新日が同じでも、引き継がずに作り直す', async () => {
		await setup();
		const fixed = [work(1, { title: '直した題名' }), works[1]];
		for (const revalidate of [false, true]) {
			const r = await run(revalidate ? 'r3' : 'r2', fixed, { revalidate });
			// 作品1は検証子つきで確かめる（本文は受け取らない）。作品2は変わっていないので引き継ぐ。
			expect(r.stats).toMatchObject({ notModified: revalidate ? 2 : 1 });
			const json = await readFile(
				join(root, 'runs', revalidate ? 'r3' : 'r2', 'works', '000001.json'),
				'utf-8'
			);
			const parsed = readWork(json);
			expect(parsed.ok && parsed.work.title).toBe('直した題名');
		}
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
		const r = await run('r2', [work(1)], { revalidate: true });
		expect(r.stats).toMatchObject({ fetched: 1, contentUnchanged: 1 });
		expect(
			await readFile(join(root, 'runs', 'r2', 'works', '000001.json'), 'utf-8')
		).toBe(
			await readFile(join(root, 'runs', 'r1', 'works', '000001.json'), 'utf-8')
		);
	});

	it('目録の符号化方式だけが直ったときも、同じ本文を引き継がず、読み直す', async () => {
		serveXhtml(1, '本文です。<br />', '"v1"');
		await run('r1', [work(1)]);
		await commitRun(root, 'r1');
		hits = [];
		// 符号化方式の申告が変わった。本文のバイト列は同じで、読み方が変わる。
		const w = work(1);
		const fixed = {
			...w,
			xhtml: { ...w.xhtml!, encoding: 'ShiftJIS' as const }
		};
		for (const revalidate of [false, true]) {
			const r = await run(revalidate ? 'r3' : 'r2', [fixed], { revalidate });
			expect(r.stats.catalogUnchanged).toBe(0);
			// UTF-8 の本文を Shift_JIS として読むので、読み方が反映され、記録は変わる。
			const rec = (await manifest(revalidate ? 'r3' : 'r2')).records[0];
			expect(rec).not.toEqual((await manifest('r1')).records[0]);
		}
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

	it('失敗の割合の上限に NaN や範囲外の値を渡すと、確定せず、current も変えない', async () => {
		serveXhtml(1);
		await run('r1', [work(1)]);
		await commitRun(root, 'r1');
		await run('r2', [work(2)]);
		for (const maxFailureRatio of [Number.NaN, -0.1, 1.5])
			await expect(commitRun(root, 'r2', { maxFailureRatio })).rejects.toThrow(
				RangeError
			);
		expect(await readCurrent(root)).toBe('r1');
	});

	it('作品のファイルが無い・記録と合わない、manifest が壊れた実行は、確定を拒まれ、current は変わらない', async () => {
		serveXhtml(1);
		serveXhtml(2);
		const works = [work(1), work(2)];
		await run('good', works);
		await commitRun(root, 'good');

		const dir = (id: string, ...rest: string[]) =>
			join(root, 'runs', id, ...rest);
		const edit = async (id: string, change: (m: Manifest) => void) => {
			const m = JSON.parse(await readFile(dir(id, 'manifest.json'), 'utf-8'));
			change(m);
			await writeFile(dir(id, 'manifest.json'), JSON.stringify(m));
		};
		const check = async (id: string, spoil: () => Promise<void>) => {
			await run(id, works);
			await spoil();
			await expect(commitRun(root, id), id).rejects.toThrow(CommitRefused);
			expect(await readCurrent(root)).toBe('good');
		};
		await check('missing', () => rm(dir('missing', 'works', '000001.json')));
		await check('altered', () =>
			writeFile(dir('altered', 'works', '000002.json'), '{}')
		);
		await check('counts', () => edit('counts', (m) => (m.counts.failed = 5)));
		await check('garbled', () =>
			writeFile(dir('garbled', 'manifest.json'), '{"schemaVersion":1')
		);
		await check('badrecord', () =>
			edit('badrecord', (m) => {
				// 記録の必須の項目が欠けている。
				delete (m.records[0] as Partial<WorkRecord>).id;
			})
		);
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
