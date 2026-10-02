// Plan 003: 縦書きページ送りの比較用リーダー。
// approach: 'offsets'（行数の整数倍のページ幅 + 実測オフセット）/ 'columns'（CSS multicol の列＝ページ）。
// 位置の識別は「段落番号 p + 段落内の文字位置 off」。ルビ（rt/rp）は文字数に含めない。
const LINE_HEIGHT = 2;
const GUTTER = 16;
const EPS = 0.5;

/** 位置判定に使える項目（ルビと不可視の空白を除く）。 */
const isBody = (/** @type {{ kind: string, ws?: boolean }} */ i) =>
	i.kind !== 'rt' && !i.ws;

/** @typedef {{ p: number, off: number }} Anchor */
/** @typedef {{ kind: 'c' | 'img' | 'rt', ws?: boolean, tcy?: boolean, p: number, off: number, page: number, endPage: number, across: number, along: number, outside: boolean, afterBreak: boolean }} Item */

/** @param {HTMLElement} viewport */
export function createReader(viewport) {
	const stage = document.createElement('div');
	stage.className = 'stage';
	const flow = document.createElement('div');
	flow.className = 'flow';
	stage.append(flow);
	viewport.prepend(stage);

	const state = {
		size: 18,
		mode: 'vertical',
		approach: 'offsets',
		page: 0,
		pageW: 0,
		pageH: 0,
		pitch: 0,
		/** @type {Item[]} */
		items: [],
		pageCount: 1,
		/** 利用者が最後に置いた位置。再レイアウトのたびにページ先頭へ丸めず、これを基準に復元する。 */
		anchor: /** @type {Anchor} */ ({ p: 0, off: 0 }),
		layoutMs: 0,
		measureMs: 0
	};

	function dimensions() {
		const availW = viewport.clientWidth - GUTTER * 2;
		const availH = viewport.clientHeight - GUTTER * 2;
		const pitch = state.size * LINE_HEIGHT;
		if (state.mode === 'horizontal') {
			return { pitch, pageW: availW, pageH: availH };
		}
		// 1ページに入る行数と1行の字数を整数にして、行や文字が境界をまたがないようにする。
		return {
			pitch,
			pageW: Math.max(1, Math.floor(availW / pitch)) * pitch,
			pageH: Math.floor(availH / state.size) * state.size
		};
	}

	/** 強制改ページと単独挿絵を、ページ境界に合わせて余白で押し出す（offsets 方式のみ）。 */
	function padBlocks() {
		const { pageW } = state;
		for (const target of flow.querySelectorAll(
			'hr[data-page-break], p[data-image]'
		)) {
			const fr = flow.getBoundingClientRect();
			const r = target.getBoundingClientRect();
			const start = fr.right - r.right;
			const rem = start % pageW;
			if (target instanceof HTMLHRElement) {
				const pad = rem < EPS || pageW - rem < EPS ? 0 : pageW - rem;
				target.style.blockSize = `${pad}px`;
			} else if (
				Math.floor((start + EPS) / pageW) !==
				Math.floor((start + r.width - EPS) / pageW)
			) {
				const pad = document.createElement('div');
				pad.className = 'pad';
				pad.style.blockSize = `${pageW - rem}px`;
				target.before(pad);
			}
		}
	}

	/** @param {DOMRect} rect */
	function locate(rect) {
		const fr = flow.getBoundingClientRect();
		const { pageW, pageH } = state;
		if (state.mode === 'horizontal') {
			const top = rect.top - fr.top;
			const page = Math.floor((top + EPS) / pageH);
			return {
				page,
				endPage: page,
				across: top - page * pageH,
				along: rect.left - fr.left,
				outside: rect.right > fr.left + pageW + EPS
			};
		}
		if (state.approach === 'columns') {
			const top = rect.top - fr.top;
			const page = Math.floor((top + EPS) / pageH);
			return {
				page,
				endPage: Math.floor((rect.bottom - fr.top - EPS) / pageH),
				across: fr.right - rect.right,
				along: top - page * pageH,
				outside:
					rect.right > fr.right + EPS || rect.left < fr.right - pageW - EPS
			};
		}
		const ds = fr.right - rect.right;
		const page = Math.floor((ds + EPS) / pageW);
		return {
			page,
			endPage: Math.floor((fr.right - rect.left - EPS) / pageW),
			across: ds - page * pageW,
			along: rect.top - fr.top,
			outside: rect.top < fr.top - EPS || rect.bottom > fr.top + pageH + EPS
		};
	}

	function measure() {
		const t0 = performance.now();
		/** @type {Item[]} */
		const items = [];
		const counters = new Map();
		let afterBreak = false;
		const range = document.createRange();
		const walker = document.createTreeWalker(
			flow,
			NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
			{
				acceptNode: (n) =>
					n instanceof Element && (n.tagName === 'RT' || n.tagName === 'RP')
						? NodeFilter.FILTER_REJECT
						: NodeFilter.FILTER_ACCEPT
			}
		);
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			if (n instanceof HTMLHRElement) {
				afterBreak = true;
				continue;
			}
			const owner = (n instanceof Element ? n : n.parentElement)?.closest(
				'[data-p]'
			);
			if (!(owner instanceof HTMLElement)) continue;
			const p = Number(owner.dataset.p);
			const off = counters.get(p) ?? 0;
			if (n instanceof HTMLImageElement) {
				counters.set(p, off + 1);
				items.push({
					kind: 'img',
					p,
					off,
					afterBreak,
					...locate(n.getBoundingClientRect())
				});
				afterBreak = false;
			} else if (n instanceof Text) {
				const text = n.data;
				for (let i = 0; i < text.length; i += 1) {
					range.setStart(n, i);
					range.setEnd(n, i + 1);
					const rect = range.getClientRects()[0];
					if (rect && rect.width > 0 && rect.height > 0) {
						// 行末の全角空白は 1 字ぶんはみ出して行頭側へ数えられるが、見えないので位置判定から外す。
						items.push({
							kind: 'c',
							ws: /\s/.test(text[i]),
							tcy: n.parentElement?.closest('.tcy') != null,
							p,
							off: off + i,
							afterBreak,
							...locate(rect)
						});
						afterBreak = false;
					}
				}
				counters.set(p, off + text.length);
			}
		}
		for (const rt of flow.querySelectorAll('rt')) {
			const owner = rt.closest('[data-p]');
			if (!(owner instanceof HTMLElement)) continue;
			for (const rect of rt.getClientRects()) {
				if (rect.width === 0 || rect.height === 0) continue;
				items.push({
					kind: 'rt',
					p: Number(owner.dataset.p),
					off: -1,
					afterBreak: false,
					...locate(rect)
				});
			}
		}
		state.items = items;
		const last = items.filter(isBody).at(-1);
		state.pageCount = last ? last.endPage + 1 : 1;
		state.measureMs = performance.now() - t0;
	}

	function show(page, remember = true) {
		state.page = Math.min(Math.max(0, page), state.pageCount - 1);
		if (state.mode === 'horizontal') {
			stage.scrollTop = state.page * state.pageH;
			flow.style.transform = '';
		} else if (state.approach === 'columns') {
			stage.scrollTop = 0; // 横書きで残ったスクロール量と二重にずれないようにする
			flow.style.transform = `translateY(${-state.page * state.pageH}px)`;
		} else {
			stage.scrollTop = 0;
			flow.style.transform = `translateX(${state.page * state.pageW}px)`;
		}
		viewport.dataset.page = String(state.page);
		if (remember) state.anchor = anchor();
	}

	// 縦書きのステージは clip にして、横書き側の慣性スクロールが残っても動かないようにする。
	// 横書きはネイティブスクロールなので、利用者のスクロールで変わったページと位置を取り込む。
	// show() 自身の scrollTop 更新は同じページ番号になるため、細かい位置の基準は上書きしない。
	stage.addEventListener('scroll', () => {
		if (state.mode !== 'horizontal') return;
		const page = Math.min(
			Math.max(0, Math.round(stage.scrollTop / state.pageH)),
			state.pageCount - 1
		);
		if (page === state.page) return;
		state.page = page;
		viewport.dataset.page = String(page);
		state.anchor = anchor();
	});

	function layout() {
		const t0 = performance.now();
		for (const pad of flow.querySelectorAll('.pad')) pad.remove();
		for (const hr of flow.querySelectorAll('hr')) hr.style.blockSize = '';
		const d = dimensions();
		Object.assign(state, d);
		stage.style.cssText = `left:${(viewport.clientWidth - d.pageW) / 2}px;top:${(viewport.clientHeight - d.pageH) / 2}px;width:${d.pageW}px;height:${d.pageH}px;overflow:${state.mode === 'horizontal' ? 'hidden auto' : 'clip'}`;
		viewport.style.setProperty('--page-w', `${d.pageW}px`);
		viewport.style.setProperty('--page-h', `${d.pageH}px`);
		flow.style.fontSize = `${state.size}px`;
		flow.style.transform = '';
		flow.dataset.mode = state.mode;
		flow.dataset.approach = state.approach;
		if (state.mode === 'vertical' && state.approach === 'offsets') padBlocks();
		state.layoutMs = performance.now() - t0;
		measure();
	}

	/** 現在ページ先頭の位置。 */
	function anchor() {
		const first = state.items.find((i) => isBody(i) && i.page === state.page);
		return first ? { p: first.p, off: first.off } : { p: 0, off: 0 };
	}

	/** @param {Anchor} a */
	function restore(a) {
		const body = state.items.filter(isBody);
		const same = body.filter((i) => i.p === a.p && i.off <= a.off).at(-1);
		const target = same ?? body.find((i) => i.p >= a.p);
		show(target ? target.page : 0, false);
		state.anchor = a;
	}

	return {
		/** 検証用の信頼済みフィクスチャだけを読む。本番は型付きスキーマから描画する（Plan 004/007）。 */
		load(/** @type {string} */ html) {
			const doc = new DOMParser().parseFromString(html, 'text/html');
			flow.replaceChildren(...doc.body.childNodes);
			layout();
			show(0);
		},
		configure(
			/** @type {{ size?: number, mode?: string, approach?: string }} */ o
		) {
			Object.assign(state, o);
			layout();
			restore(state.anchor);
		},
		relayout() {
			layout();
			restore(state.anchor);
		},
		next: () => show(state.page + 1),
		prev: () => show(state.page - 1),
		goTo: show,
		anchor,
		restore,
		state
	};
}
