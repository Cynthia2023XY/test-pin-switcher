# 测试 PIN 切换

Chrome Manifest V3 扩展，使用 WXT、Vue 3 和 TypeScript。点击工具栏图标打开侧边栏，在联调页面旁查看当前测试 PIN、发起切换、管理备注和收藏，以及复制 PIN 或切换链接。记录保存在当前 Chrome 配置文件中。

## 本地构建

1. 将 `.env.example` 复制为 `.env.local`，填入你有权使用的 HTTPS 测试网关地址和对应的身份 Cookie 名称。网关接受 `pin` 查询参数，由浏览器访问后更新测试身份。
2. 运行 `npm ci` 和 `npm run build`。
3. 在 `chrome://extensions` 开启开发者模式，选择「加载已解压的扩展程序」，加载 `.output/chrome-mv3`。把扩展图标固定到工具栏后，点击图标打开侧边栏。

测试网关配置会写入本地构建产物，以便扩展申请精确主机权限。请将 `.env.local` 和包含实际测试配置的产物留在本地。示例使用保留域名，便于验证构建；实际切换需要可用的测试网关。
