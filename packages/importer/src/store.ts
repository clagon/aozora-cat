// 取り込みの作業領域（.corpus/）への書き込み。途中で止まっても、半端なファイルが残らない。

import { createHash, randomBytes } from 'node:crypto';
import {
	link,
	mkdir,
	readFile,
	rename,
	unlink,
	writeFile
} from 'node:fs/promises';
import { dirname } from 'node:path';

export const sha256 = (data: string | Uint8Array): string =>
	createHash('sha256').update(data).digest('hex');

/** 同じ場所の一時ファイルへ書いてから、名前を付け替える。読み手は、書き終えたものだけを見る。 */
export async function writeAtomic(
	path: string,
	data: string | Uint8Array
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
	await writeFile(tmp, data);
	await rename(tmp, path);
}

/** なければ null。そのほかの失敗は、握りつぶさず投げる。 */
export async function readOptional(path: string): Promise<Buffer | null> {
	try {
		return await readFile(path);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw e;
	}
}

export class LockedError extends Error {}

/** そのプロセスが、まだ動いているか。権限がなくて信号を送れない場合も、動いているとみなす。 */
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'EPERM';
	}
};

/**
 * 排他的にファイルを作って、場所を確保する。すでにあり、持ち主が動いていれば拒む。
 * 持ち主が終わっている（落ちて残った）ものは、名前を付け替えて取り除き、取り直す。
 * 付け替えは1つのプロセスしか成功しないので、取り除きを競り合っても、確保できるのは1つだけ。
 * 返した関数で解放する。
 */
export async function acquireLock(path: string): Promise<() => Promise<void>> {
	await mkdir(dirname(path), { recursive: true });
	for (let attempt = 0; attempt < 3; attempt++) {
		// 持ち主の番号を書いた一時ファイルを、ハードリンクで本来の名前にする。リンクは、すでにあれば失敗する
		// （排他的）うえ、名前が見えるときには、中身が書き終わっている（空のロックを、落ちたものと誤らない）。
		const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
		await writeFile(tmp, String(process.pid));
		try {
			await link(tmp, path);
			return async () => {
				try {
					await unlink(path);
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
				}
			};
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
		} finally {
			await unlink(tmp);
		}
		const owner = Number((await readOptional(path))?.toString('utf-8'));
		if (Number.isInteger(owner) && owner > 0 && alive(owner))
			throw new LockedError(`${path} は、プロセス ${owner} が使っています`);
		try {
			await rename(path, `${path}.stale-${randomBytes(6).toString('hex')}`);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
		}
	}
	throw new LockedError(`${path} を確保できません`);
}
