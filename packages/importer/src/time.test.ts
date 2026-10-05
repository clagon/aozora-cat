import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_TIMER_MS, sleep } from './time.ts';

afterEach(() => vi.useRealTimers());

describe('sleep', () => {
	it('タイマーの上限を超える待ちも、上限以下に小分けにして、全体の時間だけ待つ', async () => {
		vi.useFakeTimers();
		const spy = vi.spyOn(globalThis, 'setTimeout');
		let done = false;
		const total = MAX_TIMER_MS * 2 + 5;
		void sleep(total).then(() => (done = true));
		await vi.advanceTimersByTimeAsync(total - 1);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(done).toBe(true);
		const delays = spy.mock.calls.map((c) => c[1] as number);
		expect(delays).toEqual([MAX_TIMER_MS, MAX_TIMER_MS, 5]);
	});

	it('0以下の待ちは、タイマーを使わずに終わる', async () => {
		vi.useFakeTimers();
		await sleep(0);
		await sleep(-5);
	});
});
