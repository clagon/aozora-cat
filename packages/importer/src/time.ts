/** setTimeout が扱える最大の遅延。超えると 1ms に丸められ、待ちが効かなくなる。 */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** 長い待ちも、タイマーの上限を超えないよう、小分けにして待つ。 */
export async function sleep(ms: number): Promise<void> {
	for (let left = ms; left > 0; left -= MAX_TIMER_MS)
		await new Promise((r) => setTimeout(r, Math.min(left, MAX_TIMER_MS)));
}

/**
 * 通信を始める順番を、1つずつ並べる関数を作る。待ちを先に予約する方式だと、処理が長く止まったとき、
 * 予約した待ちが一斉に切れて、通信がまとめて始まる。順番が来たときに、前の通信の開始から間隔が
 * 空いているかを、その時点で確かめる。
 */
export function createGate(minIntervalMs: number): () => Promise<void> {
	let queue: Promise<void> = Promise.resolve();
	let lastStart = -Infinity;
	return () => {
		const turn = queue.then(async () => {
			const wait = lastStart + minIntervalMs - performance.now();
			if (wait > 0) await sleep(wait);
			lastStart = performance.now();
		});
		queue = turn.catch(() => {});
		return turn;
	};
}
