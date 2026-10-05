import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ZipError, readZip, type ZipOptions } from './zip.ts';

type Entry = {
	name: string;
	data: string;
	method?: 0 | 8;
	flags?: number;
	crc?: number;
	rawSize?: number;
};

/** 試験用の最小のzipを作る。 */
function zip(entries: Entry[]): Uint8Array {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const e of entries) {
		const raw = Buffer.from(e.data);
		const packed = (e.method ?? 8) === 8 ? deflateRawSync(raw) : raw;
		const name = Buffer.from(e.name);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(e.method ?? 8, 8);
		local.writeUInt32LE(e.crc ?? crc32(raw), 14);
		local.writeUInt32LE(packed.length, 18);
		local.writeUInt32LE(e.rawSize ?? raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		const head = Buffer.alloc(46);
		head.writeUInt32LE(0x02014b50, 0);
		head.writeUInt16LE(e.flags ?? 0, 8);
		head.writeUInt16LE(e.method ?? 8, 10);
		head.writeUInt32LE(e.crc ?? crc32(raw), 16);
		head.writeUInt32LE(packed.length, 20);
		head.writeUInt32LE(e.rawSize ?? raw.length, 24);
		head.writeUInt16LE(name.length, 28);
		head.writeUInt32LE(offset, 42);
		parts.push(local, name, packed);
		central.push(head, name);
		offset += 30 + name.length + packed.length;
	}
	const dir = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(dir.length, 12);
	end.writeUInt32LE(offset, 16);
	return new Uint8Array(Buffer.concat([...parts, dir, end]));
}

const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b);
const limit: ZipOptions = { maxEntryBytes: 1000 };

describe('readZip', () => {
	it('deflate と store のファイルを読み、名前で引ける', () => {
		const got = readZip(
			zip([
				{ name: 'a.csv', data: 'あいう,えお\n'.repeat(5) },
				{ name: 'b.txt', data: 'そのまま', method: 0 }
			]),
			limit
		);
		expect([...got.keys()]).toEqual(['a.csv', 'b.txt']);
		expect(text(got.get('b.txt'))).toBe('そのまま');
		expect(text(got.get('a.csv'))).toContain('あいう,えお');
	});

	const rejects = (entries: Entry[], options = limit) =>
		expect(() => readZip(zip(entries), options)).toThrow(ZipError);

	it('チェックサム・大きさの食い違い、暗号化、重複した名前、展開後に大きすぎるものは拒否する', () => {
		rejects([{ name: 'a', data: 'abc', crc: 1 }]);
		rejects([{ name: 'a', data: 'abc', rawSize: 4 }]);
		rejects([{ name: 'a', data: 'abc', flags: 1 }]);
		rejects([
			{ name: 'a', data: 'x' },
			{ name: 'a', data: 'y' }
		]);
		rejects([{ name: 'a', data: 'x'.repeat(2000) }]);
	});

	it('申告より大きく展開されるzipは、展開しきる前に拒否する', () => {
		// 申告上は小さいが、実際は大きい（zip爆弾の形）。
		rejects([{ name: 'a', data: 'x'.repeat(100000), rawSize: 10 }]);
	});

	it('展開後の合計が上限を超えるzipは、1つずつは小さくても、展開する前に拒否する', () => {
		const big = 'x'.repeat(600);
		rejects([
			{ name: 'a', data: big },
			{ name: 'b', data: big }
		]);
		// 合計を広げれば通る。
		expect(
			readZip(
				zip([
					{ name: 'a', data: big },
					{ name: 'b', data: big }
				]),
				{ maxEntryBytes: 1000, maxTotalBytes: 2000 }
			).size
		).toBe(2);
	});

	it('zip でないもの・途中で切れたもの・ファイルが多すぎるものを拒否する', () => {
		expect(() =>
			readZip(new TextEncoder().encode('PK not a zip'), limit)
		).toThrow(ZipError);
		expect(() =>
			readZip(zip([{ name: 'a', data: 'abc' }]).slice(0, 40), limit)
		).toThrow(ZipError);
		rejects(
			[
				{ name: 'a', data: '1' },
				{ name: 'b', data: '2' }
			],
			{ maxEntryBytes: 1000, maxEntries: 1 }
		);
	});
});
