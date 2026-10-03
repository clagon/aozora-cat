import { describe, expect, it } from 'vitest';
import { WORK_SCHEMA_VERSION, parseWork } from './work.ts';

const gaiji = 'https://www.aozora.gr.jp/gaiji/1-87/1-87-71.png';

/** 全種類のノードを1つずつ含む、正しい作品。テストごとに複製して壊す。 */
function valid() {
	return {
		schemaVersion: WORK_SCHEMA_VERSION,
		id: '000092',
		title: '蜘蛛の糸',
		titleReading: 'くものいと',
		subtitle: '童話',
		subtitleReading: 'どうわ',
		classification: 'NDC 913',
		people: [
			{ role: 'author', name: '芥川竜之介', reading: 'あくたがわりゅうのすけ' }
		],
		orthography: '新字新仮名',
		provenance: {
			copyright: { work: 'なし' },
			source: {
				cardUrl: 'https://www.aozora.gr.jp/cards/000879/card92.html',
				fileUrl: 'https://www.aozora.gr.jp/cards/000879/files/92_14545.html',
				upstreamUpdated: '2014-09-17'
			},
			converter: { version: '1.0.0', path: 'xhtml' },
			bibliography: ['底本：「蜘蛛の糸・杜子春」新潮文庫', '入力：作業者']
		},
		blocks: [
			{
				kind: 'heading',
				id: 'p1',
				level: 'medium',
				layout: { kind: 'indent', chars: 8 },
				inline: [{ kind: 'text', text: '一' }]
			},
			{ kind: 'paragraph', id: 'p2', layout: { kind: 'none' }, inline: [] },
			{
				kind: 'paragraph',
				id: 'p3',
				layout: { kind: 'hanging', indent: 3, first: 1 },
				inline: [
					{ kind: 'text', text: 'ある日' },
					{
						kind: 'ruby',
						base: [
							{
								kind: 'gaiji',
								description: '※(「虫＋廾」)',
								image: { url: gaiji }
							},
							{ kind: 'text', text: '陀多' }
						],
						reading: 'かんだた'
					},
					{
						kind: 'emphasis',
						style: 'sesame',
						children: [
							{ kind: 'strong', children: [{ kind: 'text', text: '傍点' }] }
						]
					},
					{ kind: 'warichu', children: [{ kind: 'text', text: '割注' }] },
					{ kind: 'tcy', children: [{ kind: 'text', text: '12' }] },
					{
						kind: 'size',
						direction: 'larger',
						step: 2,
						children: [{ kind: 'text', text: '大' }]
					},
					{ kind: 'note', text: '［＃「甍の」は底本では「薨の」］' },
					{
						kind: 'image',
						image: {
							url: 'https://www.aozora.gr.jp/cards/000462/files/fig462_01.png'
						},
						alt: '数式',
						size: { width: 44, height: 43 }
					}
				]
			},
			{ kind: 'pageBreak', style: 'page' },
			{
				kind: 'figure',
				id: 'p4',
				image: {
					url: 'https://www.aozora.gr.jp/cards/001317/files/fig1317_01.png'
				},
				alt: '',
				size: { width: 198, height: 198 },
				caption: [{ kind: 'text', text: '二十八葉橄欖冠の図' }]
			},
			{
				kind: 'paragraph',
				id: 'p5',
				layout: { kind: 'end', inset: 1 },
				inline: []
			},
			{ kind: 'pageCenter' }
		]
	};
}

const REMOVE = Symbol('remove');

/** `a.b[0].c` 形式のパスの値を、複製した作品の中で書き換える（REMOVE なら削除する）。 */
function change(path: string, value: unknown, base: unknown = valid()) {
	const doc: unknown = JSON.parse(JSON.stringify(base));
	const keys = path.match(/[^.[\]]+/g) ?? [];
	const last = keys.pop() ?? '';
	let node: unknown = doc;
	for (const key of keys) node = Reflect.get(Object(node), key);
	if (value === REMOVE) Reflect.deleteProperty(Object(node), last);
	else Reflect.set(Object(node), last, value);
	return doc;
}

function rejects(path: string, value: unknown, errorPath = `$.${path}`) {
	const r = parseWork(change(path, value));
	expect(r.ok, `${path} = ${String(value)}`).toBe(false);
	if (!r.ok)
		expect(r.error).toMatchObject({ code: 'invalid', path: errorPath });
}

describe('parseWork', () => {
	it('全種類のノードを通し、新しいオブジェクトを返す', () => {
		const input: unknown = JSON.parse(JSON.stringify(valid()));
		const r = parseWork(input);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.work).toEqual(input);
			expect(r.work).not.toBe(input);
		}
	});

	it('将来のバージョンと、バージョンのないものを拒否する', () => {
		for (const version of [2, 0, REMOVE]) {
			expect(parseWork(change('schemaVersion', version))).toMatchObject({
				ok: false,
				error: { code: 'unsupported-version' }
			});
		}
	});

	it('来歴が欠けているものを拒否する', () => {
		rejects('provenance', REMOVE);
		rejects('provenance.source', REMOVE);
		rejects('provenance.bibliography', []);
		rejects('provenance.converter.path', REMOVE);
	});

	it('作品の著作権フラグが「なし」でないものを拒否する', () => {
		for (const flag of ['あり', 'なし ', REMOVE]) {
			rejects('provenance.copyright.work', flag);
		}
	});

	it('未知のブロック・ノード・配置の種別を拒否する', () => {
		rejects('blocks[0].kind', 'html');
		rejects('blocks[2].inline[0].kind', 'script');
		rejects('blocks[0].layout.kind', 'float');
	});

	it('想定していない項目（生のHTMLなど）を拒否する', () => {
		rejects('blocks[2].inline[0].html', '<b>x</b>');
		rejects('extra', 1);
		rejects('blocks[6].style', 'center');
	});

	it('許可していない画像の参照を拒否する', () => {
		const bad = [
			'javascript:alert(1)',
			'data:image/svg+xml,<svg/>',
			'http://www.aozora.gr.jp/gaiji/a.png',
			'https://evil.example/gaiji/a.png',
			'https://www.aozora.gr.jp.evil.example/gaiji/a.png',
			'https://user@www.aozora.gr.jp/gaiji/a.png',
			'https://www.aozora.gr.jp:8443/gaiji/a.png',
			'https://www.aozora.gr.jp/gaiji/../x/a.png',
			'https://www.aozora.gr.jp/gaiji/a.png?x=1',
			'https://www.aozora.gr.jp/gaiji/a.svg',
			'https://www.aozora.gr.jp/other/a.png',
			'//www.aozora.gr.jp/gaiji/a.png',
			'gaiji/a.png',
			''
		];
		for (const url of bad) rejects('blocks[4].image.url', url);
	});

	it('出典のURLは図書カードとファイルの場所だけを許す', () => {
		rejects('provenance.source.cardUrl', 'https://www.aozora.gr.jp/');
		rejects(
			'provenance.source.fileUrl',
			'https://www.aozora.gr.jp/cards/1/files/a.js'
		);
	});

	it('形式の崩れた値を拒否する', () => {
		rejects('id', '92');
		rejects('provenance.source.upstreamUpdated', '2014-02-30');
		rejects('provenance.converter.version', 'v1');
		rejects('people', []);
		rejects('people[0].role', 'illustrator');
		rejects('blocks[4].size.width', 0);
		rejects('blocks[0].layout.chars', 1.5);
		rejects('blocks[2].inline[0].text', '');
	});

	it('挿絵のキャプションを残し、欠けているものを拒否する', () => {
		const r = parseWork(change('blocks[4].id', 'p4'));
		expect(r.ok && r.work.blocks[4]).toMatchObject({
			caption: [{ kind: 'text', text: '二十八葉橄欖冠の図' }]
		});
		rejects('blocks[4].caption', REMOVE);
		rejects('blocks[4].caption[0].kind', 'html');
	});

	it('別の作品の図書カード・ファイルを来歴にしたものを拒否する', () => {
		const other = 'https://www.aozora.gr.jp/cards/000148';
		rejects('provenance.source.cardUrl', `${other}/card773.html`);
		rejects('provenance.source.fileUrl', `${other}/files/773_14560.html`);
		rejects(
			'provenance.source.fileUrl',
			'https://www.aozora.gr.jp/cards/000879/files/ruby_14545.zip'
		);
		// 先頭のゼロの有無は同じ作品として扱う。
		const ok = parseWork(
			change(
				'provenance.source.cardUrl',
				'https://www.aozora.gr.jp/cards/000879/card000092.html'
			)
		);
		expect(ok.ok).toBe(true);
	});

	it('大きな文字・小さな文字は1〜5段階だけを許す', () => {
		const at = 'blocks[2].inline[5]';
		rejects(`${at}.step`, 0);
		rejects(`${at}.step`, 6);
		rejects(`${at}.direction`, 'bigger');
	});

	it('副題・読み・分類は任意だが、あれば空を許さない', () => {
		for (const key of ['subtitle', 'subtitleReading', 'classification']) {
			expect(parseWork(change(key, REMOVE)).ok, key).toBe(true);
			rejects(key, '');
		}
		expect(parseWork(change('titleReading', REMOVE)).ok).toBe(true);
		expect(parseWork(change('people[0].reading', REMOVE)).ok).toBe(true);
		rejects('people[0].reading', '');
	});

	it('block の id の重複を拒否する', () => {
		rejects('blocks[4].id', 'p1');
	});

	it('ルビの親文字にルビを入れられない', () => {
		const nested = {
			kind: 'ruby',
			base: [{ kind: 'text', text: 'x' }],
			reading: 'y'
		};
		rejects(
			'blocks[2].inline[1].base[2]',
			nested,
			'$.blocks[2].inline[1].base[2]'
		);
	});

	it('深すぎる入れ子を拒否する', () => {
		let node: unknown = { kind: 'text', text: 'x' };
		for (let i = 0; i < 20; i++) node = { kind: 'strong', children: [node] };
		expect(parseWork(change('blocks[2].inline', [node])).ok).toBe(false);
	});

	it('オブジェクトでない入力は例外にせず拒否する', () => {
		for (const input of [null, 'x', 1, [], undefined]) {
			expect(parseWork(input).ok).toBe(false);
		}
	});
});
