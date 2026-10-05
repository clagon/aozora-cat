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

	it('落ちたプロセスのロックは、既定では取り直さず、確かめるよう案内して拒む', async () => {
		const lock = join(dir, 'x', 'lock');
		await (
			await acquireLock(lock)
		)();
		await writeFile(lock, '2147483646');
		await expect(acquireLock(lock)).rejects.toThrow(/動いていません/);
		// 拒んだだけで、ロックには触れない。
		expect(await readFile(lock, 'utf-8')).toBe('2147483646');
	});

	it('取り直すと明示したときだけ、落ちたプロセスのロックを取り直す。動いているプロセスのロックは取り直さない', async () => {
		const lock = join(dir, 'x', 'lock');
		await (
			await acquireLock(lock)
		)();
		await writeFile(lock, '2147483646');
		const release = await acquireLock(lock, { recoverStale: true });
		expect(await readFile(lock, 'utf-8')).toBe(String(process.pid));
		await expect(acquireLock(lock, { recoverStale: true })).rejects.toThrow(
			/使っています/
		);
		expect(await readFile(lock, 'utf-8')).toBe(String(process.pid));
		await release();
		expect(await readdir(join(dir, 'x'))).toEqual([]);
	});

	it('中身が読めないロックは、持ち主が分からないので、動いていないものとして扱い、既定では拒む', async () => {
		const lock = join(dir, 'x', 'lock');
		await (
			await acquireLock(lock)
		)();
		await writeFile(lock, '');
		await expect(acquireLock(lock)).rejects.toThrow(LockedError);
	});
});
