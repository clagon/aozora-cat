// 公式の「公開中 作品一覧（拡張・UTF-8）」CSV を、作品ごとの目録へ正規化する。
// 作品の著作権フラグだけが頒布の根拠。人物のフラグは読むが、判断には使わない。
// 決められない行は推測せず、作品ごと理由付きで外す（外した作品は配信しない）。

import { parseCsv } from './csv.ts';
import type {
	BodyRef,
	CatalogWork,
	Diagnostic,
	ParsedCatalog,
	Person,
	SearchEntry,
	Selection
} from './types.ts';

/** 読む列。これが欠けたら、公式の形式が変わったとして取り込みを止める。 */
export const REQUIRED_COLUMNS = [
	'作品ID',
	'作品名',
	'作品名読み',
	'ソート用読み',
	'副題',
	'副題読み',
	'原題',
	'初出',
	'分類番号',
	'文字遣い種別',
	'作品著作権フラグ',
	'公開日',
	'最終更新日',
	'図書カードURL',
	'人物ID',
	'姓',
	'名',
	'姓読み',
	'名読み',
	'役割フラグ',
	'人物著作権フラグ',
	'テキストファイルURL',
	'テキストファイル最終更新日',
	'テキストファイル符号化方式',
	'XHTML/HTMLファイルURL',
	'XHTML/HTMLファイル最終更新日',
	'XHTML/HTMLファイル符号化方式'
] as const;

export class CatalogFormatError extends Error {}

const ROLES: Record<string, Person['role']> = {
	著者: 'author',
	翻訳者: 'translator',
	編者: 'editor',
	校訂者: 'reviser',
	その他: 'other'
};
const ENCODINGS = ['ShiftJIS', 'UTF-8'];
const CARD = /^https:\/\/www\.aozora\.gr\.jp\/cards\/(\d{6})\/card(\d+)\.html$/;
const FILE =
	/^https:\/\/www\.aozora\.gr\.jp\/cards\/(\d{6})\/files\/[A-Za-z0-9_.-]+\.(html|zip)$/;
const DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 暦にある日付か。形だけでなく、2025-02-31 のような存在しない日も除く。 */
const isDate = (v: string): boolean => {
	const m = DATE_SHAPE.exec(v);
	if (!m) return false;
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	return d.toISOString().startsWith(v);
};

export function parseCatalog(csv: string): ParsedCatalog {
	const rows = parseCsv(csv.replace(/^﻿/, ''));
	const header = rows[0] ?? [];
	const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
	if (missing.length > 0)
		throw new CatalogFormatError(`必要な列がありません: ${missing.join('、')}`);
	const col = new Map(header.map((c, i) => [c, i]));
	const notes: Diagnostic[] = [];
	for (const c of header)
		if (!(REQUIRED_COLUMNS as readonly string[]).includes(c) && !KNOWN.has(c))
			notes.push({ code: 'new-column', message: `読まない列があります: ${c}` });

	// 作品IDごとに行をまとめる。順序は初めて現れた順のまま。
	const groups = new Map<string, Map<string, string>[]>();
	for (const [n, r] of rows.slice(1).entries()) {
		if (r.length !== header.length)
			throw new CatalogFormatError(
				`${n + 2}行目の列数が見出しと合いません（${r.length}列）`
			);
		const get = (name: string) => r[col.get(name) as number].trim();
		const id = get('作品ID');
		const g = groups.get(id) ?? [];
		g.push(new Map(REQUIRED_COLUMNS.map((c) => [c, get(c)])));
		groups.set(id, g);
	}

	const works: CatalogWork[] = [];
	const rejected: Diagnostic[] = [];
	for (const [id, g] of groups) {
		const result = toWork(id, g);
		if ('work' in result) {
			works.push(result.work);
			notes.push(...result.notes);
		} else rejected.push({ id, code: result.code, message: result.message });
	}
	return { works, rejected, notes };
}

/** 公式が持つが、使わない列。新しい列が増えたことだけを知らせる。 */
const KNOWN = new Set([
	'姓読みソート用',
	'名読みソート用',
	'姓ローマ字',
	'名ローマ字',
	'生年月日',
	'没年月日',
	'入力者',
	'校正者',
	'テキストファイル文字集合',
	'テキストファイル修正回数',
	'XHTML/HTMLファイル文字集合',
	'XHTML/HTMLファイル修正回数',
	...[1, 2].flatMap((n) =>
		[
			'底本名',
			'底本出版社名',
			'底本初版発行年',
			'入力に使用した版',
			'校正に使用した版',
			'底本の親本名',
			'底本の親本出版社名',
			'底本の親本初版発行年'
		].map((c) => `${c}${n}`)
	)
]);

type Row = Map<string, string>;
type Made =
	| { work: CatalogWork; notes: Diagnostic[] }
	| { code: string; message: string };

function toWork(id: string, g: Row[]): Made {
	const reject = (code: string, message: string): Made => ({ code, message });
	const first = g[0];
	const get = (c: string) => first.get(c) as string;
	if (!/^\d{6}$/.test(id))
		return reject('invalid-field', '作品IDが6桁ではありません');

	// 作品の項目は、人物ごとの行で食い違ってはいけない。
	const personColumns = [
		'人物ID',
		'姓',
		'名',
		'姓読み',
		'名読み',
		'役割フラグ',
		'人物著作権フラグ'
	];
	for (const c of REQUIRED_COLUMNS)
		if (!personColumns.includes(c) && g.some((r) => r.get(c) !== get(c)))
			return reject('inconsistent-rows', `行ごとに「${c}」が食い違っています`);

	const flag = get('作品著作権フラグ');
	if (flag !== 'なし' && flag !== 'あり')
		return reject(
			'unknown-copyright-flag',
			`作品著作権フラグが読めません（${flag}）`
		);
	const title = get('作品名');
	if (title === '') return reject('invalid-field', '作品名が空です');
	const orthography = get('文字遣い種別');
	if (orthography === '')
		return reject('invalid-field', '文字遣い種別が空です');
	const card = CARD.exec(get('図書カードURL'));
	if (!card || card[2] !== String(Number(id)))
		return reject('invalid-field', '図書カードURLが作品と合いません');
	for (const c of ['公開日', '最終更新日'])
		if (!isDate(get(c)))
			return reject('invalid-field', `${c}が日付ではありません`);

	// 同じ人物・役割の行は1つにまとめ、人物と役割はすべて残す。
	const people: Person[] = [];
	for (const r of g) {
		const role = ROLES[r.get('役割フラグ') as string];
		if (role === undefined)
			return reject(
				'unknown-role',
				`役割フラグが読めません（${r.get('役割フラグ')}）`
			);
		const personId = r.get('人物ID') as string;
		const name = `${r.get('姓')}${r.get('名')}`;
		if (!/^\d{6}$/.test(personId) || name === '')
			return reject('invalid-field', '人物が読めません');
		if (people.some((p) => p.id === personId && p.role === role)) continue;
		const reading = `${r.get('姓読み')}${r.get('名読み')}`;
		people.push({ id: personId, role, name, ...(reading && { reading }) });
	}

	const notes: Diagnostic[] = [];
	const bodies = (['xhtml', 'text'] as const).map((path) => {
		const p = path === 'xhtml' ? 'XHTML/HTMLファイル' : 'テキストファイル';
		const url = get(`${p}URL`);
		const ref = bodyRef(
			path,
			card[1],
			url,
			get(`${p}最終更新日`),
			get(`${p}符号化方式`)
		);
		if (url !== '' && 'why' in ref)
			notes.push({
				id,
				code: ref.why,
				message: `${path} の本文は使いません（${url}）`
			});
		return ref;
	});
	const [xhtml, text] = bodies.map((b) => ('why' in b ? undefined : b));
	const work: CatalogWork = {
		id,
		title,
		titleReading: get('作品名読み'),
		sortReading: get('ソート用読み'),
		...(get('副題') && { subtitle: get('副題') }),
		...(get('副題読み') && { subtitleReading: get('副題読み') }),
		...(get('原題') && { originalTitle: get('原題') }),
		...(get('初出') && { firstPublication: get('初出') }),
		...(get('分類番号') && { classification: get('分類番号') }),
		orthography,
		workCopyright: flag,
		published: get('公開日'),
		updated: get('最終更新日'),
		cardUrl: get('図書カードURL'),
		people,
		...(xhtml && { xhtml }),
		...(text && { text })
	};
	return { work, notes };
}

/** 本文の参照。公式の cards/ 配下の、同じ人物の files/ だけを認める。 */
function bodyRef(
	path: 'xhtml' | 'text',
	person: string,
	url: string,
	updated: string,
	encoding: string
): BodyRef | { why: string } {
	if (url === '') return { why: 'no-body-url' };
	const m = FILE.exec(url);
	const ext = path === 'xhtml' ? 'html' : 'zip';
	if (!m || m[1] !== person || m[2] !== ext)
		return { why: 'external-body-url' };
	if (!isDate(updated)) return { why: 'invalid-body-date' };
	if (!ENCODINGS.includes(encoding)) return { why: 'unsupported-encoding' };
	return { url, updated, encoding: encoding as BodyRef['encoding'] };
}

/**
 * 本文を取りに行く作品。作品の著作権フラグが「なし」で、本文の参照があるものだけ。
 * 取得の順は、公式のXHTML、なければテキスト（変換に失敗したときの代替も同じ順）。
 * 著作権が「あり」の作品は、ここへ入らないので、本文の取得は1件も起きない。
 */
export function selectBodies(works: CatalogWork[]): Selection {
	const selection: Selection = { fetch: [], skipped: [] };
	for (const w of works) {
		if (w.workCopyright !== 'なし') {
			selection.skipped.push({ id: w.id, reason: 'copyright-active' });
			continue;
		}
		const sources = [
			...(w.xhtml ? [{ path: 'xhtml' as const, ...w.xhtml }] : []),
			...(w.text ? [{ path: 'text' as const, ...w.text }] : [])
		];
		if (sources.length === 0)
			selection.skipped.push({ id: w.id, reason: 'no-body' });
		else selection.fetch.push({ id: w.id, sources });
	}
	return selection;
}

/** 検索用の軽い目録。配信してよい作品だけを、作品IDの順に並べる。 */
export function buildSearchCatalog(works: CatalogWork[]): SearchEntry[] {
	return works
		.filter((w) => w.workCopyright === 'なし' && (w.xhtml || w.text))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.map((w) => ({
			id: w.id,
			title: w.title,
			titleReading: w.titleReading,
			sortReading: w.sortReading,
			...(w.subtitle && { subtitle: w.subtitle }),
			...(w.classification && { classification: w.classification }),
			orthography: w.orthography,
			updated: w.updated,
			people: w.people.map(({ role, name, reading }) => ({
				role,
				name,
				...(reading && { reading })
			}))
		}));
}
