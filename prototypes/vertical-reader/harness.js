import { createReader } from '/reader.js';
import { attachGestures } from '/gestures.js';

const params = new URLSearchParams(location.search);
const viewport = document.getElementById('viewport');
const chrome = document.getElementById('chrome');
const status = document.getElementById('status');
if (!(viewport && chrome && status))
	throw new Error('harness markup is missing');

document.documentElement.dataset.theme = params.get('theme') ?? 'paper';
// 検証環境に明朝がないため、テストでは固定フォントを指定できるようにする。
const font = params.get('font');
if (font) document.documentElement.style.setProperty('--font-reading', font);
const reader = createReader(viewport);
Object.assign(reader.state, {
	size: Number(params.get('size') ?? 18),
	mode: params.get('mode') ?? 'vertical',
	approach: params.get('approach') ?? 'offsets'
});

function updateStatus() {
	status.textContent = `${reader.state.page + 1} / ${reader.state.pageCount}`;
}

const html = await (
	await fetch(`/fixtures/${params.get('fixture') ?? 'kumo-no-ito'}.html`)
).text();
reader.load(html);
updateStatus();

attachGestures(viewport, {
	enabled: () => reader.state.mode === 'vertical',
	next: () => (reader.next(), updateStatus()),
	prev: () => (reader.prev(), updateStatus()),
	center: () => {
		chrome.hidden = !chrome.hidden;
	}
});
addEventListener('resize', () => {
	reader.relayout();
	updateStatus();
});

// テストから操作するための公開口。
Object.assign(window, {
	reader,
	updateStatus,
	setTheme: (/** @type {string} */ t) =>
		(document.documentElement.dataset.theme = t)
});
viewport.dataset.ready = 'true';
