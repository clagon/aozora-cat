export default {
	testDir: 'tests/e2e',
	projects: [
		{ name: 'chromium', use: { browserName: 'chromium' } },
		{ name: 'webkit', use: { browserName: 'webkit' } }
	]
};
