// タップ領域・スワイプ・キーボードを同じ操作へ対応づける。
// 左端／左スワイプ／ArrowLeft が次ページ、右端／右スワイプ／ArrowRight が前ページ。
const EDGE = 0.2;
const SWIPE_MIN = 40;
const TAP_MAX_MOVE = 10;
const TAP_MAX_MS = 500;

/**
 * @param {HTMLElement} el
 * @param {{ next: () => void, prev: () => void, center: () => void, enabled: () => boolean }} actions
 */
export function attachGestures(el, actions) {
	let start = null;

	el.addEventListener('pointerdown', (e) => {
		start = { x: e.clientX, y: e.clientY, t: e.timeStamp };
	});
	el.addEventListener('pointercancel', () => {
		start = null;
	});
	el.addEventListener('pointerup', (e) => {
		if (!start || !actions.enabled()) return;
		const dx = e.clientX - start.x;
		const dy = e.clientY - start.y;
		const moved = Math.hypot(dx, dy);
		const elapsed = e.timeStamp - start.t;
		const origin = start;
		start = null;
		if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.5) {
			if (dx < 0) actions.next();
			else actions.prev();
			return;
		}
		// 縦方向が優位な動きはスクロール意図として何もしない。
		if (moved > TAP_MAX_MOVE || elapsed > TAP_MAX_MS) return;
		const ratio = origin.x / el.clientWidth;
		if (ratio < EDGE) actions.next();
		else if (ratio > 1 - EDGE) actions.prev();
		else actions.center();
	});
	el.addEventListener('keydown', (e) => {
		if (!actions.enabled()) return;
		if (
			e.key === 'ArrowLeft' ||
			e.key === 'PageDown' ||
			(e.key === ' ' && !e.shiftKey)
		)
			actions.next();
		else if (
			e.key === 'ArrowRight' ||
			e.key === 'PageUp' ||
			(e.key === ' ' && e.shiftKey)
		)
			actions.prev();
		else return;
		e.preventDefault();
	});
}
