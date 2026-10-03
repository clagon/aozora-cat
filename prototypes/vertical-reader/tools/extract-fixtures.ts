// Plan 003 の使い捨て抽出器。公式XHTMLの抜粋から縮約フィクスチャを作る。
// 本番の変換器は Plan 004 で別に作るため、ここは既知の記法だけを正規表現で扱う。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Source = {
	id: string;
	workId: string;
	url: string;
	/** 抜粋の開始行（空白行を除く構造行を数えない通し番号）。 */
	from: number;
	count: number;
};

/** 字下げ（jisage）と地付き（chitsuki）。数値は字数。 */
type Wrapper = { kind: 'jisage' | 'chitsuki'; n: number };

type Line = {
	tag: 'blank' | 'break' | 'skip' | 'h' | 'img' | 'p';
	html: string;
	wrapper: Wrapper | null;
};

const root = fileURLToPath(new URL('../../../', import.meta.url));
const outDir = join(root, 'tests/fixtures/reader');
const cacheDir = process.env.AOZORA_CACHE ?? '/tmp/aozora-fixtures';

function isSource(value: unknown): value is Source {
	if (typeof value !== 'object' || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.id === 'string' &&
		typeof v.workId === 'string' &&
		typeof v.url === 'string' &&
		typeof v.from === 'number' &&
		typeof v.count === 'number'
	);
}

async function readSources(): Promise<Source[]> {
	const parsed: unknown = JSON.parse(
		await readFile(new URL('./sources.json', import.meta.url), 'utf8')
	);
	if (!Array.isArray(parsed) || !parsed.every(isSource)) {
		throw new Error('sources.json の形式が不正です');
	}
	return parsed;
}

async function fetchShiftJis(url: string): Promise<string> {
	const path = join(cacheDir, url.split('/').pop() ?? 'x.html');
	if (!existsSync(path)) {
		await mkdir(cacheDir, { recursive: true });
		const res = await fetch(url);
		if (!res.ok) throw new Error(`${url}: ${res.status}`);
		await writeFile(path, Buffer.from(await res.arrayBuffer()));
	}
	return new TextDecoder('shift_jis').decode(await readFile(path));
}

const gaiji = (alt: string) =>
	`<img class="gaiji" src="/img/gaiji.svg" alt="${alt}" width="32" height="32">`;

/** 上流の記法を、検証に必要な最小のHTMLへ正規化する。見出しにも同じ処理を通す。 */
function clean(html: string): string {
	return html
		.replace(/<div class="(?:jisage|chitsuki)_\d+"[^>]*>/g, '')
		.replace(/<\/div>/g, '')
		.replace(/<img class="gaiji"[^>]*alt="([^"]*)"[^>]*>/g, (_, alt: string) =>
			gaiji(alt)
		)
		.replace(
			/<img [^>]*src="[^"]*gaiji\/[^"]*"[^>]*alt="([^"]*)"[^>]*>/g,
			(_, alt: string) => gaiji(alt)
		)
		.replace(
			/<img class="illustration" width="(\d+)" height="(\d+)"[^>]*alt="([^"]*)"[^>]*>/g,
			(_, w: string, h: string, alt: string) =>
				`<img class="illustration" src="/img/illustration.svg" alt="${alt}" width="${w}" height="${h}" style="aspect-ratio:${w}/${h}">`
		)
		.replace(/<rp>[^<]*<\/rp>/g, '')
		.replace(/<rb>(.*?)<\/rb>/g, '$1')
		.replace(/<span class="notes">.*?<\/span>/g, '')
		.replace(/<br \/>/g, '');
}

/** 本文の1行を意味を保った最小のHTMLへ縮約する。 */
function convertLine(raw: string): Omit<Line, 'wrapper'> {
	const line = raw.trim();
	if (line === '') return { tag: 'blank', html: '' };
	if (/^<span class="notes">［＃改ページ］<\/span>$/.test(line))
		return { tag: 'break', html: '<hr data-page-break>' };
	if (/^<span class="notes">［＃ページの左右中央］<\/span>$/.test(line))
		return { tag: 'skip', html: '' };
	const heading = line.match(/<h(\d) class="[^"]*"><a [^>]*>(.*?)<\/a><\/h\d>/);
	if (heading) return { tag: 'h', html: `<h2>${clean(heading[2])}</h2>` };
	const html = clean(line);
	// 閉じタグや注記だけの行は、空行ではなく構造上の行なので数えない。
	if (html.trim() === '') return { tag: 'skip', html: '' };
	// 挿絵だけの行だけを単独画像として扱う。文中の画像は行内に残す。
	return /^<img class="illustration"[^>]*>$/.test(html)
		? { tag: 'img', html }
		: { tag: 'p', html };
}

/** 字下げは --indent（字数）、地付きは data-align="end" と --inset（字数）で残す。 */
function layout(wrapper: Wrapper | null): string {
	if (!wrapper) return '';
	return wrapper.kind === 'jisage'
		? ` style="--indent:${wrapper.n}"`
		: ` data-align="end" style="--inset:${wrapper.n}"`;
}

function extract(html: string, src: Source): { body: string; lines: number } {
	const start =
		html.indexOf('<div class="main_text">') + '<div class="main_text">'.length;
	const end = html.indexOf('<div class="bibliographical_information">');
	// 字下げ・地付きは複数行を囲む div のクラスで表されるため、行をまたいで状態を持つ。
	let wrapper: Wrapper | null = null;
	const lines = html
		.slice(start, end)
		.split(/<br \/>\r?\n|\r?\n/)
		.map((raw): Line => {
			const open = raw.match(/<div class="(jisage|chitsuki)_(\d+)"/);
			if (open) {
				wrapper = { kind: open[1] as Wrapper['kind'], n: Number(open[2]) };
			}
			const line = { ...convertLine(raw), wrapper };
			if (raw.includes('</div>')) wrapper = null;
			return line;
		});
	const picked = lines
		.filter((l) => l.tag !== 'skip')
		.slice(src.from, src.from + src.count);
	let n = 0;
	const body = picked
		.map((l) => {
			if (l.tag === 'break') return l.html;
			n += 1;
			if (l.tag === 'blank') return `<p data-p="${n}" data-blank></p>`;
			if (l.tag === 'h')
				return l.html.replace('<h2>', `<h2 data-p="${n}"${layout(l.wrapper)}>`);
			if (l.tag === 'img') return `<p data-p="${n}" data-image>${l.html}</p>`;
			return `<p data-p="${n}"${layout(l.wrapper)}>${l.html}</p>`;
		})
		.join('\n');
	return { body, lines: picked.length };
}

for (const src of await readSources()) {
	const { body, lines } = extract(await fetchShiftJis(src.url), src);
	await writeFile(join(outDir, `${src.id}.html`), `${body}\n`);
	console.log(src.id, `${lines} lines`, `${body.length} bytes`);
}
