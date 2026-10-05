import { describe, expect, it } from 'vitest';
import { makeZip as zip, type ZipEntry as Entry } from './test-zip.ts';
import { ZipError, readZip, type ZipOptions } from './zip.ts';

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
