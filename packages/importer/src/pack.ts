// 作品1つを、配信用の圧縮アセットにする。作品の意味と、検証した画像を1つのファイルにまとめる。
// 25MiB を超えるときだけ、画像を別のファイルに分ける（作品の本文は分けない）。

import { gzipSync } from 'node:zlib';
import { mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
	ASSET_FORMAT,
	MAX_IMAGE_PARTS,
	collectImageUrls,
	type AssetImage
} from '../../../src/lib/domain/asset.ts';
import { readWork, type Work } from '../../../src/lib/domain/work.ts';
import { assertFetchOptions, type FetchOptions } from './download.ts';
import { ImageLoader, type ImageResult, type LoadedImage } from './images.ts';
import { readOptional, acquireLock, sha256, writeAtomic } from './store.ts';
import { assertPacing, createGate } from './time.ts';
import { verifyRun, workFilePath } from './run.ts';

/** 1つの作品の画像の、生のバイト数の合計の上限。梱包のあいだ、メモリに持つ量を抑える。 */
export const MAX_WORK_IMAGE_BYTES = 32 * 2 ** 20;

/** Cloudflare の静的アセットの、1ファイルの上限。 */
export const MAX_FILE_BYTES = 25 * 2 ** 20;

export class PackError extends Error {
	code:
		'work-too-large' | 'image-too-large' | 'too-many-parts' | 'missing-image';
	constructor(code: PackError['code'], message: string) {
		super(message);
		this.code = code;
	}
}

/** 上限は、配信先の上限（25MiB）を超えられない。NaN や無限大、0以下も、比較を狂わせるので断る。 */
function assertMaxFileBytes(v: number | undefined): void {
	if (
		v !== undefined &&
		!(Number.isInteger(v) && v >= 1 && v <= MAX_FILE_BYTES)
	)
		throw new RangeError(`maxFileBytes が使えません: ${v}`);
}

export type PackFile = { path: string; bytes: Uint8Array };

const gzip = (value: unknown): Uint8Array =>
	new Uint8Array(gzipSync(JSON.stringify(value), { level: 9 }));

const strip = ({ mime, width, height, data }: AssetImage): AssetImage => ({
	mime,
	width,
	height,
	data
});

/**
 * 作品と画像から、書き出すファイルを作る（入出力なし）。画像は、作品が参照するものすべてが要る。
 * 1つのファイルに収まればそれだけ。収まらなければ、画像を別のファイルに分ける。
 */
export function packWork(
	work: Work,
	images: Map<string, AssetImage>,
	{ maxFileBytes = MAX_FILE_BYTES }: { maxFileBytes?: number } = {}
): PackFile[] {
	assertMaxFileBytes(maxFileBytes);
	const urls = collectImageUrls(work);
	for (const url of urls)
		if (!images.has(url))
			throw new PackError('missing-image', `画像がありません: ${url}`);
	const sorted = urls.map((url): [string, AssetImage] => [
		url,
		strip(images.get(url) as AssetImage)
	]);
	const path = `works/${work.id}.json.gz`;

	const whole = gzip({
		format: ASSET_FORMAT,
		work,
		images: Object.fromEntries(sorted),
		imageParts: []
	});
	if (whole.length <= maxFileBytes) return [{ path, bytes: whole }];

	// 画像を分ける。元の大きさ（base64 のJSON）が上限の9割に収まる組へ、順に詰める。圧縮すると小さくなる
	// ので、収まったあとに実際の大きさを確かめる。
	const budget = Math.floor(maxFileBytes * 0.9);
	const groups: [string, AssetImage][][] = [];
	let current: [string, AssetImage][] = [];
	let size = 0;
	for (const entry of sorted) {
		const bytes = JSON.stringify(entry).length + 1;
		if (bytes > budget)
			throw new PackError('image-too-large', `画像が大きすぎます: ${entry[0]}`);
		if (size + bytes > budget && current.length > 0) {
			groups.push(current);
			current = [];
			size = 0;
		}
		current.push(entry);
		size += bytes;
	}
	if (current.length > 0) groups.push(current);
	if (groups.length > MAX_IMAGE_PARTS)
		throw new PackError('too-many-parts', '画像の分け先が多すぎます');

	const partFiles = groups.map((group, i): PackFile => {
		const bytes = gzip({
			format: ASSET_FORMAT,
			images: Object.fromEntries(group)
		});
		if (bytes.length > maxFileBytes)
			throw new PackError(
				'image-too-large',
				'画像を分けても、上限に収まりません'
			);
		return { path: `works/${work.id}.images-${i + 1}.json.gz`, bytes };
	});
	const main = gzip({
		format: ASSET_FORMAT,
		work,
		images: {},
		imageParts: partFiles.map((f) => f.path)
	});
	if (main.length > maxFileBytes)
		throw new PackError(
			'work-too-large',
			'画像を分けても、作品の本文が上限に収まりません'
		);
	return [{ path, bytes: main }, ...partFiles];
}

export type PackedWork = {
	id: string;
	files: { path: string; bytes: number; sha256: string }[];
	images: number;
};
export type PackFailure = {
	id: string;
	code: string;
	message: string;
	url?: string;
};
export type PackResult = { packed: PackedWork[]; failed: PackFailure[] };

export type PackOptions = {
	/** 作業領域（.corpus/）。 */
	root: string;
	/** 梱包する実行。終わっていて、作品のファイルが記録と合っているもの。 */
	runId: string;
	/** 出力先。存在しないか、空であること。 */
	outDir: string;
	concurrency?: number;
	/** 画像の取得を始める間隔の下限。 */
	minIntervalMs?: number;
	revalidateImages?: boolean;
	/** 1つの作品の画像の合計（生のバイト数）の上限。既定は 32MiB。超える作品は失敗にする。 */
	maxWorkImageBytes?: number;
	maxFileBytes?: number;
	fetchOptions?: Partial<FetchOptions>;
};

/** 実行の作品を1つずつアセットにして、出力先の works/ へ書く。画像が使えない作品は、失敗として返す。 */
export async function packRun(options: PackOptions): Promise<PackResult> {
	const { root, runId, outDir, concurrency = 4, minIntervalMs = 100 } = options;
	assertPacing(concurrency, minIntervalMs);
	assertMaxFileBytes(options.maxFileBytes);
	if (
		options.maxWorkImageBytes !== undefined &&
		!(
			Number.isInteger(options.maxWorkImageBytes) &&
			options.maxWorkImageBytes >= 1
		)
	)
		throw new RangeError(
			`maxWorkImageBytes が使えません: ${options.maxWorkImageBytes}`
		);
	assertFetchOptions(options.fetchOptions ?? {});
	const manifest = await verifyRun(root, runId);

	await mkdir(outDir, { recursive: true });
	if ((await readdir(outDir)).length > 0)
		throw new Error(`出力先が空ではありません: ${outDir}`);
	const release = await acquireLock(join(outDir, '.pack.lock'));
	try {
		const loader = new ImageLoader({
			root,
			fetchOptions: options.fetchOptions,
			concurrency,
			waitTurn: createGate(minIntervalMs),
			revalidate: options.revalidateImages
		});
		const todo = manifest.records.filter((r) => r.status === 'converted');
		const results: (PackedWork | PackFailure)[] = [];
		let next = 0;
		const worker = async () => {
			for (;;) {
				const k = next++;
				if (k >= todo.length) return;
				results[k] = await packOne(todo[k].id, options, loader);
			}
		};
		const settled = await Promise.allSettled(
			Array.from({ length: concurrency }, () => {
				return worker().catch((e: unknown) => {
					next = todo.length;
					throw e;
				});
			})
		);
		const crashed = settled.find((r) => r.status === 'rejected');
		if (crashed) throw crashed.reason;
		return {
			packed: results.filter((r): r is PackedWork => 'files' in r),
			failed: results.filter((r): r is PackFailure => 'code' in r)
		};
	} finally {
		await release();
	}
}

async function packOne(
	id: string,
	options: PackOptions,
	loader: ImageLoader
): Promise<PackedWork | PackFailure> {
	const { root, runId, outDir } = options;
	const text = await readOptional(workFilePath(root, runId, id));
	const parsed = text === null ? null : readWork(text.toString('utf-8'));
	if (!parsed?.ok)
		return {
			id,
			code: 'work-unreadable',
			message: '作品のファイルが読めません'
		};
	const work = parsed.work;

	const urls = collectImageUrls(work);
	const budget = options.maxWorkImageBytes ?? MAX_WORK_IMAGE_BYTES;
	// 作品の画像は、読めた分だけを、合計が予算を超えない範囲で持つ。超えたら、新しい画像を取りに
	// 行かず、作品を失敗にする（画像の多い作品が、メモリを使い切らないように）。1つが予期しない
	// 失敗をしても、ほかの画像の取得が終わるのを待ってから、失敗を返す。先に返すと、取得と控えの
	// 書き込みが、packRun の完了（ロックの解放）のあとも、裏で続いてしまう。
	const results: (ImageResult | undefined)[] = urls.map(() => undefined);
	let total = 0;
	let exceeded = false;
	let crash: { error: unknown } | null = null;
	let next = 0;
	const worker = async () => {
		while (!exceeded && crash === null) {
			const k = next++;
			if (k >= urls.length) return;
			try {
				const r = await loader.load(urls[k]);
				if (r.ok) {
					total += r.image.byteLength;
					if (total > budget) exceeded = true;
					else results[k] = r;
				} else results[k] = r;
			} catch (error) {
				crash ??= { error };
			}
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.min(options.concurrency ?? 4, urls.length) },
			worker
		)
	);
	if (crash !== null) throw (crash as { error: unknown }).error;
	const failed = results.findIndex((r) => r !== undefined && !r.ok);
	if (failed >= 0) {
		const r = results[failed] as Extract<ImageResult, { ok: false }>;
		return {
			id,
			code: `image-${r.code}`,
			message: r.message,
			url: urls[failed]
		};
	}
	if (exceeded)
		return {
			id,
			code: 'images-too-large',
			message: `画像の合計が上限（${budget} バイト）を超えます`
		};
	const images = new Map<string, LoadedImage>();
	for (const [i, r] of results.entries())
		if (r?.ok) images.set(urls[i], r.image);
	let files: PackFile[];
	try {
		files = packWork(work, images, { maxFileBytes: options.maxFileBytes });
	} catch (e) {
		if (e instanceof PackError) return { id, code: e.code, message: e.message };
		throw e;
	}
	for (const f of files) {
		const to = join(outDir, f.path);
		await mkdir(dirname(to), { recursive: true });
		await writeAtomic(to, f.bytes);
	}
	return {
		id,
		files: files.map((f) => ({
			path: f.path,
			bytes: f.bytes.length,
			sha256: sha256(f.bytes)
		})),
		images: urls.length
	};
}
