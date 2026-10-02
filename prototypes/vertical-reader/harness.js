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
// 実機の安全領域（上,右,下,左 px）をブラウザ上で再現する。例: ?safe=47,0,34,0
const safe = params.get('safe');
if (safe) {
	for (const [side, px] of ['top', 'right', 'bottom', 'left'].map((side, i) => [
		side,
		safe.split(',')[i]
	])) {
		document.documentElement.style.setProperty(
			`--safe-area-inset-${side}`,
			`${px}px`
		);
	}
}
const font = params.get('font');
if (font) document.documentElement.style.setProperty('--font-reading', font);
const reader = createReader(viewport);
Object.assign(reader.state, {
	size: Number(params.get('size') ?? 18),
	mode: params.get('mode') ?? 'vertical',
	// 採用した方式を既定にする。比較したいときだけ ?approach=offsets を付ける。
	approach: params.get('approach') ?? 'columns'
});

const controls = chrome.querySelectorAll('button');

/** 現在の条件をボタンの押下状態と状態表示へ反映する。 */
function syncControls() {
	const theme = document.documentElement.dataset.theme;
	for (const button of controls) {
		const { mode, size, theme: t } = button.dataset;
		button.setAttribute(
			'aria-pressed',
			String(
				mode === reader.state.mode ||
					Number(size) === reader.state.size ||
					t === theme
			)
		);
	}
}

function updateStatus() {
	status.textContent = `${reader.state.page + 1} / ${reader.state.pageCount}`;
	syncControls();
}

const html = await (
	await fetch(`/fixtures/${params.get('fixture') ?? 'kumo-no-ito'}.html`)
).text();
reader.load(html);
updateStatus();

// 再読み込みせずに設定を変える。位置は reader が保持した基準から復元する。
chrome.addEventListener('click', (e) => {
	const button =
		e.target instanceof Element ? e.target.closest('button') : null;
	if (!button) return;
	const { mode, size, theme } = button.dataset;
	if (mode) reader.configure({ mode });
	if (size) reader.configure({ size: Number(size) });
	if (theme) document.documentElement.dataset.theme = theme;
	updateStatus();
});

attachGestures(viewport, {
	enabled: () => reader.state.mode === 'vertical',
	next: () => (reader.next(), updateStatus()),
	prev: () => (reader.prev(), updateStatus()),
	scroll: (direction, unit) => {
		const { pageH, pitch } = reader.state;
		const stage = viewport.querySelector('.stage');
		stage?.scrollBy({
			top: direction * (unit === 'page' ? pageH * 0.9 : pitch)
		});
	},
	center: () => {
		chrome.hidden = !chrome.hidden;
		updateStatus();
	}
});
// 横書きのネイティブスクロールでも、ページ表示を最新にする。
let statusFrame = 0;
viewport.addEventListener(
	'scroll',
	() => {
		cancelAnimationFrame(statusFrame);
		statusFrame = requestAnimationFrame(updateStatus);
	},
	true
);
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
// 開いてすぐ、矢印キー・PageDown・Space でページ送りできるようにする。
viewport.focus();
viewport.dataset.ready = 'true';
