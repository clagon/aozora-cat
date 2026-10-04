import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { FetchError, fetchBytes, fetchCatalog } from './download.ts';

type Handler = Parameters<typeof createServer>[1];
let server: Server | undefined;
const seen: IncomingMessage[] = [];

/** 手元のサーバーだけを相手にする。公式サイトへは通信しない。 */
async function serve(handler: NonNullable<Handler>): Promise<string> {
	server = createServer((req, res) => {
		seen.push(req);
		handler(req, res);
	});
	await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`;
}

async function stop() {
	const s = server;
	server = undefined;
	if (!s) return;
	s.closeAllConnections();
	await new Promise((r) => s.close(r));
}

afterEach(async () => {
	seen.length = 0;
	await stop();
});

const fast = { retryDelayMs: 1, timeoutMs: 2000 };
const fails = async (p: Promise<unknown>) => {
	try {
		await p;
	} catch (e) {
		return e instanceof FetchError ? e.code : 'other';
	}
	return 'ok';
};

describe('fetchBytes', () => {
	it('本文を読み、自分が何者かを User-Agent で名乗る', async () => {
		const url = await serve((_, res) => res.end('hello'));
		expect(
			new TextDecoder().decode(
				await fetchBytes(url, { maxBytes: 100, ...fast })
			)
		).toBe('hello');
		expect(seen[0].headers['user-agent']).toContain('aozora-cat');
	});

	it('503 は再試行して成功し、404 は再試行しない', async () => {
		let n = 0;
		const url = await serve((_, res) => {
			if (++n < 3) return void res.writeHead(503).end();
			res.end('ok');
		});
		await fetchBytes(url, { maxBytes: 100, retries: 2, ...fast });
		expect(n).toBe(3);

		n = 0;
		const gone = await serve((_, res) => (n++, res.writeHead(404).end()));
		expect(
			await fails(fetchBytes(gone, { maxBytes: 100, retries: 2, ...fast }))
		).toBe('status');
		expect(n).toBe(1);
	});

	it('再試行を使い切れば、最後の失敗を返す', async () => {
		let n = 0;
		const url = await serve((_, res) => (n++, res.writeHead(500).end()));
		expect(
			await fails(fetchBytes(url, { maxBytes: 100, retries: 1, ...fast }))
		).toBe('status');
		expect(n).toBe(2);
	});

	it('応答がなければ時間切れにし、再試行する', async () => {
		let n = 0;
		const url = await serve(() => void n++);
		expect(
			await fails(
				fetchBytes(url, {
					maxBytes: 100,
					retries: 1,
					retryDelayMs: 1,
					timeoutMs: 50
				})
			)
		).toBe('timeout');
		expect(n).toBe(2);
	});

	it('大きすぎる応答は、申告があっても、なくても、再試行せずに止める', async () => {
		let n = 0;
		const url = await serve((_, res) => (n++, res.end('x'.repeat(200))));
		expect(
			await fails(fetchBytes(url, { maxBytes: 100, retries: 2, ...fast }))
		).toBe('too-large');
		expect(n).toBe(1);

		const chunked = await serve((_, res) => {
			res.write('x'.repeat(80));
			setTimeout(() => res.end('x'.repeat(80)), 5);
		});
		expect(
			await fails(fetchBytes(chunked, { maxBytes: 100, retries: 0, ...fast }))
		).toBe('too-large');
	});

	it('転送先をたどらず、失敗にする', async () => {
		const url = await serve((req, res) => {
			if (req.url === '/y') return void res.end('moved');
			res.writeHead(302, { location: '/y' }).end();
		});
		expect(
			await fails(fetchBytes(url, { maxBytes: 100, retries: 0, ...fast }))
		).toBe('network');
		expect(seen.map((r) => r.url)).toEqual(['/x']);
	});

	it('つながらない相手は network として失敗にする', async () => {
		expect(
			await fails(
				fetchBytes('http://127.0.0.1:1/', {
					maxBytes: 100,
					retries: 0,
					...fast
				})
			)
		).toBe('network');
	});
});

/** CSV 1つだけのzip。 */
function zipOf(entries: [string, string][]): Buffer {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const [n, data] of entries) {
		const raw = Buffer.from(data);
		const packed = deflateRawSync(raw);
		const name = Buffer.from(n);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(crc32(raw), 14);
		local.writeUInt32LE(packed.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		const head = Buffer.alloc(46);
		head.writeUInt32LE(0x02014b50, 0);
		head.writeUInt16LE(8, 10);
		head.writeUInt32LE(crc32(raw), 16);
		head.writeUInt32LE(packed.length, 20);
		head.writeUInt32LE(raw.length, 24);
		head.writeUInt16LE(name.length, 28);
		head.writeUInt32LE(offset, 42);
		parts.push(local, name, packed);
		central.push(head, name);
		offset += 30 + name.length + packed.length;
	}
	const dir = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(dir.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, dir, end]);
}

describe('fetchCatalog', () => {
	const header =
		'作品ID,作品名,作品名読み,ソート用読み,副題,副題読み,原題,初出,分類番号,文字遣い種別,作品著作権フラグ,公開日,最終更新日,図書カードURL,人物ID,姓,名,姓読み,名読み,役割フラグ,人物著作権フラグ,テキストファイルURL,テキストファイル最終更新日,テキストファイル符号化方式,XHTML/HTMLファイルURL,XHTML/HTMLファイル最終更新日,XHTML/HTMLファイル符号化方式';
	const row =
		'"000092","蜘蛛の糸","くものいと","くものいと","","","","","NDC 913","新字新仮名","なし",2000-01-01,2014-09-17,"https://www.aozora.gr.jp/cards/000879/card92.html","000879","芥川","竜之介","あくたがわ","りゅうのすけ","著者","なし","https://www.aozora.gr.jp/cards/000879/files/92_ruby_164.zip",2014-09-17,"ShiftJIS","https://www.aozora.gr.jp/cards/000879/files/92_14545.html",2014-09-17,"ShiftJIS"';

	it('zip を取得して、BOM 付きの CSV を目録にする', async () => {
		const body = zipOf([['list.csv', `﻿${header}\n${row}\n`]]);
		const url = await serve((_, res) => res.end(body));
		const c = await fetchCatalog({ url, ...fast });
		expect(c.works.map((w) => w.title)).toEqual(['蜘蛛の糸']);
	});

	it('zip でない応答、CSV が1つでない zip、UTF-8 でない CSV は、目録にせず失敗にする', async () => {
		for (const body of [
			Buffer.from('<html>メンテナンス中</html>'),
			zipOf([
				['a.csv', header],
				['b.csv', header]
			]),
			zipOf([['a.txt', header]]),
			zipOf([['a.csv', header]]).fill(0xff, 40, 60)
		]) {
			const url = await serve((_, res) => res.end(body));
			expect(
				await fails(fetchCatalog({ url, ...fast })),
				String(body.length)
			).not.toBe('ok');
			await stop();
		}
	});
});
