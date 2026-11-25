export function isTrustedGenerationResultUrl(value: string): boolean {
  if (!value.startsWith('https://')) return false
  try {
    const { protocol, hostname, port, username, password } = new URL(value)
    if (protocol !== 'https:' || port || username || password) return false
    return hostname === 'dashscope.aliyuncs.com' ||
      hostname.endsWith('.dashscope.aliyuncs.com') ||
      /^(?:[a-z0-9-]+\.)?oss(?:-[a-z0-9-]+)?\.aliyuncs\.com$/.test(hostname)
  } catch {
    return false
  }
}
