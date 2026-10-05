/** setTimeout が扱える最大の遅延。超えると 1ms に丸められ、待ちが効かなくなる。 */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** 長い待ちも、タイマーの上限を超えないよう、小分けにして待つ。 */
export async function sleep(ms: number): Promise<void> {
	for (let left = ms; left > 0; left -= MAX_TIMER_MS)
		await new Promise((r) => setTimeout(r, Math.min(left, MAX_TIMER_MS)));
}
