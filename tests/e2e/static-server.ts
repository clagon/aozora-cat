import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** URL の接頭辞と、リポジトリ内の配信元の対応。上から順に最初に一致したものを使う。 */
const routes: readonly (readonly [prefix: string, source: string])[] = [
	['/fixtures/', 'tests/fixtures/reader/'],
	['/img/', 'tests/fixtures/reader/img/'],
	['/tokens.css', 'src/lib/ui/tokens.css'],
	['/', 'prototypes/vertical-reader/']
];

const contentTypes: Readonly<Record<string, string>> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml'
};

export type StaticServerOptions = {
	/** 既定は自動テスト向けの 127.0.0.1。実機から開くときは 0.0.0.0。 */
	host?: string;
	/** 0 なら空きポートを使う。 */
	port?: number;
};

export type StaticServer = {
	url: string;
	port: number;
	close: () => void;
};

/**
 * 検証ハーネス用の最小の静的サーバー。
 * 実機から開くときは host に 0.0.0.0 を渡す（prototypes/vertical-reader/serve.mjs）。
 */
export async function startStaticServer({
	host = '127.0.0.1',
	port = 0
}: StaticServerOptions = {}): Promise<StaticServer> {
	const server = createServer(async (req, res) => {
		const path = new URL(req.url ?? '/', 'http://x').pathname;
		const route = routes.find(([prefix]) => path.startsWith(prefix));
		if (!route) return void res.writeHead(404).end();
		const [prefix, source] = route;
		const relative = path === '/' ? 'index.html' : path.slice(prefix.length);
		const file = prefix === '/tokens.css' ? source : join(source, relative);
		if (file.includes('..')) return void res.writeHead(400).end();
		try {
			const body = await readFile(join(root, file));
			res
				.writeHead(200, {
					'content-type': contentTypes[extname(file)] ?? 'text/plain'
				})
				.end(body);
		} catch {
			res.writeHead(404).end();
		}
	});
	await new Promise<void>((resolve) => server.listen(port, host, resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('no port');
	return {
		url: `http://${host}:${address.port}`,
		port: address.port,
		close: () => void server.close()
	};
}
