// 青空文庫の公式XHTMLを、許可した構成だけで作品スキーマへ変換する。
// 上流のHTMLは信頼せず、実行も描画もしない。未知の構成は黙って捨てずに失敗させる。
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import {
	EMPHASIS_MARKS,
	hasVisible,
	isBlank,
	isGaijiImageUrl,
	WORK_SCHEMA_VERSION,
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
	Diagnostic,
	FailureCode,
	WorkSource
} from './types.ts';

type Node = DefaultTreeAdapterMap['node'];
type El = DefaultTreeAdapterMap['element'];

/** 挿絵のキャプション。直前の挿絵に結びつけるまでの一時的な形で、スキーマには出ない。 */
type Caption = { kind: 'caption'; children: Inline[] };
type Draft = Inline | Caption;

class Failure extends Error {
	failure: ConversionFailure;
	constructor(code: FailureCode, message: string, location: string) {
		super(message);
		this.failure = { code, message, location };
	}
}

const isEl = (n: Node): n is El => 'tagName' in n;
const isText = (n: Node): n is DefaultTreeAdapterMap['textNode'] =>
	n.nodeName === '#text';

/** 実行・読み込み・外部通信につながる要素。出力へは入れない。 */
const ACTIVE = new Set([
	'script',
	'style',
	'iframe',
	'frame',
	'frameset',
	'object',
	'embed',
	'applet',
	'form',
	'input',
	'button',
	'select',
	'textarea',
	'link',
	'meta',
	'base',
	'noscript',
	'template',
	'svg',
	'math',
	'audio',
	'video',
	'canvas'
]);

/** 中身が文字ではなくコードの要素。中に文字があっても本文ではないので、そのまま取り除く。 */
const CODE = new Set(['script', 'style']);

const BREAKS: Record<string, PageBreakStyle> = {
	改ページ: 'page',
	改丁: 'leaf',
	改見開き: 'spread',
	改段: 'column'
};

const DOTS: Record<string, EmphasisMark> = {
	sesame_dot: 'sesame',
	white_sesame_dot: 'whiteSesame',
	black_circle: 'blackCircle',
	white_circle: 'whiteCircle',
	'black_up-pointing_triangle': 'blackTriangle',
	'white_up-pointing_triangle': 'whiteTriangle',
	bullseye: 'bullseye',
	fisheye: 'fisheye',
	saltire: 'saltire'
};

const LINES: Record<string, EmphasisMark> = {
	solid: 'solid',
	double: 'double',
	dotted: 'dotted',
	dashed: 'dashed',
	wave: 'wave'
};

const HEADINGS: Record<string, { tag: string; level: HeadingLevel }> = {
	'o-midashi': { tag: 'h3', level: 'large' },
	'naka-midashi': { tag: 'h4', level: 'medium' },
	'ko-midashi': { tag: 'h5', level: 'small' }
};

const AOZORA_ORIGIN = 'https://www.aozora.gr.jp';

/** URL を取る属性。値のスキームを調べる。 */
const URL_ATTRS = [
	'href',
	'src',
	'action',
	'formaction',
	'data',
	'xlink:href',
	'poster'
];

/** 文字を持ちうる属性。実行要素の中にあれば、中身ごと捨てずに失敗させる。 */
const TEXT_ATTRS = [
	'value',
	'alt',
	'title',
	'placeholder',
	'label',
	'aria-label',
	'srcdoc'
];

/** 木の深さの上限。公式のファイルは十数段で、これを超えるのは異常な入力。 */
const MAX_DOM_DEPTH = 64;

/** 公式XHTMLを変換する。出力は必ず parseWork を通した作品か、場所つきの失敗になる。 */
export function convertXhtml(html: string, source: WorkSource): ConvertResult {
	// 頒布してよいのは作品の著作権フラグが「なし」のものだけ。本文を読む前に止める。
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
		return convert(html, source);
	} catch (e) {
		if (e instanceof Failure) return { ok: false, failure: e.failure };
		throw e;
	}
}

function convert(html: string, source: WorkSource): ConvertResult {
	const diagnostics: Diagnostic[] = [];
	const doc = parse(html, { sourceCodeLocationInfo: true });

	const where = (el: El) => {
		const loc = el.sourceCodeLocation;
		const cls = attr(el, 'class');
		return `L${loc?.startLine ?? '?'}:C${loc?.startCol ?? '?'} <${el.tagName}${cls ? ` class="${cls}"` : ''}>`;
	};
	const fail: (code: FailureCode, message: string, el: El) => never = (
		code,
		message,
		el
	) => {
		throw new Failure(code, message, where(el));
	};
	const note = (code: Diagnostic['code'], message: string, el: El) => {
		diagnostics.push({ code, message, location: where(el) });
	};

	/** 実行につながる要素を取り除く。表示される文字を含むものは、情報を失わないよう失敗させる。 */
	const removeActive = (el: El) => {
		// 子の文字に加えて、属性に入った文字（value・alt・title など）も、表示・読み上げされうる。
		const hasText = (n: Node): boolean =>
			isText(n)
				? n.value.trim() !== ''
				: isEl(n) &&
					(n.attrs.some(
						(a) => TEXT_ATTRS.includes(a.name) && a.value.trim() !== ''
					) ||
						n.childNodes.some(hasText));
		if (!CODE.has(el.tagName) && hasText(el))
			fail(
				'unsupported-construct',
				`<${el.tagName}> の中に表示される文字があります`,
				el
			);
		note('active-content-removed', `<${el.tagName}> を取り除きました`, el);
	};

	/** 意味を持つ属性以外は捨てる。イベント属性や javascript: は、捨てたことを記録する。 */
	const attrs = (el: El, allowed: string[]) => {
		for (const { name, value } of el.attrs) {
			// 意味を持つ属性でも、実行につながる値は先に調べて記録する。
			const active = isActiveAttr(name, value);
			if (
				!active &&
				(allowed.includes(name) || ['id', 'lang', 'xml:lang'].includes(name))
			)
				continue;
			note(
				active ? 'active-content-removed' : 'attribute-dropped',
				`属性 ${name} を取り除きました`,
				el
			);
		}
	};

	const root = doc.childNodes.filter(isEl).find((e) => e.tagName === 'html');
	const body = root?.childNodes.filter(isEl).find((e) => e.tagName === 'body');
	// 元のファイルに html と body がない場合、parse5 が補うので、位置のないものは存在しないものとして扱う。
	if (!root?.sourceCodeLocation || !body?.sourceCodeLocation)
		throw new Failure('missing-section', 'body がありません', 'document');

	// 再帰で読む前に、木の深さを数える。深く入れ子にした入力で例外にならないようにする。
	const stack: [El, number][] = [[root ?? body, 1]];
	for (let top = stack.pop(); top; top = stack.pop()) {
		const [el, depth] = top;
		if (depth > MAX_DOM_DEPTH)
			fail('unsupported-construct', '要素の入れ子が深すぎます', el);
		for (const child of el.childNodes)
			if (isEl(child)) stack.push([child, depth + 1]);
	}

	/** 捨てるセクションの中の、実行につながるものを記録する。 */
	const scanActive = (el: El) => {
		for (const child of el.childNodes.filter(isEl)) {
			if (ACTIVE.has(child.tagName))
				note(
					'active-content-removed',
					`<${child.tagName}> を取り除きました`,
					child
				);
			for (const { name, value } of child.attrs)
				if (isActiveAttr(name, value))
					note(
						'active-content-removed',
						`属性 ${name} を取り除きました`,
						child
					);
			scanActive(child);
		}
	};

	// 文書の外枠（html・head・body）の属性と、取り込まない head の中の実行につながるものも記録する。
	attrs(root ?? body, ['xmlns']);
	for (const child of root?.childNodes.filter(isEl) ?? [])
		if (child.tagName === 'head') {
			attrs(child, []);
			scanActive(child);
		}
	attrs(body, []);

	const sections: Record<string, El> = {};
	for (const node of body.childNodes) {
		if (isText(node)) {
			// セクションの外の本文は、途中で閉じた壊れたマークアップの可能性がある。捨てずに止める。
			if (node.value.trim() !== '')
				fail('unknown-section', 'セクションの外に文字があります', body);
			continue;
		}
		if (!isEl(node)) continue;
		if (ACTIVE.has(node.tagName)) {
			removeActive(node);
			continue;
		}
		const cls = attr(node, 'class');
		// セクションの外枠の属性も、中身と同じ規則で検査して記録する。
		if (node.tagName === 'div')
			attrs(node, attr(node, 'id') === 'contents' ? ['style'] : ['class']);
		if (node.tagName === 'div' && cls === 'main_text') {
			if (sections.main)
				fail('unsupported-construct', '本文が複数あります', node);
			sections.main = node;
		} else if (
			node.tagName === 'div' &&
			(cls === 'bibliographical_information' || cls === 'after_text')
		) {
			// ［＃本文終わり］のあるファイルでは、同じ形の記載事項が after_text に入る。どちらか1つだけ。
			if (sections.bibliography)
				fail('unsupported-construct', '底本情報が複数あります', node);
			sections.bibliography = node;
		} else if (node.tagName === 'div' && cls === 'metadata') scanActive(node);
		else if (node.tagName === 'div' && attr(node, 'id') === 'contents')
			scanActive(node);
		else if (node.tagName === 'div' && cls === 'notation_notes') {
			note('section-ignored', '表記についての定型の注記は含めません', node);
			scanActive(node);
		} else if (node.tagName === 'div' && attr(node, 'id') === 'card') {
			// 図書カードへの、スクリプトで動くリンク。中身は出力へ入れない。
			note(
				'section-ignored',
				'図書カードへのスクリプトのリンクは含めません',
				node
			);
			scanActive(node);
		} else fail('unknown-section', '未知のセクションです', node);
	}
	if (!sections.main)
		throw new Failure(
			'missing-section',
			'本文（main_text）がありません',
			'body'
		);
	if (!sections.bibliography)
		throw new Failure(
			'missing-section',
			'底本情報（bibliographical_information または after_text）がありません',
			'body'
		);

	/** 要素の文字列。外字の画像は、代わりに説明文（alt）を入れる。 */
	const plainText = (node: Node): string => {
		if (isText(node)) return node.value.replace(/[\r\n]/g, '');
		if (!isEl(node)) return '';
		if (ACTIVE.has(node.tagName)) return '';
		if (node.tagName === 'img') return attr(node, 'alt') ?? '';
		return node.childNodes.map(plainText).join('');
	};

	/**
	 * 注記の文字列。文字・外字の画像（説明文）・ルビだけを許し、ほかの要素は失敗させる。
	 * 底本との差異を引用する注記にはルビが入るので、青空文庫の記法（親文字《読み》）で残す。
	 */
	const noteText = (el: El, inRuby = false): string =>
		el.childNodes
			.map((child): string => {
				if (isText(child)) return plainText(child);
				if (!isEl(child)) return '';
				if (isGaiji(child)) return gaijiText(child);
				if (child.tagName !== 'ruby')
					return fail(
						'unsupported-construct',
						'注記の中に文字以外があります',
						child
					);
				if (inRuby)
					fail('unsupported-construct', 'ルビの中にルビがあります', child);
				const { rb, rt } = rubyParts(child);
				const base = noteText(rb, true);
				const reading = noteText(rt, true);
				if (isBlank(base) || isBlank(reading))
					fail('unsupported-construct', '注記の中のルビが空白だけです', child);
				return `${base}《${reading}》`;
			})
			.join('');

	/** 文字へ平らにする外字の説明。説明（alt）がなければ、文字を消さずに失敗させる。 */
	const gaijiText = (el: El): string => {
		attrs(el, ['class', 'src', 'alt']);
		const alt = attr(el, 'alt') ?? '';
		if (isBlank(alt))
			fail('invalid-image', '外字の説明（alt）がありません', el);
		// 説明文を信頼する前に、画像の参照も本文の外字と同じ規則で確かめる。
		if (!isGaijiImageUrl(resolve(el)))
			fail('invalid-image', '外字の画像が /gaiji/ の外にあります', el);
		return alt;
	};

	/** 画像の参照を、変換元ファイルを基準に絶対URLへ解決し、青空文庫の外を拒否する。 */
	const resolve = (el: El): string => {
		const src = attr(el, 'src') ?? '';
		let url: URL;
		try {
			url = new URL(src, source.fileUrl);
		} catch {
			return fail('invalid-image', `画像の参照 ${src} を解決できません`, el);
		}
		if (url.origin !== AOZORA_ORIGIN)
			fail('invalid-image', `青空文庫の外の画像です: ${src}`, el);
		return url.href;
	};

	const intAttr = (el: El, name: string): number => {
		const value = attr(el, name) ?? '';
		if (!/^\d{1,5}$/.test(value))
			fail('invalid-image', `${name} が整数ではありません: ${value}`, el);
		return Number(value);
	};

	/** 要素の中身。装飾やルビの中にキャプションは置けない。 */
	function nested(el: El, inRuby: boolean): Inline[] {
		return onlyInline(inlines(el.childNodes, inRuby), el);
	}

	function container(el: El, kind: ContainerKind, inRuby: boolean): Draft[] {
		return [{ kind, children: nested(el, inRuby) }];
	}

	function span(el: El, inRuby: boolean): Draft[] {
		const cls = attr(el, 'class');
		if (cls === undefined && attr(el, 'dir') === 'ltr') {
			attrs(el, ['dir']);
			return container(el, 'tcy', inRuby);
		}
		attrs(el, ['class']);
		if (cls === 'futoji') return container(el, 'strong', inRuby);
		if (cls === 'keigakomi') return container(el, 'frame', inRuby);
		if (cls === 'warichu') return container(el, 'warichu', inRuby);
		if (cls === 'yokogumi') return container(el, 'horizontal', inRuby);
		// 行の途中や装飾の中の注記は、構造の指示ではなく、そのまま注記として残す。
		if (cls === 'notes') return [{ kind: 'note', text: noteText(el) }];
		if (cls === 'caption')
			return [{ kind: 'caption', children: nested(el, inRuby) }];
		const size = cls?.match(/^(dai|sho)([1-5])$/);
		if (size)
			return [
				{
					kind: 'size',
					direction: size[1] === 'dai' ? 'larger' : 'smaller',
					step: Number(size[2]),
					children: nested(el, inRuby)
				}
			];
		return fail(
			'unknown-class',
			`未知の span です（${cls ?? 'class なし'}）`,
			el
		);
	}

	function emphasis(el: El, inRuby: boolean): Draft[] {
		attrs(el, ['class']);
		const cls = attr(el, 'class') ?? '';
		let mark: EmphasisMark | undefined;
		let side: 'right' | 'left' = 'right';
		const dot = cls.replace(/_after$/, '');
		if (DOTS[dot] !== undefined) {
			mark = DOTS[dot];
			if (cls.endsWith('_after')) side = 'left';
		}
		const line = cls.match(
			/^(underline|overline)_(solid|double|dotted|dashed|wave)$/
		);
		if (line) {
			mark = LINES[line[2]];
			side = line[1] === 'overline' ? 'left' : 'right';
		}
		if (!mark || !EMPHASIS_MARKS.includes(mark))
			return fail('unknown-class', `未知の強調です（${cls}）`, el);
		return [{ kind: 'emphasis', mark, side, children: nested(el, inRuby) }];
	}

	/** ルビの構造を確かめる。親文字（rb）と読み（rt）はちょうど1つずつ、rp は括弧だけ。 */
	function rubyParts(el: El): { rb: El; rt: El } {
		attrs(el, []);
		let rb: El | undefined;
		let rt: El | undefined;
		for (const child of el.childNodes) {
			if (isText(child)) {
				if (plainText(child).trim() !== '')
					fail('unsupported-construct', 'ルビの外に文字があります', el);
			} else if (isEl(child) && child.tagName === 'rb') {
				if (rb)
					fail('unsupported-construct', 'ルビの親文字が複数あります', child);
				rb = child;
			} else if (isEl(child) && child.tagName === 'rt') {
				if (rt)
					fail('unsupported-construct', 'ルビの読みが複数あります', child);
				rt = child;
			} else if (isEl(child) && child.tagName === 'rp') {
				attrs(child, []);
				if (child.childNodes.some((c) => !isText(c)))
					fail('unsupported-construct', 'rp に文字以外が入っています', child);
				if (!/^[（）()]*$/.test(plainText(child)))
					fail('unsupported-construct', 'rp に括弧以外の文字があります', child);
			} else if (isEl(child)) {
				fail(
					'unknown-element',
					`ルビの中の未知の要素 <${child.tagName}>`,
					child
				);
			}
		}
		if (!rb || !rt)
			return fail(
				'unsupported-construct',
				'ルビの親文字または読みがありません',
				el
			);
		attrs(rb, []);
		attrs(rt, []);
		if (rt.childNodes.some((c) => !isText(c)))
			fail('unsupported-construct', 'ルビの読みに文字以外が入っています', rt);
		return { rb, rt };
	}

	function ruby(el: El): Draft[] {
		const { rb, rt } = rubyParts(el);
		const base = onlyInline(inlines(rb.childNodes, true), rb);
		const reading = plainText(rt);
		if (!hasVisible(base) || isBlank(reading))
			fail('unsupported-construct', 'ルビの親文字または読みが空です', el);
		return [{ kind: 'ruby', base, reading }];
	}

	function image(el: El, inRuby: boolean): Draft[] {
		const cls = attr(el, 'class');
		if (cls === 'gaiji') {
			attrs(el, ['class', 'src', 'alt']);
			const description = attr(el, 'alt') ?? '';
			if (isBlank(description))
				fail('invalid-image', '外字の説明（alt）がありません', el);
			return [{ kind: 'gaiji', description, image: { url: resolve(el) } }];
		}
		if (cls === 'illustration') {
			if (inRuby)
				fail('unsupported-construct', 'ルビの親文字に挿絵は置けません', el);
			attrs(el, ['class', 'src', 'alt', 'width', 'height']);
			return [
				{
					kind: 'image',
					image: { url: resolve(el) },
					alt: attr(el, 'alt') ?? '',
					size: { width: intAttr(el, 'width'), height: intAttr(el, 'height') }
				}
			];
		}
		return fail(
			'unknown-class',
			`未知の画像です（${cls ?? 'class なし'}）`,
			el
		);
	}

	function onlyInline(drafts: Draft[], at: El): Inline[] {
		return drafts.map((d) => {
			if (d.kind === 'caption')
				return fail(
					'unsupported-construct',
					'ここにキャプションは置けません',
					at
				);
			return d;
		});
	}

	/** 行の中の要素。ここでは改行も構造（見出し・ブロック）も扱わない。 */
	function inlineEl(el: El, inRuby: boolean): Draft[] {
		switch (el.tagName) {
			case 'ruby':
				return inRuby
					? fail('unsupported-construct', 'ルビの親文字にルビがあります', el)
					: ruby(el);
			case 'em':
				return emphasis(el, inRuby);
			case 'span':
				return span(el, inRuby);
			case 'sup':
			case 'sub': {
				attrs(el, ['class']);
				const kind = el.tagName === 'sup' ? 'superscript' : 'subscript';
				if (attr(el, 'class') !== kind)
					fail('unknown-class', `未知の ${el.tagName} です`, el);
				return container(el, kind, inRuby);
			}
			case 'img':
				return image(el, inRuby);
			case 'a':
				// リンクは外へ出さない。文字だけを残す。
				note('link-removed', 'リンクを取り除き、文字だけを残しました', el);
				attrs(el, ['href']);
				return inlines(el.childNodes, inRuby);
			default:
				return fail('unknown-element', `未知の要素 <${el.tagName}> です`, el);
		}
	}

	function inlines(nodes: Node[], inRuby: boolean): Draft[] {
		const out: Draft[] = [];
		for (const node of nodes) {
			if (isText(node)) {
				const text = plainText(node);
				if (text !== '') out.push({ kind: 'text', text });
			} else if (isEl(node)) {
				if (ACTIVE.has(node.tagName)) removeActive(node);
				else for (const d of inlineEl(node, inRuby)) out.push(d);
			}
		}
		return merge(out);
	}

	/** 隣り合うテキストを1つにする。 */
	function merge(drafts: Draft[]): Draft[] {
		const out: Draft[] = [];
		for (const d of drafts) {
			const last = out.at(-1);
			if (d.kind === 'text' && last?.kind === 'text')
				out[out.length - 1] = { kind: 'text', text: last.text + d.text };
			else out.push(d);
		}
		return out;
	}

	// ここから本文。1行は、改行（br）かブロックの終わりで区切る。
	const blocks: Block[] = [];
	let line: Draft[] = [];
	let layout: Layout = { kind: 'none' };
	let inWrapper = false;
	let count = 0;
	let skipBr = false;

	const nextId = () => `p${++count}`;

	function emitLine(at: El) {
		const drafts = merge(line);
		line = [];
		const [only] = drafts;
		if (drafts.length === 1 && only.kind === 'caption') {
			// 字下げの中のキャプションは、字下げを表せないので受け取らない。
			if (layout.kind !== 'none')
				fail(
					'unsupported-construct',
					'字下げなどの中のキャプションは扱えません',
					at
				);
			const prev = blocks.at(-1);
			if (prev?.kind !== 'figure' || prev.caption.length > 0)
				fail('unsupported-construct', '挿絵に続かないキャプションです', at);
			prev.caption = only.children;
			return;
		}
		const inline = onlyInline(drafts, at);
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

	const flushIfNeeded = (at: El) => {
		if (line.length > 0) emitLine(at);
	};

	function layoutOf(el: El): Layout {
		attrs(el, ['class', 'style']);
		const cls = attr(el, 'class') ?? '';
		const style = (attr(el, 'style') ?? '').replace(/\s+/g, ' ').trim();
		const num = (re: RegExp) => {
			const m = style.match(re);
			return m ? Number(m[1]) : NaN;
		};
		let m = cls.match(/^jisage_(\d{1,3})$/);
		if (m && style.replace(/;$/, '') === `margin-left: ${m[1]}em`)
			return { kind: 'indent', chars: Number(m[1]) };
		m = cls.match(/^chitsuki_(\d{1,3})$/);
		if (
			m &&
			style.replace(/;$/, '') ===
				`text-align:right; margin-right: ${m[1]}em`.replace(/\s+/g, ' ')
		)
			return { kind: 'end', inset: Number(m[1]) };
		if (cls === 'burasage') {
			const left = num(/^margin-left: (\d{1,3})em; text-indent: -\d{1,3}em;?$/);
			const hang = num(/^margin-left: \d{1,3}em; text-indent: -(\d{1,3})em;?$/);
			if (
				Number.isInteger(left) &&
				Number.isInteger(hang) &&
				hang >= 1 &&
				left >= hang
			)
				return { kind: 'hanging', indent: left, first: hang };
		}
		if (/^(jisage|chitsuki|burasage)/.test(cls))
			return fail('invalid-layout', `字下げの指定を読めません（${style}）`, el);
		return fail(
			'unknown-class',
			`未知の div です（${cls || 'class なし'}）`,
			el
		);
	}

	function heading(el: El) {
		const cls = attr(el, 'class') ?? '';
		const spec = HEADINGS[cls];
		if (!spec || spec.tag !== el.tagName)
			fail('unknown-class', `未知の見出しです（${el.tagName}.${cls}）`, el);
		attrs(el, ['class']);
		const children = el.childNodes.flatMap((child): Node[] => {
			if (!(isEl(child) && child.tagName === 'a')) return [child];
			if (attr(child, 'class') !== 'midashi_anchor')
				fail('unknown-class', '未知のリンクです', child);
			attrs(child, ['class']);
			return child.childNodes;
		});
		blocks.push({
			kind: 'heading',
			id: nextId(),
			level: spec.level,
			layout,
			inline: onlyInline(inlines(children, false), el)
		});
	}

	function noteSpan(el: El) {
		attrs(el, ['class']);
		const text = noteText(el);
		const inner = text.match(/^［＃(.*)］$/s)?.[1];
		const pageBreak = inner === undefined ? undefined : BREAKS[inner];
		if (pageBreak !== undefined || inner === 'ページの左右中央') {
			flushIfNeeded(el);
			blocks.push(
				pageBreak !== undefined
					? { kind: 'pageBreak', style: pageBreak }
					: { kind: 'pageCenter' }
			);
			// 指示だけの行の改行は、空行ではなく行の終わりとして扱う。
			skipBr = true;
			return;
		}
		line.push({ kind: 'note', text });
	}

	function walk(nodes: Node[], at: El) {
		for (const node of nodes) {
			if (isText(node)) {
				const text = plainText(node);
				if (text !== '') {
					line.push({ kind: 'text', text });
					skipBr = false;
				}
				continue;
			}
			if (!isEl(node)) continue;
			if (ACTIVE.has(node.tagName)) {
				removeActive(node);
				continue;
			}
			if (node.tagName === 'br') {
				attrs(node, []);
				if (skipBr) skipBr = false;
				else emitLine(node);
				continue;
			}
			const wasSkipping = skipBr;
			skipBr = false;
			if (node.tagName === 'div') {
				// 未知の div（罫囲み・横組みなど）は、先に種類の不明として止める。
				const wrapper = layoutOf(node);
				if (inWrapper)
					fail(
						'unsupported-construct',
						'字下げの中に別のブロックがあります',
						node
					);
				flushIfNeeded(node);
				layout = wrapper;
				inWrapper = true;
				walk(node.childNodes, node);
				flushIfNeeded(node);
				layout = { kind: 'none' };
				inWrapper = false;
			} else if (/^h[1-6]$/.test(node.tagName)) {
				flushIfNeeded(node);
				heading(node);
			} else if (node.tagName === 'span' && attr(node, 'class') === 'notes') {
				skipBr = wasSkipping;
				noteSpan(node);
			} else {
				// 要素が多くても引数の上限に当たらないよう、展開せず1つずつ足す。
				for (const d of inlineEl(node, false)) line.push(d);
			}
		}
		flushIfNeeded(at);
	}

	walk(sections.main.childNodes, sections.main);

	// 底本情報。上流の順のまま、行ごとに残す。
	const bibliography: string[] = [];
	let current = '';
	const collect = (nodes: Node[]) => {
		for (const node of nodes) {
			if (isText(node)) current += plainText(node);
			else if (isEl(node) && node.tagName === 'br') {
				attrs(node, []);
				bibliography.push(current);
				current = '';
			} else if (isEl(node) && ACTIVE.has(node.tagName)) removeActive(node);
			else if (isEl(node) && node.tagName === 'hr') {
				// 罫線は行の区切り。前後の記載事項を1行に連結しない。
				attrs(node, []);
				bibliography.push(current);
				current = '';
			} else if (isEl(node) && node.tagName === 'a') {
				note('link-removed', 'リンクを取り除き、文字だけを残しました', node);
				attrs(node, ['href']);
				collect(node.childNodes);
			} else if (isEl(node) && isGaiji(node)) current += gaijiText(node);
			else if (isEl(node))
				fail(
					'unknown-element',
					`底本情報の中の未知の要素 <${node.tagName}>`,
					node
				);
		}
	};
	collect(sections.bibliography.childNodes);
	bibliography.push(current);

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
			converter: { version: CONVERTER_VERSION, path: 'xhtml' },
			bibliography: bibliography
				.map((l) => l.replace(/\s+$/, ''))
				.filter((l) => l !== '')
		},
		blocks
	};
	// 最後の関門。ここを通らない出力は返さない。
	const checked = parseWork(candidate);
	if (!checked.ok) {
		const e = checked.error;
		throw new Failure(
			'schema',
			e.code === 'invalid' ? e.message : 'スキーマのバージョンが合いません',
			e.code === 'invalid' ? e.path : 'schemaVersion'
		);
	}
	return { ok: true, work: checked.work, diagnostics };
}

/** イベント属性、または javascript: などのスキームを持つ URL 属性。 */
function isActiveAttr(name: string, value: string): boolean {
	return (
		name.startsWith('on') ||
		(URL_ATTRS.includes(name) && /^\s*(javascript|data|vbscript):/i.test(value))
	);
}

function isGaiji(el: El): boolean {
	return el.tagName === 'img' && attr(el, 'class') === 'gaiji';
}

function attr(el: El, name: string): string | undefined {
	return el.attrs.find((a) => a.name === name)?.value;
}
