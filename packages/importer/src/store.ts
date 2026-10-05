// 取り込みの作業領域（.corpus/）への書き込み。途中で止まっても、半端なファイルが残らない。

import { createHash, randomBytes } from 'node:crypto';
import {
	link,
	mkdir,
	readFile,
	rename,
	stat,
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** 取り直しの番人が、この時間より長く残っていれば、落ちたものとして取り除く。 */
const GUARD_STALE_MS = 10_000;

/**
 * 排他的にファイルを作って、場所を確保する。すでにあり、持ち主が動いていれば拒む。
 * 持ち主が終わっている（落ちて残った）ロックは、取り直す。取り直しは、調べることと取り除くことの
 * あいだに別のプロセスが取り直し終えると、その新しいロックを壊してしまう。そこで、取り直す側は
 * 先に番人（path.guard）を排他的に取り、番人を持つ間に、持ち主が同じ落ちたものであることを調べ直して
 * から取り除く。取り直しは同時に1つしか進まず、調べ直しで生きた持ち主が見えれば拒む。
 * 返した関数で解放する。
 */
export async function acquireLock(
	path: string,
	/** 試験用。持ち主を調べたあと、取り直しに進む前に呼ぶ（競り合いを決まった順で起こす）。 */
	hooks: { afterInspect?: () => Promise<void> } = {}
): Promise<() => Promise<void>> {
	await mkdir(dirname(path), { recursive: true });
	const release = async () => {
		try {
			await unlink(path);
		} catch (e) {
			if (code(e) !== 'ENOENT') throw e;
		}
	};
	const locked = (owner: number) =>
		new LockedError(`${path} は、プロセス ${owner} が使っています`);

	if (await createExclusive(path)) return release;
	let owner = await ownerOf(path);
	if (isLive(owner)) throw locked(owner);
	await hooks.afterInspect?.();

	const guard = `${path}.guard`;
	for (let wait = 0; ; wait++) {
		if (await createExclusive(guard)) break;
		const age =
			Date.now() -
			(await stat(guard).then(
				(s) => s.mtimeMs,
				() => Date.now()
			));
		if (age > GUARD_STALE_MS) await unlink(guard).catch(() => {});
		if (wait >= 2000) throw new LockedError(`${guard} を確保できません`);
		await sleep(2);
	}
	try {
		// 番人を持っている。ほかの取り直しは進んでいないので、ここで調べ直した持ち主を信じてよい。
		owner = await ownerOf(path);
		if (isLive(owner)) throw locked(owner);
		await unlink(path).catch((e: unknown) => {
			if (code(e) !== 'ENOENT') throw e;
		});
		if (await createExclusive(path)) return release;
		throw locked(await ownerOf(path));
	} finally {
		await unlink(guard).catch(() => {});
	}
}
