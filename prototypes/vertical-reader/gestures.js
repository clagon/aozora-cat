// タップ領域・スワイプ・キーボードを同じ操作へ対応づける。
// 左端／左スワイプ／ArrowLeft が次ページ、右端／右スワイプ／ArrowRight が前ページ。
const EDGE = 0.2;
const SWIPE_MIN = 40;
const TAP_MAX_MOVE = 10;
const TAP_MAX_MS = 500;

/**
 * @param {HTMLElement} el
 * @param {{ next: () => void, prev: () => void, center: () => void, enabled: () => boolean, scroll: (direction: 1 | -1, unit: 'line' | 'page') => void }} actions
 */
export function attachGestures(el, actions) {
	let start = null;

	el.addEventListener('pointerdown', (e) => {
		// 操作バーのボタンは、ページ送りや中央タップとして数えない。
		if (e.target instanceof Element && e.target.closest('button')) {
			start = null;
			return;
		}
		start = { x: e.clientX, y: e.clientY, t: e.timeStamp };
	});
	el.addEventListener('pointercancel', () => {
		start = null;
	});
	el.addEventListener('pointerup', (e) => {
		if (!start) return;
		const dx = e.clientX - start.x;
		const dy = e.clientY - start.y;
		const moved = Math.hypot(dx, dy);
		const elapsed = e.timeStamp - start.t;
		const origin = start;
		start = null;
		// ページ送りが無効（横書き）でも、中央タップによる操作バーの開閉は使える。
		const paging = actions.enabled();
		if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.5) {
			if (!paging) return;
			if (dx < 0) actions.next();
			else actions.prev();
			return;
		}
		// 縦方向が優位な動きはスクロール意図として何もしない。
		if (moved > TAP_MAX_MOVE || elapsed > TAP_MAX_MS) return;
		const ratio = origin.x / el.clientWidth;
		if (ratio < EDGE) {
			if (paging) actions.next();
		} else if (ratio > 1 - EDGE) {
			if (paging) actions.prev();
		} else actions.center();
	});
	el.addEventListener('keydown', (e) => {
		// 操作バーのボタンは、Space や矢印を自分の操作に使う。
		if (e.target instanceof Element && e.target.closest('button')) return;
		const forward =
			e.key === 'PageDown' ||
			(e.key === ' ' && !e.shiftKey) ||
			e.key === 'ArrowDown';
		const backward =
			e.key === 'PageUp' ||
			(e.key === ' ' && e.shiftKey) ||
			e.key === 'ArrowUp';
		if (!actions.enabled()) {
			// 横書きは縦スクロール。フォーカスは本文の外枠にあるので、中のステージへ送る。
			if (forward || backward) {
				actions.scroll(
					forward ? 1 : -1,
					e.key.startsWith('Arrow') ? 'line' : 'page'
				);
				e.preventDefault();
			}
			return;
		}
		if (e.key === 'ArrowLeft' || forward) actions.next();
		else if (e.key === 'ArrowRight' || backward) actions.prev();
		else return;
		e.preventDefault();
	});
}
