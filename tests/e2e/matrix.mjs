import { chromium, webkit } from 'playwright';
import { spawn } from 'node:child_process';

const server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1'], {
	stdio: 'ignore',
	shell: process.platform === 'win32'
});

async function waitForServer() {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		try {
			const response = await fetch('http://127.0.0.1:5173/');
			if (response.ok) return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw new Error('dev server did not start');
}

async function check(browserType, name) {
	const browser = await browserType.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.goto('http://127.0.0.1:5173/');
		if ((await page.title()) !== 'Aozora Cat')
			throw new Error(`${name}: unexpected title`);
		if (
			!(await page.getByRole('heading', { name: 'Aozora Cat' }).isVisible())
		) {
			throw new Error(`${name}: product heading is not visible`);
		}
		if (
			!(await page
				.getByText('青空文庫の作品を、静かに読むためのリーダー')
				.isVisible())
		) {
			throw new Error(`${name}: product description is not visible`);
		}
	} finally {
		await browser.close();
	}
}

try {
	await waitForServer();
	await check(chromium, 'chromium');
	await check(webkit, 'webkit');
} finally {
	server.kill();
}
