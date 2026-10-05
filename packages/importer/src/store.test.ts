import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LockedError, acquireLock } from './store.ts';

let dir = '';
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'aozora-lock-'));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('acquireLock', () => {
	it('1つだけが確保でき、解放すると次が確保できる', async () => {
		const lock = join(dir, 'x', 'lock');
		const release = await acquireLock(lock);
		await expect(acquireLock(lock)).rejects.toThrow(LockedError);
		await release();
		await release(); // 二重の解放も安全
		await (
			await acquireLock(lock)
		)();
		expect(await readdir(join(dir, 'x'))).toEqual([]);
	});

	it('落ちたロックを調べたあとに、別のプロセスが取り直し終えても、その新しいロックを壊さない', async () => {
		const lock = join(dir, 'x', 'lock');
		await (
			await acquireLock(lock)
		)();
		await writeFile(lock, '2147483646');

		// B は、落ちた持ち主を見たところで止まる。そのあいだに A が取り直し終える。
		let resume = () => {};
		const paused = new Promise<void>((r) => (resume = r));
		let inspected = () => {};
		const seen = new Promise<void>((r) => (inspected = r));
		const b = acquireLock(lock, {
			afterInspect: async () => {
				inspected();
				await paused;
			}
		});
		const bResult = b.then(
			() => 'acquired',
			(e: unknown) => e
		);
		await seen;
		const releaseA = await acquireLock(lock);
		resume();
		expect(await bResult).toBeInstanceOf(LockedError);
		// A のロックは、そのまま残っている。
		expect(await readFile(lock, 'utf-8')).toBe(String(process.pid));
		await releaseA();
		expect(await readdir(join(dir, 'x'))).toEqual([]);
	});

	it('落ちたロックを複数が同時に取り直そうとしても、確保できるのは1つだけ', async () => {
		for (let round = 0; round < 30; round++) {
			const lock = join(dir, `r${round}`, 'lock');
			await (
				await acquireLock(lock)
			)();
			await writeFile(lock, '2147483646');
			const results = await Promise.allSettled(
				Array.from({ length: 12 }, () => acquireLock(lock))
			);
			expect(
				results.filter((r) => r.status === 'fulfilled'),
				`round ${round}`
			).toHaveLength(1);
			for (const r of results)
				if (r.status === 'rejected')
					expect(r.reason).toBeInstanceOf(LockedError);
		}
	});
});
