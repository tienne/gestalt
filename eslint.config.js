import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'node_modules/',
      '.claude/',
      '_workspace/',
      'benchmarks/results/',
      '.gestalt/',
      '.gestalt-test/',
      '.gestalt-bench/',
      'coverage/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      // tsconfig의 noUnusedLocals/noUnusedParameters와 동일하게 `_` prefix는 의도적 미사용으로 허용
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // 테스트에서는 partial mock 객체를 위한 타입 단언(any)을 허용한다 (소스 코드는 엄격 유지)
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
