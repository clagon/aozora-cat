// 実機（iPhone / Android）からハーネスを開くための常駐サーバー。
// 使い方: pnpm harness [ポート]  同じ Wi-Fi の端末で、表示された URL を開く。
import { networkInterfaces } from 'node:os';
import { startStaticServer } from '../../tests/e2e/static-server.mjs';

const port = Number(process.argv[2] ?? 4173);
const server = await startStaticServer({ host: '0.0.0.0', port });
const query = '?fixture=kokoro&size=18';

console.log(`縦書きページ送りのハーネスを起動しました（Ctrl+C で終了）`);
console.log(`  この端末: http://localhost:${server.port}/${query}`);
for (const list of Object.values(networkInterfaces())) {
	for (const net of list ?? []) {
		if (net.family === 'IPv4' && !net.internal) {
			console.log(
				`  同じネットワーク: http://${net.address}:${server.port}/${query}`
			);
		}
	}
}
console.log(
	'Android は USB 接続なら `adb reverse tcp:%d tcp:%d` で localhost も使えます。',
	server.port,
	server.port
);
process.on('SIGINT', () => {
	server.close();
	process.exit(0);
});
