import { describe, expect, it } from 'vitest';
import {
	CatalogFormatError,
	REQUIRED_COLUMNS,
	buildSearchCatalog,
	parseCatalog,
	selectBodies
} from './catalog.ts';

const HEADER = [...REQUIRED_COLUMNS, '人物ID'].filter(
	(c, i, a) => a.indexOf(c) === i
);

const quote = (v: string) => `"${v.replaceAll('"', '""')}"`;
type Row = Record<string, string>;

const base = (id: string, extra: Row = {}): Row => ({
	作品ID: id,
	作品名: `作品${id}`,
	作品名読み: `さくひん${id}`,
	ソート用読み: `さくひん${id}`,
	副題: '',
	副題読み: '',
	原題: '',
	初出: '',
	分類番号: 'NDC 913',
	文字遣い種別: '新字新仮名',
	作品著作権フラグ: 'なし',
	公開日: '2020-01-01',
	最終更新日: '2020-02-02',
	図書カードURL: `https://www.aozora.gr.jp/cards/000879/card${Number(id)}.html`,
	人物ID: '000879',
	姓: '芥川',
	名: '竜之介',
	姓読み: 'あくたがわ',
	名読み: 'りゅうのすけ',
	役割フラグ: '著者',
	人物著作権フラグ: 'なし',
	テキストファイルURL: `https://www.aozora.gr.jp/cards/000879/files/${Number(id)}_ruby_1.zip`,
	テキストファイル最終更新日: '2020-02-02',
	テキストファイル符号化方式: 'ShiftJIS',
	'XHTML/HTMLファイルURL': `https://www.aozora.gr.jp/cards/000879/files/${Number(id)}_1.html`,
	'XHTML/HTMLファイル最終更新日': '2020-02-02',
	'XHTML/HTMLファイル符号化方式': 'ShiftJIS',
	...extra
});

function csv(rows: Row[], header: string[] = HEADER) {
	return [
		header.join(','),
		...rows.map((r) => header.map((c) => quote(r[c] ?? '')).join(','))
	].join('\n');
}

const parse = (...rows: Row[]) => parseCatalog(csv(rows));
const one = (...rows: Row[]) => {
	const c = parse(...rows);
	expect(c.rejected).toEqual([]);
	return c.works[0];
};

describe('parseCatalog', () => {
	it('読む列が欠けていれば、形式が変わったとして止める', () => {
		const header = HEADER.filter((c) => c !== '作品著作権フラグ');
		expect(() => parseCatalog(csv([base('000001')], header))).toThrow(
			CatalogFormatError
		);
		expect(() => parseCatalog('')).toThrow(CatalogFormatError);
	});

	it('同じ列が重複していれば、どちらが正か決められないので止める（著作権フラグが食い違っても通さない）', () => {
		const header = [...HEADER, '作品著作権フラグ'];
		const rows = `${header.join(',')}\n${header.map((c, i) => quote(i === header.length - 1 ? 'なし' : (base('000001', { 作品著作権フラグ: 'あり' })[c] ?? ''))).join(',')}`;
		expect(() => parseCatalog(rows)).toThrow(CatalogFormatError);
		expect(() =>
			parseCatalog(csv([base('000001')], [...HEADER, '新しい列', '新しい列']))
		).toThrow(CatalogFormatError);
	});

	it('列数が見出しと合わない行があれば、ずれた読みをせず止める', () => {
		expect(() => parseCatalog(`${HEADER.join(',')}\n"1","2"`)).toThrow(
			CatalogFormatError
		);
	});

	it('読まない新しい列があれば、取り込みは続けて、知らせる', () => {
		const c = parseCatalog(csv([base('000001')], [...HEADER, '新しい列']));
		expect(c.works).toHaveLength(1);
		expect(c.notes).toEqual([
			{ code: 'new-column', message: '読まない列があります: 新しい列' }
		]);
	});

	it('著者と翻訳者の行を1つの作品にまとめ、人物と役割をすべて残す。同じ人物・役割の行は1つにする', () => {
		const w = one(
			base('000001'),
			base('000001', {
				人物ID: '001258',
				姓: '吉田',
				名: '甲子太郎',
				姓読み: 'よしだ',
				名読み: 'きねたろう',
				役割フラグ: '翻訳者',
				人物著作権フラグ: 'あり'
			}),
			base('000001')
		);
		expect(w.people).toEqual([
			{
				id: '000879',
				role: 'author',
				name: '芥川竜之介',
				reading: 'あくたがわりゅうのすけ'
			},
			{
				id: '001258',
				role: 'translator',
				name: '吉田甲子太郎',
				reading: 'よしだきねたろう'
			}
		]);
	});

	it('同じ人物が別の役割でも、別々に残す', () => {
		const w = one(base('000001'), base('000001', { 役割フラグ: '編者' }));
		expect(w.people.map((p) => p.role)).toEqual(['author', 'editor']);
	});

	it('作品の項目が行ごとに食い違えば、その作品を外す', () => {
		const c = parse(
			base('000001'),
			base('000001', { 作品名: '違う題' }),
			base('000002')
		);
		expect(c.works.map((w) => w.id)).toEqual(['000002']);
		expect(c.rejected).toEqual([
			{
				id: '000001',
				code: 'inconsistent-rows',
				message: expect.stringContaining('作品名')
			}
		]);
	});

	const rejectedAs = (code: string, row: Row) =>
		expect(parse(row).rejected.map((r) => r.code)).toEqual([code]);

	it('決められない値の作品は、推測せず外す', () => {
		rejectedAs(
			'unknown-copyright-flag',
			base('000001', { 作品著作権フラグ: '不明' })
		);
		rejectedAs(
			'unknown-copyright-flag',
			base('000001', { 作品著作権フラグ: '' })
		);
		rejectedAs('unknown-role', base('000001', { 役割フラグ: '画家' }));
		rejectedAs('invalid-field', base('00001'));
		rejectedAs('invalid-field', base('000001', { 作品名: '' }));
		rejectedAs('invalid-field', base('000001', { 文字遣い種別: '' }));
		rejectedAs('invalid-field', base('000001', { 公開日: '2020/01/01' }));
		rejectedAs('invalid-field', base('000001', { 公開日: '2025-02-31' }));
		rejectedAs('invalid-field', base('000001', { 最終更新日: '2026-99-99' }));
		rejectedAs('invalid-field', base('000001', { 人物ID: 'x' }));
		rejectedAs('invalid-field', base('000001', { 姓: '', 名: '' }));
		// 図書カードのURLが、作品ID・公式の場所と合わない。
		rejectedAs(
			'invalid-field',
			base('000001', {
				図書カードURL: 'https://www.aozora.gr.jp/cards/000879/card2.html'
			})
		);
		rejectedAs(
			'invalid-field',
			base('000001', {
				図書カードURL: 'https://example.com/cards/000879/card1.html'
			})
		);
	});

	it('作品の著作権フラグだけで頒布を決め、人物のフラグは使わない', () => {
		const active = one(base('000001', { 作品著作権フラグ: 'あり' }));
		expect(active.workCopyright).toBe('あり');
		const personActive = one(base('000002', { 人物著作権フラグ: 'あり' }));
		expect(personActive.workCopyright).toBe('なし');
		expect(selectBodies([active, personActive]).fetch.map((f) => f.id)).toEqual(
			['000002']
		);
	});
});

describe('本文の参照', () => {
	const bodies = (row: Row) => {
		const w = one(base('000001', row));
		return { xhtml: w.xhtml, text: w.text };
	};

	it('XHTML とテキストの両方があれば、どちらも持ち、XHTML を先にする', () => {
		const w = one(base('000001'));
		expect(w.xhtml).toEqual({
			url: 'https://www.aozora.gr.jp/cards/000879/files/1_1.html',
			updated: '2020-02-02',
			encoding: 'ShiftJIS'
		});
		expect(selectBodies([w]).fetch[0].sources.map((s) => s.path)).toEqual([
			'xhtml',
			'text'
		]);
	});

	it('XHTML がなければ、テキストだけを取りに行く', () => {
		const w = one(
			base('000001', {
				'XHTML/HTMLファイルURL': '',
				'XHTML/HTMLファイル符号化方式': ''
			})
		);
		expect(w.xhtml).toBeUndefined();
		expect(selectBodies([w]).fetch).toEqual([
			{ id: '000001', sources: [expect.objectContaining({ path: 'text' })] }
		]);
	});

	it('本文がなければ、作品は残すが、取りに行かず、目録にも入れない', () => {
		const w = one(
			base('000001', {
				'XHTML/HTMLファイルURL': '',
				'XHTML/HTMLファイル符号化方式': '',
				テキストファイルURL: '',
				テキストファイル符号化方式: ''
			})
		);
		expect(selectBodies([w])).toEqual({
			fetch: [],
			skipped: [{ id: '000001', reason: 'no-body' }]
		});
		expect(buildSearchCatalog([w])).toEqual([]);
	});

	it('公式の同じ人物の files/ の外を指す本文は使わず、理由を残す', () => {
		const external = 'https://example.com/cards/000879/files/1_1.html';
		for (const url of [
			external,
			'http://www.aozora.gr.jp/cards/000879/files/1_1.html',
			'https://www.aozora.gr.jp/cards/000999/files/1_1.html',
			'https://www.aozora.gr.jp/cards/000879/files/1_1.zip',
			'https://www.aozora.gr.jp/cards/000879/files/../1_1.html'
		]) {
			const c = parse(base('000001', { 'XHTML/HTMLファイルURL': url }));
			expect(c.works[0].xhtml, url).toBeUndefined();
			expect(c.works[0].text).toBeDefined();
			expect(c.notes, url).toEqual([
				{ id: '000001', code: 'external-body-url', message: expect.any(String) }
			]);
		}
	});

	it('符号化方式や日付が読めない本文は使わない', () => {
		expect(
			bodies({ 'XHTML/HTMLファイル符号化方式': 'EUC-JP' }).xhtml
		).toBeUndefined();
		expect(
			bodies({ 'XHTML/HTMLファイル符号化方式': '' }).xhtml
		).toBeUndefined();
		expect(bodies({ テキストファイル最終更新日: '' }).text).toBeUndefined();
		expect(
			bodies({ テキストファイル最終更新日: '2025-02-31' }).text
		).toBeUndefined();
		expect(
			bodies({ テキストファイル最終更新日: '2024-02-29' }).text
		).toBeDefined();
		expect(
			bodies({ 'XHTML/HTMLファイル符号化方式': 'UTF-8' }).xhtml?.encoding
		).toBe('UTF-8');
	});

	it('著作権が「あり」の作品は、本文の参照があっても、取りに行く対象に入れない', () => {
		const w = one(base('000001', { 作品著作権フラグ: 'あり' }));
		expect(w.xhtml).toBeDefined();
		expect(selectBodies([w])).toEqual({
			fetch: [],
			skipped: [{ id: '000001', reason: 'copyright-active' }]
		});
	});
});

describe('buildSearchCatalog', () => {
	it('配信してよい作品だけを、行の順によらず作品IDの順に並べ、同じ入力から同じ結果を作る', () => {
		const rows = [
			base('000003'),
			base('000001', { 作品著作権フラグ: 'あり' }),
			base('000002', { 副題: '副題です' })
		];
		const a = buildSearchCatalog(parse(...rows).works);
		const b = buildSearchCatalog(parse(...[...rows].reverse()).works);
		expect(a.map((e) => e.id)).toEqual(['000002', '000003']);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
		expect(a[0]).toMatchObject({
			subtitle: '副題です',
			classification: 'NDC 913'
		});
	});

	it('目録に、本文のURL・図書カードの外の情報・人物ID・著作権フラグを入れない', () => {
		const [entry] = buildSearchCatalog(parse(base('000001')).works);
		const json = JSON.stringify(entry);
		expect(json).not.toContain('http');
		expect(entry).not.toHaveProperty('workCopyright');
		expect(entry.people[0]).not.toHaveProperty('id');
	});
});
