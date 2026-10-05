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
