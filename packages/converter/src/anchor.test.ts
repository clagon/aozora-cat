import { describe, expect, it } from 'vitest';
import {
	positionAt,
	restorePosition,
	type Position
} from '../../../src/lib/domain/anchor.ts';
import type { Work } from '../../../src/lib/domain/work.ts';
import { convertText } from './text.ts';
import type { WorkSource } from './types.ts';

const source: WorkSource = {
	id: '000092',
	title: '蜘蛛の糸',
	people: [{ role: 'author', name: '芥川竜之介' }],
	orthography: '新字新仮名',
	workCopyrightFlag: 'なし',
	cardUrl: 'https://www.aozora.gr.jp/cards/000879/card92.html',
	fileUrl: 'https://www.aozora.gr.jp/cards/000879/files/92_ruby_164.zip',
	upstreamUpdated: '2014-09-17'
};
const DASH = '-'.repeat(55);

/** 本文の行から作品を作る。 */
function work(...lines: string[]): Work {
	const text = `題\n著者\n\n${DASH}\n【テキスト中に現れる記号について】\n${DASH}\n${lines.join('\n')}\n底本：x\n`;
	const r = convertText(text, source);
	if (!r.ok) throw new Error(JSON.stringify(r.failure));
	return r.work;
}

const ids = (w: Work) =>
	w.blocks.flatMap((b) =>
		b.kind === 'pageBreak' || b.kind === 'pageCenter' ? [] : [b.id]
	);

const A = '朝のうちは晴れていたのに、昼を過ぎるころから空が重くなってきた。';
const B = '犍陀多《かんだた》は、血の池の底からじっと空を見上げていました。';
const C =
	'極楽の蓮池のふちを、御釈迦様はひとりでぶらぶら歩いていらっしゃいました。';
const D =
	'すると、はるか頭の上に、銀色の蜘蛛の糸が、一すじ細く光りながら下りて来るのでございます。';

describe('block の id', () => {
	it('内容から決まり、前に block が増えても、無関係な block の id は変わらない', () => {
		const before = ids(work(A, B, C));
		const after = ids(work('新しい段落です。', A, B, C));
		expect(before).toHaveLength(3);
		expect(after.slice(1)).toEqual(before);
	});

	it('同じ内容を2回変換すれば、同じ id になる', () => {
		expect(ids(work(A, B))).toEqual(ids(work(A, B)));
	});

	it('同じ内容が重なっても、id は作品の中で重ならない', () => {
		const got = ids(work(A, A, A, '', '', A));
		expect(new Set(got).size).toBe(got.length);
	});

	it('ルビの読みを直しても、親文字が同じなら id は変わらない', () => {
		expect(ids(work(B))).toEqual(ids(work(B.replace('かんだた', 'カンダタ'))));
	});
});

describe('読書位置の移行', () => {
	const old = work(A, B, C, D);
	const save = (w: Work, index: number, offset: number): Position => {
		const p = positionAt(w, ids(w)[index], offset);
		if (!p) throw new Error('位置を作れない');
		return p;
	};

	it('範囲外の位置は作らない', () => {
		expect(positionAt(old, 'p-none', 0)).toBeNull();
		expect(positionAt(old, ids(old)[0], A.length + 1)).toBeNull();
		expect(positionAt(old, ids(old)[0], -1)).toBeNull();
	});

	it('別の段落が増えても減っても、同じ段落と文字位置へ戻る（exact）', () => {
		const saved = save(old, 2, 10);
		const edited = work('前書き', A, B, C, D, '後書き');
		const idsEdited = ids(edited);
		expect(restorePosition(edited, saved)).toEqual({
			how: 'exact',
			blockId: idsEdited[3],
			offset: 10
		});
		expect(restorePosition(work(B, C), saved)).toMatchObject({
			how: 'exact',
			offset: 10
		});
	});

	it('段落の別の場所を直すと、前後の文字から探し直す（context）', () => {
		const saved = save(old, 2, 30);
		// 位置の前後の文字（24字ずつ）より手前を直す。段落の id は変わるが、前後の文字は残る。
		const edited = work(A, B, C.replace('極楽', '極楽浄土'), D);
		const r = restorePosition(edited, saved);
		expect(r).toMatchObject({ how: 'context', blockId: ids(edited)[2] });
		expect(r?.offset).toBe(32);
	});

	it('位置の周りが書き換わると、割合から求め、context にはしない（percent）', () => {
		const saved = save(old, 3, 30);
		const edited = work(
			A,
			B,
			C,
			'全く違う文章に差し替えられました。' + D.slice(40)
		);
		const r = restorePosition(edited, saved);
		expect(r?.how).toBe('percent');
		expect(ids(edited)).toContain(r?.blockId);
	});

	it('前後の文字が複数の場所に見つかるときは、取り違えず割合に任せる', () => {
		const dup = 'いつまでも、いつまでも、いつまでも、続くのでした。';
		const w = work(dup, 'ほかの段落。', dup + 'さらに。');
		const saved = save(w, 0, 6);
		const edited = work(
			'先頭に足した段落。',
			dup + '！',
			'ほかの段落。',
			dup + 'さらに。'
		);
		expect(restorePosition(edited, saved)?.how).toBe('percent');
	});

	it('割合は先頭と末尾に収まる', () => {
		expect(
			restorePosition(old, {
				...save(old, 0, 0),
				blockId: 'p-x',
				before: '',
				after: '',
				percent: 0
			})
		).toMatchObject({ how: 'percent', offset: 0 });
		const last = restorePosition(old, {
			blockId: 'p-x',
			offset: 0,
			before: '',
			after: '',
			percent: 1
		});
		expect(last).toMatchObject({ how: 'percent', blockId: ids(old)[3] });
	});

	it('壊れた保存値は例外にせず、割合に任せる', () => {
		const broken: Position = {
			blockId: ids(old)[0],
			offset: -5,
			before: 'x'.repeat(100),
			after: '',
			percent: Number.NaN
		};
		expect(restorePosition(old, broken)).toMatchObject({
			how: 'percent',
			offset: 0
		});
	});

	it('文字のない作品には戻せない', () => {
		expect(restorePosition(work(''), save(old, 0, 0))).toBeNull();
	});
});
