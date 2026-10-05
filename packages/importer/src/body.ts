// 取得した本文を、変換器へ渡せる文字列にする。復号と zip の展開は、ここだけで行う。

import { readZip, ZipError } from './zip.ts';
import type { BodyRef, CatalogWork } from './types.ts';
import type { WorkSource } from '../../converter/src/index.ts';

/** 展開後の本文の上限。公式の本文は数MBまで。 */
const MAX_BODY_BYTES = 64 * 2 ** 20;

export type Decoded =
	| { ok: true; text: string }
	| { ok: false; code: 'decode-error'; message: string };

export function decodeBody(
	path: 'xhtml' | 'text',
	encoding: BodyRef['encoding'],
	bytes: Uint8Array
): Decoded {
	let body = bytes;
	if (path === 'text') {
		// テキストは zip の中の .txt 1つ。
		try {
			const entries = readZip(bytes, {
				maxEntryBytes: MAX_BODY_BYTES,
				maxEntries: 8
			});
			const txt = [...entries.keys()].filter((n) => n.endsWith('.txt'));
			if (txt.length !== 1)
				return fail(`zip の中の .txt が1つではありません（${txt.length}）`);
			body = entries.get(txt[0]) as Uint8Array;
		} catch (e) {
			if (e instanceof ZipError) return fail(e.message);
			throw e;
		}
	}
	try {
		return {
			ok: true,
			text: new TextDecoder(encoding === 'ShiftJIS' ? 'shift_jis' : 'utf-8', {
				fatal: true
			}).decode(body)
		};
	} catch {
		return fail(`${encoding} として読めない文字があります`);
	}
}

const fail = (message: string): Decoded => ({
	ok: false,
	code: 'decode-error',
	message
});

/** 目録の1作品と本文の参照から、変換器へ渡す来歴つきの入力を作る。 */
export function toSource(work: CatalogWork, ref: BodyRef): WorkSource {
	const reading = (v?: string) => (v ? v : undefined);
	return {
		id: work.id,
		title: work.title,
		titleReading: reading(work.titleReading),
		subtitle: work.subtitle,
		subtitleReading: reading(work.subtitleReading),
		classification: work.classification,
		originalTitle: work.originalTitle,
		firstPublication: work.firstPublication,
		people: work.people.map(({ role, name, reading: r }) => ({
			role,
			name,
			...(r && { reading: r })
		})),
		orthography: work.orthography,
		workCopyrightFlag: work.workCopyright,
		cardUrl: work.cardUrl,
		fileUrl: ref.url,
		upstreamUpdated: ref.updated
	};
}
