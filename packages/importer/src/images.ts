// 作品が参照する画像の取得と検証。取得した本文と同じく、内容の名前（raw/<sha256>）で控えを残し、
// 前回の検証子があれば条件付きで取得する。形式を確かめた画像だけを、アセットへ渡す。

import { join } from 'node:path';
import type { AssetImage, ImageMime } from '../../../src/lib/domain/asset.ts';
import { MAX_IMAGE_SIDE } from '../../../src/lib/domain/work.ts';
import {
	assertFetchOptions,
	FetchError,
	fetchResource,
	type FetchOptions
} from './download.ts';
import { readOptional, sha256, writeAtomic } from './store.ts';

/** 1枚の大きさの上限（バイト）と、画素数の上限。端末で展開するときの負荷を抑える。 */
export const MAX_IMAGE_BYTES = 8 * 2 ** 20;
export const MAX_IMAGE_PIXELS = 40_000_000;

export type Sniffed = { mime: ImageMime; width: number; height: number };

const u16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u32 = (b: Uint8Array, at: number) =>
	((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const startsWith = (b: Uint8Array, sig: number[]) =>
	sig.every((x, i) => b[i] === x);

/**
 * 画像の形式と大きさを、中身から読む。拡張子や応答の種類は信用しない。読めない・壊れている・
 * 大きすぎるものは null。PNG・JPEG・GIF だけを扱い、ヘッダーと終わりの印を確かめる。
 */
export function sniffImage(b: Uint8Array): Sniffed | null {
	let found: Sniffed | null = null;
	if (b.length > MAX_IMAGE_BYTES) return null;
	if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
		// 先頭の IHDR（13バイト）と、末尾の IEND。
		const iend = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
		if (
			b.length >= 8 + 25 + 12 &&
			u32(b, 8) === 13 &&
			startsWith(b.subarray(12), [0x49, 0x48, 0x44, 0x52]) &&
			iend.every((x, i) => b[b.length - 12 + i] === x)
		)
			found = { mime: 'image/png', width: u32(b, 16), height: u32(b, 20) };
	} else if (
		startsWith(b, [0x47, 0x49, 0x46, 0x38]) &&
		(b[4] === 0x37 || b[4] === 0x39) &&
		b[5] === 0x61
	) {
		if (b.length >= 14 && b[b.length - 1] === 0x3b)
			found = {
				mime: 'image/gif',
				width: b[6] | (b[7] << 8),
				height: b[8] | (b[9] << 8)
			};
	} else if (startsWith(b, [0xff, 0xd8, 0xff])) {
		// セグメントをたどって、SOF（大きさ）を探す。SOS（画像データ）より前にあること。
		let i = 2;
		while (i + 4 <= b.length && found === null) {
			if (b[i] !== 0xff) break;
			const m = b[i + 1];
			if (m === 0xff) {
				i += 1;
				continue;
			}
			if (m === 0xd9 || m === 0xda) break;
			if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
				i += 2;
				continue;
			}
			const len = u16(b, i + 2);
			if (len < 2 || i + 2 + len > b.length) break;
			if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
				if (len >= 8)
					found = {
						mime: 'image/jpeg',
						width: u16(b, i + 7),
						height: u16(b, i + 5)
					};
				break;
			}
			i += 2 + len;
		}
		if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return null;
	}
	if (
		found === null ||
		found.width < 1 ||
		found.height < 1 ||
		found.width > MAX_IMAGE_SIDE ||
		found.height > MAX_IMAGE_SIDE ||
		found.width * found.height > MAX_IMAGE_PIXELS
	)
		return null;
	return found;
}

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
	constructor(opts: ImageLoaderOptions) {
		assertFetchOptions(opts.fetchOptions ?? {});
		this.#opts = opts;
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
			got = await fetchResource(url, {
				...this.#opts.fetchOptions,
				maxBytes: MAX_IMAGE_BYTES,
				beforeAttempt: this.#opts.waitTurn,
				...(meta &&
					cached && { etag: meta.etag, lastModified: meta.lastModified })
			});
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
