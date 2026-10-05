// 取り込みの作業領域（.corpus/）への書き込み。途中で止まっても、半端なファイルが残らない。

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
