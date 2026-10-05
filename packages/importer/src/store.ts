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

const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

/**
 * 自分のプロセス番号を書いた一時ファイルを、ハードリンクで path にする。リンクは、すでにあれば
 * 失敗する（排他的）うえ、名前が見えるときには中身が書き終わっている。作れたら true。
 */
async function createExclusive(path: string): Promise<boolean> {
	const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
	await writeFile(tmp, String(process.pid));
	try {
		await link(tmp, path);
		return true;
	} catch (e) {
		if (code(e) !== 'EEXIST') throw e;
		return false;
	} finally {
		await unlink(tmp);
	}
}

const ownerOf = async (path: string): Promise<number> =>
	Number((await readOptional(path))?.toString('utf-8'));
const isLive = (pid: number) => Number.isInteger(pid) && pid > 0 && alive(pid);

/**
 * 排他的にファイルを作って、場所を確保する。すでにあれば拒む。返した関数で解放する。
 *
 * 持ち主が終わっている（落ちて残った）ロックは、既定では取り直さず、拒む。自動で取り直すと、
 * 複数のプロセスが同時に取り直したときに、互いの新しいロックを壊す競り合いが避けられない。
 * ほかに動いているプロセスがないと呼び出し側が言い切れるときだけ、`recoverStale` で取り直せる。
 * 動いている持ち主のロックは、`recoverStale` でも取り直さない。
 */
export async function acquireLock(
	path: string,
	{ recoverStale = false }: { recoverStale?: boolean } = {}
): Promise<() => Promise<void>> {
	await mkdir(dirname(path), { recursive: true });
	const release = async () => {
		try {
			await unlink(path);
		} catch (e) {
			if (code(e) !== 'ENOENT') throw e;
		}
	};
	if (await createExclusive(path)) return release;

	const owner = await ownerOf(path);
	if (isLive(owner))
		throw new LockedError(`${path} は、プロセス ${owner} が使っています`);
	if (!recoverStale)
		throw new LockedError(
			`${path} が残っています（持ち主のプロセス ${owner} は動いていません）。` +
				'ほかに動いている取り込みがなければ、recoverStaleLock を指定するか、このファイルを削除してください'
		);
	await unlink(path).catch((e: unknown) => {
		if (code(e) !== 'ENOENT') throw e;
	});
	if (await createExclusive(path)) return release;
	throw new LockedError(`${path} を取り直せません`);
}
