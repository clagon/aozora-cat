import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv.ts';

describe('parseCsv', () => {
	it('引用符の中のカンマ・改行・二重の引用符と、空のフィールドを読む', () => {
		expect(parseCsv('a,"b,c","d\ne","f""g",\n"",x\n')).toEqual([
			['a', 'b,c', 'd\ne', 'f"g', ''],
			['', 'x']
		]);
	});

	it('CRLF と CR の行末、末尾の改行がない最終行を読む', () => {
		expect(parseCsv('a,b\r\nc,d\re,f')).toEqual([
			['a', 'b'],
			['c', 'd'],
			['e', 'f']
		]);
	});

	it('閉じた引用符の後ろの文字と、フィールドの途中の引用符は、読み替えず失敗にする', () => {
		expect(() => parseCsv('"な"し,x')).toThrow();
		expect(() => parseCsv('a,"な" ,x')).toThrow();
		expect(() => parseCsv('ab"c",x')).toThrow();
		expect(() => parseCsv('a"')).toThrow();
		// 引用符で閉じた直後が、区切り・行末・入力の終わりなら通る。
		expect(parseCsv('"a","b"\n"c"')).toEqual([['a', 'b'], ['c']]);
	});

	it('空の入力は行なし。閉じていない引用符は失敗にする', () => {
		expect(parseCsv('')).toEqual([]);
		expect(() => parseCsv('a,"b')).toThrow();
	});
});
