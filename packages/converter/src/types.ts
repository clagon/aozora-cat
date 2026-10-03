import type { Person, Work } from '../../../src/lib/domain/work.ts';

/** 変換器のバージョン。出力の来歴に記録する。出力が変わる修正のたびに上げる。 */
export const CONVERTER_VERSION = '1.0.0';

/** 公式の作品一覧（カタログ）にある、1作品ぶんの情報。変換は本文とこの情報から作品を組み立てる。 */
export type WorkSource = {
	id: string;
	title: string;
	titleReading?: string;
	subtitle?: string;
	subtitleReading?: string;
	classification?: string;
	originalTitle?: string;
	firstPublication?: string;
	people: Person[];
	orthography: string;
	/** 公式の作品一覧の「作品著作権フラグ」。人物のフラグではない。 */
	workCopyrightFlag: string;
	cardUrl: string;
	fileUrl: string;
	upstreamUpdated: string;
};

export type FailureCode =
	| 'copyright-active'
	| 'missing-section'
	| 'unknown-section'
	| 'unknown-element'
	| 'unknown-class'
	| 'unsupported-construct'
	| 'invalid-layout'
	| 'invalid-image'
	| 'schema';

/** 変換を止めた理由。location は元ファイルの行・列と要素で、直す場所を示す。 */
export type ConversionFailure = {
	code: FailureCode;
	message: string;
	location: string;
};

/** 変換は続けたが、出力に含めなかったもの。 */
export type Diagnostic = {
	code:
		| 'active-content-removed'
		| 'attribute-dropped'
		| 'link-removed'
		| 'section-ignored';
	message: string;
	location: string;
};

export type ConvertResult =
	| { ok: true; work: Work; diagnostics: Diagnostic[] }
	| { ok: false; failure: ConversionFailure };
