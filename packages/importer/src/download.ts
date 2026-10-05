// 公式サイトからの取得。時間・大きさ・再試行を制限し、公式のサイトへ負荷をかけすぎない。
// 取得の関数は差し替えられる（テストは手元のサーバーだけを相手にする）。

import { parseCatalog } from './catalog.ts';
import { MAX_TIMER_MS, sleep } from './time.ts';
import { readZip } from './zip.ts';
import type { ParsedCatalog } from './types.ts';

export const CATALOG_URL =
	'https://www.aozora.gr.jp/index_pages/list_person_all_extended_utf8.zip';
const USER_AGENT =
	'aozora-cat-importer (+https://github.com/clagon/aozora-cat)';

export class FetchError extends Error {
	code: 'timeout' | 'status' | 'too-large' | 'network';
	constructor(code: FetchError['code'], message: string) {
		super(message);
		this.code = code;
	}
}

export type FetchOptions = {
	/** 本文の最大バイト数。超えたら読むのをやめる。 */
	maxBytes: number;
	timeoutMs?: number;
	/** 失敗したときの追加の試行回数。 */
	retries?: number;
	/** 1回目の待ち時間。以降は倍にする。 */
	retryDelayMs?: number;
	/** 再試行を含めた、通信を始める前に毎回待つ処理。取得の間隔を守るために使う。 */
	beforeAttempt?: () => Promise<void>;
	fetch?: typeof fetch;
};

/**
 * 数値の設定を確かめる。NaN や負の値だと、大きさ・時間・回数の比較がすべて偽になり、
 * 上限や待ちが働かなくなる（公式サイトへ続けざまに通信するなど）ので、通信の前に断る。
 * maxBytes の Infinity は許す（呼び出し側で上限に丸める）。時間は、タイマーの上限（約24.8日）まで。
 */
export function assertFetchOptions(
	o: Partial<
		Pick<FetchOptions, 'maxBytes' | 'timeoutMs' | 'retries' | 'retryDelayMs'>
	>
): void {
	const bad = (name: string, v: unknown): never => {
		throw new RangeError(`${name} が使えません: ${String(v)}`);
	};
	const { maxBytes, timeoutMs, retries, retryDelayMs } = o;
	if (maxBytes !== undefined && !(maxBytes >= 0)) bad('maxBytes', maxBytes);
	if (timeoutMs !== undefined && !(timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS))
		bad('timeoutMs', timeoutMs);
	if (
		retries !== undefined &&
		!(Number.isInteger(retries) && retries >= 0 && retries <= 10)
	)
		bad('retries', retries);
	if (
		retryDelayMs !== undefined &&
		!(retryDelayMs >= 0 && retryDelayMs <= MAX_TIMER_MS)
	)
		bad('retryDelayMs', retryDelayMs);
}

/** 前回の応答の検証子。あれば条件付きで取得し、変わっていなければ本文を受け取らない。 */
export type Validators = { etag?: string; lastModified?: string };

export type Fetched =
	| { status: 'not-modified' }
	| ({ status: 'ok'; bytes: Uint8Array } & Validators);

/** 429・5xx・通信の失敗・時間切れだけを再試行する。ほかの4xxや、大きすぎる応答は再試行しない。 */
export async function fetchResource(
	url: string,
	{
		maxBytes,
		timeoutMs = 30_000,
		retries = 2,
		retryDelayMs = 1000,
		fetch: doFetch = fetch,
		beforeAttempt,
		etag,
		lastModified
	}: FetchOptions & Validators
): Promise<Fetched> {
	assertFetchOptions({ maxBytes, timeoutMs, retries, retryDelayMs });
	let last: FetchError | undefined;
	for (let attempt = 0; attempt <= retries; attempt++) {
		if (attempt > 0) await sleep(retryDelayMs * 2 ** (attempt - 1));
		await beforeAttempt?.();
		try {
			return await once(url, doFetch, maxBytes, timeoutMs, {
				etag,
				lastModified
			});
		} catch (e) {
			if (!(e instanceof FetchError)) throw e;
			last = e;
			if (e.code === 'too-large') break;
			if (e.code === 'status' && !/ (429|5\d\d)$/.test(e.message)) break;
		}
	}
	throw last ?? new FetchError('network', '取得できませんでした');
}

export async function fetchBytes(
	url: string,
	options: FetchOptions
): Promise<Uint8Array> {
	const got = await fetchResource(url, options);
	if (got.status !== 'ok')
		throw new FetchError('status', `${url} が条件なしで 304`);
	return got.bytes;
}

async function once(
	url: string,
	doFetch: typeof fetch,
	maxBytes: number,
	timeoutMs: number,
	{ etag, lastModified }: Validators
): Promise<Fetched> {
	const signal = AbortSignal.timeout(timeoutMs);
	const conditional = etag !== undefined || lastModified !== undefined;
	try {
		// 転送先を自動でたどらない。公式が移したときは、気づけるよう失敗にする。
		const res = await doFetch(url, {
			signal,
			redirect: 'error',
			headers: {
				'user-agent': USER_AGENT,
				...(etag !== undefined && { 'if-none-match': etag }),
				...(lastModified !== undefined && {
					'if-modified-since': lastModified
				})
			}
		});
		if (res.status === 304 && conditional) {
			void res.body?.cancel();
			return { status: 'not-modified' };
		}
		if (!res.ok) throw new FetchError('status', `${url} が ${res.status}`);
		const declared = Number(res.headers.get('content-length'));
		if (declared > maxBytes)
			throw new FetchError('too-large', `${url} が大きすぎます（${declared}）`);
		const chunks: Uint8Array[] = [];
		let total = 0;
		const reader = res.body?.getReader();
		for (;;) {
			const part = await reader?.read();
			if (!part || part.done) break;
			total += part.value.length;
			if (total > maxBytes) {
				void reader?.cancel();
				throw new FetchError('too-large', `${url} が大きすぎます`);
			}
			chunks.push(part.value);
		}
		const bytes = new Uint8Array(total);
		let at = 0;
		for (const c of chunks) (bytes.set(c, at), (at += c.length));
		return {
			status: 'ok',
			bytes,
			...(res.headers.get('etag') && {
				etag: res.headers.get('etag') as string
			}),
			...(res.headers.get('last-modified') && {
				lastModified: res.headers.get('last-modified') as string
			})
		};
	} catch (e) {
		if (e instanceof FetchError) throw e;
		if (signal.aborted)
			throw new FetchError(
				'timeout',
				`${url} が ${timeoutMs}ms で応答しません`
			);
		throw new FetchError('network', `${url} を取得できません`);
	}
}

const CATALOG_LIMITS = { download: 32 * 2 ** 20, csv: 128 * 2 ** 20 };

/** 公式のCSV（zip）を取得し、zip と CSV の中身を確かめてから読む。 */
export async function fetchCatalog(
	options: Partial<FetchOptions> & { url?: string } = {}
): Promise<ParsedCatalog> {
	const { url = CATALOG_URL, ...rest } = options;
	const zip = await fetchBytes(url, {
		maxBytes: CATALOG_LIMITS.download,
		...rest
	});
	const entries = readZip(zip, {
		maxEntryBytes: CATALOG_LIMITS.csv,
		maxEntries: 1
	});
	const names = [...entries.keys()].filter((n) => n.endsWith('.csv'));
	if (entries.size !== 1 || names.length !== 1)
		throw new FetchError('status', 'zip の中身が、CSV 1つではありません');
	const csv = new TextDecoder('utf-8', { fatal: true }).decode(
		entries.get(names[0])
	);
	return parseCatalog(csv);
}
