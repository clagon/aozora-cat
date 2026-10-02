// Plan 003 の使い捨て抽出器。公式XHTMLの抜粋から縮約フィクスチャを作る。
// 本番の変換器は Plan 004 で別に作るため、ここは既知の記法だけを正規表現で扱う。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const outDir = join(root, 'tests/fixtures/reader');
const cacheDir = process.env.AOZORA_CACHE ?? '/tmp/aozora-fixtures';

/** @type {{id:string, workId:string, url:string, from:number, count:number}[]} */
const sources = JSON.parse(
	await readFile(new URL('./sources.json', import.meta.url), 'utf8')
);

async function fetchShiftJis(url) {
	const path = join(cacheDir, url.split('/').pop() ?? 'x.html');
	if (!existsSync(path)) {
		await mkdir(cacheDir, { recursive: true });
		const res = await fetch(url);
		if (!res.ok) throw new Error(`${url}: ${res.status}`);
		await writeFile(path, Buffer.from(await res.arrayBuffer()));
	}
	return new TextDecoder('shift_jis').decode(await readFile(path));
}

/** 本文の1行を意味を保った最小のHTMLへ縮約する。 */
function convertLine(raw) {
	let line = raw.trim();
	if (line === '') return { tag: 'blank', html: '' };
	if (/^<span class="notes">［＃改ページ］<\/span>$/.test(line))
		return { tag: 'break', html: '<hr data-page-break>' };
	if (/^<span class="notes">［＃ページの左右中央］<\/span>$/.test(line))
		return { tag: 'skip', html: '' };
	const heading = line.match(/<h(\d) class="[^"]*"><a [^>]*>(.*?)<\/a><\/h\d>/);
	if (heading) return { tag: 'h', html: `<h2>${heading[2]}</h2>` };
	line = line
		.replace(/<div class="(?:jisage|chitsuki)_\d+"[^>]*>/g, '')
		.replace(/<\/div>/g, '')
		.replace(
			/<img class="gaiji"[^>]*alt="([^"]*)"[^>]*>/g,
			(_, alt) =>
				`<img class="gaiji" src="/img/gaiji.svg" alt="${alt}" width="32" height="32">`
		)
		.replace(
			/<img [^>]*src="[^"]*gaiji\/[^"]*"[^>]*alt="([^"]*)"[^>]*>/g,
			(_, alt) =>
				`<img class="gaiji" src="/img/gaiji.svg" alt="${alt}" width="32" height="32">`
		)
		.replace(
			/<img class="illustration" width="(\d+)" height="(\d+)"[^>]*alt="([^"]*)"[^>]*>/g,
			(_, w, h, alt) =>
				`<img class="illustration" src="/img/illustration.svg" alt="${alt}" width="${w}" height="${h}">`
		)
		.replace(/<rp>[^<]*<\/rp>/g, '')
		.replace(/<rb>(.*?)<\/rb>/g, '$1')
		.replace(/<span class="notes">.*?<\/span>/g, '')
		.replace(/<br \/>/g, '');
	// 挿絵だけの行だけを単独画像として扱う。文中の画像は行内に残す。
	return /^<img class="illustration"[^>]*>$/.test(line)
		? { tag: 'img', html: line }
		: { tag: 'p', html: line };
}

for (const src of sources) {
	const html = await fetchShiftJis(src.url);
	const start =
		html.indexOf('<div class="main_text">') + '<div class="main_text">'.length;
	const end = html.indexOf('<div class="bibliographical_information">');
	// 字下げ・地付きは複数行を囲む div のクラスで表されるため、行をまたいで状態を持つ。
	let wrapper = null;
	const lines = html
		.slice(start, end)
		.split(/<br \/>\r?\n|\r?\n/)
		.map((raw) => {
			const open = raw.match(/<div class="(jisage|chitsuki)_(\d+)"/);
			if (open) wrapper = { kind: open[1], n: Number(open[2]) };
			const line = { ...convertLine(raw), wrapper };
			if (raw.includes('</div>')) wrapper = null;
			return line;
		});
	const picked = lines
		.filter((l) => l.tag !== 'skip')
		.slice(src.from, src.from + src.count);
	let n = 0;
	// 字下げは --indent（字数）、地付きは data-align="end" と --inset（字数）で残す。
	const layout = (l) =>
		!l.wrapper
			? ''
			: l.wrapper.kind === 'jisage'
				? ` style="--indent:${l.wrapper.n}"`
				: ` data-align="end" style="--inset:${l.wrapper.n}"`;
	const body = picked
		.map((l) => {
			if (l.tag === 'break') return l.html;
			n += 1;
			if (l.tag === 'blank') return `<p data-p="${n}" data-blank></p>`;
			if (l.tag === 'h')
				return l.html.replace('<h2>', `<h2 data-p="${n}"${layout(l)}>`);
			if (l.tag === 'img') return `<p data-p="${n}" data-image>${l.html}</p>`;
			return `<p data-p="${n}"${layout(l)}>${l.html}</p>`;
		})
		.join('\n');
	await writeFile(join(outDir, `${src.id}.html`), `${body}\n`);
	console.log(src.id, `${picked.length} lines`, `${body.length} bytes`);
}
