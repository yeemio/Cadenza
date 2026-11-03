// @ts-check
import tseslint from 'typescript-eslint'

/**
 * Cadenza ESLint flat 配置。
 *
 * 依赖方向静态边界（SYSTEM_ARCHITECTURE §3：domain ← application ← persistence/integrations，apps 组合）：
 * - domain 禁止 import application / persistence / integrations / ui / apps，且禁止相对引用逃逸出 domain 包；
 * - application 禁止 import persistence / integrations / ui / apps（persistence 实现 application 端口，不得反向）。
 *
 * 证明方式：向 packages/domain/src 放入含越界 import 的临时文件，eslint 应报 no-restricted-imports 错误。
 */
const DOMAIN_FORBIDDEN_MESSAGE =
  '依赖方向违规：domain 是最内层，禁止依赖 application/persistence/integrations/ui/apps（只允许依赖 @cadenza/contracts）'
const APPLICATION_FORBIDDEN_MESSAGE =
  '依赖方向违规：application 只能依赖 @cadenza/contracts 与 @cadenza/domain，禁止依赖 persistence/integrations/ui/apps'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '.owlcoda/**',
      'architecture/**',
      'requirements/**',
      'output/**',
      'delivery/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@cadenza/application', message: DOMAIN_FORBIDDEN_MESSAGE },
            { name: '@cadenza/persistence', message: DOMAIN_FORBIDDEN_MESSAGE },
            { name: '@cadenza/integrations', message: DOMAIN_FORBIDDEN_MESSAGE },
            { name: '@cadenza/ui', message: DOMAIN_FORBIDDEN_MESSAGE },
            { name: '@cadenza/api', message: DOMAIN_FORBIDDEN_MESSAGE },
            { name: '@cadenza/worker', message: DOMAIN_FORBIDDEN_MESSAGE },
            { name: '@cadenza/web', message: DOMAIN_FORBIDDEN_MESSAGE },
            { name: '@cadenza/pda', message: DOMAIN_FORBIDDEN_MESSAGE },
          ],
          patterns: [
            {
              group: [
                '@cadenza/application/*',
                '@cadenza/persistence/*',
                '@cadenza/integrations/*',
                '@cadenza/ui/*',
                '@cadenza/api/*',
                '@cadenza/worker/*',
                '@cadenza/web/*',
                '@cadenza/pda/*',
              ],
              message: DOMAIN_FORBIDDEN_MESSAGE,
            },
            {
              group: ['..', '../*'],
              message: 'domain 包内文件不得以相对路径逃逸出本包（只允许包内相对引用与 @cadenza/contracts）',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@cadenza/persistence', message: APPLICATION_FORBIDDEN_MESSAGE },
            { name: '@cadenza/integrations', message: APPLICATION_FORBIDDEN_MESSAGE },
            { name: '@cadenza/ui', message: APPLICATION_FORBIDDEN_MESSAGE },
            { name: '@cadenza/api', message: APPLICATION_FORBIDDEN_MESSAGE },
            { name: '@cadenza/worker', message: APPLICATION_FORBIDDEN_MESSAGE },
            { name: '@cadenza/web', message: APPLICATION_FORBIDDEN_MESSAGE },
            { name: '@cadenza/pda', message: APPLICATION_FORBIDDEN_MESSAGE },
          ],
          patterns: [
            {
              group: [
                '@cadenza/persistence/*',
                '@cadenza/integrations/*',
                '@cadenza/ui/*',
                '@cadenza/api/*',
                '@cadenza/worker/*',
                '@cadenza/web/*',
                '@cadenza/pda/*',
              ],
              message: APPLICATION_FORBIDDEN_MESSAGE,
            },
            {
              group: ['..', '../*'],
              message: 'application 包内文件不得以相对路径逃逸出本包（实现层须反向依赖端口）',
            },
          ],
        },
      ],
    },
  },
)
