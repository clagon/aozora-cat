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

	it('空の入力は行なし。閉じていない引用符は失敗にする', () => {
		expect(parseCsv('')).toEqual([]);
		expect(() => parseCsv('a,"b')).toThrow();
	});
});
