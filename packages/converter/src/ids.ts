// block の id を、内容から決める。前に block が増えても、無関係な block の id は変わらない。
// 同じ内容が重なるときは出現順の番号を付ける。内容のない行（空行）は、直前の block も混ぜる。

import { createHash } from 'node:crypto';
import { blockText } from '../../../src/lib/domain/anchor.ts';
import type { Block } from '../../../src/lib/domain/work.ts';

export function withStableIds(blocks: Block[]): Block[] {
	const seen = new Map<string, number>();
	let prev = '';
	return blocks.map((b) => {
		if (b.kind === 'pageBreak' || b.kind === 'pageCenter') return b;
		const text = blockText(b);
		const key =
			b.kind === 'figure'
				? `figure\0${b.image.url}\0${text}`
				: `${b.kind}\0${text}`;
		const hash = createHash('sha256')
			.update(text === '' ? `${key}\0${prev}` : key)
			.digest('hex')
			.slice(0, 12);
		prev = hash;
		const n = (seen.get(hash) ?? 0) + 1;
		seen.set(hash, n);
		return { ...b, id: n === 1 ? `p-${hash}` : `p-${hash}-${n}` };
	});
}
