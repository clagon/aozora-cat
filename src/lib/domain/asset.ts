// 作品1つぶんの配信用アセット（圧縮する前のJSON）の形。作品の意味と、検証済みの画像をまとめる。
// 圧縮の方法と、ファイルの置き場所は、取り込み側（packages/importer）の責務で、ここでは形だけを扱う。

import { MAX_IMAGE_SIDE, parseWork, type Inline, type Work } from './work.ts';

export const ASSET_FORMAT = 1;

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif';
export const IMAGE_MIMES: readonly ImageMime[] = [
	'image/png',
	'image/jpeg',
	'image/gif'
];

/** 検証済みの画像。data は base64。 */
export type AssetImage = {
	mime: ImageMime;
	width: number;
	height: number;
	data: string;
};

export type Asset = {
	format: typeof ASSET_FORMAT;
	work: Work;
	/** 画像。キーは作品が参照する画像のURL。大きくて分けたときは空で、imageParts に分かれている。 */
	images: Record<string, AssetImage>;
	/** 画像を分けた先のファイル（出力の根からの相対パス）。分けなければ空。 */
	imageParts: string[];
};

/** 画像だけを分けたファイル。 */
export type AssetPart = {
	format: typeof ASSET_FORMAT;
	images: Record<string, AssetImage>;
};

export type AssetResult =
	{ ok: true; asset: Asset } | { ok: false; error: string };
export type PartResult =
	{ ok: true; part: AssetPart } | { ok: false; error: string };

/** 作品が参照する画像のURL（外字・挿絵・図）。重複なしで、辞書順。 */
export function collectImageUrls(work: Work): string[] {
	const urls = new Set<string>();
	const stack: Inline[] = [];
	const push = (nodes: Inline[]) => {
		for (const n of nodes) stack.push(n);
	};
	for (const b of work.blocks) {
		if (b.kind === 'figure') {
			urls.add(b.image.url);
			push(b.caption);
		} else if (b.kind === 'paragraph' || b.kind === 'heading') push(b.inline);
	}
	while (stack.length > 0) {
		const n = stack.pop() as Inline;
		if (n.kind === 'gaiji' || n.kind === 'image') urls.add(n.image.url);
		else if (n.kind === 'ruby') push(n.base);
		else if ('children' in n) push(n.children);
	}
	return [...urls].sort();
}

const BASE64 =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PART_PATH = /^works\/\d{6}\.images-\d{1,4}\.json\.gz$/;
export const MAX_IMAGE_PARTS = 1000;

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

function exactKeys(v: Record<string, unknown>, keys: string[]): string | null {
	for (const k of Object.keys(v))
		if (!keys.includes(k)) return `想定していない項目です: ${k}`;
	for (const k of keys) if (!(k in v)) return `項目がありません: ${k}`;
	return null;
}

function parseImages(
	v: unknown,
	allowed: Set<string>,
	path: string
): Record<string, AssetImage> | string {
	if (!isObj(v)) return `${path} がオブジェクトではありません`;
	const entries: [string, AssetImage][] = [];
	for (const [url, raw] of Object.entries(v)) {
		const at = `${path}[${JSON.stringify(url)}]`;
		if (!allowed.has(url)) return `${at} は、作品が参照していない画像です`;
		if (!isObj(raw)) return `${at} がオブジェクトではありません`;
		const bad = exactKeys(raw, ['mime', 'width', 'height', 'data']);
		if (bad) return `${at}: ${bad}`;
		const { mime, width, height, data } = raw;
		const m = IMAGE_MIMES.find((x) => x === mime);
		if (!m) return `${at}.mime が使えません`;
		for (const [k, n] of [
			['width', width],
			['height', height]
		] as const)
			if (
				typeof n !== 'number' ||
				!Number.isInteger(n) ||
				n < 1 ||
				n > MAX_IMAGE_SIDE
			)
				return `${at}.${k} が使えません`;
		if (typeof data !== 'string' || data === '' || !BASE64.test(data))
			return `${at}.data が base64 ではありません`;
		entries.push([
			url,
			{ mime: m, width: width as number, height: height as number, data }
		]);
	}
	return Object.fromEntries(entries);
}

/** 圧縮を解いたJSONを、作品と画像に分けて検証する。未知の項目・将来の形式・参照していない画像は拒否する。 */
export function parseAsset(input: unknown): AssetResult {
	if (!isObj(input)) return { ok: false, error: 'オブジェクトではありません' };
	if (input.format !== ASSET_FORMAT)
		return { ok: false, error: `未対応の形式です: ${String(input.format)}` };
	const bad = exactKeys(input, ['format', 'work', 'images', 'imageParts']);
	if (bad) return { ok: false, error: bad };
	const work = parseWork(input.work);
	if (!work.ok)
		return {
			ok: false,
			error:
				work.error.code === 'invalid'
					? `work: ${work.error.path}: ${work.error.message}`
					: 'work: バージョンが合いません'
		};
	const images = parseImages(
		input.images,
		new Set(collectImageUrls(work.work)),
		'images'
	);
	if (typeof images === 'string') return { ok: false, error: images };
	const parts = input.imageParts;
	if (
		!Array.isArray(parts) ||
		parts.length > MAX_IMAGE_PARTS ||
		parts.some((p) => typeof p !== 'string' || !PART_PATH.test(p)) ||
		new Set(parts).size !== parts.length ||
		parts.some((p) => !p.startsWith(`works/${work.work.id}.`))
	)
		return { ok: false, error: 'imageParts が使えません' };
	return {
		ok: true,
		asset: {
			format: ASSET_FORMAT,
			work: work.work,
			images,
			imageParts: parts as string[]
		}
	};
}

/** 画像だけを分けたファイルを検証する。allowed は、元の作品が参照する画像のURL。 */
export function parseAssetPart(
	input: unknown,
	allowed: Set<string>
): PartResult {
	if (!isObj(input)) return { ok: false, error: 'オブジェクトではありません' };
	if (input.format !== ASSET_FORMAT)
		return { ok: false, error: `未対応の形式です: ${String(input.format)}` };
	const bad = exactKeys(input, ['format', 'images']);
	if (bad) return { ok: false, error: bad };
	const images = parseImages(input.images, allowed, 'images');
	if (typeof images === 'string') return { ok: false, error: images };
	return { ok: true, part: { format: ASSET_FORMAT, images } };
}

/** 作品が参照する画像のうち、画像のどれにもないURL。空なら、参照はすべて解決できる。 */
export function missingImages(asset: Asset, parts: AssetPart[]): string[] {
	const have = new Set([
		...Object.keys(asset.images),
		...parts.flatMap((p) => Object.keys(p.images))
	]);
	return collectImageUrls(asset.work).filter((u) => !have.has(u));
}
