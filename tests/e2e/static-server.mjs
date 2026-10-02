import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const routes = [
	['/fixtures/', 'tests/fixtures/reader/'],
	['/img/', 'tests/fixtures/reader/img/'],
	['/tokens.css', 'src/lib/ui/tokens.css'],
	['/', 'prototypes/vertical-reader/']
];
const types = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml'
};

/**
 * 検証ハーネス用の最小の静的サーバー。既定は自動テスト向けに 127.0.0.1 の空きポート。
 * 実機から開くときは host に 0.0.0.0 を渡す（prototypes/vertical-reader/serve.mjs）。
 */
export async function startStaticServer({ host = '127.0.0.1', port = 0 } = {}) {
	const server = createServer(async (req, res) => {
		const path = new URL(req.url ?? '/', 'http://x').pathname;
		const route = routes.find(([prefix]) => path.startsWith(prefix));
		if (!route) return void res.writeHead(404).end();
		const rel = path === '/' ? 'index.html' : path.slice(route[0].length) || '';
		const file = route[0] === '/tokens.css' ? route[1] : join(route[1], rel);
		if (file.includes('..')) return void res.writeHead(400).end();
		try {
			const body = await readFile(join(root, file));
			res
				.writeHead(200, {
					'content-type': types[extname(file)] ?? 'text/plain'
				})
				.end(body);
		} catch {
			res.writeHead(404).end();
		}
	});
	await new Promise((resolve) => server.listen(port, host, resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('no port');
	return {
		url: `http://${host}:${address.port}`,
		port: address.port,
		close: () => server.close()
	};
}
