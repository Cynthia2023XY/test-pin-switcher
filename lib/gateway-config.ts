/** 校验构建者提供的测试网关 URL 和 Cookie 名称 */
export function readGatewayConfig(rawUrl: string | undefined, rawCookieName: string | undefined) {
  // 两项配置都由使用者的测试环境提供。
  const cookieName = rawCookieName?.trim();
  if (!rawUrl || !cookieName) {
    throw new Error('请在 .env.local 中设置测试网关 URL 和 Cookie 名称。');
  }

  // 解析并限制为不含账号凭据或片段的 HTTPS 测试地址。
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('测试网关必须是有效的 HTTPS URL，且不能包含凭据或片段。');
  }

  // Chrome 的主机权限按协议和主机匹配，不按请求路径划分。
  return { url: url.href, cookieName, hostPermission: 'https://' + url.hostname + '/*' };
}
