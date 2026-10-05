import type { Diagnostic as ConversionDiagnostic } from '../../converter/src/types.ts';

export type Role = 'author' | 'translator' | 'editor' | 'reviser' | 'other';

export type Person = { id: string; role: Role; name: string; reading?: string };

/** 公式の一覧にある本文の参照。取得は取り込みの次の段で行う。 */
export type BodyRef = {
	url: string;
	updated: string;
	encoding: 'ShiftJIS' | 'UTF-8';
};

export type CatalogWork = {
	id: string;
	title: string;
	titleReading: string;
	sortReading: string;
	subtitle?: string;
	subtitleReading?: string;
	originalTitle?: string;
	firstPublication?: string;
	classification?: string;
	orthography: string;
	/** 公式の「作品著作権フラグ」。頒布してよいのは「なし」だけ。人物のフラグは持たない。 */
	workCopyright: 'なし' | 'あり';
	published: string;
	updated: string;
	cardUrl: string;
	people: Person[];
	xhtml?: BodyRef;
	text?: BodyRef;
};

export type Diagnostic = { id?: string; code: string; message: string };

export type ParsedCatalog = {
	works: CatalogWork[];
	/** 決められずに外した作品。配信しない。 */
	rejected: Diagnostic[];
	notes: Diagnostic[];
};

export type Selection = {
	fetch: {
		id: string;
		sources: ({ path: 'xhtml' | 'text' } & BodyRef)[];
	}[];
	skipped: { id: string; reason: 'copyright-active' | 'no-body' }[];
};

export type SearchEntry = {
	id: string;
	title: string;
	titleReading: string;
	sortReading: string;
	subtitle?: string;
	classification?: string;
	orthography: string;
	updated: string;
	people: { role: Role; name: string; reading?: string }[];
};

/** 取得や変換に失敗した1回の試み。次の経路へ移った理由を残す。 */
export type Attempt = {
	path: 'xhtml' | 'text';
	url: string;
	code: string;
	message: string;
	location?: string;
};

/** 変換元の本文の記録。再取得の要否と、同じ内容かどうかの判断に使う。 */
export type SourceRecord = {
	path: 'xhtml' | 'text';
	url: string;
	/** 目録の「最終更新日」。変わっていなければ、取得し直さない。 */
	catalogUpdated: string;
	/** 変換器へ渡した入力（目録の項目と来歴）のハッシュ。変わっていれば、前回の作品は使えない。 */
	inputSha256: string;
	etag?: string;
	lastModified?: string;
	rawSha256: string;
	rawBytes: number;
};

/** 1作品の取り込み結果。時刻などの実行ごとに変わる値は入れない（同じ入力から同じ記録になる）。 */
export type WorkRecord =
	| {
			id: string;
			status: 'converted';
			source: SourceRecord;
			converter: { version: string; path: 'xhtml' | 'text' };
			workSha256: string;
			workBytes: number;
			diagnostics: ConversionDiagnostic[];
			attempts: Attempt[];
	  }
	| {
			id: string;
			status: 'failed';
			attempts: Attempt[];
	  };

export type Manifest = {
	schemaVersion: 1;
	converterVersion: string;
	counts: { total: number; converted: number; failed: number };
	records: WorkRecord[];
};
