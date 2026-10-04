// 青空文庫形式のテキストを、XHTML 版と同じ作品スキーマへ変換する（XHTML がない場合の代替）。
// 読めるのは、承認済みの作品で使う注記だけ。未知の注記は黙って捨てずに失敗させる。
import {
	WORK_SCHEMA_VERSION,
	isBlank,
	parseWork
} from '../../../src/lib/domain/work.ts';
import type {
	Block,
	ContainerKind,
	EmphasisMark,
	HeadingLevel,
	Inline,
	Layout,
	PageBreakStyle
} from '../../../src/lib/domain/work.ts';
import { CONVERTER_VERSION } from './types.ts';
import type {
	ConversionFailure,
	ConvertResult,
	FailureCode,
	WorkSource
} from './types.ts';

class Failure extends Error {
	failure: ConversionFailure;
	constructor(code: FailureCode, message: string, location: string) {
		super(message);
		this.failure = { code, message, location };
	}
}

const AOZORA = 'https://www.aozora.gr.jp';
const KANJI = /[㐀-䶿一-鿿豈-﫿々〆〇ヶ\u{20000}-\u{3FFFF}]/u;
/** 欧文字（アクセント付き・ギリシャ文字・キリル文字を含む）。ルビの親文字として、続く並びを1つに数える。 */
const ALPHA = /[\p{L}&&[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]]/v;

const BREAKS: Record<string, PageBreakStyle> = {
	改ページ: 'page',
	改丁: 'leaf',
	改見開き: 'spread',
	改段: 'column'
};

const DOTS: Record<string, EmphasisMark> = {
	傍点: 'sesame',
	白ゴマ傍点: 'whiteSesame',
	丸傍点: 'blackCircle',
	白丸傍点: 'whiteCircle',
	黒三角傍点: 'blackTriangle',
	白三角傍点: 'whiteTriangle',
	二重丸傍点: 'bullseye',
	蛇の目傍点: 'fisheye',
	ばつ傍点: 'saltire',
	傍線: 'solid',
	二重傍線: 'double',
	鎖線: 'dotted',
	破線: 'dashed',
	波線: 'wave'
};

const CONTAINERS: Record<string, ContainerKind> = {
	太字: 'strong',
	罫囲み: 'frame',
	割り注: 'warichu',
	行右小書き: 'superscript',
	上付き小文字: 'superscript',
	行左小書き: 'subscript',
	下付き小文字: 'subscript',
	縦中横: 'tcy',
	横組み: 'horizontal'
};

const HEADINGS: Record<string, HeadingLevel> = {
	大見出し: 'large',
	中見出し: 'medium',
	小見出し: 'small'
};

/** 行の中身の途中経過。文字は1字ずつ、注記で作ったものはノードとして持つ。 */
type Unit =
	| { k: 'ch'; c: string }
	| { k: 'bar' }
	/** d は入れ子の深さ。葉は0、包むたびに1ずつ増える。 */
	| { k: 'node'; n: Inline; plain: string; kanji: boolean; d: number };

type Token =
	| { t: 'text'; s: string; col: number }
	| { t: 'note'; s: string; col: number }
	| { t: 'ruby'; s: string; col: number }
	| { t: 'bar'; col: number }
	| { t: 'gaiji'; col: number };

/** 注記の数字は全角が多い。 */
const num = (s: string): number =>
	Number(s.replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xff10)));

/** 青空文庫形式のテキスト（復号済み）を変換する。 */
export function convertText(text: string, source: WorkSource): ConvertResult {
	if (source.workCopyrightFlag !== 'なし')
		return {
			ok: false,
			failure: {
				code: 'copyright-active',
				message: `作品の著作権フラグが「${source.workCopyrightFlag}」です`,
				location: `work ${source.id}`
			}
		};
	try {
		return convert(text, source);
	} catch (e) {
		if (e instanceof Failure) return { ok: false, failure: e.failure };
		throw e;
	}
}

function convert(text: string, source: WorkSource): ConvertResult {
	const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
	const at = (n: number, col?: number, what?: string) =>
		`L${n + 1}${col === undefined ? '' : `:C${col + 1}`}${what ? ` ${what}` : ''}`;
	const fail: (
		code: FailureCode,
		message: string,
		n: number,
		col?: number,
		what?: string
	) => never = (code, message, n, col, what) => {
		throw new Failure(code, message, at(n, col, what));
	};

	// 見出し部（題名・著者）と記号の説明は、区切り線にはさまれた範囲まで読み飛ばす。
	const dashes = lines.flatMap((l, i) => (/^-{20,}$/.test(l) ? [i] : []));
	if (dashes.length < 2)
		throw new Failure(
			'missing-section',
			'記号の説明を囲む区切り線がありません',
			'header'
		);
	const bodyStart = dashes[1] + 1;

	// 本文の終わり。「底本：」から後ろが記載事項。［＃本文終わり］があればその後ろ。
	let bodyEnd = -1;
	let bibStart = -1;
	for (let i = bodyStart; i < lines.length; i++) {
		if (lines[i].startsWith('底本：')) {
			bodyEnd = i;
			bibStart = i;
			break;
		}
		if (lines[i].trim() === '［＃本文終わり］') {
			bodyEnd = i;
			bibStart = i + 1;
			break;
		}
	}
	if (bodyEnd < 0)
		throw new Failure(
			'missing-section',
			'底本情報（「底本：」または［＃本文終わり］）がありません',
			'footer'
		);

	// ここから本文。
	const blocks: Block[] = [];
	let count = 0;
	let range: {
		kind: 'indent' | 'end' | 'hanging';
		layout: Layout;
		where: string;
	} | null = null;
	const nextId = () => `p${++count}`;
	/** 開いている範囲。行ごとの関数が書き換えるので、読むときはこの関数を通す。 */
	const openRange = () => range;

	function tokenize(line: string, n: number): Token[] {
		const out: Token[] = [];
		let buf = '';
		let bufCol = 0;
		const flush = () => {
			if (buf !== '') out.push({ t: 'text', s: buf, col: bufCol });
			buf = '';
		};
		for (let i = 0; i < line.length;) {
			if (line.startsWith('［＃', i)) {
				const j = line.indexOf('］', i);
				if (j < 0) fail('unclosed-notation', '注記が閉じていません', n, i);
				flush();
				out.push({ t: 'note', s: line.slice(i + 2, j), col: i });
				i = j + 1;
			} else if (line[i] === '《') {
				const j = line.indexOf('》', i);
				if (j < 0) fail('unclosed-notation', 'ルビが閉じていません', n, i);
				flush();
				out.push({ t: 'ruby', s: line.slice(i + 1, j), col: i });
				i = j + 1;
			} else if (line[i] === '｜') {
				flush();
				out.push({ t: 'bar', col: i });
				i += 1;
			} else if (line[i] === '※' && line.startsWith('［＃', i + 1)) {
				flush();
				out.push({ t: 'gaiji', col: i });
				i += 1;
			} else {
				if (buf === '') bufCol = i;
				buf += line[i];
				i += 1;
			}
		}
		flush();
		return out;
	}

	/** 画像にも文字にもできない外字（ページと行だけの注記）。公式のXHTMLと同じく、※と注記で残す。 */
	function bareGaiji(inner: string): boolean {
		const parts = inner.split('、');
		return parts.length === 2 && parts[0] !== '' && /^\d+-\d+$/.test(parts[1]);
	}

	/** 外字の注記から、画像か文字を作る。 */
	function gaijiUnit(inner: string, n: number, col: number): Unit {
		const parts = inner.split('、');
		const code = parts
			.at(-1)
			?.match(/^(?:第([34])水準)?(\d)-(\d{1,2})-(\d{1,2})$/);
		if (code) {
			const [level, plane, row, cell] = [
				code[1],
				code[2],
				code[3],
				code[4]
			].map((v) => (v === undefined ? 0 : Number(v)));
			// JIS X 0213 の面は1か2、区と点はそれぞれ1〜94。
			if (
				(plane !== 1 && plane !== 2) ||
				(level !== 0 && level !== plane + 2) ||
				row < 1 ||
				row > 94 ||
				cell < 1 ||
				cell > 94
			)
				return fail(
					'unknown-notation',
					'外字の面区点が JIS X 0213 の範囲にありません',
					n,
					col,
					`［＃${inner}］`
				);
			const [, , men, ku, ten] = code;
			const k = ku.padStart(2, '0');
			const t = ten.padStart(2, '0');
			return {
				k: 'node',
				plain: '※',
				kanji: true,
				d: 0,
				n: {
					kind: 'gaiji',
					description: `※(${inner})`,
					image: { url: `${AOZORA}/gaiji/${men}-${k}/${men}-${k}-${t}.png` }
				}
			};
		}
		const unicode = parts
			.map((p) => p.match(/^U\+([0-9A-F]{4,6})$/)?.[1])
			.find(Boolean);
		if (unicode) {
			const cp = parseInt(unicode, 16);
			// 正しい Unicode のスカラー値で、表示される文字のものだけを文字にする。
			const valid = cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
			if (valid && !isBlank(String.fromCodePoint(cp)))
				return { k: 'ch', c: String.fromCodePoint(cp) };
			return fail(
				'unknown-notation',
				'外字の U+ の値が文字として使えません',
				n,
				col,
				`［＃${inner}］`
			);
		}
		return fail(
			'unknown-notation',
			'読めない外字の注記です',
			n,
			col,
			`［＃${inner}］`
		);
	}

	/** 包んだときの入れ子の深さ。スキーマの上限を超える入れ子は、再帰で読む前に止める。 */
	const nest = (units: Unit[], n: number, col: number): number => {
		let d = 0;
		for (const u of units) if (u.k === 'node' && u.d > d) d = u.d;
		d += 1;
		if (d > 7)
			fail('unsupported-construct', '注記の入れ子が深すぎます', n, col);
		return d;
	};

	/** 入れ子の中まで、指定した種類のノードがあるか。 */
	const hasKind = (nodes: Inline[], kinds: string[]): boolean =>
		nodes.some(
			(n) =>
				kinds.includes(n.kind) ||
				(n.kind === 'ruby' && hasKind(n.base, kinds)) ||
				('children' in n && hasKind(n.children, kinds))
		);

	const plainOf = (u: Unit): string =>
		u.k === 'ch' ? u.c : u.k === 'node' ? u.plain : '';

	function toInline(units: Unit[], n: number): Inline[] {
		const out: Inline[] = [];
		let buf = '';
		const flush = () => {
			if (buf !== '') out.push({ kind: 'text', text: buf });
			buf = '';
		};
		for (const u of units) {
			if (u.k === 'ch') buf += u.c;
			else if (u.k === 'node') {
				flush();
				out.push(u.n);
			} else fail('ruby-base', '｜ の後にルビがありません', n);
		}
		flush();
		return out;
	}

	const wrapOf = (name: string, left: boolean) => {
		const mark = DOTS[name];
		if (mark !== undefined)
			return (children: Inline[]): Inline => ({
				kind: 'emphasis',
				mark,
				side: left ? 'left' : 'right',
				children
			});
		const kind = CONTAINERS[name];
		if (kind !== undefined && !left)
			return (children: Inline[]): Inline => ({ kind, children });
		return undefined;
	};

	/** 本文の1行を、ブロックへ変換する。 */
	function line(raw: string, n: number) {
		if (raw === '') {
			blocks.push({
				kind: 'paragraph',
				id: nextId(),
				layout: range?.layout ?? { kind: 'none' },
				inline: []
			});
			return;
		}
		const tokens = tokenize(raw, n);
		const first = tokens[0];
		const only = tokens.length === 1 && first.t === 'note' ? first : null;

		// 注記だけの行: 範囲の始まりと終わり、改ページ、挿絵。
		if (only) {
			const inner = only.s;
			if (BREAKS[inner] !== undefined) {
				blocks.push({ kind: 'pageBreak', style: BREAKS[inner] });
				return;
			}
			if (inner === 'ページの左右中央') {
				blocks.push({ kind: 'pageCenter' });
				return;
			}
			if (rangeNote(inner, n, only.col)) return;
			const img = imageNote(inner);
			if (img && !range) {
				blocks.push({
					kind: 'figure',
					id: nextId(),
					image: img.image,
					alt: img.alt,
					size: img.size,
					caption: []
				});
				return;
			}
		}

		let lineLayout: Layout | null = null;
		const units: Unit[] = [];
		const spans: {
			name: string;
			left: boolean;
			start: number;
			col: number;
			heading?: HeadingLevel;
		}[] = [];
		let heading: HeadingLevel | null = null;
		let headingEnded = false;
		let caption = false;
		let barAt = -1;

		const layoutNote = (inner: string): Layout | null => {
			let m =
				inner.match(/^([０-９0-9]+)字下げ$/) ??
				inner.match(/^天から([０-９0-9]+)字下げ$/);
			if (m) return { kind: 'indent', chars: num(m[1]) };
			if (inner === '地付き') return { kind: 'end', inset: 0 };
			m = inner.match(/^地から([０-９0-9]+)字上げ$/);
			if (m) return { kind: 'end', inset: num(m[1]) };
			return null;
		};

		for (let ti = 0; ti < tokens.length; ti++) {
			const tok = tokens[ti];
			if (headingEnded && !(tok.t === 'text' && isBlank(tok.s)))
				fail(
					'unsupported-construct',
					'見出しの終わりの後に文字があります',
					n,
					tok.col
				);
			if (tok.t === 'text') {
				for (const c of Array.from(tok.s)) units.push({ k: 'ch', c });
			} else if (tok.t === 'bar') {
				barAt = units.length;
				units.push({ k: 'bar' });
			} else if (tok.t === 'gaiji') {
				const next = tokens[++ti];
				if (!next || next.t !== 'note')
					fail('unknown-notation', '外字の注記がありません', n, tok.col);
				if (bareGaiji(next.s)) {
					units.push(
						{ k: 'ch', c: '※' },
						{
							k: 'node',
							plain: '',
							kanji: false,
							d: 0,
							n: { kind: 'note', text: `［＃${next.s}］` }
						}
					);
				} else units.push(gaijiUnit(next.s, n, next.col));
			} else if (tok.t === 'ruby') {
				if (isBlank(tok.s)) fail('ruby-base', 'ルビの読みが空です', n, tok.col);
				// 読みは文字だけを扱う。注記・外字・｜が入っていたら、文字のままにせず止める。
				if (/［＃|｜|※/.test(tok.s))
					fail('ruby-base', 'ルビの読みに注記や記号があります', n, tok.col);
				let start: number;
				if (barAt >= 0) {
					start = barAt;
				} else {
					start = units.length;
					const last = units.at(-1);
					const isK = (u: Unit) =>
						(u.k === 'ch' && KANJI.test(u.c)) || (u.k === 'node' && u.kanji);
					const isA = (u: Unit) => u.k === 'ch' && ALPHA.test(u.c);
					const same = last && isK(last) ? isK : last && isA(last) ? isA : null;
					if (!same)
						fail('ruby-base', 'ルビの親文字が決められません', n, tok.col);
					while (start > 0 && same?.(units[start - 1])) start--;
				}
				const baseUnits = units.slice(barAt >= 0 ? start + 1 : start);
				const base = toInline(baseUnits, n);
				if (base.length === 0 || hasKind(base, ['ruby', 'image']))
					fail('ruby-base', 'ルビの親文字が正しくありません', n, tok.col);
				units.splice(start, units.length - start, {
					k: 'node',
					plain: baseUnits.map(plainOf).join(''),
					kanji: false,
					d: nest(baseUnits, n, tok.col),
					n: { kind: 'ruby', base, reading: tok.s }
				});
				barAt = -1;
			} else {
				const inner = tok.s;
				const where = `［＃${inner}］`;
				const col = tok.col;
				// 行頭の字下げなど。
				const lay = units.length === 0 ? layoutNote(inner) : null;
				if (lay) {
					if (range || lineLayout)
						fail(
							'unsupported-construct',
							'字下げが重なっています',
							n,
							col,
							where
						);
					lineLayout = lay;
					continue;
				}
				// 見出し（始まりと終わり）。
				if (HEADINGS[inner] !== undefined) {
					if (units.length > 0 || heading)
						fail(
							'unsupported-construct',
							'行の途中の見出しは扱えません',
							n,
							col,
							where
						);
					heading = HEADINGS[inner];
					spans.push({ name: inner, left: false, start: 0, col, heading });
					continue;
				}
				const endName = inner.endsWith('終わり') ? inner.slice(0, -3) : null;
				if (endName !== null && HEADINGS[endName] !== undefined) {
					const open = spans.pop();
					if (!open?.heading || open.name !== endName)
						fail(
							'unclosed-notation',
							'見出しの始まりと終わりが合いません',
							n,
							col,
							where
						);
					headingEnded = true;
					continue;
				}
				// 見出し（後ろから指す形）: 行の本文全体が対象。
				let m = inner.match(/^「(.+)」は(大見出し|中見出し|小見出し)$/);
				if (m) {
					// 行の本文の全体が対象。画像や注記など文字にならないものが混じっていれば、対象ではない。
					if (
						plainText(units) !== m[1] ||
						units.length === 0 ||
						units.some((u) => plainOf(u) === '')
					)
						fail(
							'unsupported-construct',
							'行の途中の見出しは扱えません',
							n,
							col,
							where
						);
					heading = HEADINGS[m[2]];
					headingEnded = true;
					continue;
				}
				// 挿絵（文中）。
				const img = imageNote(inner);
				if (img) {
					units.push({
						k: 'node',
						plain: '',
						kanji: false,
						d: 0,
						n: { kind: 'image', image: img.image, alt: img.alt, size: img.size }
					});
					continue;
				}
				// キャプション。
				if (inner === 'キャプション') {
					if (units.length > 0 || caption)
						fail(
							'unsupported-construct',
							'行の途中のキャプションは扱えません',
							n,
							col,
							where
						);
					caption = true;
					spans.push({ name: inner, left: false, start: 0, col });
					continue;
				}
				if (inner === 'キャプション終わり') {
					const open = spans.pop();
					if (open?.name !== 'キャプション')
						fail(
							'unclosed-notation',
							'キャプションの始まりと終わりが合いません',
							n,
							col,
							where
						);
					headingEnded = true;
					continue;
				}
				// 底本との差異などの注記は、そのまま注記として残す。
				if (
					/^「.+」は底本では「.+」$/.test(inner) ||
					/^ルビの「.+」は底本では「.+」$/.test(inner) ||
					/^「.+」はママ$/.test(inner)
				) {
					units.push({
						k: 'node',
						plain: '',
						kanji: false,
						d: 0,
						n: { kind: 'note', text: where }
					});
					continue;
				}
				// 後ろから指す装飾: 「X」に傍点 / 「X」は太字 など。
				m =
					inner.match(/^「(.+)」(の左)?に(.+)$/) ??
					inner.match(/^「(.+)」は(.+)$/);
				if (m) {
					const target = m[1];
					const left = inner.includes('」の左に');
					const name = m[m.length - 1] ?? '';
					const make = wrapOf(name, left);
					if (!make)
						fail('unknown-notation', '読めない注記です', n, col, where);
					wrapTail(units, target, make, n, col, where);
					continue;
				}
				// 始まりと終わりで囲む装飾。
				const left = inner.startsWith('左に');
				const name = (endName ?? inner).replace(/^左に/, '');
				const make = wrapOf(name, left);
				if (make && endName === null) {
					spans.push({ name, left, start: units.length, col });
					continue;
				}
				if (make && endName !== null) {
					const open = spans.pop();
					if (!open || open.name !== name || open.left !== left)
						fail(
							'unclosed-notation',
							'注記の始まりと終わりが合いません',
							n,
							col,
							where
						);
					const inner2 = units.splice(open.start, units.length - open.start);
					const children = toInline(inner2, n);
					if (children.length === 0)
						fail(
							'unsupported-construct',
							'囲まれた文字がありません',
							n,
							col,
							where
						);
					units.push({
						k: 'node',
						plain: inner2.map(plainOf).join(''),
						kanji: false,
						d: nest(inner2, n, col),
						n: make(children)
					});
					continue;
				}
				// 範囲の始まり・終わりが行の途中にある、読めない注記。
				fail('unknown-notation', '読めない注記です', n, col, where);
			}
		}
		if (spans.length > 0) {
			const open = spans[spans.length - 1];
			fail(
				'unclosed-notation',
				'複数行にまたがる記法は扱えません',
				n,
				open.col,
				`［＃${open.name}］`
			);
		}

		const layout = lineLayout ?? range?.layout ?? { kind: 'none' };
		const inline = toInline(units, n);
		if (heading) {
			blocks.push({
				kind: 'heading',
				id: nextId(),
				level: heading,
				layout,
				inline
			});
			return;
		}
		if (caption) {
			if (layout.kind !== 'none')
				fail(
					'unsupported-construct',
					'字下げなどの中のキャプションは扱えません',
					n
				);
			const prev = blocks.at(-1);
			if (prev?.kind !== 'figure' || prev.caption.length > 0)
				fail('unsupported-construct', '挿絵に続かないキャプションです', n);
			prev.caption = inline;
			return;
		}
		if (
			inline.length === 1 &&
			inline[0].kind === 'image' &&
			layout.kind === 'none'
		) {
			const { image, alt, size } = inline[0];
			blocks.push({
				kind: 'figure',
				id: nextId(),
				image,
				alt,
				size,
				caption: []
			});
			return;
		}
		blocks.push({ kind: 'paragraph', id: nextId(), layout, inline });
	}

	const plainText = (units: Unit[]) => units.map(plainOf).join('');

	/** 直前の対象の文字列を、1つのノードにまとめる。 */
	function wrapTail(
		units: Unit[],
		target: string,
		make: (children: Inline[]) => Inline,
		n: number,
		col: number,
		what: string
	) {
		let start = units.length;
		let got = '';
		while (start > 0 && got.length < target.length) {
			// 画像や注記など、対象の文字にならないものをまたいで探さない。
			if (plainOf(units[start - 1]) === '') break;
			start--;
			got = plainOf(units[start]) + got;
		}
		if (got !== target || start === units.length)
			fail(
				'unknown-notation',
				`対象「${target}」が直前にありません`,
				n,
				col,
				what
			);
		const taken = units.splice(start, units.length - start);
		units.push({
			k: 'node',
			plain: got,
			kanji: false,
			d: nest(taken, n, col),
			n: make(toInline(taken, n))
		});
	}

	/** ［＃ここから…］［＃ここで…終わり］。範囲の注記なら true。 */
	function rangeNote(inner: string, n: number, col: number): boolean {
		const where = `［＃${inner}］`;
		const start = (kind: 'indent' | 'end' | 'hanging', layout: Layout) => {
			// 字下げどうしは、終わりを省いて続けて指定できる。
			const sameIndent =
				range &&
				kind !== 'end' &&
				(range.kind === 'indent' || range.kind === 'hanging');
			if (range && !sameIndent)
				fail('unsupported-construct', '範囲が重なっています', n, col, where);
			range = { kind, layout, where: at(n, col, where) };
		};
		let m = inner.match(/^ここから([０-９0-9]+)字下げ$/);
		if (m) return (start('indent', { kind: 'indent', chars: num(m[1]) }), true);
		m = inner.match(
			/^ここから([０-９0-9]+)字下げ、折り返して([０-９0-9]+)字下げ$/
		);
		if (m) {
			const first = num(m[1]);
			const indent = num(m[2]);
			if (indent < first || indent < 1)
				fail(
					'unsupported-construct',
					'折り返しの字下げが読めません',
					n,
					col,
					where
				);
			return (
				start('hanging', { kind: 'hanging', indent, first: indent - first }),
				true
			);
		}
		m = inner.match(/^ここから改行天付き、折り返して([０-９0-9]+)字下げ$/);
		if (m) {
			const indent = num(m[1]);
			return (
				start('hanging', { kind: 'hanging', indent, first: indent }),
				true
			);
		}
		if (inner === 'ここから地付き')
			return (start('end', { kind: 'end', inset: 0 }), true);
		m = inner.match(/^ここから地から([０-９0-9]+)字上げ$/);
		if (m) return (start('end', { kind: 'end', inset: num(m[1]) }), true);
		const ends: Record<string, 'indent' | 'end'> = {
			ここで字下げ終わり: 'indent',
			ここで地付き終わり: 'end',
			ここで字上げ終わり: 'end'
		};
		const endKind =
			ends[inner] ??
			(/^ここで地から[０-９0-9]+字上げ終わり$/.test(inner) ? 'end' : undefined);
		if (endKind) {
			const ok =
				range &&
				(range.kind === endKind ||
					(endKind === 'indent' && range.kind === 'hanging'));
			if (!ok)
				fail(
					'unclosed-notation',
					'範囲の始まりと終わりが合いません',
					n,
					col,
					where
				);
			range = null;
			return true;
		}
		return false;
	}

	function imageNote(inner: string) {
		const m = inner.match(
			/^(.+)（([^、（）]+\.(?:png|jpe?g|gif))、横(\d+)×縦(\d+)）入る$/
		);
		if (!m) return null;
		let url: string;
		try {
			url = new URL(m[2], source.fileUrl).href;
		} catch {
			throw new Failure(
				'invalid-image',
				`画像の参照 ${m[2]} を解決できません`,
				'image'
			);
		}
		return {
			alt: m[1],
			image: { url },
			size: { width: Number(m[3]), height: Number(m[4]) }
		};
	}

	for (let i = bodyStart; i < bodyEnd; i++) line(lines[i], i);
	const open = openRange();
	if (open)
		throw new Failure('unclosed-notation', '範囲が閉じていません', open.where);

	const bibliography = lines.slice(bibStart).filter((l) => !isBlank(l));
	const candidate = {
		schemaVersion: WORK_SCHEMA_VERSION,
		id: source.id,
		title: source.title,
		titleReading: source.titleReading,
		subtitle: source.subtitle,
		subtitleReading: source.subtitleReading,
		classification: source.classification,
		originalTitle: source.originalTitle,
		firstPublication: source.firstPublication,
		people: source.people,
		orthography: source.orthography,
		provenance: {
			copyright: { work: 'なし' },
			source: {
				cardUrl: source.cardUrl,
				fileUrl: source.fileUrl,
				upstreamUpdated: source.upstreamUpdated
			},
			converter: { version: CONVERTER_VERSION, path: 'text' },
			bibliography: bibliography.map((l) => l.replace(/\s+$/, ''))
		},
		blocks
	};
	const checked = parseWork(candidate);
	if (!checked.ok) {
		const e = checked.error;
		throw new Failure(
			'schema',
			e.code === 'invalid' ? e.message : 'スキーマのバージョンが合いません',
			e.code === 'invalid' ? e.path : 'schemaVersion'
		);
	}
	return { ok: true, work: checked.work, diagnostics: [] };
}
