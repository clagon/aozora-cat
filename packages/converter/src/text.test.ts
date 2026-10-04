import { describe, expect, it } from 'vitest';
import { convertText } from './text.ts';
import { convertXhtml } from './xhtml.ts';
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
const xhtmlSource: WorkSource = {
	...source,
	fileUrl: 'https://www.aozora.gr.jp/cards/000879/files/92_14545.html'
};

const DASH = '-------------------------------------------------------';
const BIB = '底本：「蜘蛛の糸・杜子春」新潮文庫、新潮社\n入力：作業者';

/** 青空文庫形式のテキストの骨格に、本文だけを差し込む。 */
function file(body: string, footer = BIB) {
	return `蜘蛛の糸\n芥川龍之介\n\n${DASH}\n【テキスト中に現れる記号について】\n\n《》：ルビ\n（例）蓮池《はすいけ》のふち\n${DASH}\n${body}\n${footer}\n`;
}

function ok(body: string) {
	const r = convertText(file(body), source);
	if (!r.ok) throw new Error(`変換に失敗: ${JSON.stringify(r.failure)}`);
	return r;
}

function failure(body: string, footer?: string) {
	const r = convertText(file(body, footer), source);
	expect(r.ok, '失敗するはずの入力が通った').toBe(false);
	return r.ok ? undefined : r.failure;
}

const text = (t: string) => ({ kind: 'text', text: t });
const gaijiUrl = 'https://www.aozora.gr.jp/gaiji/1-87/1-87-71.png';
const gaiji = {
	kind: 'gaiji',
	description: '※(「特のへん＋廴＋聿」、第3水準1-87-71)',
	image: { url: gaijiUrl }
};
const gaijiNote = '※［＃「特のへん＋廴＋聿」、第3水準1-87-71］';
const gaijiImg =
	'<img src="../../../gaiji/1-87/1-87-71.png" alt="※(「特のへん＋廴＋聿」、第3水準1-87-71)" class="gaiji" />';

describe('convertText: 本文', () => {
	it('見出し・ルビ・外字・段落を、意味を保った形へ変換する', () => {
		const { work } = ok(
			`\n［＃８字下げ］［＃中見出し］一［＃中見出し終わり］\n\nある日の事。御釈迦様《おしゃかさま》は｜極楽の蓮池《はすいけ》を、${gaijiNote}陀多《かんだた》と。`
		);
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
					text('ある日の事。'),
					{ kind: 'ruby', base: [text('御釈迦様')], reading: 'おしゃかさま' },
					text('は'),
					{ kind: 'ruby', base: [text('極楽の蓮池')], reading: 'はすいけ' },
					text('を、'),
					{ kind: 'ruby', base: [gaiji, text('陀多')], reading: 'かんだた' },
					text('と。')
				]
			}
		]);
	});

	it('来歴に変換経路 text と、底本・入力者の行を残す', () => {
		const r = ok('本文');
		expect(r.work.provenance).toEqual({
			copyright: { work: 'なし' },
			source: {
				cardUrl: source.cardUrl,
				fileUrl: source.fileUrl,
				upstreamUpdated: '2014-09-17'
			},
			converter: { version: '1.0.0', path: 'text' },
			bibliography: [
				'底本：「蜘蛛の糸・杜子春」新潮文庫、新潮社',
				'入力：作業者'
			]
		});
		// 題名・著者の行と、記号の説明は本文に入らない。
		expect(JSON.stringify(r.work.blocks)).not.toContain(
			'テキスト中に現れる記号'
		);
		expect(JSON.stringify(r.work.blocks)).not.toContain('芥川');
	});

	it('本文の行が「底本：」で始まっても、［＃本文終わり］があればそこまでを本文にする', () => {
		const { work } = ok('底本：という題の本\n［＃本文終わり］\n入力：富田倫生');
		expect(work.blocks).toHaveLength(1);
	});

	it('［＃本文終わり］があれば、その後ろを記載事項にする', () => {
		const r = convertText(
			file('本文\n［＃本文終わり］\n入力：富田倫生\n校正：富田倫生', ''),
			source
		);
		expect(r.ok && r.work.provenance.bibliography).toEqual([
			'入力：富田倫生',
			'校正：富田倫生'
		]);
	});

	it('親文字の決め方: 漢字の連なり・｜・欧文字（ギリシャ文字を含む）', () => {
		const { work } = ok(
			'丁度｜地獄《じごく》の底に、Undine《ウンディネ》は、λ《ラムダ》を、日本語々《にほんごご》。'
		);
		expect(work.blocks[0]).toMatchObject({
			inline: [
				text('丁度'),
				{ kind: 'ruby', base: [text('地獄')], reading: 'じごく' },
				text('の底に、'),
				{ kind: 'ruby', base: [text('Undine')], reading: 'ウンディネ' },
				text('は、'),
				{ kind: 'ruby', base: [text('λ')], reading: 'ラムダ' },
				text('を、日本語々'.replace('日本語々', '')),
				{ kind: 'ruby', base: [text('日本語々')], reading: 'にほんごご' },
				text('。')
			]
		});
	});

	it('｜で始まりを示したルビは、記号や〔〕の親文字でも受け取る（推測が要らない）', () => {
		const { work } = ok('あ｜＋《プラス》い｜〔語〕《ご》う');
		expect(work.blocks[0]).toMatchObject({
			inline: [
				text('あ'),
				{ kind: 'ruby', base: [text('＋')], reading: 'プラス' },
				text('い'),
				{ kind: 'ruby', base: [text('〔語〕')], reading: 'ご' },
				text('う')
			]
		});
	});

	it('外字: JIS X 0213 の面区点は画像、U+ は文字、ページと行だけの注記は※と注記で残す', () => {
		const { work } = ok(
			[
				`あ${gaijiNote}い`,
				'あ※［＃感嘆符疑問符、1-8-78］い',
				'あ※［＃「穴かんむり／石」、U+25954、430-13］い',
				'あ※［＃小書き平仮名ん、183-7］い',
				'あ※［＃「蠹」の「虫＋虫」に代えて「木」、第3水準1-86-13］い'
			].join('\n')
		);
		expect(work.blocks[0]).toMatchObject({
			inline: [text('あ'), gaiji, text('い')]
		});
		expect(work.blocks[1]).toMatchObject({
			inline: [
				text('あ'),
				{
					kind: 'gaiji',
					description: '※(感嘆符疑問符、1-8-78)',
					image: { url: 'https://www.aozora.gr.jp/gaiji/1-08/1-08-78.png' }
				},
				text('い')
			]
		});
		expect(work.blocks[2]).toMatchObject({
			inline: [{ kind: 'text', text: 'あ\u{25954}い' }]
		});
		expect(work.blocks[3]).toMatchObject({
			inline: [
				text('あ※'),
				{ kind: 'note', text: '［＃小書き平仮名ん、183-7］' },
				text('い')
			]
		});
		expect(work.blocks[4]).toMatchObject({
			inline: [
				text('あ'),
				{
					kind: 'gaiji',
					image: { url: 'https://www.aozora.gr.jp/gaiji/1-86/1-86-13.png' }
				},
				text('い')
			]
		});
	});

	it('傍点9種・傍線5種と左右の側を、後ろから指す形と始まり・終わりの形で残す', () => {
		const cases: Record<string, [string, string]> = {
			傍点: ['sesame', 'right'],
			白ゴマ傍点: ['whiteSesame', 'right'],
			丸傍点: ['blackCircle', 'right'],
			白丸傍点: ['whiteCircle', 'right'],
			黒三角傍点: ['blackTriangle', 'right'],
			白三角傍点: ['whiteTriangle', 'right'],
			二重丸傍点: ['bullseye', 'right'],
			蛇の目傍点: ['fisheye', 'right'],
			ばつ傍点: ['saltire', 'right'],
			傍線: ['solid', 'right'],
			二重傍線: ['double', 'right'],
			鎖線: ['dotted', 'right'],
			破線: ['dashed', 'right'],
			波線: ['wave', 'right']
		};
		for (const [name, [mark, side]] of Object.entries(cases)) {
			const expected = {
				inline: [{ kind: 'emphasis', mark, side, children: [text('強')] }]
			};
			expect(ok(`強［＃「強」に${name}］`).work.blocks[0], name).toMatchObject(
				expected
			);
			expect(
				ok(`［＃${name}］強［＃${name}終わり］`).work.blocks[0],
				name
			).toMatchObject(expected);
		}
		expect(ok('強［＃「強」の左に傍点］').work.blocks[0]).toMatchObject({
			inline: [{ kind: 'emphasis', mark: 'sesame', side: 'left' }]
		});
		expect(
			ok('［＃左に傍線］強［＃左に傍線終わり］').work.blocks[0]
		).toMatchObject({
			inline: [{ kind: 'emphasis', mark: 'solid', side: 'left' }]
		});
	});

	it('太字・罫囲み・割り注・上付き・下付き・横組み・縦中横を残す', () => {
		const { work } = ok(
			[
				'ＦＲＣＯ［＃「ＦＲＣＯ」は太字］',
				'［＃割り注］割［＃割り注終わり］',
				'（註）［＃「（註）」は行右小書き］',
				'2［＃「2」は行左小書き］',
				'12［＃「12」は縦中横］',
				'［＃横組み］横［＃横組み終わり］',
				'［＃罫囲み］枠［＃罫囲み終わり］',
				'　　［＃「　　」は罫囲み］'
			]
				.map((l) => l)
				.join('\n')
		);
		const kinds = work.blocks.map(
			(b) => b.kind === 'paragraph' && b.inline[0].kind
		);
		expect(kinds).toEqual([
			'strong',
			'warichu',
			'superscript',
			'subscript',
			'tcy',
			'horizontal',
			'frame',
			'frame'
		]);
	});

	it('底本との差異・ママの注記は、注記として残す', () => {
		const { work } = ok(
			'甍の［＃「甍の」は底本では「薨の」］先、あ［＃ルビの「あ」は底本では「あか」］、レミ［＃「レミ」はママ］。'
		);
		expect(work.blocks[0]).toMatchObject({
			inline: [
				text('甍の'),
				{ kind: 'note', text: '［＃「甍の」は底本では「薨の」］' },
				text('先、あ'),
				{ kind: 'note', text: '［＃ルビの「あ」は底本では「あか」］' },
				text('、レミ'),
				{ kind: 'note', text: '［＃「レミ」はママ］' },
				text('。')
			]
		});
	});

	it('字下げ・地付き・ぶら下げ（行と範囲）を字数で残す', () => {
		const { work } = ok(
			[
				'［＃３字下げ］下げ',
				'［＃天から４字下げ］天',
				'［＃地付き］付き',
				'［＃地から２字上げ］上げ',
				'［＃ここから２字下げ］',
				'一行',
				'二行',
				'［＃ここで字下げ終わり］',
				'［＃ここから２字下げ、折り返して３字下げ］',
				'ぶら',
				'［＃ここで字下げ終わり］',
				'［＃ここから改行天付き、折り返して１字下げ］',
				'天付き',
				'［＃ここで字下げ終わり］',
				'［＃ここから地付き］',
				'末',
				'［＃ここで地付き終わり］',
				'普通'
			].join('\n')
		);
		expect(work.blocks.map((b) => b.kind === 'paragraph' && b.layout)).toEqual([
			{ kind: 'indent', chars: 3 },
			{ kind: 'indent', chars: 4 },
			{ kind: 'end', inset: 0 },
			{ kind: 'end', inset: 2 },
			{ kind: 'indent', chars: 2 },
			{ kind: 'indent', chars: 2 },
			{ kind: 'hanging', indent: 3, first: 1 },
			{ kind: 'hanging', indent: 1, first: 1 },
			{ kind: 'end', inset: 0 },
			{ kind: 'none' }
		]);
	});

	it('範囲の終わりを省いた字下げの続けて指定と、字上げの終わりを読む', () => {
		const { work } = ok(
			[
				'［＃ここから２字下げ］',
				'あ',
				'［＃ここから４字下げ］',
				'い',
				'［＃ここから２字下げ、折り返して３字下げ］',
				'う',
				'［＃ここで字下げ終わり］',
				'［＃ここから地から３字上げ］',
				'え',
				'［＃ここで字上げ終わり］'
			].join('\n')
		);
		expect(work.blocks.map((b) => b.kind === 'paragraph' && b.layout)).toEqual([
			{ kind: 'indent', chars: 2 },
			{ kind: 'indent', chars: 4 },
			{ kind: 'hanging', indent: 3, first: 1 },
			{ kind: 'end', inset: 3 }
		]);
	});

	it('見出しの3つの大きさと、始まり・終わりの形・後ろから指す形', () => {
		const { work } = ok(
			[
				'［＃大見出し］大［＃大見出し終わり］',
				'中［＃「中」は中見出し］',
				'［＃２字下げ］小［＃「小」は小見出し］'
			].join('\n')
		);
		expect(work.blocks).toMatchObject([
			{ kind: 'heading', level: 'large', layout: { kind: 'none' } },
			{ kind: 'heading', level: 'medium' },
			{ kind: 'heading', level: 'small', layout: { kind: 'indent', chars: 2 } }
		]);
	});

	it('改ページ類と左右中央は構造として残し、その行を空行にしない', () => {
		const { work } = ok(
			[
				'前',
				'［＃改ページ］',
				'［＃改丁］',
				'［＃改見開き］',
				'［＃改段］',
				'［＃ページの左右中央］',
				'後'
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

	it('挿絵は行だけなら figure、文中なら行内の image、字下げの中は段落に残し、キャプションを結びつける', () => {
		const { work } = ok(
			[
				'［＃二十八葉橄欖冠の図（fig92_01.png、横198×縦198）入る］',
				'［＃キャプション］第一七圖［＃キャプション終わり］',
				'文中［＃図（fig92_02.png、横44×縦43）入る］の図',
				'［＃ここから２字下げ］',
				'［＃字形（fig92_03.png、横18×縦23）入る］',
				'［＃ここで字下げ終わり］'
			].join('\n')
		);
		expect(work.blocks[0]).toMatchObject({
			kind: 'figure',
			alt: '二十八葉橄欖冠の図',
			image: {
				url: 'https://www.aozora.gr.jp/cards/000879/files/fig92_01.png'
			},
			size: { width: 198, height: 198 },
			caption: [text('第一七圖')]
		});
		expect(work.blocks[1]).toMatchObject({
			inline: [text('文中'), { kind: 'image', alt: '図' }, text('の図')]
		});
		expect(work.blocks[2]).toMatchObject({
			kind: 'paragraph',
			layout: { kind: 'indent', chars: 2 },
			inline: [{ kind: 'image' }]
		});
	});

	it('同じ入力からは、同じ出力になる', () => {
		const body = `強［＃「強」に傍点］${gaijiNote}\n［＃図（fig92_01.png、横1×縦1）入る］`;
		expect(JSON.stringify(ok(body))).toBe(JSON.stringify(ok(body)));
	});
});

describe('convertText: XHTML 版と同じ意味になる', () => {
	/** 同じ内容の XHTML と テキストを、それぞれの変換器に通して、ブロックを比べる。 */
	function same(html: string, body: string) {
		const x = convertXhtml(xhtmlPage(html), xhtmlSource);
		const t = convertText(file(body), source);
		if (!x.ok || !t.ok)
			throw new Error(
				JSON.stringify([x.ok ? 'ok' : x.failure, t.ok ? 'ok' : t.failure])
			);
		expect(t.work.blocks).toEqual(x.work.blocks);
	}

	function xhtmlPage(main: string) {
		return `<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body><div class="metadata"><h1 class="title">蜘蛛の糸</h1></div><div class="main_text">${main}</div><div class="bibliographical_information"><hr />底本：x<br /></div></body></html>`;
	}

	it('見出し・ルビ・外字・傍点', () => {
		same(
			`<br />\n<div class="jisage_8" style="margin-left: 8em"><h4 class="naka-midashi"><a class="midashi_anchor" id="m1">一</a></h4></div>\n<br />\n御釈迦様<ruby><rb>蓮池</rb><rp>（</rp><rt>はすいけ</rt><rp>）</rp></ruby>を${gaijiImg}と、<em class="sesame_dot">傍</em>。<br />`,
			'\n［＃８字下げ］［＃中見出し］一［＃中見出し終わり］\n\n御釈迦様｜蓮池《はすいけ》を' +
				gaijiNote +
				'と、傍［＃「傍」に傍点］。'
		);
	});

	it('字下げ・地付き・ぶら下げ', () => {
		same(
			[
				'<div class="jisage_3" style="margin-left: 3em">一<br />二<br /></div>',
				'<div class="chitsuki_1" style="text-align:right; margin-right: 1em">付<br /></div>',
				'<div class="burasage" style="margin-left: 3em; text-indent: -1em;">ぶ<br /></div>'
			].join('\n'),
			[
				'［＃ここから３字下げ］',
				'一',
				'二',
				'［＃ここで字下げ終わり］',
				'［＃地から１字上げ］付',
				'［＃ここから２字下げ、折り返して３字下げ］',
				'ぶ',
				'［＃ここで字下げ終わり］'
			].join('\n')
		);
	});

	it('改ページ・挿絵とキャプション・注記・装飾', () => {
		same(
			[
				'前<br />',
				'<span class="notes">［＃改ページ］</span><br />',
				'<span class="notes">［＃ページの左右中央］</span><br />',
				'<img class="illustration" width="198" height="198" src="fig92_01.png" alt="図の説明" /><br />',
				'<span class="caption">題</span><br />',
				'<span class="futoji">太</span><sup class="superscript">上</sup><sub class="subscript">下</sub><span dir="ltr">12</span><span class="warichu">割</span><span class="notes">［＃「甍の」は底本では「薨の」］</span><br />'
			].join('\n'),
			[
				'前',
				'［＃改ページ］',
				'［＃ページの左右中央］',
				'［＃図の説明（fig92_01.png、横198×縦198）入る］',
				'［＃キャプション］題［＃キャプション終わり］',
				'太［＃「太」は太字］上［＃「上」は行右小書き］下［＃「下」は行左小書き］12［＃「12」は縦中横］［＃割り注］割［＃割り注終わり］［＃「甍の」は底本では「薨の」］'
			].join('\n')
		);
	});
});

describe('convertText: 未知・不正な記法は閉じて失敗する', () => {
	const cases: [string, string, string][] = [
		['未知の注記', 'あ［＃ふしぎな注記］', 'unknown-notation'],
		['注記だけの行の未知の注記', '［＃ふしぎな注記］', 'unknown-notation'],
		['空の注記', 'あ［＃］', 'unknown-notation'],
		['読めない外字', 'あ※［＃ふしぎ］い', 'unknown-notation'],
		[
			'範囲外の U+ の外字',
			'あ※［＃「x」、U+110000、1-1］い',
			'unknown-notation'
		],
		[
			'包みの中に画像がある行の後ろから指す見出し',
			'［＃太字］章［＃図（fig92_01.png、横1×縦1）入る］［＃太字終わり］［＃「章」は中見出し］',
			'unsupported-construct'
		],
		[
			'包みの中に画像がある傍点の対象',
			'［＃太字］文［＃図（fig92_01.png、横1×縦1）入る］［＃太字終わり］［＃「文」に傍点］',
			'unknown-notation'
		],
		['読みの中のルビの始まり', '漢《か《ん》', 'ruby-base'],
		[
			'本文の行が「底本：」で始まり、終わりが決められない',
			'底本：という題の本',
			'unsupported-construct'
		],
		[
			'［＃本文終わり］が2つある',
			'あ\n［＃本文終わり］\nい\n［＃本文終わり］',
			'unsupported-construct'
		],
		[
			'画像を含む行の後ろから指す見出し',
			'章［＃図（fig92_01.png、横1×縦1）入る］［＃「章」は中見出し］',
			'unsupported-construct'
		],
		[
			'範囲外の面区点の外字',
			'あ※［＃x、第9水準9-99-99］い',
			'unknown-notation'
		],
		['区が0の外字', 'あ※［＃x、第3水準1-0-5］い', 'unknown-notation'],
		['点が95の外字', 'あ※［＃x、第3水準1-1-95］い', 'unknown-notation'],
		['水準が違う外字', 'あ※［＃x、第9水準1-1-1］い', 'unknown-notation'],
		[
			'面と合わない水準の外字',
			'あ※［＃x、第4水準1-1-1］い',
			'unknown-notation'
		],
		[
			'面と合わない水準の外字（第3水準の2面）',
			'あ※［＃x、第3水準2-1-1］い',
			'unknown-notation'
		],
		[
			'画像を親文字にするルビ',
			'｜［＃図（fig92_01.png、横1×縦1）入る］《え》',
			'ruby-base'
		],
		[
			'装飾の中の画像を親文字にするルビ',
			'｜［＃太字］［＃図（fig92_01.png、横1×縦1）入る］［＃太字終わり］《え》',
			'ruby-base'
		],
		[
			'注記のある読みのルビ',
			'漢《かん［＃図（fig92_01.png、横1×縦1）入る］》',
			'ruby-base'
		],
		['外字のある読みのルビ', `漢《かん${gaijiNote}》`, 'ruby-base'],
		[
			'画像をまたぐ傍点',
			'文［＃図（fig92_01.png、横1×縦1）入る］［＃「文」に傍点］',
			'unknown-notation'
		],
		[
			'注記をまたぐ傍点',
			'文［＃「文」はママ］［＃「文」に傍点］',
			'unknown-notation'
		],
		[
			'サロゲートの U+ の外字',
			'あ※［＃「x」、U+D800、1-1］い',
			'unknown-notation'
		],
		['面区点が複数ある外字', 'あ※［＃x、1-1-1、1-2-2］い', 'unknown-notation'],
		[
			'面区点と U+ がある外字',
			'あ※［＃x、U+4E00、1-1-1］い',
			'unknown-notation'
		],
		['ルビの終わりだけ', '漢《かん》》', 'unclosed-notation'],
		[
			'記号の外字を親文字にするルビ',
			'※［＃感嘆符疑問符、1-8-78］《かんたんふ》',
			'ruby-base'
		],
		['アクセント分解', "あ〔e'tiquette〕い", 'unknown-notation'],
		[
			'U+ が複数ある外字',
			'あ※［＃「x」、U+4E00、U+4E01、1-1］い',
			'unknown-notation'
		],
		['見えない U+ の外字', 'あ※［＃「x」、U+200B、1-1］い', 'unknown-notation'],
		['外字の注記がない※', 'あ※［＃］', 'unknown-notation'],
		['注記が閉じていない', 'あ［＃傍点', 'unclosed-notation'],
		['ルビが閉じていない', 'あ漢《かん', 'unclosed-notation'],
		['終わりのない囲み', '［＃太字］あ', 'unclosed-notation'],
		['始まりのない終わり', 'あ［＃太字終わり］', 'unclosed-notation'],
		[
			'入れ違いの囲み',
			'［＃太字］［＃割り注］あ［＃太字終わり］［＃割り注終わり］',
			'unclosed-notation'
		],
		[
			'複数行にまたがる囲み',
			'［＃太字］あ\nい［＃太字終わり］',
			'unclosed-notation'
		],
		['範囲が閉じていない', '［＃ここから２字下げ］\nあ', 'unclosed-notation'],
		['範囲の終わりだけ', 'あ\n［＃ここで字下げ終わり］', 'unclosed-notation'],
		[
			'種類の違う範囲の終わり',
			'［＃ここから２字下げ］\n［＃ここで地付き終わり］',
			'unclosed-notation'
		],
		[
			'範囲の入れ子',
			'［＃ここから２字下げ］\n［＃ここから地付き］',
			'unsupported-construct'
		],
		[
			'範囲の中の行の字下げ',
			'［＃ここから２字下げ］\n［＃３字下げ］あ',
			'unsupported-construct'
		],
		[
			'折り返しが浅いぶら下げ',
			'［＃ここから３字下げ、折り返して２字下げ］',
			'unsupported-construct'
		],
		['親文字のないルビ', '、《かん》', 'ruby-base'],
		['親文字が決められないルビ（記号）', '＋《じゅうじ》', 'ruby-base'],
		['ひらがなのルビ', 'あい《かん》', 'ruby-base'],
		['記号の親文字（×）', '×《かける》', 'ruby-base'],
		['記号の親文字（÷）', 'ab÷《わる》', 'ruby-base'],
		['空のルビ', '漢《》', 'ruby-base'],
		['空白だけのルビ', '漢《　》', 'ruby-base'],
		['｜の後にルビのない文字', '｜あ', 'ruby-base'],
		['対象が直前にない傍点', '強い［＃「弱」に傍点］', 'unknown-notation'],
		['未知の装飾', '強［＃「強」に点滅］', 'unknown-notation'],
		['左側のない太字', '強［＃「強」の左に太字］', 'unknown-notation'],
		[
			'行の途中の見出し',
			'あ［＃中見出し］い［＃中見出し終わり］',
			'unsupported-construct'
		],
		[
			'行の一部だけの見出し',
			'あい［＃「い」は中見出し］',
			'unsupported-construct'
		],
		[
			'見出しの後の文字',
			'［＃中見出し］あ［＃中見出し終わり］い',
			'unsupported-construct'
		],
		['窓見出し', 'あ［＃「あ」は窓中見出し］', 'unknown-notation'],
		['同行見出し', 'あ［＃「あ」は同行中見出し］', 'unknown-notation'],
		[
			'複数行の横組み',
			'［＃ここから横組み］\nあ\n［＃ここで横組み終わり］',
			'unknown-notation'
		],
		[
			'行をまたぐ罫囲み',
			'［＃罫囲み］\nあ\n［＃罫囲み終わり］',
			'unclosed-notation'
		],
		[
			'挿絵のないキャプション',
			'［＃キャプション］題［＃キャプション終わり］',
			'unsupported-construct'
		],
		[
			'行の途中のキャプション',
			'あ［＃キャプション］題［＃キャプション終わり］',
			'unsupported-construct'
		],
		[
			'終わりのないキャプション',
			'［＃図（fig92_01.png、横1×縦1）入る］\n［＃キャプション］題',
			'unclosed-notation'
		]
	];
	for (const [name, body, code] of cases) {
		it(name, () => {
			const f = failure(body);
			expect(f?.code).toBe(code);
			expect(f?.location).toMatch(/^L\d+/);
		});
	}

	it('とても長い対象の後ろから指す注記も、時間をかけずに処理する', () => {
		const long = 'a'.repeat(300000);
		const t0 = Date.now();
		expect(ok(`${long}［＃「${long}」は太字］`).work.blocks).toHaveLength(1);
		expect(Date.now() - t0).toBeLessThan(3000);
	});

	it('深い入れ子や、同じ対象への注記の繰り返しは、例外にせず失敗として返す', () => {
		const depth = 5000;
		const nested =
			'｜' +
			'［＃太字］'.repeat(depth) +
			'漢' +
			'［＃太字終わり］'.repeat(depth) +
			'《かん》';
		expect(failure(nested)?.code).toBe('unsupported-construct');
		const repeated = '強' + '［＃「強」は太字］'.repeat(depth);
		expect(failure(repeated)?.code).toBe('unsupported-construct');
		// 範囲を取り囲む注記の内側が非常に長くても、例外にならない。
		expect(ok('［＃太字］' + '強'.repeat(200000) + '［＃太字終わり］').ok).toBe(
			true
		);
		// 浅い入れ子は通る。
		expect(
			ok('［＃太字］［＃割り注］強［＃割り注終わり］［＃太字終わり］').work
				.blocks
		).toHaveLength(1);
	});

	it('記号の説明の見出しがなければ、区切り線が2本あっても見出し部とは見なさない', () => {
		const r = convertText(
			`本文A\n${DASH}\n本文B\n${DASH}\n本文C\n底本：x\n`,
			source
		);
		expect(r).toMatchObject({
			ok: false,
			failure: { code: 'missing-section' }
		});
	});

	it('区切り線や底本情報がないファイルは失敗する', () => {
		const noDash = convertText('蜘蛛の糸\n本文\n底本：x\n', source);
		expect(noDash).toMatchObject({
			ok: false,
			failure: { code: 'missing-section' }
		});
		const noFooter = convertText(
			`題\n\n${DASH}\n【テキスト中に現れる記号について】\n${DASH}\n本文\n`,
			source
		);
		expect(noFooter).toMatchObject({
			ok: false,
			failure: { code: 'missing-section' }
		});
	});

	it('見える文字のない記載事項は、来歴がないものとして失敗にする', () => {
		const r = convertText(
			file('本文', '底本：​\n​\n').replace('底本：​', '底本：'),
			source
		);
		expect(r.ok).toBe(true);
		const blank = convertText(
			`題\n\n${DASH}\n【テキスト中に現れる記号について】\n${DASH}\n本文\n［＃本文終わり］\n​\n　\n`,
			source
		);
		expect(blank).toMatchObject({
			ok: false,
			failure: { code: 'schema', location: '$.provenance.bibliography' }
		});
	});

	it('著作権フラグが「なし」でない作品は、本文を読む前に失敗する', () => {
		for (const flag of ['あり', '', 'なし ']) {
			expect(
				convertText('<<<壊れた入力', { ...source, workCopyrightFlag: flag })
			).toMatchObject({ ok: false, failure: { code: 'copyright-active' } });
		}
	});

	it('来歴が作品と合わない場合は、スキーマの関門で止まる', () => {
		expect(
			convertText(file('本文'), {
				...source,
				cardUrl: 'https://www.aozora.gr.jp/cards/000148/card773.html'
			})
		).toMatchObject({
			ok: false,
			failure: { code: 'schema', location: '$.provenance.source.cardUrl' }
		});
	});

	it('失敗の場所は、元のファイルの行と列を指す', () => {
		const body = 'あ\nい\nうえ［＃ふしぎな注記］';
		const f = failure(body);
		const lines = file(body).split('\n');
		const line = lines.findIndex((l) => l.includes('ふしぎ')) + 1;
		expect(f?.location).toMatch(new RegExp(`^L${line}:C3 `));
		expect(f?.location).toContain('［＃ふしぎな注記］');
	});

	it('画像の参照が解決できない・青空文庫の外なら失敗する', () => {
		expect(
			convertText(file('［＃図（fig92_01.png、横1×縦1）入る］'), {
				...source,
				fileUrl: 'https://evil.example/cards/000879/files/92_ruby_164.zip'
			}).ok
		).toBe(false);
	});
});
