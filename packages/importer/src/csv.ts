// RFC 4180 の CSV を読む。引用符の中の改行・カンマ・二重の引用符を扱い、BOM は呼び出し側で除く。
// 壊れた引用符（閉じた後ろに文字がある、フィールドの途中にある）は、読み替えず失敗にする。

export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	/** 現在のフィールドに、文字か引用符を置いたか。 */
	let started = false;
	/** 現在の行に、何かを置いたか。 */
	let touched = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c !== '"') field += c;
			else if (text[i + 1] === '"') ((field += '"'), i++);
			else {
				quoted = false;
				// 閉じた引用符の直後は、区切りか行末でなければならない。続きを黙ってつなげない。
				const next = text[i + 1];
				if (
					next !== undefined &&
					next !== ',' &&
					next !== '\n' &&
					next !== '\r'
				)
					throw new Error('CSV の閉じた引用符の後ろに文字があります');
			}
		} else if (c === '"') {
			if (started) throw new Error('CSV のフィールドの途中に引用符があります');
			quoted = started = touched = true;
		} else if (c === ',') {
			row.push(field);
			field = '';
			started = false;
			touched = true;
		} else if (c === '\n' || c === '\r') {
			if (c === '\r' && text[i + 1] === '\n') i++;
			if (touched || field !== '') rows.push([...row, field]);
			row = [];
			field = '';
			started = touched = false;
		} else {
			field += c;
			started = touched = true;
		}
	}
	if (quoted) throw new Error('CSV の引用符が閉じていません');
	if (touched || field !== '') rows.push([...row, field]);
	return rows;
}
