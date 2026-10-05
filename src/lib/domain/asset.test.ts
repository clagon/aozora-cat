import { describe, expect, it } from 'vitest';
import {
	collectImageUrls,
	type AssetImage,
	missingImages,
	parseAsset,
	parseAssetPart,
	type Asset
} from './asset.ts';
import { parseWork, type Work } from './work.ts';

const U = (name: string) =>
	`https://www.aozora.gr.jp/cards/000879/files/${name}`;
const G = 'https://www.aozora.gr.jp/gaiji/1-87/1-87-71.png';

function work(): Work {
	const r = parseWork({
		schemaVersion: 1,
		id: '000092',
		title: '蜘蛛の糸',
		people: [{ role: 'author', name: '芥川竜之介' }],
		orthography: '新字新仮名',
		provenance: {
			copyright: { work: 'なし' },
			source: {
				cardUrl: 'https://www.aozora.gr.jp/cards/000879/card92.html',
				fileUrl: 'https://www.aozora.gr.jp/cards/000879/files/92_14545.html',
				upstreamUpdated: '2014-09-17'
			},
			converter: { version: '1.2.0', path: 'xhtml' },
			bibliography: ['底本：x']
		},
		blocks: [
			{
				kind: 'paragraph',
				id: 'p-1',
				layout: { kind: 'none' },
				inline: [
					{ kind: 'gaiji', description: '※(x)', image: { url: G } },
					{
						kind: 'ruby',
						base: [
							{
								kind: 'image',
								image: { url: U('a.png') },
								alt: 'a',
								size: { width: 1, height: 1 }
							}
						],
						reading: 'あ'
					},
					{
						kind: 'strong',
						children: [
							{
								kind: 'emphasis',
								mark: 'sesame',
								side: 'right',
								children: [
									{ kind: 'gaiji', description: '※(y)', image: { url: G } }
								]
							}
						]
					}
				]
			},
			{
				kind: 'figure',
				id: 'p-2',
				image: { url: U('fig.png') },
				alt: '図',
				size: { width: 1, height: 1 },
				caption: [
					{
						kind: 'size',
						direction: 'larger',
						step: 1,
						children: [
							{
								kind: 'image',
								image: { url: U('cap.gif') },
								alt: 'c',
								size: { width: 1, height: 1 }
							}
						]
					}
				]
			}
		]
	});
	if (!r.ok) throw new Error(JSON.stringify(r.error));
	return r.work;
}

const img = (n = 1): AssetImage => ({
	mime: 'image/png',
	width: n,
	height: n,
	data: 'AAAA'
});
const asset = (extra: object = {}) => ({
	format: 1,
	work: work(),
	images: {},
	imageParts: [],
	...extra
});

describe('collectImageUrls', () => {
	it('外字・ルビの親文字の画像・挿絵・図の説明の中まで、重複なしで辞書順に集める', () => {
		expect(collectImageUrls(work())).toEqual([
			U('a.png'),
			U('cap.gif'),
			U('fig.png'),
			G
		]);
	});

	it('画像のない作品は空', () => {
		const w = { ...work(), blocks: [] };
		expect(collectImageUrls(w)).toEqual([]);
	});
});

describe('parseAsset', () => {
	const ok = (v: unknown) => parseAsset(v);
	const bad = (v: unknown, message: RegExp) => {
		const r = parseAsset(v);
		expect(r.ok).toBe(false);
		expect(r.ok ? '' : r.error).toMatch(message);
	};

	it('作品と、作品が参照する画像を読む', () => {
		const r = ok(asset({ images: { [G]: img(), [U('a.png')]: img(2) } }));
		expect(r.ok && Object.keys(r.asset.images).sort()).toEqual(
			[G, U('a.png')].sort()
		);
		expect(r.ok && r.asset.work.id).toBe('000092');
	});

	it('未知の項目・将来の形式・不正な作品を拒否する', () => {
		bad({ ...asset(), extra: 1 }, /想定していない項目/);
		bad({ ...asset(), format: 2 }, /未対応の形式/);
		bad({ ...asset(), work: {} }, /work:/);
		bad(null, /オブジェクト/);
		bad([], /オブジェクト/);
		const { imageParts: _ignored, ...rest } = asset();
		void _ignored;
		bad(rest, /項目がありません/);
	});

	it('参照していない画像・不正な画像の項目を拒否する', () => {
		bad(asset({ images: { [U('other.png')]: img() } }), /参照していない/);
		bad(
			asset({ images: { [G]: { ...img(), mime: 'image/svg+xml' } } }),
			/mime/
		);
		bad(asset({ images: { [G]: { ...img(), width: 0 } } }), /width/);
		bad(asset({ images: { [G]: { ...img(), height: 10001 } } }), /height/);
		bad(asset({ images: { [G]: { ...img(), width: 1.5 } } }), /width/);
		bad(asset({ images: { [G]: { ...img(), data: '' } } }), /base64/);
		bad(asset({ images: { [G]: { ...img(), data: 'AA=A' } } }), /base64/);
		bad(asset({ images: { [G]: { ...img(), data: 'AAA' } } }), /base64/);
		bad(asset({ images: { [G]: { ...img(), extra: 1 } } }), /想定していない/);
		bad(asset({ images: { __proto__x: img() } }), /参照していない/);
	});

	it('画像の分け先は、この作品のファイル名の形だけを認める', () => {
		const p = (n: number) => `works/000092.images-${n}.json.gz`;
		expect(ok(asset({ imageParts: [p(1), p(2)] })).ok).toBe(true);
		for (const parts of [
			['works/000093.images-1.json.gz'],
			['../works/000092.images-1.json.gz'],
			['works/000092.images-1.json'],
			[p(1), p(1)],
			[7],
			'works/x'
		])
			bad(asset({ imageParts: parts }), /imageParts/);
		bad(
			asset({ imageParts: Array.from({ length: 1001 }, (_, i) => p(i + 1)) }),
			/imageParts/
		);
	});
});

describe('分けた画像の検証と、参照の解決', () => {
	const allowed = new Set([G, U('a.png')]);

	it('画像だけのファイルを、許された画像のURLに限って読む', () => {
		expect(
			parseAssetPart({ format: 1, images: { [G]: img() } }, allowed).ok
		).toBe(true);
		expect(
			parseAssetPart({ format: 1, images: { [U('x.png')]: img() } }, allowed).ok
		).toBe(false);
		expect(
			parseAssetPart({ format: 1, images: {}, extra: 1 }, allowed).ok
		).toBe(false);
		expect(parseAssetPart({ format: 2, images: {} }, allowed).ok).toBe(false);
	});

	it('作品が参照する画像が、アセットと分け先のどちらにもなければ、足りないものを返す', () => {
		const r = parseAsset(asset({ images: { [G]: img() } }));
		if (!r.ok) throw new Error(r.error);
		const part = parseAssetPart(
			{ format: 1, images: { [U('a.png')]: img(), [U('fig.png')]: img() } },
			new Set(collectImageUrls(r.asset.work))
		);
		if (!part.ok) throw new Error(part.error);
		expect(missingImages(r.asset, [part.part])).toEqual([U('cap.gif')]);
		expect(missingImages(r.asset, [])).toEqual([
			U('a.png'),
			U('cap.gif'),
			U('fig.png')
		]);
		const asset2: Asset = {
			...r.asset,
			images: { ...r.asset.images, ...part.part.images, [U('cap.gif')]: img() }
		};
		expect(missingImages(asset2, [])).toEqual([]);
	});
});
