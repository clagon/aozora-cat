// Plan 003: 縦書きページ分割の境界検証。
// 単独実行: node tests/e2e/pagination.mjs [chromium|webkit] [--report]
//   --report: 採用する columns に加えて、不採用の offsets も全件実行して結果を表示する（失敗しても終了コード 0）。
import { chromium, webkit, devices } from 'playwright';
import { readFile } from 'node:fs/promises';
import { startStaticServer } from './static-server.ts';

export const FIXTURES = [
	'kumo-no-ito',
	'kokoro',
	'ginga-tetsudo',
	'rashomon-old',
	'kuroshikan',
	'aki-no-hitomi',
	'kaze-no-matasaburo',
	'edge-cases'
];
export const SIZES = [16, 18, 20, 24];
export const VIEWPORTS = [
	{ width: 390, height: 844 },
	{ width: 360, height: 800 }
];
export const APPROACHES = ['offsets', 'columns'];

/** 配置された全項目から、欠落・重複・境界またぎ・順序違反を数える。 */
function inspect() {
	const { items, pageCount, layoutMs, measureMs, pitch, pageH } =
		window.reader.state;
	const body = items.filter((i) => i.kind !== 'rt' && !i.ws);
	const flow = document.querySelector('.flow');
	let expected = 0;
	const walker = document.createTreeWalker(flow, NodeFilter.SHOW_TEXT, {
		acceptNode: (n) =>
			n.parentElement?.closest('rt, rp') ||
			!n.parentElement?.closest('[data-p]')
				? NodeFilter.FILTER_REJECT
				: NodeFilter.FILTER_ACCEPT
	});
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		// 空白は折り返し位置で潰れて矩形を持たないことがあるため、欠落の対象は空白以外の文字に限る。
		expected += n.data.replace(/\s/g, '').length;
	}
	expected += flow.querySelectorAll('img').length;
	const chars = items.filter(
		(i) => (i.kind === 'c' && !i.ws) || i.kind === 'img'
	).length;

	const visible = items.filter((i) => !i.ws);
	const straddle = visible.filter((i) => i.page !== i.endPage).length;
	const outside = visible.filter((i) => i.outside).length;
	let order = 0;
	let overlap = 0;
	const seen = new Set();
	for (let k = 0; k < body.length; k += 1) {
		const a = body[k - 1];
		const b = body[k];
		const key = `${b.page}:${Math.round(b.across)}:${Math.round(b.along)}`;
		if (seen.has(key)) overlap += 1;
		seen.add(key);
		if (!a || a.tcy || b.tcy) continue;
		// 大きな文字で行幅が揺れるため、同じページ内で右（先頭側）へ 3/4 行以上戻った場合だけ逆順とみなす。
		const backwards =
			b.page < a.page ||
			(b.page === a.page && b.across < a.across - pitch * 0.75);
		if (backwards) order += 1;
	}
	let breakMisaligned = 0;
	body.forEach((item, k) => {
		if (
			item.afterBreak &&
			// 字下げで行頭が下がるため、位置は「ページの上半分」までを許す。
			(item.along > pageH / 2 || (body[k - 1] && item.page <= body[k - 1].page))
		)
			breakMisaligned += 1;
	});
	// 各ページが1文字以上を持つか（空ページ検出）。挿絵だけのページも1項目とみなす。
	const populated = new Set(body.map((i) => i.page));
	const emptyPages = pageCount - populated.size;
	return {
		pageCount,
		skipped: expected - chars,
		straddle,
		outside,
		order,
		overlap,
		breakMisaligned,
		emptyPages,
		layoutMs: Math.round(layoutMs),
		measureMs: Math.round(measureMs)
	};
}

// 開発・CI環境に明朝がないため、既定は実機に近い寸法を持つ IPAGothic に固定する。
export const TEST_FONT = 'IPAGothic';

export async function openReader(
	browser,
	base,
	{
		fixture,
		approach,
		size,
		viewport,
		theme = 'paper',
		font = TEST_FONT,
		safe = null,
		mode = 'vertical',
		reducedMotion = 'no-preference',
		device = null
	}
) {
	const context = await browser.newContext(
		device
			? { ...device, reducedMotion }
			: { viewport, reducedMotion, hasTouch: true }
	);
	const page = await context.newPage();
	const errors = [];
	page.on('pageerror', (e) => errors.push(String(e)));
	await page.goto(
		`${base}/?fixture=${fixture}&approach=${approach}&size=${size}&theme=${theme}&font=${encodeURIComponent(font)}${safe ? `&safe=${safe}` : ''}&mode=${mode}`
	);
	await page.waitForSelector('#viewport[data-ready="true"]');
	return { page, context, errors };
}

export async function measure(browser, base, opts) {
	const { page, context, errors } = await openReader(browser, base, opts);
	try {
		await page.evaluate(() => document.fonts.ready);
		const result = await page.evaluate(inspect);
		return { ...result, errors };
	} finally {
		await context.close();
	}
}

export const failing = (r) =>
	r.skipped !== 0 ||
	r.straddle ||
	r.outside ||
	r.order ||
	r.overlap ||
	r.breakMisaligned ||
	r.emptyPages ||
	r.errors.length;

const THEMES = ['white', 'paper', 'night'];
const REPORT_FAILURES_LIMIT = 12;

function assert(condition, message, failures) {
	if (!condition) failures.push(message);
}

/** 採用方式（columns）の境界・位置・ジェスチャー検証。失敗は集めて最後にまとめて投げる。 */
export async function runPagination(browserType, name) {
	const failures = [];
	const server = await startStaticServer();
	const browser = await browserType.launch({ headless: true });
	try {
		// 1. 全フィクスチャ × 4 文字サイズ × 2 画面で、欠落・重複・境界またぎ・順序違反がないこと。
		for (const viewport of VIEWPORTS) {
			for (const fixture of FIXTURES) {
				for (const size of SIZES) {
					const r = await measure(browser, server.url, {
						fixture,
						approach: 'columns',
						size,
						viewport
					});
					assert(
						!failing(r),
						`${name} 境界 ${fixture} ${size}px ${viewport.width}x${viewport.height}: ${JSON.stringify(r)}`,
						failures
					);
				}
			}
		}
		await checkHorizontal(browser, server.url, name, failures);
		await checkThemes(browser, server.url, name, failures);
		await checkPositions(browser, server.url, name, failures);
		await checkGestures(browser, server.url, name, failures);
		await checkMotion(browser, server.url, name, failures);
		await checkDevice(browser, server.url, name, failures);
		await checkSafeArea(browser, server.url, name, failures);
	} finally {
		await browser.close();
		server.close();
	}
	if (failures.length > 0) {
		throw new Error(
			`${name}: 縦書きページ分割の検証に失敗\n${failures.slice(0, REPORT_FAILURES_LIMIT).join('\n')}`
		);
	}
}

async function withReader(browser, base, opts, fn) {
	const { page, context, errors } = await openReader(browser, base, opts);
	try {
		await page.evaluate(() => document.fonts.ready);
		await fn(page);
		return errors;
	} finally {
		await context.close();
	}
}

const base = {
	fixture: 'kokoro',
	approach: 'columns',
	size: 18,
	viewport: VIEWPORTS[0]
};

/** 現在ページが anchor の位置を含むか。 */
const containsAnchor = (page, a) =>
	page.evaluate(({ p, off }) => {
		const st = window.reader.state;
		const hit = st.items.find(
			(i) => i.kind !== 'rt' && !i.ws && i.p === p && i.off >= off
		);
		return hit ? hit.page === st.page : false;
	}, a);

// 横書きは通常のブロックの流れで縦スクロールする。強制改ページがあっても本文が列に隠れないこと。
async function checkHorizontal(browser, url, name, failures) {
	for (const fixture of FIXTURES) {
		for (const size of [16, 24]) {
			const { page, context } = await openReader(browser, url, {
				...base,
				fixture,
				size,
				mode: 'horizontal'
			});
			try {
				await page.evaluate(() => document.fonts.ready);
				const r = await page.evaluate(inspect);
				const overflow = await page.evaluate(() => {
					const s = document.querySelector('.stage');
					return s.scrollWidth - s.clientWidth;
				});
				assert(
					r.skipped === 0 && r.outside === 0 && overflow <= 1,
					`${name} 横書き ${fixture} ${size}px: ${JSON.stringify({ ...r, overflow })}`,
					failures
				);
			} finally {
				await context.close();
			}
		}
	}
}

async function checkThemes(browser, url, name, failures) {
	const colors = new Set();
	for (const theme of THEMES) {
		await withReader(browser, url, { ...base, theme }, async (page) => {
			const r = await page.evaluate(() => {
				const lum = (rgb) => {
					const [r, g, b] = rgb
						.match(/\d+/g)
						.slice(0, 3)
						.map((v) => {
							const c = Number(v) / 255;
							return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
						});
					return 0.2126 * r + 0.7152 * g + 0.0722 * b;
				};
				const fg = getComputedStyle(document.querySelector('.flow')).color;
				const bg = getComputedStyle(document.body).backgroundColor;
				const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
				return {
					bg,
					ratio: (hi + 0.05) / (lo + 0.05),
					failing: window.reader.state.items.filter(
						(i) => i.page !== i.endPage && !i.ws
					).length
				};
			});
			colors.add(r.bg);
			assert(
				r.ratio >= 4.5,
				`${name} テーマ ${theme}: 本文コントラスト ${r.ratio.toFixed(2)}`,
				failures
			);
			assert(
				r.failing === 0,
				`${name} テーマ ${theme}: 境界またぎ ${r.failing}`,
				failures
			);
		});
	}
	assert(
		colors.size === THEMES.length,
		`${name} テーマ: 背景色が3種類にならない`,
		failures
	);
}

async function checkPositions(browser, url, name, failures) {
	await withReader(browser, url, base, async (page) => {
		const count = await page.evaluate(() => window.reader.state.pageCount);
		// 前後往復で同じページ・同じ位置に戻る。
		await page.evaluate(() => window.reader.goTo(10));
		const a = await page.evaluate(() => window.reader.anchor());
		await page.evaluate(() => {
			for (let i = 0; i < 7; i += 1) window.reader.next();
			for (let i = 0; i < 7; i += 1) window.reader.prev();
		});
		assert(
			(await page.evaluate(() => window.reader.state.page)) === 10,
			`${name} 往復: ページが戻らない`,
			failures
		);
		assert(
			JSON.stringify(await page.evaluate(() => window.reader.anchor())) ===
				JSON.stringify(a),
			`${name} 往復: 位置が戻らない`,
			failures
		);
		// 端での停止。
		await page.evaluate((n) => {
			window.reader.goTo(0);
			window.reader.prev();
		}, count);
		assert(
			(await page.evaluate(() => window.reader.state.page)) === 0,
			`${name} 先頭で前ページへ進んだ`,
			failures
		);
		await page.evaluate(() => {
			window.reader.goTo(10 ** 6);
			window.reader.next();
		});
		assert(
			(await page.evaluate(() => window.reader.state.page)) === count - 1,
			`${name} 末尾で次ページへ進んだ`,
			failures
		);

		// 文字サイズを往復しても、保存した位置を含むページへ戻る。
		await page.evaluate(() => window.reader.goTo(20));
		const b = await page.evaluate(() => window.reader.anchor());
		for (const size of [24, 16, 20, 18]) {
			await page.evaluate((s) => window.reader.configure({ size: s }), size);
			assert(
				await containsAnchor(page, b),
				`${name} 文字サイズ ${size}px: 位置を含まない`,
				failures
			);
		}
		// 縦横の向きを変えても同様。
		await page.evaluate(() => window.reader.goTo(30));
		const c = await page.evaluate(() => window.reader.anchor());
		for (const viewport of [
			{ width: 844, height: 390 },
			VIEWPORTS[0],
			VIEWPORTS[1]
		]) {
			await page.setViewportSize(viewport);
			await page.waitForFunction(() => window.reader.state.pageW > 0);
			assert(
				await containsAnchor(page, c),
				`${name} 画面 ${viewport.width}x${viewport.height}: 位置を含まない`,
				failures
			);
		}
		// 縦書き／横書きを切り替えても位置を保ち、横書きは横スクロールを持たない。
		await page.evaluate(() => window.reader.configure({ mode: 'horizontal' }));
		assert(
			await containsAnchor(page, c),
			`${name} 横書き: 位置を含まない`,
			failures
		);
		const overflow = await page.evaluate(() => {
			const s = document.querySelector('.stage');
			return s.scrollWidth - s.clientWidth;
		});
		assert(
			overflow <= 1,
			`${name} 横書き: 横方向にあふれる ${overflow}px`,
			failures
		);
		await page.evaluate(() => window.reader.next());
		assert(
			(await page.evaluate(() => document.querySelector('.stage').scrollTop)) >
				0,
			`${name} 横書き: スクロールしない`,
			failures
		);
		// 利用者がホイールで直接スクロールした位置も、縦書きへ戻したときの新しい基準になる。
		await page.mouse.move(195, 400);
		await page.mouse.wheel(0, 2400);
		// ホイールは滑らかにスクロールするため、止まるまで待ってから次の操作をする。
		await page.waitForFunction(
			() => {
				const y = document.querySelector('.stage').scrollTop;
				const settled = window.lastStageY === y && y > 1500;
				window.lastStageY = y;
				return settled;
			},
			null,
			{ polling: 100 }
		);
		await page.waitForFunction(() => window.reader.state.page > 1);
		// ページ境界の途中で止まったスクロールも、丸めずにその位置の最初の項目を基準にする。
		const exact = await page.evaluate(() => {
			const st = window.reader.state;
			document.querySelector('.stage').scrollTop = 1234;
			return { pageH: st.pageH };
		});
		await page.waitForFunction(
			() =>
				window.reader.state.page ===
				Math.floor(1234 / window.reader.state.pageH)
		);
		const rounded = await page.evaluate(() => {
			const st = window.reader.state;
			const first = st.items.find(
				(i) => i.kind !== 'rt' && !i.ws && i.bottom > 1234 + 0.5
			);
			return { expected: { p: first.p, off: first.off }, actual: st.anchor };
		});
		assert(
			JSON.stringify(rounded.actual) === JSON.stringify(rounded.expected),
			`${name} 横書きのスクロール位置が丸められた: ${JSON.stringify(rounded)}`,
			failures
		);
		// プログラムによるスクロールの直後に、利用者が別の位置へ動かし、元の位置へ戻っても取り込む。
		await page.evaluate(() => window.reader.goTo(3));
		await page.evaluate(() => {
			document.querySelector('.stage').scrollTop = 1000;
		});
		await page.waitForFunction(
			() =>
				window.reader.state.page ===
				Math.floor(1000 / window.reader.state.pageH)
		);
		await page.evaluate(() => {
			document.querySelector('.stage').scrollTop =
				3 * window.reader.state.pageH;
		});
		await page.waitForFunction(() => window.reader.state.page === 3);
		// 横書きで進めた位置は、縦書きへ戻したときの新しい基準になる。
		const d = await page.evaluate(() => window.reader.state.anchor);
		await page.evaluate(() => window.reader.configure({ mode: 'vertical' }));
		assert(
			await containsAnchor(page, d),
			`${name} 縦書きへ戻す: 位置を含まない`,
			failures
		);
		// 見た目でも、横書きのスクロール量が残らず、ページ分だけ送られていること。
		await page.waitForFunction(
			() => document.querySelector('.flow').getAnimations().length === 0
		);
		const shown = await page.evaluate(() => {
			const st = window.reader.state;
			const stage = document.querySelector('.stage');
			const flowTop = document
				.querySelector('.flow')
				.getBoundingClientRect().top;
			return {
				stageScroll: stage.scrollTop,
				offset: flowTop - stage.getBoundingClientRect().top,
				expected: -st.page * st.pageH
			};
		});
		assert(
			shown.stageScroll === 0 && Math.abs(shown.offset - shown.expected) <= 1,
			`${name} 縦書きへ戻す: 表示がずれている ${JSON.stringify(shown)}`,
			failures
		);
	});
	// 背の高い挿絵の途中で横書きのスクロールが止まっても、挿絵を飛ばさない。
	await withReader(
		browser,
		url,
		{ ...base, fixture: 'edge-cases', mode: 'horizontal' },
		async (page) => {
			const top = await page.evaluate(() => {
				const img = document.querySelector('[data-p="6"] img');
				const fr = document.querySelector('.flow').getBoundingClientRect();
				const r = img.getBoundingClientRect();
				return { y: r.top - fr.top, h: r.height };
			});
			await page.evaluate(
				(y) => {
					document.querySelector('.stage').scrollTop = y;
				},
				top.y + top.h / 2
			);
			await page.waitForFunction(() => window.reader.state.anchor.p === 6);
			await page.evaluate(() => window.reader.configure({ mode: 'vertical' }));
			const shown = await page.evaluate(() => {
				const st = window.reader.state;
				const img = st.items.find((i) => i.kind === 'img' && i.p === 6);
				return { page: st.page, imagePage: img.page };
			});
			assert(
				shown.page === shown.imagePage,
				`${name} 挿絵の途中から縦書きへ戻すと挿絵を飛ばす: ${JSON.stringify(shown)}`,
				failures
			);
		}
	);
	// 挿絵だけのページと強制改ページ。
	await withReader(
		browser,
		url,
		{ ...base, fixture: 'edge-cases' },
		async (page) => {
			const r = await page.evaluate(() => {
				const body = window.reader.state.items.filter(
					(i) => i.kind !== 'rt' && !i.ws
				);
				const image = body.find((i) => i.kind === 'img' && i.p === 6);
				const onPage = body.filter((i) => i.page === image.page);
				const box = document
					.querySelector('[data-p="6"] img')
					.getBoundingClientRect();
				return {
					alone: onPage.length,
					afterBreaks: body.filter((i) => i.afterBreak).length,
					imageWidth: box.width,
					imageHeight: box.height
				};
			});
			// 挿絵だけのページが小さなアイコンではなく、実際に大きな画像で検証されていること。
			assert(
				Math.abs(r.imageHeight - r.imageWidth * 2) <= 2,
				`${name} 挿絵の縦横比が320×640でない: ${r.imageWidth}x${r.imageHeight}`,
				failures
			);
			assert(
				r.imageHeight > 300,
				`${name} 挿絵だけのページの画像が小さすぎる: ${r.imageWidth}x${r.imageHeight}`,
				failures
			);
			assert(
				r.alone === 1,
				`${name} 挿絵だけのページに他の項目がある: ${r.alone}`,
				failures
			);
			assert(
				r.afterBreaks === 2,
				`${name} 改ページ注記が2件にならない: ${r.afterBreaks}`,
				failures
			);
		}
	);
}

async function checkGestures(browser, url, name, failures) {
	await withReader(browser, url, base, async (page) => {
		// マウス操作の前、開いた直後からキーで操作できること。
		assert(
			await page.evaluate(
				() => document.activeElement === document.getElementById('viewport')
			),
			`${name} 開いた直後に本文がフォーカスされない`,
			failures
		);
		const pageNo = () => page.evaluate(() => window.reader.state.page);
		const drag = async (x0, y0, x1, y1) => {
			await page.mouse.move(x0, y0);
			await page.mouse.down();
			await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2);
			await page.mouse.move(x1, y1);
			await page.mouse.up();
		};
		await page.evaluate(() => window.reader.goTo(5));
		await drag(300, 400, 100, 400);
		assert(
			(await pageNo()) === 6,
			`${name} 左スワイプで次ページへ進まない`,
			failures
		);
		await drag(100, 400, 300, 400);
		assert(
			(await pageNo()) === 5,
			`${name} 右スワイプで前ページへ戻らない`,
			failures
		);
		await drag(200, 400, 170, 400);
		assert(
			(await pageNo()) === 5,
			`${name} 閾値未満のスワイプでページが動いた`,
			failures
		);
		await drag(300, 200, 250, 600);
		assert(
			(await pageNo()) === 5,
			`${name} 縦方向の動きでページが動いた`,
			failures
		);
		await drag(300, 200, 200, 500);
		assert(
			(await pageNo()) === 5,
			`${name} 斜めの動きでページが動いた`,
			failures
		);

		await page.mouse.click(20, 400);
		assert(
			(await pageNo()) === 6,
			`${name} 左端タップで次ページへ進まない`,
			failures
		);
		await page.mouse.click(370, 400);
		assert(
			(await pageNo()) === 5,
			`${name} 右端タップで前ページへ戻らない`,
			failures
		);
		const chrome = () =>
			page.evaluate(() => !document.getElementById('chrome').hidden);
		assert(!(await chrome()), `${name} 操作バーが初期表示されている`, failures);
		await page.mouse.click(195, 400);
		assert(await chrome(), `${name} 中央タップで操作バーが開かない`, failures);
		assert(
			(await pageNo()) === 5,
			`${name} 中央タップでページが動いた`,
			failures
		);
		await page.mouse.click(195, 400);
		assert(
			!(await chrome()),
			`${name} 中央タップで操作バーが閉じない`,
			failures
		);

		for (const [key, delta] of [
			['ArrowLeft', 1],
			['ArrowRight', -1],
			['PageDown', 1],
			['PageUp', -1],
			['Space', 1],
			['Shift+Space', -1]
		]) {
			const before = await pageNo();
			await page.keyboard.press(key);
			assert(
				(await pageNo()) === before + delta,
				`${name} キー ${key} が期待どおりでない`,
				failures
			);
		}
		// 横書きはネイティブスクロールに任せ、ページ送りの操作を奪わない。
		await page.evaluate(() => window.reader.configure({ mode: 'horizontal' }));
		const before = await page.evaluate(() => window.reader.state.page);
		await page.mouse.click(20, 400);
		assert(
			(await page.evaluate(() => window.reader.state.page)) === before,
			`${name} 横書きで端タップがページ送りになった`,
			failures
		);
		await page.mouse.click(195, 400);
		assert(
			await page.evaluate(() => !document.getElementById('chrome').hidden),
			`${name} 横書きで中央タップが操作バーを開かない`,
			failures
		);
	});
}

// 実機（iPhone Safari / Android Chrome）が使えないため、各エンジンに対応する端末プロファイルで代替する。
const DEVICE_PROFILES = { chromium: 'Pixel 7', webkit: 'iPhone 15' };

async function checkDevice(browser, url, name, failures) {
	const device = devices[DEVICE_PROFILES[name]];
	for (const fixture of ['kokoro', 'kuroshikan', 'edge-cases']) {
		for (const size of SIZES) {
			const r = await measure(browser, url, { ...base, fixture, size, device });
			assert(
				!failing(r),
				`${name} 端末 ${DEVICE_PROFILES[name]} ${fixture} ${size}px: ${JSON.stringify(r)}`,
				failures
			);
		}
	}
	await withReader(browser, url, { ...base, device }, async (page) => {
		const { width } = page.viewportSize();
		await page.evaluate(() => window.reader.goTo(3));
		await page.touchscreen.tap(width * 0.08, 400);
		assert(
			(await page.evaluate(() => window.reader.state.page)) === 4,
			`${name} 端末のタッチで左端タップが次ページにならない`,
			failures
		);
		await page.touchscreen.tap(width * 0.92, 400);
		assert(
			(await page.evaluate(() => window.reader.state.page)) === 3,
			`${name} 端末のタッチで右端タップが前ページにならない`,
			failures
		);

		// 横方向のドラッグをブラウザに奪われないこと（pan-y のみ許可）。
		const touchAction = await page.evaluate(
			() => getComputedStyle(document.getElementById('viewport')).touchAction
		);
		assert(
			touchAction === 'pan-y',
			`${name} touch-action が pan-y でない: ${touchAction}`,
			failures
		);
		if (name === 'chromium') {
			// 実際のタッチ入力（CDP）でも、左スワイプで次ページ・右スワイプで前ページになる。
			const client = await page.context().newCDPSession(page);
			const swipe = async (x0, x1, y) => {
				const point = (x) => [{ x, y, id: 1 }];
				await client.send('Input.dispatchTouchEvent', {
					type: 'touchStart',
					touchPoints: point(x0)
				});
				for (let step = 1; step <= 6; step += 1) {
					await client.send('Input.dispatchTouchEvent', {
						type: 'touchMove',
						touchPoints: point(x0 + ((x1 - x0) * step) / 6)
					});
				}
				await client.send('Input.dispatchTouchEvent', {
					type: 'touchEnd',
					touchPoints: []
				});
			};
			const pageNo = () => page.evaluate(() => window.reader.state.page);
			await page.evaluate(() => window.reader.goTo(6));
			await swipe(width * 0.8, width * 0.2, 400);
			await page.waitForFunction(() => window.reader.state.page === 7);
			await swipe(width * 0.2, width * 0.8, 400);
			await page.waitForFunction(() => window.reader.state.page === 6);
			assert(
				(await pageNo()) === 6,
				`${name} 端末のタッチスワイプで往復できない`,
				failures
			);
		}
	});
}

// ノッチ・ホームインジケータ相当の安全領域を避けて、本文のページが組まれること。
async function checkSafeArea(browser, url, name, failures) {
	const cases = [
		{ safe: '47,0,34,0', viewport: VIEWPORTS[0] },
		{ safe: '0,47,21,47', viewport: { width: 844, height: 390 } }
	];
	for (const { safe, viewport } of cases) {
		const [top, right, bottom, left] = safe.split(',').map(Number);
		for (const fixture of ['kokoro', 'edge-cases']) {
			const { page, context } = await openReader(browser, url, {
				...base,
				fixture,
				viewport,
				safe
			});
			try {
				await page.evaluate(() => document.fonts.ready);
				const r = await page.evaluate(inspect);
				const box = await page.evaluate(() => {
					const s = document.querySelector('.stage').getBoundingClientRect();
					return {
						top: s.top,
						right: innerWidth - s.right,
						bottom: innerHeight - s.bottom,
						left: s.left
					};
				});
				const label = `${name} 安全領域 ${safe} ${fixture}`;
				assert(
					!failing({ ...r, errors: [] }),
					`${label}: ${JSON.stringify(r)}`,
					failures
				);
				assert(
					box.top >= top &&
						box.right >= right &&
						box.bottom >= bottom &&
						box.left >= left,
					`${label}: 本文が安全領域に入り込む ${JSON.stringify(box)}`,
					failures
				);
			} finally {
				await context.close();
			}
		}
	}
}

async function checkMotion(browser, url, name, failures) {
	const duration = async (reducedMotion) => {
		let value = '';
		await withReader(browser, url, { ...base, reducedMotion }, async (page) => {
			value = await page.evaluate(
				() =>
					getComputedStyle(document.querySelector('.flow')).transitionDuration
			);
		});
		return Number.parseFloat(value);
	};
	assert(
		(await duration('reduce')) <= 0.01,
		`${name} 動きを減らす設定でも遷移が残る`,
		failures
	);
	assert(
		(await duration('no-preference')) >= 0.1,
		`${name} 通常時の遷移が短すぎる`,
		failures
	);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const engine = process.argv[2] === 'webkit' ? webkit : chromium;
	const name = process.argv[2] === 'webkit' ? 'webkit' : 'chromium';
	if (process.argv.includes('--report')) {
		const server = await startStaticServer();
		const browser = await engine.launch({ headless: true });
		try {
			for (const approach of APPROACHES) {
				for (const fixture of FIXTURES) {
					for (const size of SIZES) {
						const r = await measure(browser, server.url, {
							fixture,
							approach,
							size,
							viewport: VIEWPORTS[0]
						});
						console.log(
							name,
							approach.padEnd(8),
							fixture.padEnd(20),
							size,
							failing(r) ? 'FAIL' : 'ok  ',
							JSON.stringify(r)
						);
					}
				}
			}
		} finally {
			await browser.close();
			server.close();
		}
	} else {
		await runPagination(engine, name);
		console.log(`${name}: ok`);
	}
}
