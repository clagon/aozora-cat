// 試験用の最小のzipを作る。製品のコードからは使わない。

import { crc32, deflateRawSync } from 'node:zlib';

export type ZipEntry = {
	name: string;
	data: string | Uint8Array;
	method?: 0 | 8;
	flags?: number;
	crc?: number;
	rawSize?: number;
};

export function makeZip(entries: ZipEntry[]): Uint8Array {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const e of entries) {
		const raw = Buffer.from(e.data);
		const method = e.method ?? 8;
		const packed = method === 8 ? deflateRawSync(raw) : raw;
		const name = Buffer.from(e.name);
		const crc = e.crc ?? crc32(raw);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(packed.length, 18);
		local.writeUInt32LE(e.rawSize ?? raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		const head = Buffer.alloc(46);
		head.writeUInt32LE(0x02014b50, 0);
		head.writeUInt16LE(e.flags ?? 0, 8);
		head.writeUInt16LE(method, 10);
		head.writeUInt32LE(crc, 16);
		head.writeUInt32LE(packed.length, 20);
		head.writeUInt32LE(e.rawSize ?? raw.length, 24);
		head.writeUInt16LE(name.length, 28);
		head.writeUInt32LE(offset, 42);
		parts.push(local, name, packed);
		central.push(head, name);
		offset += 30 + name.length + packed.length;
	}
	const dir = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(dir.length, 12);
	end.writeUInt32LE(offset, 16);
	return new Uint8Array(Buffer.concat([...parts, dir, end]));
}
