import { webkit } from 'playwright';

const browser = await webkit.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://127.0.0.1:5173/');
if ((await page.title()) !== 'Aozora Cat') throw new Error('unexpected title');
await browser.close();
