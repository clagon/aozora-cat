// 作品が参照する画像の取得と検証。取得した本文と同じく、内容の名前（raw/<sha256>）で控えを残し、
// 前回の検証子があれば条件付きで取得する。形式を確かめた画像だけを、アセットへ渡す。

import { join } from 'node:path';
import type { AssetImage } from '../../../src/lib/domain/asset.ts';
import {
	assertFetchOptions,
	FetchError,
	fetchResource,
	type FetchOptions
} from './download.ts';
import { readOptional, sha256, writeAtomic } from './store.ts';
import { MAX_IMAGE_BYTES, sniffImage } from './sniff.ts';
import { assertPacing, createLimiter } from './time.ts';

export {
	MAX_IMAGE_BYTES,
	MAX_IMAGE_PIXELS,
	sniffImage,
	type Sniffed
} from './sniff.ts';

/** 取り込める画像のURL。公式の外字（/gaiji/）と、作品の files ディレクトリ。 */
const IMAGE_URL =
	/^https:\/\/www\.aozora\.gr\.jp\/(?:gaiji\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*|cards\/\d{6}\/files\/[A-Za-z0-9_.-]+)\.(?:png|jpe?g|gif)$/;

export type LoadedImage = AssetImage & { sha256: string; byteLength: number };
export type ImageResult =
	| { ok: true; image: LoadedImage }
	| { ok: false; code: string; message: string };

export type ImageLoaderOptions = {
	/** 作業領域（.corpus/）。 */
	root: string;
	fetchOptions?: Partial<FetchOptions>;
	/** 通信を始める前に待つ処理（取得の間隔を、本文の取得と共有する）。 */
	waitTurn?: () => Promise<void>;
	/** 同時に通信する数の上限（作品をまたいで共通）。既定は 4。 */
	concurrency?: number;
	/** 控えがあっても、検証子つきで取得し直す。 */
	revalidate?: boolean;
};

type Meta = {
	url: string;
	sha256: string;
	etag?: string;
	lastModified?: string;
};

const parseMeta = (text: string, url: string): Meta | null => {
	try {
		const v: unknown = JSON.parse(text);
		if (typeof v !== 'object' || v === null) return null;
		const {
			url: u,
			sha256: h,
			etag,
			lastModified
		} = v as Record<string, unknown>;
		if (u !== url || typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h))
			return null;
		return {
			url,
			sha256: h,
			...(typeof etag === 'string' && { etag }),
			...(typeof lastModified === 'string' && { lastModified })
		};
	} catch {
		return null;
	}
};

const toLoaded = (bytes: Uint8Array, hash: string): ImageResult => {
	const s = sniffImage(bytes);
	if (!s)
		return {
			ok: false,
			code: 'invalid-image',
			message: '画像として読めない・壊れている・大きすぎます'
		};
	return {
		ok: true,
		image: {
			...s,
			data: Buffer.from(bytes).toString('base64'),
			sha256: hash,
			byteLength: bytes.length
		}
	};
};

/** 画像を取得して検証する。同じURLは、実行のあいだ、1回だけ取得する。 */
export class ImageLoader {
	#memo = new Map<string, Promise<ImageResult>>();
	#opts: ImageLoaderOptions;
	#limit: ReturnType<typeof createLimiter>;
	constructor(opts: ImageLoaderOptions) {
		assertFetchOptions(opts.fetchOptions ?? {});
		assertPacing(opts.concurrency ?? 4, 0);
		this.#opts = opts;
		this.#limit = createLimiter(opts.concurrency ?? 4);
	}

	load(url: string): Promise<ImageResult> {
		let p = this.#memo.get(url);
		if (!p) {
			p = this.#fetchOne(url);
			this.#memo.set(url, p);
		}
		return p;
	}

	async #fetchOne(url: string): Promise<ImageResult> {
		if (!IMAGE_URL.test(url))
			return {
				ok: false,
				code: 'invalid-url',
				message: '取り込める画像のURLではありません'
			};
		const { root } = this.#opts;
		const metaPath = join(root, 'images', `${sha256(url)}.json`);
		const text = await readOptional(metaPath);
		const meta = text === null ? null : parseMeta(text.toString('utf-8'), url);
		let cached: Uint8Array | null = null;
		if (meta) {
			const raw = await readOptional(join(root, 'raw', meta.sha256));
			if (raw !== null && sha256(raw) === meta.sha256) cached = raw;
		}
		if (cached && meta && !this.#opts.revalidate) {
			const r = toLoaded(cached, meta.sha256);
			if (r.ok) return r;
		}

		let got;
		try {
			// 通信している間だけ、同時に走る数を抑える（間隔の待ちは、始める時刻をそろえるだけ）。
			got = await this.#limit(() =>
				fetchResource(url, {
					...this.#opts.fetchOptions,
					maxBytes: MAX_IMAGE_BYTES,
					beforeAttempt: this.#opts.waitTurn,
					...(meta &&
						cached && { etag: meta.etag, lastModified: meta.lastModified })
				})
			);
		} catch (e) {
			if (!(e instanceof FetchError)) throw e;
			return { ok: false, code: `fetch-${e.code}`, message: e.message };
		}
		if (got.status === 'not-modified') {
			if (!cached || !meta)
				return {
					ok: false,
					code: 'fetch-status',
					message: '条件なしの取得に 304 が返りました'
				};
			return toLoaded(cached, meta.sha256);
		}
		const hash = sha256(got.bytes);
		const result = toLoaded(got.bytes, hash);
		// 読めた画像だけ、控えとして残す。
		if (result.ok) {
			await writeAtomic(join(root, 'raw', hash), got.bytes);
			await writeAtomic(
				metaPath,
				`${JSON.stringify({
					url,
					sha256: hash,
					...(got.etag !== undefined && { etag: got.etag }),
					...(got.lastModified !== undefined && {
						lastModified: got.lastModified
					})
				})}\n`
			);
		}
		return result;
	}
}
