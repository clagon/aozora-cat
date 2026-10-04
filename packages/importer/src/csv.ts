// RFC 4180 の CSV を読む。引用符の中の改行・カンマ・二重の引用符を扱い、BOM は呼び出し側で除く。

export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	let touched = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quoted) {
			if (c !== '"') field += c;
			else if (text[i + 1] === '"') ((field += '"'), i++);
			else quoted = false;
		} else if (c === '"' && field === '') {
			quoted = true;
			touched = true;
		} else if (c === ',') {
			row.push(field);
			field = '';
			touched = true;
		} else if (c === '\n' || c === '\r') {
			if (c === '\r' && text[i + 1] === '\n') i++;
			if (touched || field !== '') rows.push([...row, field]);
			row = [];
			field = '';
			touched = false;
		} else {
			field += c;
			touched = true;
		}
	}
	if (quoted) throw new Error('CSV の引用符が閉じていません');
	if (touched || field !== '') rows.push([...row, field]);
	return rows;
}
