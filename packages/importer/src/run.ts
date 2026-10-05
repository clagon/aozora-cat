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
import { checkWork, selectBodies } from './catalog.ts';
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

/** 英数字で始める。「.」「..」のようなパスの一部になる値は、runs/<runId>/ から出てしまうので使えない。 */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

type Source = ReturnType<
	typeof selectBodies
>['fetch'][number]['sources'][number];

/** 変換の入力のハッシュ。変換器へ渡す値に加え、復号を決める符号化方式も含める。 */
const inputHash = (work: CatalogWork, src: Source): string =>
	sha256(
		JSON.stringify({ source: toSource(work, src), encoding: src.encoding })
	);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const runPath = (root: string, runId: string, ...rest: string[]) =>
	join(root, 'runs', runId, ...rest);

export async function runImport(options: RunOptions): Promise<RunResult> {
	const { root, runId, concurrency = 4, minIntervalMs = 100 } = options;
	if (!RUN_ID.test(runId)) throw new Error(`runId が使えません: ${runId}`);
	if ((await readOptional(runPath(root, runId, 'manifest.json'))) !== null)
		throw new Error(`実行 ${runId} は、すでに終わっています`);

	// 作品IDはファイル名に、本文のURLは通信の宛先になる。呼び出し側が組んだ値でも、公式以外や
	// パスの一部、別の作品のものを持ち込ませない。何かを読み書きする前に調べる。
	for (const w of options.works) {
		const bad = checkWork(w);
		if (bad !== null) throw new Error(bad);
	}
	if (new Set(options.works.map((w) => w.id)).size !== options.works.length)
		throw new Error('作品IDが重複しています');

	const byId = new Map(options.works.map((w) => [w.id, w]));
	// 著作権が「あり」の作品は、ここへ来ても取りに行かない。
	const targets = selectBodies(options.works).fetch;

	// 実行は、始めたときの入力（目録の項目・本文の参照・変換器）と取り直しの指定に結び付ける。再開のとき、入力が
	// 変わっていれば、古い記録を混ぜずに止める（記録の中身が、今の入力に合うかを個別に調べない）。
	const key = sha256(
		JSON.stringify({
			converter: CONVERTER_VERSION,
			revalidate: options.revalidate === true,
			inputs: targets
				.map((t) => [
					t.id,
					t.sources.map((src) => [
						src.path,
						src.url,
						src.encoding,
						inputHash(byId.get(t.id) as CatalogWork, src)
					])
				])
				.sort((a, b) => (a[0] < b[0] ? -1 : 1))
		})
	);
	// 前回の実行（引き継ぎの土台）も、始めたときの current に固定する。再開の間に別の実行が
	// 確定しても、新旧の土台を混ぜない。
	const started = await readOptional(runPath(root, runId, 'run.json'));
	let previous: string | null;
	if (started === null) {
		previous = await readCurrent(root);
		await writeAtomic(
			runPath(root, runId, 'run.json'),
			`${JSON.stringify({ key, previous })}\n`
		);
	} else {
		const saved = parseStarted(started.toString('utf-8'));
		if (saved?.key !== key)
			throw new Error(
				`実行 ${runId} は、別の入力（目録・変換器・取り直しの指定）で始めた実行です。新しい runId で始めてください`
			);
		previous = saved.previous;
	}

	const stats: RunStats = {
		fetched: 0,
		notModified: 0,
		contentUnchanged: 0,
		catalogUnchanged: 0,
		resumed: 0,
		requests: 0
	};

	let next = 0;
	/** 作業者が1つでも予期しない失敗をしたら、残りは新しい作品を取らない。 */
	let broken = false;
	let gate = 0;
	const waitTurn = async () => {
		const at = Math.max(Date.now(), gate);
		gate = at + minIntervalMs;
		if (at > Date.now()) await sleep(at - Date.now());
	};

	// 穴の空いた配列は every が飛ばすので、未完了を数え間違える。undefined で埋めておく。
	const records: (WorkRecord | undefined)[] = targets.map(() => undefined);
	const loop = async () => {
		for (;;) {
			if (broken || options.signal?.aborted) return;
			const k = next++;
			if (k >= targets.length) return;
			const t = targets[k];
			const done = await readRecord(
				runPath(root, runId, 'records', `${t.id}.json`)
			);
			// 取得の失敗（通信・時間切れなど）は、再開のときにもう一度試す。変換の失敗は同じ結果なので飛ばす。
			if (
				done &&
				done.id === t.id &&
				(await artifactOk(root, runId, done)) &&
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
	const worker = () =>
		loop().catch((e: unknown) => {
			broken = true;
			throw e;
		});
	// 1つが失敗しても、ほかの作業者が終わる（書き込み中のものも含めて）のを待ってから、失敗を返す。
	// 先に返すと、呼び出し側が後片付けや再実行を始めたあとも、裏で通信と書き込みが続いてしまう。
	const settled = await Promise.allSettled(
		Array.from({ length: Math.max(1, concurrency) }, worker)
	);
	const crashed = settled.find((r) => r.status === 'rejected');
	if (crashed) throw crashed.reason;

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
		// 変換器へ渡す入力。目録の項目（題名・人物・図書カードなど）が直ると変わるので、再利用の鍵にする。
		const input = inputHash(work, src);
		// 前回の実行で、同じ経路・同じURLから変換できていれば、それを土台にする。
		const prev = await previousConverted(ctx, work.id, src.path, src.url);

		// 変換器への入力（目録の更新日を含む）も変換器も前回と同じなら、取得せず、前回の作品を引き継ぐ。
		if (
			prev &&
			!ctx.revalidate &&
			prev.record.source.inputSha256 === input &&
			prev.record.converter.version === CONVERTER_VERSION
		) {
			await writeAtomic(
				runPath(root, runId, 'works', `${work.id}.json`),
				prev.work
			);
			stats.catalogUnchanged++;
			// 変換の結果は引き継ぐが、この実行で先の経路が失敗した理由は、今のものを残す。
			return finish({ ...prev.record, attempts });
		}

		const cached = prev
			? await readRaw(root, prev.record.source.rawSha256)
			: null;
		let got;
		try {
			got = await fetchResource(src.url, {
				maxBytes: 64 * 2 ** 20,
				...ctx.fetchOptions,
				// 再試行も含めて、通信を始めるたびに間隔を守り、数える。
				beforeAttempt: async () => {
					await ctx.waitTurn();
					stats.requests++;
				},
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
			source = {
				...prev.record.source,
				catalogUpdated: src.updated,
				inputSha256: input
			};
		} else {
			stats.fetched++;
			bytes = got.bytes;
			const hash = sha256(bytes);
			await writeAtomic(join(root, 'raw', hash), bytes);
			source = {
				path: src.path,
				url: src.url,
				catalogUpdated: src.updated,
				inputSha256: input,
				...(got.etag !== undefined && { etag: got.etag }),
				...(got.lastModified !== undefined && {
					lastModified: got.lastModified
				}),
				rawSha256: hash,
				rawBytes: bytes.length
			};
		}

		// 本文も変換への入力も前回と同じで、変換器も同じなら、変換し直さない。
		if (
			prev &&
			prev.record.source.rawSha256 === source.rawSha256 &&
			prev.record.source.inputSha256 === input &&
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

/** 記録が示す作品のファイルが、あり、記録のハッシュと大きさに合うか。失敗の記録は作品を持たないので、常に合う。 */
async function artifactOk(
	root: string,
	runId: string,
	r: WorkRecord
): Promise<boolean> {
	if (r.status !== 'converted') return true;
	const work = await readOptional(
		runPath(root, runId, 'works', `${r.id}.json`)
	);
	return (
		work !== null &&
		work.length === r.workBytes &&
		sha256(work) === r.workSha256
	);
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
	if (
		work === null ||
		work.length !== record.workBytes ||
		sha256(work) !== record.workSha256
	)
		return null;
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
	const [p, url, catalogUpdated, inputSha256, rawSha256, rawBytes] = [
		path(s.path),
		str(s.url),
		str(s.catalogUpdated),
		str(s.inputSha256),
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
		inputSha256 === null ||
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
			inputSha256,
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

/** run.json を読む。読めなければ null（別の入力で始めた実行と同じく、再開を断る）。 */
function parseStarted(
	text: string
): { key: string; previous: string | null } | null {
	try {
		const v: unknown = JSON.parse(text);
		if (!isObj(v)) return null;
		const key = str(v.key);
		const previous = v.previous === null ? null : str(v.previous);
		return key !== null && (previous === null || RUN_ID.test(previous))
			? { key, previous }
			: null;
	} catch {
		return null;
	}
}

export class CommitRefused extends Error {}

/** manifest を読み、記録を作り直す。形が合わない・件数が合わないものは null。 */
function parseManifest(text: string): Manifest | null {
	try {
		const v: unknown = JSON.parse(text);
		if (!isObj(v) || v.schemaVersion !== 1 || !isObj(v.counts)) return null;
		const converterVersion = str(v.converterVersion);
		const records = all(v.records, parseRecord);
		if (converterVersion === null || records === null) return null;
		const counts = {
			total: records.length,
			converted: records.filter((r) => r.status === 'converted').length,
			failed: records.filter((r) => r.status === 'failed').length
		};
		const c = v.counts;
		return c.total === counts.total &&
			c.converted === counts.converted &&
			c.failed === counts.failed &&
			new Set(records.map((r) => r.id)).size === records.length
			? { schemaVersion: 1, converterVersion, counts, records }
			: null;
	} catch {
		return null;
	}
}

/**
 * 終わった実行を、最後に正常な実行にする。
 * 終わっていない、manifest が壊れている、作品のファイルが記録と合わない、1件もない、
 * 失敗が多すぎる実行は拒み、これまでの current を動かさない。
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
	const manifest = parseManifest(text.toString('utf-8'));
	if (!manifest) throw new CommitRefused('manifest が読めません');
	const { counts } = manifest;
	if (counts.total === 0) throw new CommitRefused('作品が1件もありません');
	if (counts.failed / counts.total > maxFailureRatio)
		throw new CommitRefused(
			`失敗が多すぎます（${counts.failed}/${counts.total}）`
		);
	// 記録が示す作品のファイルが、すべてあり、ハッシュと大きさが合うこと。
	for (const r of manifest.records)
		if (!(await artifactOk(root, runId, r)))
			throw new CommitRefused(`作品 ${r.id} のファイルが、記録と合いません`);
	await writeAtomic(
		join(root, 'current.json'),
		`${JSON.stringify({ runId })}\n`
	);
}
