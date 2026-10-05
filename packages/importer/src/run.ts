// 本文の差分取得と変換。1回の実行は runs/<runId>/ に作り、成功が確かめられるまで current を動かさない。
//
//   raw/<sha256>                  取得した本文（内容で名前が決まる。書き換えない）
//   runs/<runId>/works/<id>.json  変換した作品
//   runs/<runId>/records/<id>.json 作品ごとの記録（これがある作品は、再開のときに飛ばす）
//   runs/<runId>/manifest.json    全作品が終わったときだけ書く
//   current.json                  最後に正常と確かめた実行（commitRun だけが書き換える）

import { join } from 'node:path';
import {
	convertText,
	convertXhtml,
	CONVERTER_VERSION
} from '../../converter/src/index.ts';
import { serializeWork } from '../../../src/lib/domain/work.ts';
import { selectBodies } from './catalog.ts';
import { decodeBody, toSource } from './body.ts';
import { FetchError, fetchResource, type FetchOptions } from './download.ts';
import { readOptional, sha256, writeAtomic } from './store.ts';
import type { Diagnostic as ConversionDiagnostic } from '../../converter/src/types.ts';
import type {
	Attempt,
	CatalogWork,
	Manifest,
	SourceRecord,
	WorkRecord
} from './types.ts';

const RUN_ID = /^[A-Za-z0-9._-]{1,64}$/;

export type RunOptions = {
	/** 作業領域（.corpus/）。 */
	root: string;
	runId: string;
	works: CatalogWork[];
	/** 同時に取得する数。 */
	concurrency?: number;
	/** 取得を始める間隔の下限。公式サイトへ負荷をかけすぎない。 */
	minIntervalMs?: number;
	/** 目録の更新日が同じでも、検証子つきで取得し直す。 */
	revalidate?: boolean;
	/** 止めると、取得中のものが終わった時点で戻る。同じ runId でやり直すと、続きから進む。 */
	signal?: AbortSignal;
	fetchOptions?: Partial<FetchOptions>;
};

/** 各作品が、どう片付いたか。記録には入れない（実行ごとに変わるので）。 */
export type RunStats = {
	fetched: number;
	notModified: number;
	contentUnchanged: number;
	catalogUnchanged: number;
	resumed: number;
	requests: number;
};

export type RunResult = {
	runId: string;
	complete: boolean;
	counts: Manifest['counts'];
	stats: RunStats;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const runPath = (root: string, runId: string, ...rest: string[]) =>
	join(root, 'runs', runId, ...rest);

export async function runImport(options: RunOptions): Promise<RunResult> {
	const { root, runId, concurrency = 4, minIntervalMs = 100 } = options;
	if (!RUN_ID.test(runId)) throw new Error(`runId が使えません: ${runId}`);
	if ((await readOptional(runPath(root, runId, 'manifest.json'))) !== null)
		throw new Error(`実行 ${runId} は、すでに終わっています`);

	const byId = new Map(options.works.map((w) => [w.id, w]));
	// 著作権が「あり」の作品は、ここへ来ても取りに行かない。
	const targets = selectBodies(options.works).fetch;
	const previous = await readCurrent(root);
	const stats: RunStats = {
		fetched: 0,
		notModified: 0,
		contentUnchanged: 0,
		catalogUnchanged: 0,
		resumed: 0,
		requests: 0
	};

	let next = 0;
	let gate = 0;
	const waitTurn = async () => {
		const at = Math.max(Date.now(), gate);
		gate = at + minIntervalMs;
		if (at > Date.now()) await sleep(at - Date.now());
	};

	// 穴の空いた配列は every が飛ばすので、未完了を数え間違える。undefined で埋めておく。
	const records: (WorkRecord | undefined)[] = targets.map(() => undefined);
	const worker = async () => {
		for (;;) {
			if (options.signal?.aborted) return;
			const k = next++;
			if (k >= targets.length) return;
			const t = targets[k];
			const done = await readRecord(
				runPath(root, runId, 'records', `${t.id}.json`)
			);
			// 取得の失敗（通信・時間切れなど）は、再開のときにもう一度試す。変換の失敗は同じ結果なので飛ばす。
			if (
				done &&
				!(
					done.status === 'failed' &&
					done.attempts.some((a) => a.code.startsWith('fetch-'))
				)
			) {
				stats.resumed++;
				records[k] = done;
				continue;
			}
			const work = byId.get(t.id) as CatalogWork;
			records[k] = await importWork(t, work, {
				...options,
				previous,
				stats,
				waitTurn
			});
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

	const complete = records.every((r) => r !== undefined);
	const sorted = records
		.filter((r): r is WorkRecord => r !== undefined)
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const counts = {
		total: sorted.length,
		converted: sorted.filter((r) => r.status === 'converted').length,
		failed: sorted.filter((r) => r.status === 'failed').length
	};
	if (complete) {
		const manifest: Manifest = {
			schemaVersion: 1,
			converterVersion: CONVERTER_VERSION,
			counts,
			records: sorted
		};
		await writeAtomic(
			runPath(root, runId, 'manifest.json'),
			`${JSON.stringify(manifest, null, 1)}\n`
		);
	}
	return { runId, complete, counts, stats };
}

type Ctx = RunOptions & {
	previous: string | null;
	stats: RunStats;
	waitTurn: () => Promise<void>;
};

async function importWork(
	target: ReturnType<typeof selectBodies>['fetch'][number],
	work: CatalogWork,
	ctx: Ctx
): Promise<WorkRecord> {
	const { root, runId, stats } = ctx;
	const attempts: Attempt[] = [];
	const finish = async (record: WorkRecord) => {
		await writeAtomic(
			runPath(root, runId, 'records', `${work.id}.json`),
			`${JSON.stringify(record, null, 1)}\n`
		);
		return record;
	};

	for (const src of target.sources) {
		const problem = (code: string, message: string, location?: string) =>
			attempts.push({
				path: src.path,
				url: src.url,
				code,
				message,
				...(location && { location })
			});
		// 前回の実行で、同じ経路・同じURLから変換できていれば、それを土台にする。
		const prev = await previousConverted(ctx, work.id, src.path, src.url);

		// 目録の更新日も変換器も前回と同じなら、取得せず、前回の作品を引き継ぐ。
		if (
			prev &&
			!ctx.revalidate &&
			prev.record.source.catalogUpdated === src.updated &&
			prev.record.converter.version === CONVERTER_VERSION
		) {
			await writeAtomic(
				runPath(root, runId, 'works', `${work.id}.json`),
				prev.work
			);
			stats.catalogUnchanged++;
			return finish(prev.record);
		}

		const cached = prev
			? await readRaw(root, prev.record.source.rawSha256)
			: null;
		await ctx.waitTurn();
		stats.requests++;
		let got;
		try {
			got = await fetchResource(src.url, {
				maxBytes: 64 * 2 ** 20,
				...ctx.fetchOptions,
				...(prev &&
					cached && {
						etag: prev.record.source.etag,
						lastModified: prev.record.source.lastModified
					})
			});
		} catch (e) {
			if (!(e instanceof FetchError)) throw e;
			problem(`fetch-${e.code}`, e.message);
			continue;
		}

		let bytes: Uint8Array;
		let source: SourceRecord;
		if (got.status === 'not-modified') {
			if (!prev || !cached) {
				problem('fetch-status', '条件なしの取得に 304 が返りました');
				continue;
			}
			stats.notModified++;
			bytes = cached;
			source = { ...prev.record.source, catalogUpdated: src.updated };
		} else {
			stats.fetched++;
			bytes = got.bytes;
			const hash = sha256(bytes);
			await writeAtomic(join(root, 'raw', hash), bytes);
			source = {
				path: src.path,
				url: src.url,
				catalogUpdated: src.updated,
				...(got.etag !== undefined && { etag: got.etag }),
				...(got.lastModified !== undefined && {
					lastModified: got.lastModified
				}),
				rawSha256: hash,
				rawBytes: bytes.length
			};
		}

		// 本文が前回と同じで、変換器も同じなら、変換し直さない。
		if (
			prev &&
			prev.record.source.rawSha256 === source.rawSha256 &&
			prev.record.converter.version === CONVERTER_VERSION
		) {
			if (got.status === 'ok') stats.contentUnchanged++;
			await writeAtomic(
				runPath(root, runId, 'works', `${work.id}.json`),
				prev.work
			);
			return finish({ ...prev.record, source, attempts });
		}

		const decoded = decodeBody(src.path, src.encoding, bytes);
		if (!decoded.ok) {
			problem(decoded.code, decoded.message);
			continue;
		}
		const converted = (src.path === 'xhtml' ? convertXhtml : convertText)(
			decoded.text,
			toSource(work, src)
		);
		if (!converted.ok) {
			problem(
				`convert-${converted.failure.code}`,
				converted.failure.message,
				converted.failure.location
			);
			continue;
		}
		const json = `${serializeWork(converted.work)}\n`;
		await writeAtomic(runPath(root, runId, 'works', `${work.id}.json`), json);
		return finish({
			id: work.id,
			status: 'converted',
			source,
			converter: converted.work.provenance.converter,
			workSha256: sha256(json),
			workBytes: Buffer.byteLength(json),
			diagnostics: converted.diagnostics,
			attempts
		});
	}
	return finish({ id: work.id, status: 'failed', attempts });
}

/** 前回の実行の、この経路・URLの変換結果。作品のファイルが記録と合わなければ、なかったことにする。 */
async function previousConverted(
	ctx: Ctx,
	id: string,
	path: 'xhtml' | 'text',
	url: string
) {
	if (!ctx.previous) return null;
	const record = await readRecord(
		runPath(ctx.root, ctx.previous, 'records', `${id}.json`)
	);
	if (record?.status !== 'converted') return null;
	if (record.source.path !== path || record.source.url !== url) return null;
	const work = await readOptional(
		runPath(ctx.root, ctx.previous, 'works', `${id}.json`)
	);
	if (work === null || sha256(work) !== record.workSha256) return null;
	return { record, work };
}

async function readRaw(root: string, hash: string): Promise<Uint8Array | null> {
	const bytes = await readOptional(join(root, 'raw', hash));
	return bytes !== null && sha256(bytes) === hash ? bytes : null;
}

/** 作業領域のファイルは自分で書いたものだが、途中で壊れていても、読み替えずに「なし」として扱う。 */
async function readRecord(path: string): Promise<WorkRecord | null> {
	const text = await readOptional(path);
	if (text === null) return null;
	try {
		return parseRecord(JSON.parse(text.toString('utf-8')));
	} catch {
		return null;
	}
}

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null =>
	typeof v === 'number' && Number.isFinite(v) ? v : null;
const path = (v: unknown): 'xhtml' | 'text' | null =>
	v === 'xhtml' || v === 'text' ? v : null;

function parseAttempt(v: unknown): Attempt | null {
	if (!isObj(v)) return null;
	const [p, url, code, message] = [
		path(v.path),
		str(v.url),
		str(v.code),
		str(v.message)
	];
	if (!p || url === null || code === null || message === null) return null;
	const location = str(v.location);
	return { path: p, url, code, message, ...(location && { location }) };
}

/** 全部の要素が読めたときだけ、配列を返す。 */
function all<T>(v: unknown, one: (x: unknown) => T | null): T[] | null {
	if (!Array.isArray(v)) return null;
	const out: T[] = [];
	for (const x of v) {
		const got = one(x);
		if (got === null) return null;
		out.push(got);
	}
	return out;
}

const DIAGNOSTICS = [
	'active-content-removed',
	'attribute-dropped',
	'link-removed',
	'section-ignored'
] as const;

function parseDiagnostic(v: unknown): ConversionDiagnostic | null {
	if (!isObj(v)) return null;
	const code = DIAGNOSTICS.find((c) => c === v.code);
	const [message, location] = [str(v.message), str(v.location)];
	return code && message !== null && location !== null
		? { code, message, location }
		: null;
}

/** 記録を、読めた項目だけから作り直す。読めなければ null（なかったことにして、やり直す）。 */
function parseRecord(v: unknown): WorkRecord | null {
	if (!isObj(v)) return null;
	const id = str(v.id);
	const attempts = all(v.attempts, parseAttempt);
	if (id === null || attempts === null) return null;
	if (v.status === 'failed') return { id, status: 'failed', attempts };
	if (v.status !== 'converted' || !isObj(v.source) || !isObj(v.converter))
		return null;
	const s = v.source;
	const [p, url, catalogUpdated, rawSha256, rawBytes] = [
		path(s.path),
		str(s.url),
		str(s.catalogUpdated),
		str(s.rawSha256),
		num(s.rawBytes)
	];
	const [version, via] = [str(v.converter.version), path(v.converter.path)];
	const [workSha256, workBytes] = [str(v.workSha256), num(v.workBytes)];
	const diagnostics = all(v.diagnostics, parseDiagnostic);
	if (
		!p ||
		url === null ||
		catalogUpdated === null ||
		rawSha256 === null ||
		rawBytes === null ||
		version === null ||
		!via ||
		workSha256 === null ||
		workBytes === null ||
		diagnostics === null
	)
		return null;
	const [etag, lastModified] = [str(s.etag), str(s.lastModified)];
	return {
		id,
		status: 'converted',
		source: {
			path: p,
			url,
			catalogUpdated,
			...(etag !== null && { etag }),
			...(lastModified !== null && { lastModified }),
			rawSha256,
			rawBytes
		},
		converter: { version, path: via },
		workSha256,
		workBytes,
		diagnostics,
		attempts
	};
}

/** 最後に正常と確かめた実行。なければ null。 */
export async function readCurrent(root: string): Promise<string | null> {
	const text = await readOptional(join(root, 'current.json'));
	if (text === null) return null;
	try {
		const v: unknown = JSON.parse(text.toString('utf-8'));
		const runId = isObj(v) ? str(v.runId) : null;
		return runId !== null && RUN_ID.test(runId) ? runId : null;
	} catch {
		return null;
	}
}

export class CommitRefused extends Error {}

/**
 * 終わった実行を、最後に正常な実行にする。
 * 終わっていない、1件もない、失敗が多すぎる実行は拒み、これまでの current を動かさない。
 */
export async function commitRun(
	root: string,
	runId: string,
	{ maxFailureRatio = 0.02 }: { maxFailureRatio?: number } = {}
): Promise<void> {
	if (!RUN_ID.test(runId))
		throw new CommitRefused(`runId が使えません: ${runId}`);
	const text = await readOptional(runPath(root, runId, 'manifest.json'));
	if (text === null)
		throw new CommitRefused(`実行 ${runId} は、終わっていません`);
	const { counts } = JSON.parse(text.toString('utf-8')) as Manifest;
	if (counts.total === 0) throw new CommitRefused('作品が1件もありません');
	if (counts.failed / counts.total > maxFailureRatio)
		throw new CommitRefused(
			`失敗が多すぎます（${counts.failed}/${counts.total}）`
		);
	await writeAtomic(
		join(root, 'current.json'),
		`${JSON.stringify({ runId })}\n`
	);
}
