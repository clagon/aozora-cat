import svelte from 'eslint-plugin-svelte';
import prettier from 'eslint-config-prettier';

export default [
	...svelte.configs['flat/recommended'],
	prettier,
	{
		ignores: [
			'.svelte-kit/**',
			'build/**',
			'node_modules/**',
			'plans/**',
			'**/*.ts'
		]
	}
];
