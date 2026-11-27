import { defineConfig } from 'wxt';
import { readGatewayConfig } from './lib/gateway-config';

/** 向 Chrome 注册侧边栏、测试网关权限与后台操作期限 */
export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifest: () => {
    // WXT 在生成扩展清单前已加载本地环境配置。
    const gateway = readGatewayConfig(process.env.WXT_PIN_GATEWAY_URL, process.env.WXT_PIN_COOKIE_NAME);
    return {
      name: '测试 PIN 切换',
      description: '在 Chrome 侧边栏种测试 PIN，保存备注和收藏。',
      permissions: ['sidePanel', 'storage', 'cookies', 'alarms'],
      host_permissions: [gateway.hostPermission],
      incognito: 'not_allowed',
      minimum_chrome_version: '120',
      action: {
        default_title: '打开测试 PIN 侧边栏',
        default_icon: { 16: 'icon/16.png', 32: 'icon/32.png' },
      },
    };
  },
});
