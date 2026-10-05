// 1つのzipを、展開後の大きさを制限しながら読む。取り込む zip は、公式のCSVとテキストだけ。
// 暗号化・zip64・分割・store/deflate 以外の圧縮は、扱わず拒否する。

import { crc32, inflateRawSync } from 'node:zlib';

export class ZipError extends Error {}

export type ZipOptions = {
	maxEntryBytes: number;
	maxEntries?: number;
	/** 展開後の合計の上限。省略すると maxEntryBytes と同じ（全体で1ファイルぶん）。 */
	maxTotalBytes?: number;
};

export function readZip(
	bytes: Uint8Array,
	{ maxEntryBytes, maxEntries = 64, maxTotalBytes = maxEntryBytes }: ZipOptions
): Map<string, Uint8Array> {
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const bad = (why: string): never => {
		throw new ZipError(`zip を読めません: ${why}`);
	};
	// 末尾から終端レコードを探す（コメントは最大 65535 バイト）。
	let eocd = -1;
	for (
		let i = bytes.length - 22;
		i >= Math.max(0, bytes.length - 22 - 0xffff);
		i--
	)
		if (v.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	if (eocd < 0) return bad('終端レコードがありません');
	const count = v.getUint16(eocd + 10, true);
	let at = v.getUint32(eocd + 16, true);
	if (count > maxEntries) bad('ファイルが多すぎます');
	if (count === 0xffff || at === 0xffffffff) bad('zip64 は扱えません');

	const out = new Map<string, Uint8Array>();
	let total = 0;
	for (let n = 0; n < count; n++) {
		if (at + 46 > bytes.length || v.getUint32(at, true) !== 0x02014b50)
			bad('中央ディレクトリが壊れています');
		const flags = v.getUint16(at + 8, true);
		const method = v.getUint16(at + 10, true);
		const crc = v.getUint32(at + 16, true);
		const size = v.getUint32(at + 20, true);
		const rawSize = v.getUint32(at + 24, true);
		const [nameLen, extraLen, commentLen] = [28, 30, 32].map((o) =>
			v.getUint16(at + o, true)
		);
		const local = v.getUint32(at + 42, true);
		const name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'latin1').decode(
			bytes.subarray(at + 46, at + 46 + nameLen)
		);
		at += 46 + nameLen + extraLen + commentLen;

		if (flags & 1) bad('暗号化されています');
		if (size === 0xffffffff || rawSize === 0xffffffff)
			bad('zip64 は扱えません');
		if (rawSize > maxEntryBytes) bad(`${name} が大きすぎます`);
		if (name.endsWith('/')) continue;
		total += rawSize;
		if (total > maxTotalBytes) bad('展開後の合計が大きすぎます');
		if (out.has(name)) bad(`${name} が重複しています`);
		if (local + 30 > bytes.length || v.getUint32(local, true) !== 0x04034b50)
			bad('ローカルヘッダが壊れています');
		const start =
			local +
			30 +
			v.getUint16(local + 26, true) +
			v.getUint16(local + 28, true);
		if (start + size > bytes.length) bad('データが足りません');
		const packed = bytes.subarray(start, start + size);
		let data: Uint8Array;
		if (method === 0) data = packed;
		else if (method === 8)
			try {
				data = inflateRawSync(packed, { maxOutputLength: maxEntryBytes });
			} catch {
				return bad(`${name} を展開できません`);
			}
		else return bad(`未対応の圧縮方式です（${method}）`);
		if (data.length !== rawSize) bad(`${name} の大きさが合いません`);
		if (crc32(data) !== crc) bad(`${name} のチェックサムが合いません`);
		out.set(name, new Uint8Array(data));
	}
	return out;
}
