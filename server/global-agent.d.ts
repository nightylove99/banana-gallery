/** global-agent 无官方类型，供 contracts / tsc 校验通过 */
declare module 'global-agent' {
  export function bootstrap(): void
}
