// 作品の中間表現。変換器の出力と、リーダーが読み込む入力の唯一の契約。
// 上流のHTMLは通らず、ここで許した種類のノードだけが残る。
// Node の型除去でも読み込めるよう、enum やパラメータプロパティは使わない。

export const WORK_SCHEMA_VERSION = 1;

/** 画像の参照。取得は変換器の外（取り込み側）で行い、ここでは許可した場所だけを表す。 */
export type ImageRef = { url: string };

export type ImageSize = { width: number; height: number };

/**
 * 公式の強調の記法に対応する印。傍点は sesame（ゴマ）から saltire（ばつ）まで、
 * 傍線は solid（実線）から wave（波線）まで。
 */
export const EMPHASIS_MARKS = [
	'sesame',
	'whiteSesame',
	'blackCircle',
	'whiteCircle',
	'blackTriangle',
	'whiteTriangle',
	'bullseye',
	'fisheye',
	'saltire',
	'solid',
	'double',
	'dotted',
	'dashed',
	'wave'
] as const;

export type EmphasisMark = (typeof EMPHASIS_MARKS)[number];

/** 子を持つだけの装飾。strong=太字、frame=罫囲み、warichu=割注、horizontal=横組み、tcy=縦中横。 */
export type ContainerKind =
	| 'strong'
	| 'frame'
	| 'warichu'
	| 'superscript'
	| 'subscript'
	| 'horizontal'
	| 'tcy';

export type Inline =
	| { kind: 'text'; text: string }
	/** 親文字の中にルビは入れない。外字や装飾は入れてよい。 */
	| { kind: 'ruby'; base: Inline[]; reading: string }
	/** side は縦組みでの付く側。right が通常、left が「の左に」の注記。 */
	| {
			kind: 'emphasis';
			mark: EmphasisMark;
			side: 'right' | 'left';
			children: Inline[];
	  }
	| { kind: ContainerKind; children: Inline[] }
	/** 大きな文字・小さな文字。step は上流の段階（1〜5）。行の幅が変わるのでページ境界に影響する。 */
	| {
			kind: 'size';
			direction: 'larger' | 'smaller';
			step: number;
			children: Inline[];
	  }
	| { kind: 'gaiji'; description: string; image: ImageRef }
	| {
			kind: 'image';
			image: ImageRef;
			alt: string;
			size: ImageSize;
	  }
	/** 底本との差異など、本文の記法では表せない編集注記。表示するかは読み手が決める。 */
	| { kind: 'note'; text: string };

/** 字下げ・地付き・ぶら下げ。数値は字数。 */
export type Layout =
	| { kind: 'none' }
	| { kind: 'indent'; chars: number }
	| { kind: 'end'; inset: number }
	| { kind: 'hanging'; indent: number; first: number };

export type HeadingLevel = 'large' | 'medium' | 'small';

export type PageBreakStyle = 'page' | 'leaf' | 'spread' | 'column';

/** id は作品内で一意。位置の識別に使うので、番号を持つ block だけに付ける。 */
export type Block =
	/** inline が空なら空行。 */
	| { kind: 'paragraph'; id: string; layout: Layout; inline: Inline[] }
	| {
			kind: 'heading';
			id: string;
			level: HeadingLevel;
			layout: Layout;
			inline: Inline[];
	  }
	/** 挿絵だけの行。caption は見えるキャプション（なければ空）で、alt（読み上げ用）とは別。 */
	| {
			kind: 'figure';
			id: string;
			image: ImageRef;
			alt: string;
			size: ImageSize;
			caption: Inline[];
	  }
	/** 次の改ページまでを、ページの左右中央に置く指示（［＃ページの左右中央］）。 */
	| { kind: 'pageCenter' }
	| { kind: 'pageBreak'; style: PageBreakStyle };

/** 公式の作品一覧の役割フラグ（著者・翻訳者・編者・校訂者・その他）に対応する。 */
export type PersonRole =
	'author' | 'translator' | 'editor' | 'reviser' | 'other';

export type Person = { role: PersonRole; name: string; reading?: string };

export type Provenance = {
	/** 頒布してよいのは作品の著作権フラグが「なし」のものだけ。人物のフラグは使わない。 */
	copyright: { work: 'なし' };
	/** 青空文庫の公式図書カードと、変換元のファイル。 */
	source: { cardUrl: string; fileUrl: string; upstreamUpdated: string };
	converter: { version: string; path: 'xhtml' | 'text' };
	/** 底本・入力者・校正者などの行。省略せず、上流の順のまま残す。 */
	bibliography: string[];
};

export type Work = {
	schemaVersion: typeof WORK_SCHEMA_VERSION;
	/** 青空文庫の作品ID（6桁）。 */
	id: string;
	title: string;
	titleReading?: string;
	/** 副題。検索の対象なので、題名へ混ぜずに分けて持つ。 */
	subtitle?: string;
	subtitleReading?: string;
	/** 公式の分類（例: NDC 913）。分類のない作品もある。 */
	classification?: string;
	/** 公式の作品一覧にある原題と初出。 */
	originalTitle?: string;
	firstPublication?: string;
	people: Person[];
	/** 公式の作品一覧にある表記（例: 新字新仮名）。 */
	orthography: string;
	provenance: Provenance;
	blocks: Block[];
};

export type WorkError =
	| { code: 'unsupported-version'; version: unknown }
	| { code: 'invalid'; path: string; message: string };

export type WorkResult =
	{ ok: true; work: Work } | { ok: false; error: WorkError };

type Rec = Record<string, unknown>;

class Invalid extends Error {
	path: string;
	constructor(path: string, message: string) {
		super(message);
		this.path = path;
	}
}

const MAX_DEPTH = 8;
/** 画像の幅・高さ（px）の上限。これを超える宣言は、縦横比の異常として拒否する。 */
const MAX_IMAGE_SIDE = 10000;
/** 字下げ・地付き・ぶら下げの字数の上限。 */
const MAX_LAYOUT_CHARS = 200;
const AOZORA_HOST = 'www.aozora.gr.jp';

function isRec(v: unknown): v is Rec {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function rec(v: unknown, path: string, keys: string[]): Rec {
	if (!isRec(v)) throw new Invalid(path, 'オブジェクトではありません');
	for (const key of Object.keys(v)) {
		if (!keys.includes(key))
			throw new Invalid(`${path}.${key}`, '想定していない項目です');
	}
	return v;
}

function str(r: Rec, key: string, path: string, allowEmpty = false): string {
	const v = r[key];
	if (typeof v !== 'string' || (!allowEmpty && v === ''))
		throw new Invalid(`${path}.${key}`, '空でない文字列が必要です');
	return v;
}

function int(
	r: Rec,
	key: string,
	path: string,
	min: number,
	max: number
): number {
	const v = r[key];
	if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max)
		throw new Invalid(`${path}.${key}`, `${min}以上${max}以下の整数が必要です`);
	return v;
}

function oneOf<T extends string>(
	r: Rec,
	key: string,
	path: string,
	allowed: readonly T[]
): T {
	const v = r[key];
	const hit = allowed.find((a) => a === v);
	if (hit === undefined)
		throw new Invalid(
			`${path}.${key}`,
			`次のいずれかが必要です: ${allowed.join(', ')}`
		);
	return hit;
}

function list<T>(
	r: Rec,
	key: string,
	path: string,
	each: (v: unknown, path: string) => T,
	allowEmpty = false
): T[] {
	const v = r[key];
	if (!Array.isArray(v) || (!allowEmpty && v.length === 0))
		throw new Invalid(`${path}.${key}`, '配列が必要です');
	return v.map((item: unknown, i) => each(item, `${path}.${key}[${i}]`));
}

/** 青空文庫の許可した場所への https URL だけを通す。正規化した形と一致しなければ拒否する。 */
function aozoraUrl(
	r: Rec,
	key: string,
	path: string,
	pathname: RegExp
): string {
	const raw = str(r, key, path);
	const fail = () => new Invalid(`${path}.${key}`, '許可していないURLです');
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		throw fail();
	}
	if (
		u.protocol !== 'https:' ||
		u.hostname !== AOZORA_HOST ||
		u.port !== '' ||
		u.username !== '' ||
		u.password !== '' ||
		u.search !== '' ||
		u.hash !== '' ||
		u.href !== raw ||
		!pathname.test(u.pathname)
	)
		throw fail();
	return raw;
}

const IMAGE_PATH = /^\/(?:cards|gaiji)\/[A-Za-z0-9_./-]+\.(?:png|jpe?g|gif)$/;

function imageRef(v: unknown, path: string): ImageRef {
	const r = rec(v, path, ['url']);
	return { url: aozoraUrl(r, 'url', path, IMAGE_PATH) };
}

function imageSize(v: unknown, path: string): ImageSize {
	const r = rec(v, path, ['width', 'height']);
	return {
		width: int(r, 'width', path, 1, MAX_IMAGE_SIDE),
		height: int(r, 'height', path, 1, MAX_IMAGE_SIDE)
	};
}

const CONTAINERS: readonly ContainerKind[] = [
	'strong',
	'frame',
	'warichu',
	'superscript',
	'subscript',
	'horizontal',
	'tcy'
];

function children(r: Rec, path: string, depth: number, inRuby: boolean) {
	return list(r, 'children', path, (v, p) => inline(v, p, depth + 1, inRuby));
}

function inline(
	v: unknown,
	path: string,
	depth: number,
	inRuby: boolean
): Inline {
	if (depth > MAX_DEPTH) throw new Invalid(path, '入れ子が深すぎます');
	if (!isRec(v)) throw new Invalid(path, 'オブジェクトではありません');
	const kind = v.kind;
	if (kind === 'text') {
		const r = rec(v, path, ['kind', 'text']);
		return { kind, text: str(r, 'text', path) };
	}
	if (kind === 'ruby') {
		if (inRuby) throw new Invalid(path, 'ルビの親文字にルビは入れられません');
		const r = rec(v, path, ['kind', 'base', 'reading']);
		return {
			kind,
			base: list(r, 'base', path, (b, p) => inline(b, p, depth + 1, true)),
			reading: str(r, 'reading', path)
		};
	}
	if (kind === 'emphasis') {
		const r = rec(v, path, ['kind', 'mark', 'side', 'children']);
		return {
			kind,
			mark: oneOf(r, 'mark', path, EMPHASIS_MARKS),
			side: oneOf(r, 'side', path, ['right', 'left']),
			children: children(r, path, depth, inRuby)
		};
	}
	if (kind === 'size') {
		const r = rec(v, path, ['kind', 'direction', 'step', 'children']);
		const step = int(r, 'step', path, 1, 5);
		return {
			kind,
			direction: oneOf(r, 'direction', path, ['larger', 'smaller']),
			step,
			children: children(r, path, depth, inRuby)
		};
	}
	const container = CONTAINERS.find((c) => c === kind);
	if (container) {
		const r = rec(v, path, ['kind', 'children']);
		return { kind: container, children: children(r, path, depth, inRuby) };
	}
	if (kind === 'gaiji') {
		const r = rec(v, path, ['kind', 'description', 'image']);
		return {
			kind,
			description: str(r, 'description', path),
			image: imageRef(r.image, `${path}.image`)
		};
	}
	if (kind === 'image') {
		const r = rec(v, path, ['kind', 'image', 'alt', 'size']);
		return {
			kind,
			image: imageRef(r.image, `${path}.image`),
			alt: str(r, 'alt', path, true),
			size: imageSize(r.size, `${path}.size`)
		};
	}
	if (kind === 'note') {
		const r = rec(v, path, ['kind', 'text']);
		return { kind, text: str(r, 'text', path) };
	}
	throw new Invalid(`${path}.kind`, '未知のノード種別です');
}

function layout(v: unknown, path: string): Layout {
	if (!isRec(v)) throw new Invalid(path, 'オブジェクトではありません');
	const kind = v.kind;
	if (kind === 'none') {
		rec(v, path, ['kind']);
		return { kind };
	}
	if (kind === 'indent') {
		const r = rec(v, path, ['kind', 'chars']);
		return { kind, chars: int(r, 'chars', path, 1, MAX_LAYOUT_CHARS) };
	}
	if (kind === 'end') {
		const r = rec(v, path, ['kind', 'inset']);
		return { kind, inset: int(r, 'inset', path, 0, MAX_LAYOUT_CHARS) };
	}
	if (kind === 'hanging') {
		const r = rec(v, path, ['kind', 'indent', 'first']);
		return {
			kind,
			indent: int(r, 'indent', path, 1, MAX_LAYOUT_CHARS),
			first: int(r, 'first', path, 0, MAX_LAYOUT_CHARS)
		};
	}
	throw new Invalid(`${path}.kind`, '未知の配置種別です');
}

function block(v: unknown, path: string): Block {
	if (!isRec(v)) throw new Invalid(path, 'オブジェクトではありません');
	const kind = v.kind;
	const inlines = (r: Rec, key = 'inline') =>
		list(r, key, path, (i, p) => inline(i, p, 1, false), true);
	if (kind === 'paragraph') {
		const r = rec(v, path, ['kind', 'id', 'layout', 'inline']);
		return {
			kind,
			id: str(r, 'id', path),
			layout: layout(r.layout, `${path}.layout`),
			inline: inlines(r)
		};
	}
	if (kind === 'heading') {
		const r = rec(v, path, ['kind', 'id', 'level', 'layout', 'inline']);
		return {
			kind,
			id: str(r, 'id', path),
			level: oneOf(r, 'level', path, ['large', 'medium', 'small']),
			layout: layout(r.layout, `${path}.layout`),
			inline: inlines(r)
		};
	}
	if (kind === 'figure') {
		const r = rec(v, path, ['kind', 'id', 'image', 'alt', 'size', 'caption']);
		return {
			kind,
			id: str(r, 'id', path),
			image: imageRef(r.image, `${path}.image`),
			alt: str(r, 'alt', path, true),
			size: imageSize(r.size, `${path}.size`),
			caption: inlines(r, 'caption')
		};
	}
	if (kind === 'pageCenter') {
		rec(v, path, ['kind']);
		return { kind };
	}
	if (kind === 'pageBreak') {
		const r = rec(v, path, ['kind', 'style']);
		return {
			kind,
			style: oneOf(r, 'style', path, ['page', 'leaf', 'spread', 'column'])
		};
	}
	throw new Invalid(`${path}.kind`, '未知のブロック種別です');
}

function person(v: unknown, path: string): Person {
	const r = rec(v, path, ['role', 'name', 'reading']);
	const p: Person = {
		role: oneOf(r, 'role', path, [
			'author',
			'translator',
			'editor',
			'reviser',
			'other'
		]),
		name: str(r, 'name', path)
	};
	if (r.reading !== undefined) p.reading = str(r, 'reading', path);
	return p;
}

const CARD_PATH = /^\/cards\/(\d+)\/card(\d+)\.html$/;
const FILE_PATH =
	/^\/cards\/(\d+)\/files\/(\d+)_[A-Za-z0-9_.-]+\.(?:html|txt|zip)$/;

function validDate(s: string): boolean {
	const d = new Date(`${s}T00:00:00Z`);
	return (
		/^\d{4}-\d{2}-\d{2}$/.test(s) &&
		!Number.isNaN(d.getTime()) &&
		d.toISOString().startsWith(s)
	);
}

/** 図書カードとファイルの URL が、この作品のものであることを確かめ、人物ディレクトリも返す。 */
/** 先頭のゼロを除いた数字列。桁数の大きい値でも丸めず、文字列のまま比べるために使う。 */
const canon = (digits: string) => digits.replace(/^0+(?=\d)/, '');

function ownUrl(
	r: Rec,
	key: string,
	path: string,
	pathname: RegExp,
	workId: string
): { url: string; person: string } {
	const url = aozoraUrl(r, key, path, pathname);
	const [, person, number] = pathname.exec(new URL(url).pathname) ?? [];
	if (number === undefined || canon(number) !== canon(workId))
		throw new Invalid(`${path}.${key}`, '作品IDと異なる作品のURLです');
	return { url, person: canon(person ?? '') };
}

function provenance(v: unknown, path: string, workId: string): Provenance {
	const r = rec(v, path, ['copyright', 'source', 'converter', 'bibliography']);
	const copyright = rec(r.copyright, `${path}.copyright`, ['work']);
	if (copyright.work !== 'なし')
		throw new Invalid(
			`${path}.copyright.work`,
			'作品の著作権フラグが「なし」でないものは扱えません'
		);
	const sp = `${path}.source`;
	const source = rec(r.source, sp, ['cardUrl', 'fileUrl', 'upstreamUpdated']);
	const upstreamUpdated = str(source, 'upstreamUpdated', sp);
	if (!validDate(upstreamUpdated))
		throw new Invalid(`${sp}.upstreamUpdated`, 'YYYY-MM-DD の日付が必要です');
	const cp = `${path}.converter`;
	const converter = rec(r.converter, cp, ['version', 'path']);
	const version = str(converter, 'version', cp);
	if (!/^\d+\.\d+\.\d+$/.test(version))
		throw new Invalid(`${cp}.version`, 'x.y.z 形式が必要です');
	const card = ownUrl(source, 'cardUrl', sp, CARD_PATH, workId);
	const file = ownUrl(source, 'fileUrl', sp, FILE_PATH, workId);
	if (card.person !== file.person)
		throw new Invalid(
			`${sp}.fileUrl`,
			'図書カードと異なる人物のディレクトリです'
		);
	const via = oneOf(converter, 'path', cp, ['xhtml', 'text']);
	// xhtml は .html の変換元、text は .txt / .zip の変換元だけと組み合わせる。
	if (file.url.endsWith('.html') !== (via === 'xhtml'))
		throw new Invalid(
			`${cp}.path`,
			'変換経路が、変換元ファイルの形式と合いません'
		);
	return {
		copyright: { work: 'なし' },
		source: {
			cardUrl: card.url,
			fileUrl: file.url,
			upstreamUpdated
		},
		converter: { version, path: via },
		bibliography: list(r, 'bibliography', path, (line, p) => {
			if (typeof line !== 'string' || line === '')
				throw new Invalid(p, '空でない文字列が必要です');
			return line;
		})
	};
}

/**
 * 直列化された作品を検証し、型付きの新しいオブジェクトとして返す。
 * 未知の項目・種別・将来のバージョン・許可外のURLは拒否する。
 */
export function parseWork(input: unknown): WorkResult {
	if (isRec(input) && input.schemaVersion !== WORK_SCHEMA_VERSION)
		return {
			ok: false,
			error: { code: 'unsupported-version', version: input.schemaVersion }
		};
	try {
		const r = rec(input, '$', [
			'schemaVersion',
			'id',
			'title',
			'titleReading',
			'subtitle',
			'subtitleReading',
			'classification',
			'originalTitle',
			'firstPublication',
			'people',
			'orthography',
			'provenance',
			'blocks'
		]);
		const id = str(r, 'id', '$');
		if (!/^\d{6}$/.test(id)) throw new Invalid('$.id', '6桁の作品IDが必要です');
		const blocks = list(r, 'blocks', '$', block);
		const seen = new Set<string>();
		blocks.forEach((b, i) => {
			if (b.kind === 'pageBreak' || b.kind === 'pageCenter') return;
			if (seen.has(b.id))
				throw new Invalid(`$.blocks[${i}].id`, 'block の id が重複しています');
			seen.add(b.id);
		});
		const work: Work = {
			schemaVersion: WORK_SCHEMA_VERSION,
			id,
			title: str(r, 'title', '$'),
			people: list(r, 'people', '$', person),
			orthography: str(r, 'orthography', '$'),
			provenance: provenance(r.provenance, '$.provenance', id),
			blocks
		};
		for (const key of [
			'titleReading',
			'subtitle',
			'subtitleReading',
			'classification',
			'originalTitle',
			'firstPublication'
		] as const) {
			if (r[key] !== undefined) work[key] = str(r, key, '$');
		}
		if (work.subtitleReading !== undefined && work.subtitle === undefined)
			throw new Invalid(
				'$.subtitleReading',
				'副題がない作品に副題の読みは付けられません'
			);
		return { ok: true, work };
	} catch (e) {
		if (e instanceof Invalid)
			return {
				ok: false,
				error: { code: 'invalid', path: e.path, message: e.message }
			};
		throw e;
	}
}
