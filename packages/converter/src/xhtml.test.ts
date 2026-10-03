import { describe, expect, it } from 'vitest';
import { convertXhtml } from './xhtml.ts';
import type { WorkSource } from './types.ts';

const source: WorkSource = {
	id: '000092',
	title: '蜘蛛の糸',
	people: [{ role: 'author', name: '芥川竜之介' }],
	orthography: '新字新仮名',
	workCopyrightFlag: 'なし',
	cardUrl: 'https://www.aozora.gr.jp/cards/000879/card92.html',
	fileUrl: 'https://www.aozora.gr.jp/cards/000879/files/92_14545.html',
	upstreamUpdated: '2014-09-17'
};

const gaijiUrl = 'https://www.aozora.gr.jp/gaiji/1-87/1-87-71.png';
const gaijiImg =
	'<img src="../../../gaiji/1-87/1-87-71.png" alt="※(「特のへん＋廴＋聿」、第3水準1-87-71)" class="gaiji" />';
const gaiji = {
	kind: 'gaiji',
	description: '※(「特のへん＋廴＋聿」、第3水準1-87-71)',
	image: { url: gaijiUrl }
};
const fig = (name: string, w = 100, h = 50) =>
	`<img class="illustration" width="${w}" height="${h}" src="${name}" alt="図" />`;

/** 公式XHTMLと同じ骨格に、本文だけを差し込む。 */
function page(
	main: string,
	tail = '',
	bibliography = '底本：「蜘蛛の糸・杜子春」新潮文庫、新潮社<br />\n　　　1968（昭和43）年11月20日発行<br />\n入力：作業者<br />\n<br />'
) {
	return `<?xml version="1.0" encoding="Shift_JIS"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja">
<head>
<meta http-equiv="Content-Type" content="text/html;charset=Shift_JIS" />
<link rel="stylesheet" type="text/css" href="../../aozora.css" />
<title>芥川龍之介 蜘蛛の糸</title>
<script type="text/javascript" src="../../jquery-1.4.2.min.js"></script>
</head>
<body>
<div class="metadata">
<h1 class="title">蜘蛛の糸</h1>
<h2 class="author">芥川龍之介</h2>
<br />
<br />
</div>
<div id="contents" style="display:none"></div><div class="main_text">${main}</div>
<div class="bibliographical_information">
<hr />
<br />
${bibliography}
</div>
<div class="notation_notes">
<hr />
<br />
●表記について<br />
<ul>
	<li>このファイルは W3C 勧告 XHTML1.1 にそった形式で作成されています。</li>
</ul>
</div>
<div id="card">
<hr />
<br />
<a href="JavaScript:goLibCard();" id="goAZLibCard">●図書カード</a><script type="text/javascript" src="../../contents.js"></script>
</div>${tail}</body>
</html>
`;
}

function ok(main: string) {
	const r = convertXhtml(page(main), source);
	if (!r.ok) throw new Error(`変換に失敗: ${JSON.stringify(r.failure)}`);
	return r;
}

function failure(main: string, tail = '') {
	const r = convertXhtml(page(main, tail), source);
	expect(r.ok, '失敗するはずの入力が通った').toBe(false);
	return r.ok ? undefined : r.failure;
}

const text = (t: string) => ({ kind: 'text', text: t });

describe('convertXhtml: 本文', () => {
	it('見出し・ルビ・外字・段落を、意味を保った形へ変換する', () => {
		const { work } = ok(`<br />
<div class="jisage_8" style="margin-left: 8em"><h4 class="naka-midashi"><a class="midashi_anchor" id="midashi10">一</a></h4></div>
<br />
ある日の事でございます。御釈迦様は極楽の<ruby><rb>蓮池</rb><rp>（</rp><rt>はすいけ</rt><rp>）</rp></ruby>のふちを、${gaijiImg}陀多と云う男がいました。<br />
`);
		expect(work.blocks).toEqual([
			{ kind: 'paragraph', id: 'p1', layout: { kind: 'none' }, inline: [] },
			{
				kind: 'heading',
				id: 'p2',
				level: 'medium',
				layout: { kind: 'indent', chars: 8 },
				inline: [text('一')]
			},
			{ kind: 'paragraph', id: 'p3', layout: { kind: 'none' }, inline: [] },
			{
				kind: 'paragraph',
				id: 'p4',
				layout: { kind: 'none' },
				inline: [
					text('ある日の事でございます。御釈迦様は極楽の'),
					{ kind: 'ruby', base: [text('蓮池')], reading: 'はすいけ' },
					text('のふちを、'),
					gaiji,
					text('陀多と云う男がいました。')
				]
			}
		]);
	});

	it('来歴・底本情報・出典を残し、表記の定型文と図書カードのリンクは含めない', () => {
		const r = ok('本文<br />');
		expect(r.work.provenance).toEqual({
			copyright: { work: 'なし' },
			source: {
				cardUrl: source.cardUrl,
				fileUrl: source.fileUrl,
				upstreamUpdated: '2014-09-17'
			},
			converter: { version: '1.0.0', path: 'xhtml' },
			bibliography: [
				'底本：「蜘蛛の糸・杜子春」新潮文庫、新潮社',
				'　　　1968（昭和43）年11月20日発行',
				'入力：作業者'
			]
		});
		expect(JSON.stringify(r.work)).not.toContain('XHTML1.1');
		expect(r.diagnostics.map((d) => d.code)).toEqual(
			expect.arrayContaining(['section-ignored', 'active-content-removed'])
		);
	});

	it('改行1つで段落が終わり、続く改行は空行になる', () => {
		const { work } = ok('一<br />二<br /><br />三');
		expect(work.blocks.map((b) => b.kind === 'paragraph' && b.inline)).toEqual([
			[text('一')],
			[text('二')],
			[],
			[text('三')]
		]);
	});

	it('ブロックの直後の改行は空行にする（見出しの後など）', () => {
		const { work } = ok(
			'<div class="jisage_2" style="margin-left: 2em"><h3 class="o-midashi"><a class="midashi_anchor" id="midashi1">上</a></h3></div><br />本文<br />'
		);
		expect(work.blocks.map((b) => b.kind)).toEqual([
			'heading',
			'paragraph',
			'paragraph'
		]);
	});

	it('ソースの改行・復帰は文字に含めず、rp は捨てる', () => {
		const { work } = ok(
			'あ\r\nい<ruby><rb>漢</rb>\n<rp>（</rp><rt>かん</rt><rp>）</rp></ruby>う<br />'
		);
		expect(work.blocks[0]).toMatchObject({
			inline: [
				text('あい'),
				{ kind: 'ruby', base: [text('漢')], reading: 'かん' },
				text('う')
			]
		});
	});

	it('字下げ・地付き・ぶら下げを字数で残す', () => {
		const { work } = ok(
			[
				'<div class="jisage_3" style="margin-left: 3em">下げ<br /></div>',
				'<div class="chitsuki_2" style="text-align:right; margin-right: 2em">付き<br /></div>',
				'<div class="burasage" style="margin-left: 3em; text-indent: -1em;">ぶら<br /></div>'
			].join('\n')
		);
		expect(work.blocks.map((b) => b.kind === 'paragraph' && b.layout)).toEqual([
			{ kind: 'indent', chars: 3 },
			{ kind: 'end', inset: 2 },
			{ kind: 'hanging', indent: 3, first: 1 }
		]);
	});

	it('傍点9種・傍線5種と左右の側を、公式のクラス名から対応づける', () => {
		const cases: Record<string, [string, string]> = {
			sesame_dot: ['sesame', 'right'],
			white_sesame_dot: ['whiteSesame', 'right'],
			black_circle: ['blackCircle', 'right'],
			white_circle: ['whiteCircle', 'right'],
			'black_up-pointing_triangle': ['blackTriangle', 'right'],
			'white_up-pointing_triangle': ['whiteTriangle', 'right'],
			bullseye: ['bullseye', 'right'],
			fisheye: ['fisheye', 'right'],
			saltire: ['saltire', 'right'],
			sesame_dot_after: ['sesame', 'left'],
			saltire_after: ['saltire', 'left'],
			underline_solid: ['solid', 'right'],
			underline_double: ['double', 'right'],
			underline_dotted: ['dotted', 'right'],
			underline_dashed: ['dashed', 'right'],
			underline_wave: ['wave', 'right'],
			overline_solid: ['solid', 'left'],
			overline_wave: ['wave', 'left']
		};
		for (const [cls, [mark, side]] of Object.entries(cases)) {
			const { work } = ok(`<em class="${cls}">強</em><br />`);
			expect(work.blocks[0], cls).toMatchObject({
				inline: [{ kind: 'emphasis', mark, side, children: [text('強')] }]
			});
		}
	});

	it('太字・罫囲み・割注・上付き・下付き・横組み・縦中横・大小の文字を残す', () => {
		const { work } = ok(
			[
				'<span class="futoji">太</span>',
				'<span class="keigakomi">枠</span>',
				'<span class="warichu">割</span>',
				'<sup class="superscript">上</sup>',
				'<sub class="subscript">下</sub>',
				'<span class="yokogumi">横</span>',
				'<span dir="ltr">12</span>',
				'<span class="dai2">大</span>',
				'<span class="sho3">小</span><br />'
			].join('')
		);
		expect(work.blocks[0]).toMatchObject({
			inline: [
				{ kind: 'strong', children: [text('太')] },
				{ kind: 'frame', children: [text('枠')] },
				{ kind: 'warichu', children: [text('割')] },
				{ kind: 'superscript', children: [text('上')] },
				{ kind: 'subscript', children: [text('下')] },
				{ kind: 'horizontal', children: [text('横')] },
				{ kind: 'tcy', children: [text('12')] },
				{ kind: 'size', direction: 'larger', step: 2, children: [text('大')] },
				{ kind: 'size', direction: 'smaller', step: 3, children: [text('小')] }
			]
		});
	});

	it('ルビの親文字に外字や装飾を入れられる', () => {
		const { work } = ok(
			`<ruby><rb>${gaijiImg}陀多</rb><rp>（</rp><rt>かんだた</rt><rp>）</rp></ruby><br />`
		);
		expect(work.blocks[0]).toMatchObject({
			inline: [
				{ kind: 'ruby', base: [gaiji, text('陀多')], reading: 'かんだた' }
			]
		});
	});

	it('改ページ類と左右中央を構造として残し、その行の改行を空行にしない', () => {
		const { work } = ok(
			[
				'前<br />',
				'<span class="notes">［＃改ページ］</span><br />',
				'<span class="notes">［＃改丁］</span><br />',
				'<span class="notes">［＃改見開き］</span><br />',
				'<span class="notes">［＃改段］</span><br />',
				'<span class="notes">［＃ページの左右中央］</span><br />',
				'後<br />'
			].join('\n')
		);
		expect(
			work.blocks.map((b) => (b.kind === 'pageBreak' ? b.style : b.kind))
		).toEqual([
			'paragraph',
			'page',
			'leaf',
			'spread',
			'column',
			'pageCenter',
			'paragraph'
		]);
	});

	it('行の途中の注記は、捨てずに注記として残す', () => {
		const { work } = ok(
			'<ruby><rb>甍</rb><rp>（</rp><rt>いらか</rt><rp>）</rp></ruby><span class="notes">［＃「甍の」は底本では「薨の」］</span>先<br />'
		);
		expect(work.blocks[0]).toMatchObject({
			inline: [
				{ kind: 'ruby' },
				{ kind: 'note', text: '［＃「甍の」は底本では「薨の」］' },
				text('先')
			]
		});
	});

	it('挿絵だけの行は figure、文中の画像は行内の image、字下げの中は段落に残す', () => {
		const { work } = ok(
			[
				`${fig('fig92_01.png', 320, 640)}<br />`,
				`文中${fig('fig92_02.png')}の図<br />`,
				`<div class="jisage_2" style="margin-left: 2em">${fig('fig92_03.png')}<br /></div>`
			].join('\n')
		);
		expect(work.blocks[0]).toMatchObject({
			kind: 'figure',
			image: {
				url: 'https://www.aozora.gr.jp/cards/000879/files/fig92_01.png'
			},
			size: { width: 320, height: 640 },
			caption: []
		});
		expect(work.blocks[1]).toMatchObject({
			inline: [text('文中'), { kind: 'image' }, text('の図')]
		});
		expect(work.blocks[2]).toMatchObject({
			kind: 'paragraph',
			layout: { kind: 'indent', chars: 2 },
			inline: [{ kind: 'image' }]
		});
	});

	it('挿絵に続くキャプション行を、その挿絵のキャプションにする', () => {
		const { work } = ok(
			`${fig('fig92_01.png')}<br />\n<span class="caption">第一七圖　勾玉</span><br />\n次<br />`
		);
		expect(work.blocks).toHaveLength(2);
		expect(work.blocks[0]).toMatchObject({
			kind: 'figure',
			caption: [text('第一七圖　勾玉')]
		});
	});

	it('同じ入力からは、同じ出力になる', () => {
		const main = `<em class="sesame_dot">あ</em>${gaijiImg}<br />${fig('fig92_01.png')}<br />`;
		expect(JSON.stringify(ok(main))).toBe(JSON.stringify(ok(main)));
	});
});

describe('convertXhtml: 安全', () => {
	it('スクリプト・埋め込み・フォーム・イベント属性・javascript: を出力へ入れず、取り除いたことを記録する', () => {
		const r = ok(
			[
				'<script>alert(1)</script>安全<br />',
				'<iframe src="https://evil.example/"></iframe>',
				'<object data="x"></object><embed src="x" />',
				'<form action="https://evil.example/"><input name="x" /></form>',
				'<style>body{display:none}</style>',
				'<span class="futoji" onclick="alert(1)" style="position:fixed" data-x="1">太</span>',
				'<a href="javascript:alert(1)" onmouseover="x()">リンク</a><br />',
				'<a href="https://evil.example/">外部</a><br />'
			].join('\n')
		);
		const out = JSON.stringify(r.work);
		for (const bad of [
			'script',
			'alert',
			'iframe',
			'evil.example',
			'onclick',
			'javascript',
			'<object',
			'<form',
			'position:fixed'
		])
			expect(out, bad).not.toContain(bad);
		expect(out).toContain('安全');
		expect(out).toContain('リンク');
		const codes = r.diagnostics.map((d) => d.code);
		expect(codes).toContain('active-content-removed');
		expect(codes).toContain('attribute-dropped');
		expect(codes).toContain('link-removed');
		// イベント属性と javascript: は、実行につながるものとして区別して記録する。
		const active = r.diagnostics.filter(
			(d) => d.code === 'active-content-removed'
		);
		expect(active.some((d) => d.message.includes('onclick'))).toBe(true);
		expect(active.some((d) => d.message.includes('onmouseover'))).toBe(true);
		for (const d of r.diagnostics) expect(d.location).toMatch(/^L\d+:C\d+ </);
	});

	it('装飾や見出しの中のスクリプトも取り除く', () => {
		const r = ok(
			'<em class="sesame_dot">あ<script>alert(1)</script>い</em><br /><div class="jisage_2" style="margin-left: 2em"><h3 class="o-midashi"><a class="midashi_anchor" id="m1">見<iframe src="x"></iframe>出</a></h3></div>'
		);
		const out = JSON.stringify(r.work);
		expect(out).not.toContain('alert');
		expect(out).not.toContain('iframe');
		expect(out).toContain('あい');
		expect(out).toContain('見出');
	});

	it('青空文庫の外の画像は、変換器が invalid-image として止める', () => {
		for (const src of [
			'javascript:alert(1)',
			'data:image/svg+xml,<svg/>',
			'//evil.example/a.png',
			'http://www.aozora.gr.jp/gaiji/a.png',
			'https://evil.example/gaiji/a.png',
			'https://www.aozora.gr.jp.evil.example/gaiji/a.png'
		]) {
			expect(
				failure(`<img src="${src}" alt="外字" class="gaiji" /><br />`)?.code,
				src
			).toBe('invalid-image');
		}
	});

	it('青空文庫の外や安全でない画像の参照を、場所つきで拒否する', () => {
		const bad = [
			'javascript:alert(1)',
			'data:image/svg+xml,<svg/>',
			'//evil.example/a.png',
			'http://www.aozora.gr.jp/gaiji/a.png',
			'https://evil.example/gaiji/a.png',
			'https://www.aozora.gr.jp.evil.example/gaiji/a.png',
			'../../../../../../etc/passwd',
			'../../../gaiji/a.svg',
			''
		];
		for (const src of bad) {
			const f = failure(`<img src="${src}" alt="外字" class="gaiji" /><br />`);
			expect(f?.code, src).toMatch(/invalid-image|schema/);
			expect(f?.location).toBeTruthy();
		}
		const f = failure(
			`<img class="illustration" width="10" height="x" src="a.png" alt="" /><br />`
		);
		expect(f?.code).toBe('invalid-image');
	});

	it('著作権フラグが「なし」でない作品は、本文を読む前に失敗する', () => {
		for (const flag of ['あり', '', 'なし ']) {
			const r = convertXhtml('<<<壊れた入力', {
				...source,
				workCopyrightFlag: flag
			});
			expect(r).toMatchObject({
				ok: false,
				failure: { code: 'copyright-active' }
			});
		}
	});
});

describe('convertXhtml: 未知の構成は閉じて失敗する', () => {
	const cases: [string, string, string][] = [
		['未知の要素', '<p>段落</p>', 'unknown-element'],
		['表', '<table><tr><td>x</td></tr></table>', 'unknown-element'],
		['未知の span', '<span class="mystery">x</span><br />', 'unknown-class'],
		['class のない span', '<span>x</span><br />', 'unknown-class'],
		['未知の強調', '<em class="wavy">x</em><br />', 'unknown-class'],
		['未知の上付き', '<sup class="x">x</sup><br />', 'unknown-class'],
		['未知の画像', '<img src="a.png" alt="x" /><br />', 'unknown-class'],
		[
			'大きさの段階の範囲外',
			'<span class="dai6">x</span><br />',
			'unknown-class'
		],
		[
			'ブロックの罫囲み',
			'<div class="keigakomi" style="border: solid 1px">x<br /></div>',
			'unknown-class'
		],
		[
			'ブロックの横組み',
			'<div class="yokogumi">x<br /></div>',
			'unknown-class'
		],
		[
			'字詰め',
			'<div class="jizume_10" style="width: 10em">x<br /></div>',
			'unknown-class'
		],
		[
			'窓見出し',
			'<h5 class="mado-ko-midashi"><a class="midashi_anchor" id="m1">x</a></h5>',
			'unknown-class'
		],
		['同行見出し', '<h3 class="dogyo-o-midashi">x</h3>', 'unknown-class'],
		[
			'字下げの指定が読めない',
			'<div class="jisage_3" style="margin-left: 4em">x<br /></div>',
			'invalid-layout'
		],
		[
			'字下げの style がない',
			'<div class="jisage_3">x<br /></div>',
			'invalid-layout'
		],
		[
			'字下げの入れ子',
			'<div class="jisage_1" style="margin-left: 1em"><div class="jisage_2" style="margin-left: 2em">x<br /></div></div>',
			'unsupported-construct'
		],
		[
			'挿絵のないキャプション',
			'<span class="caption">x</span><br />',
			'unsupported-construct'
		],
		[
			'文の途中のキャプション',
			`文<span class="caption">x</span><br />`,
			'unsupported-construct'
		],
		[
			'読みに画像のあるルビ',
			`<ruby><rb>漢</rb><rp>（</rp><rt>${gaijiImg}</rt><rp>）</rp></ruby>`,
			'unsupported-construct'
		],
		['読みのないルビ', '<ruby><rb>漢</rb></ruby>', 'unsupported-construct'],
		[
			'読みが複数のルビ',
			'<ruby><rb>漢</rb><rt>かん</rt><rt>kan</rt></ruby>',
			'unsupported-construct'
		],
		[
			'親文字が複数のルビ',
			'<ruby><rb>漢</rb><rb>字</rb><rt>かんじ</rt></ruby>',
			'unsupported-construct'
		],
		[
			'括弧以外のある rp',
			'<ruby><rb>漢</rb><rp>隠れた文字</rp><rt>かん</rt></ruby>',
			'unsupported-construct'
		],
		[
			'注記の中の読みが複数のルビ',
			'<span class="notes">［＃「<ruby><rb>漢</rb><rt>a</rt><rt>b</rt></ruby>」］</span>',
			'unsupported-construct'
		],
		[
			'ルビの中の未知の要素',
			'<ruby><rb>漢</rb><b>x</b><rt>かん</rt></ruby>',
			'unknown-element'
		],
		[
			'ルビの入れ子',
			'<ruby><rb><ruby><rb>漢</rb><rt>かん</rt></ruby></rb><rt>x</rt></ruby>',
			'unsupported-construct'
		],
		[
			'装飾の中の改行',
			'<em class="sesame_dot">あ<br />い</em>',
			'unknown-element'
		]
	];
	for (const [name, main, code] of cases) {
		it(name, () => {
			const f = failure(main);
			expect(f?.code).toBe(code);
			expect(f?.location).toMatch(/^L\d+:C\d+ </);
		});
	}

	it('底本情報の中の未知の要素は、平らにせず失敗させる', () => {
		for (const bib of [
			'<table><tr><td>底本</td></tr></table>',
			'<ul><li>底本</li></ul>',
			'<img src="x.png" alt="底本" />',
			'<b>底本</b>'
		]) {
			const r = convertXhtml(page('x<br />', '', bib), source);
			expect(r, bib).toMatchObject({
				ok: false,
				failure: { code: 'unknown-element' }
			});
		}
		// リンクと外字の画像は、文字として残す。
		const r = convertXhtml(
			page(
				'x<br />',
				'',
				`底本：<a href="https://x.example/">本</a>${gaijiImg}<br />`
			),
			source
		);
		expect(r.ok && r.work.provenance.bibliography).toEqual([
			'底本：本※(「特のへん＋廴＋聿」、第3水準1-87-71)'
		]);
	});

	it('［＃本文終わり］のある作品の after_text を、底本情報の代わりに受け取る', () => {
		const withAfter = page('x<br />').replace(
			/<div class="bibliographical_information">[\s\S]*?<\/div>/,
			'<div class="after_text">\n<hr />\n<br />\n入力：富田倫生<br />\n校正：富田倫生<br />\n</div>'
		);
		const r = convertXhtml(withAfter, source);
		expect(r.ok && r.work.provenance.bibliography).toEqual([
			'入力：富田倫生',
			'校正：富田倫生'
		]);
		// 底本情報と after_text が両方あるものは、どちらを採るか決められないので失敗させる。
		expect(
			failure('x<br />', '<div class="after_text">x<br /></div>')?.code
		).toBe('unsupported-construct');
	});

	it('注記の中の文字以外は、文字に平らにせず失敗させる', () => {
		for (const inner of [
			'<b>文字</b>',
			'<img src="a.png" alt="文字" />',
			'<ruby><rb>漢</rb><b>x</b><rt>かん</rt></ruby>'
		]) {
			expect(
				failure(`<span class="notes">［＃${inner}］</span><br />`)?.code,
				inner
			).toMatch(/unsupported-construct|unknown-element/);
			expect(
				failure(
					`<em class="sesame_dot">あ<span class="notes">［＃${inner}］</span></em><br />`
				)?.code,
				inner
			).toMatch(/unsupported-construct|unknown-element/);
		}
		// 底本との差異を引用する注記のルビは、青空文庫の記法（親文字《読み》）で残す。
		const quoted = ok(
			'<span class="notes">［＃「<ruby><rb>物云う</rb><rp>（</rp><rt>テルテール</rt><rp>）</rp></ruby>」は底本では「物云う」］</span>あ<br />'
		);
		expect(quoted.work.blocks[0]).toMatchObject({
			inline: [
				{
					kind: 'note',
					text: '［＃「物云う《テルテール》」は底本では「物云う」］'
				},
				text('あ')
			]
		});
		// 外字の画像は、説明文を注記の文字として残す。
		const { work } = ok(
			`<span class="notes">［＃左に「${gaijiImg}」の注記付き終わり］</span>あ<br />`
		);
		expect(work.blocks[0]).toMatchObject({
			inline: [
				{ kind: 'note', text: expect.stringContaining('※(「特のへん') },
				text('あ')
			]
		});
	});

	it('同じセクションの重複は、前のものを上書きせず失敗させる', () => {
		for (const dup of [
			'<div class="main_text"></div>',
			'<div class="bibliographical_information"></div>'
		])
			expect(failure('x<br />', dup)?.code).toBe('unsupported-construct');
	});

	it('セクションの外の文字は、捨てずに失敗させる', () => {
		expect(failure('x<br />', '途中で閉じたあとの本文')?.code).toBe(
			'unknown-section'
		);
	});

	it('深い入れ子は、例外にせず失敗として返す', () => {
		for (const depth of [20, 200, 20000]) {
			const nested =
				'<span class="futoji">'.repeat(depth) + 'x' + '</span>'.repeat(depth);
			const r = convertXhtml(page(`${nested}<br />`), source);
			expect(r.ok, `depth ${depth}`).toBe(false);
		}
		const notes = `<span class="notes">${'<b>'.repeat(20000)}x</span><br />`;
		expect(convertXhtml(page(notes), source).ok).toBe(false);
	});

	it('説明のない外字は、注記・底本情報でも文字を消さずに失敗させる', () => {
		const bare = '<img src="../../../gaiji/1-87/1-87-71.png" class="gaiji" />';
		expect(
			failure(`<span class="notes">［＃「${bare}」］</span><br />`)?.code
		).toBe('invalid-image');
		const r = convertXhtml(page('x<br />', '', `底本${bare}<br />`), source);
		expect(r).toMatchObject({ ok: false, failure: { code: 'invalid-image' } });
	});

	it('注記・底本情報の中の外字も、画像の参照を確かめてから文字にする', () => {
		const bad = [
			'',
			'https://evil.example/gaiji/a.png',
			'javascript:alert(1)',
			'../../../gaiji/a.svg',
			'a.png'
		];
		for (const src of bad) {
			const img = `<img src="${src}" alt="外字" class="gaiji" />`;
			expect(
				failure(`<span class="notes">［＃「${img}」］</span><br />`)?.code,
				src
			).toBe('invalid-image');
			const r = convertXhtml(page('x<br />', '', `底本${img}<br />`), source);
			expect(r, src).toMatchObject({
				ok: false,
				failure: { code: 'invalid-image' }
			});
		}
	});

	it('属性にだけ文字のある実行要素も、中身ごと捨てずに失敗にする', () => {
		for (const el of [
			'<form><input value="底本：本文" /></form>',
			'<input value="底本：本文" />',
			'<object><img src="a.png" alt="本文" /></object>',
			'<form><input title="本文" /></form>'
		]) {
			expect(failure(`${el}<br />`)?.code, el).toBe('unsupported-construct');
			const r = convertXhtml(
				page('x<br />', '', `底本：x<br />${el}<br />`),
				source
			);
			expect(r, el).toMatchObject({
				ok: false,
				failure: { code: 'unsupported-construct' }
			});
		}
	});

	it('空白だけの説明の外字と、正規でない URL の外字は、注記・底本情報で失敗にする', () => {
		for (const [src, alt] of [
			['../../../gaiji/a.png', '　'],
			['../../../gaiji/a.png', '  '],
			['../../../gaiji/a.png?tracking=1', '外字'],
			['../../../gaiji/a.png#x', '外字'],
			['https://user@www.aozora.gr.jp/gaiji/a.png', '外字'],
			['https://www.aozora.gr.jp:8443/gaiji/a.png', '外字']
		]) {
			const img = `<img src="${src}" alt="${alt}" class="gaiji" />`;
			expect(
				failure(`<span class="notes">［＃「${img}」］</span><br />`)?.code,
				`${src} ${alt}`
			).toBe('invalid-image');
			const r = convertXhtml(page('x<br />', '', `底本${img}<br />`), source);
			expect(r, `${src} ${alt}`).toMatchObject({
				ok: false,
				failure: { code: 'invalid-image' }
			});
		}
	});

	it('本文の外字も、空白だけの説明を失敗にする', () => {
		for (const alt of ['　', ' ', '  ']) {
			expect(
				failure(
					`<img src="../../../gaiji/a.png" alt="${alt}" class="gaiji" /><br />`
				)?.code,
				JSON.stringify(alt)
			).toBe('invalid-image');
		}
	});

	it('文書の外枠（html・body）と head の実行につながるものも記録する', () => {
		const r = convertXhtml(
			page('x<br />')
				.replace('<body>', '<body onload="a()">')
				.replace(
					'<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja">',
					'<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ja" onclick="b()">'
				),
			source
		);
		const messages = r.ok
			? r.diagnostics
					.filter((d) => d.code === 'active-content-removed')
					.map((d) => d.message)
					.join('\n')
			: '';
		for (const needle of ['onload', 'onclick', '<script>', '<link>', '<meta>'])
			expect(messages, needle).toContain(needle);
	});

	it('取り込まないセクションの中の、実行につながる属性も記録する', () => {
		const r = convertXhtml(
			page('x<br />').replace(
				'<h1 class="title">',
				'<h1 class="title" onclick="x()">'
			),
			source
		);
		expect(
			r.ok &&
				r.diagnostics.some(
					(d) =>
						d.code === 'active-content-removed' && d.message.includes('onclick')
				)
		).toBe(true);
	});

	it('取り込まないセクションの中の実行につながるものも記録する', () => {
		const withActive = page('x<br />')
			.replace(
				'<h2 class="author">芥川龍之介</h2>',
				'<h2 class="author">芥川龍之介</h2><script>a()</script>'
			)
			.replace(
				'<ul>',
				'<iframe src="x"></iframe><a href="javascript:b()">x</a><ul>'
			);
		const r = convertXhtml(withActive, source);
		const active = r.ok
			? r.diagnostics.filter((d) => d.code === 'active-content-removed')
			: [];
		for (const tag of ['<script>', '<iframe>', '属性 href'])
			expect(
				active.some((d) => d.message.includes(tag)),
				tag
			).toBe(true);
	});

	it('セクションの外枠の実行につながる属性も記録する', () => {
		const withAttrs = page('x<br />')
			.replace(
				'<div class="main_text">',
				'<div class="main_text" onclick="a()">'
			)
			.replace(
				'<div class="bibliographical_information">',
				'<div class="bibliographical_information" onmouseover="b()" title="t">'
			);
		const r = convertXhtml(withAttrs, source);
		expect(r.ok).toBe(true);
		const messages = r.ok ? r.diagnostics.map((d) => d.message).join('\n') : '';
		for (const name of ['onclick', 'onmouseover', 'title'])
			expect(messages, name).toContain(name);
		// 公式のファイルにある定型の属性は、記録しない。
		const plain = convertXhtml(page('x<br />'), source);
		expect(
			plain.ok && plain.diagnostics.some((d) => d.code === 'attribute-dropped')
		).toBe(false);
	});

	it('底本情報の罫線は行の区切りで、前後の記載事項を連結しない', () => {
		const r = convertXhtml(
			page('x<br />', '', '<hr />底本：A<hr />入力：B<br />校正：C'),
			source
		);
		expect(r.ok && r.work.provenance.bibliography).toEqual([
			'底本：A',
			'入力：B',
			'校正：C'
		]);
	});

	it('表示される文字を含む実行要素は、中身ごと捨てずに失敗にする', () => {
		for (const el of [
			'<form>底本：本文</form>',
			'<noscript>本文</noscript>',
			'<iframe>本文</iframe>',
			'<object><b>本文</b></object>'
		]) {
			expect(failure(`${el}<br />`)?.code, el).toBe('unsupported-construct');
			expect(
				failure(`あ<em class="sesame_dot">${el}</em><br />`)?.code,
				el
			).toBe('unsupported-construct');
			const r = convertXhtml(
				page('x<br />', '', `底本：x<br />${el}<br />`),
				source
			);
			expect(r, el).toMatchObject({
				ok: false,
				failure: { code: 'unsupported-construct' }
			});
		}
		// 文字を含まない要素と、コードの要素は、記録して取り除く。
		for (const el of [
			'<iframe src="x"></iframe>',
			'<script>alert(1)</script>',
			'<style>a{}</style>',
			'<form><input name="x" /></form>'
		])
			expect(ok(`あ${el}<br />`).diagnostics.length, el).toBeGreaterThan(0);
	});

	it('rp の中の要素、注記の中の入れ子のルビを失敗にし、注記の外字の属性も記録する', () => {
		for (const rp of [
			'<img src="a.png" alt="（" />',
			'<script>alert(1)</script>',
			'<b>（</b>'
		])
			expect(
				failure(`<ruby><rb>漢</rb><rp>${rp}</rp><rt>かん</rt></ruby>`)?.code,
				rp
			).toBe('unsupported-construct');
		expect(
			failure(
				'<span class="notes">［＃「<ruby><rb><ruby><rb>漢</rb><rt>かん</rt></ruby></rb><rt>x</rt></ruby>」］</span>'
			)?.code
		).toBe('unsupported-construct');
		const r = ok(
			`<span class="notes">［＃「${gaijiImg.replace('/>', 'onerror="x()" />')}」］</span>あ<br />`
		);
		expect(
			r.diagnostics.some(
				(d) =>
					d.code === 'active-content-removed' && d.message.includes('onerror')
			)
		).toBe(true);
	});

	it('リンクの javascript: は、イベント属性がなくても実行につながるものとして記録する', () => {
		const r = ok('<a href="javascript:alert(1)">リンク</a><br />');
		const codes = r.diagnostics.map((d) => d.code);
		expect(codes).toContain('link-removed');
		expect(
			r.diagnostics.some(
				(d) => d.code === 'active-content-removed' && d.message.includes('href')
			)
		).toBe(true);
		// 通常のリンクは、実行につながるものとして記録しない（図書カードのセクションの分だけ）。
		const hrefs = (x: ReturnType<typeof ok>) =>
			x.diagnostics.filter(
				(d) => d.code === 'active-content-removed' && d.message.includes('href')
			).length;
		const base = ok('あ<br />');
		const plain = ok('<a href="https://x.example/">リンク</a><br />');
		expect(hrefs(plain)).toBe(hrefs(base));
		expect(hrefs(r)).toBe(hrefs(base) + 1);
	});

	it('底本情報の中のリンクの実行につながる属性も記録する', () => {
		const r = convertXhtml(
			page(
				'x<br />',
				'',
				'底本：<a href="javascript:alert(1)" onclick="x()">本</a><br />'
			),
			source
		);
		expect(r.ok).toBe(true);
		const active = r.ok
			? r.diagnostics.filter((d) => d.code === 'active-content-removed')
			: [];
		expect(active.some((d) => d.message.includes('href'))).toBe(true);
		expect(active.some((d) => d.message.includes('onclick'))).toBe(true);
	});

	it('要素が非常に多くても、例外にせず結果を返す', () => {
		const wide = '<span class="futoji">あ</span>'.repeat(150000);
		for (const wrap of [
			(x: string) => x,
			(x: string) => `<a href="x">${x}</a>`
		]) {
			const r = convertXhtml(page(`${wrap(wide)}<br />`), source);
			expect(r.ok).toBe(true);
		}
	});

	it('未知のセクションと、必須のセクションの欠落', () => {
		expect(failure('x<br />', '<div class="advert">x</div>')?.code).toBe(
			'unknown-section'
		);
		const noMain = convertXhtml(
			'<html><body><div class="bibliographical_information">x</div></body></html>',
			source
		);
		expect(noMain).toMatchObject({
			ok: false,
			failure: { code: 'missing-section' }
		});
		const noBib = convertXhtml(
			'<html><body><div class="main_text">x</div></body></html>',
			source
		);
		expect(noBib).toMatchObject({
			ok: false,
			failure: { code: 'missing-section' }
		});
	});

	it('来歴が作品と合わない場合は、スキーマの関門で止まる', () => {
		const r = convertXhtml(page('x<br />'), {
			...source,
			cardUrl: 'https://www.aozora.gr.jp/cards/000148/card773.html'
		});
		expect(r).toMatchObject({
			ok: false,
			failure: { code: 'schema', location: '$.provenance.source.cardUrl' }
		});
	});

	it('失敗の場所は、元ファイルの行と列を指す', () => {
		const f = failure('一<br />\n二<br />\n<p>三</p>');
		const lines = page('一<br />\n二<br />\n<p>三</p>').split('\n');
		const line = lines.findIndex((l) => l.includes('<p>三</p>')) + 1;
		expect(f?.location).toMatch(new RegExp(`^L${line}:C\\d+ <p>`));
	});
});
