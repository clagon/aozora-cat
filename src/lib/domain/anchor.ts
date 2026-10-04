// 読書位置の識別と、作品が更新されたときの位置の移行。
// 位置は「block の id + block 内の文字位置」。文字位置は縦書きの決定に合わせ、
// ルビの読みと注記を数えず、画像（外字を含む）を1文字として数える。UTF-16 の単位で数える。

import type { Block, Inline, Work } from './work.ts';

const OBJECT = '￼';
/** 位置の前後に残す文字数。更新後に同じ場所を探す手がかりになる。 */
const CONTEXT = 24;
/** 手がかりがこれより短いと、別の場所と取り違えるので使わない。 */
const MIN_CONTEXT = 6;

export function inlineText(nodes: Inline[]): string {
	let out = '';
	for (const n of nodes) {
		if (n.kind === 'text') out += n.text;
		else if (n.kind === 'ruby') out += inlineText(n.base);
		else if (n.kind === 'gaiji' || n.kind === 'image') out += OBJECT;
		else if (n.kind !== 'note') out += inlineText(n.children);
	}
	return out;
}

/** 位置を持つ block の、位置の数え方に合わせた文字列。 */
export function blockText(b: Block): string {
	if (b.kind === 'paragraph' || b.kind === 'heading')
		return inlineText(b.inline);
	if (b.kind === 'figure') return OBJECT + inlineText(b.caption);
	return '';
}

export type Position = {
	blockId: string;
	offset: number;
	/** 位置の前後の文字（同じ block の中だけ）。block の内容が変わっても、探し直せる。 */
	before: string;
	after: string;
	/** 作品全体の文字数に対する位置の割合（0〜1）。最後の手段。 */
	percent: number;
};

/** 位置を持つ block と、その文字列、作品の先頭からの文字数（at）。 */
function texts(work: Work) {
	let at = 0;
	return work.blocks.flatMap((b) => {
		if (b.kind === 'pageBreak' || b.kind === 'pageCenter') return [];
		const text = blockText(b);
		const t = { id: b.id, text, at };
		at += text.length;
		return [t];
	});
}

/** 保存する位置を作る。block がない、または offset が範囲外なら null。 */
export function positionAt(
	work: Work,
	blockId: string,
	offset: number
): Position | null {
	let before = 0;
	let total = 0;
	let hit: string | null = null;
	for (const t of texts(work)) {
		if (t.id === blockId) {
			if (!Number.isInteger(offset) || offset < 0 || offset > t.text.length)
				return null;
			hit = t.text;
			before = total + offset;
		}
		total += t.text.length;
	}
	if (hit === null) return null;
	return {
		blockId,
		offset,
		before: hit.slice(Math.max(0, offset - CONTEXT), offset),
		after: hit.slice(offset, offset + CONTEXT),
		percent: total === 0 ? 0 : before / total
	};
}

/**
 * exact=同じ block と文字位置、context=前後の文字から探し直した位置、
 * percent=割合から求めた位置（読み手へ「位置が変わったかもしれない」と知らせる）。
 */
export type Restored = {
	how: 'exact' | 'context' | 'percent';
	blockId: string;
	offset: number;
};

/** 保存した値の項目。端末の保存領域から読むので、型は信用しない。 */
function field(saved: unknown, key: string): unknown {
	return typeof saved === 'object' && saved !== null
		? Reflect.get(saved, key)
		: undefined;
}

/**
 * 更新後の作品で、保存した位置に当たる場所を求める。文字がなければ null。
 * 保存した値は端末の保存領域から読むので、壊れていても例外にせず、割合へ回す。
 */
export function restorePosition(work: Work, saved: unknown): Restored | null {
	const all = texts(work);
	const [blockId, offset, before, after, share] = [
		'blockId',
		'offset',
		'before',
		'after',
		'percent'
	].map((k) => field(saved, k));
	const percent =
		typeof share === 'number' && Number.isFinite(share) ? share : 0;
	const total = all.reduce((sum, t) => sum + t.text.length, 0);
	if (total === 0) return null;

	if (
		typeof blockId === 'string' &&
		typeof offset === 'number' &&
		Number.isInteger(offset) &&
		typeof before === 'string' &&
		typeof after === 'string' &&
		offset >= before.length &&
		before.length <= CONTEXT &&
		after.length <= CONTEXT
	) {
		const same = all.find((t) => t.id === blockId);
		if (
			same &&
			offset <= same.text.length &&
			same.text.slice(offset - before.length, offset) === before &&
			same.text.startsWith(after, offset)
		) {
			const twins = all.filter((t) => t.text === same.text);
			if (twins.length === 1) return { how: 'exact', blockId, offset };
			// 同じ内容の block が他にもあると、番号が付け替わって id が別の block を指すことがある。
			// 保存した割合にいちばん近いものを選び、確かではないので exact にはしない。
			const near = twins.reduce((a, b) =>
				Math.abs(b.at / total - percent) < Math.abs(a.at / total - percent)
					? b
					: a
			);
			return { how: 'context', blockId: near.id, offset };
		}

		// 前後の文字がちょうど1か所に見つかるときだけ使う。複数あれば取り違えるので割合に任せる。
		const needle = before + after;
		if (needle.length >= MIN_CONTEXT) {
			const found: Restored[] = [];
			for (const t of all) {
				for (
					let i = t.text.indexOf(needle);
					i >= 0 && found.length < 2;
					i = t.text.indexOf(needle, i + 1)
				)
					found.push({
						how: 'context',
						blockId: t.id,
						offset: i + before.length
					});
				if (found.length > 1) break;
			}
			if (found.length === 1) return found[0];
		}
	}

	const target = Math.min(total - 1, Math.max(0, Math.floor(percent * total)));
	const hit = all.find((t) => target < t.at + t.text.length);
	return hit
		? { how: 'percent', blockId: hit.id, offset: target - hit.at }
		: null;
}
