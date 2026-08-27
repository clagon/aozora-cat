import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1'], {
	stdio: 'ignore',
	shell: process.platform === 'win32'
});

try {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		try {
			const response = await fetch('http://127.0.0.1:5173/');
			if (response.ok) break;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		if (attempt === 29) throw new Error('dev server did not start');
	}

	const browser = await chromium.launch({ headless: true });
	const page = await browser.newPage();
	await page.goto('http://127.0.0.1:5173/');
	if ((await page.title()) !== 'Aozora Cat')
		throw new Error('unexpected title');
	if (!(await page.getByRole('heading', { name: 'Aozora Cat' }).isVisible())) {
		throw new Error('product heading is not visible');
	}
	if (
		!(await page
			.getByText('青空文庫の作品を、静かに読むためのリーダー')
			.isVisible())
	) {
		throw new Error('product description is not visible');
	}
	await browser.close();
} finally {
	server.kill();
}
