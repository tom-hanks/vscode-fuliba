# 福利吧 for VS Code

在 VS Code 侧边栏里浏览[福利吧](https://www.wnflb2023.com)论坛，不用切浏览器。

## 功能

- **版块树**：侧边栏浏览全部版块与子版块，支持翻页、回到首页
- **已读标记**：看过的帖子自动变对勾，也可以手动标记；可选用「隐藏已读」把看过的折叠掉
- **帖子详情**：楼层、引用、代码块、表格都按当前编辑器主题排版，浅色深色都跟得上
- **视频内嵌**：B 站等白名单站点的播放器直接嵌进详情页，点开就能播（只认白名单域名，其它一律不嵌）
- **图片按需加载**：正文图默认只显示 `[图片] 点击加载` / `[表情包] 点击加载`，鼠标悬停出预览、点击就地展开。打开帖子时一张图都不会下载
- **头像可选**：默认不显示，打开后每层显示头像（会拖慢加载）
- **搜索**：在 VS Code 里直接搜帖子

## 安装

### 从源码构建

```bash
git clone https://github.com/tom-hanks/vscode-fuliba.git
cd vscode-fuliba
npm install
npm run compile
```

然后用 VS Code 打开这个目录，按 `F5` 会启动一个装好插件的扩展开发窗口。

想要 `.vsix` 安装包的话：

```bash
npm run package
```

会生成 `fuliba-0.1.0.vsix`，在 VS Code 里 `Ctrl/Cmd+Shift+P` → `Extensions: Install from VSIX...` 选中它即可。

## 使用

### 1. 导入 Cookie

福利吧需要登录才能浏览版块和帖子，所以第一次用要先导入浏览器里的 Cookie：

1. 用浏览器登录 `www.wnflb2023.com`
2. 按 `F12` 打开开发者工具，切到 **Network** 面板
3. 刷新页面，点任意一条请求
4. 在 **Request Headers** 里找到 `Cookie:`，把冒号后面那一整串复制下来
5. 回到 VS Code，`Ctrl/Cmd+Shift+P` → **福利吧: 导入 Cookie**，粘贴进去

Cookie 会过期。之后如果提示登录失效，重复上面的步骤重新导入即可。

### 2. 浏览

左侧活动栏点福利吧图标，展开版块 → 点帖子标题即可在编辑器里打开详情。

## 设置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `fuliba.siteUrl` | `https://www.wnflb2023.com` | 论坛站点地址 |
| `fuliba.hideReadThreads` | `false` | 在帖子列表中隐藏已读帖子 |
| `fuliba.showAvatar` | `false` | 在帖子详情里显示用户头像 |
| `fuliba.requestInterval` | `800` | 两次请求之间的最小间隔（毫秒），降低触发论坛风控的概率 |

## 隐私

- Cookie 只存在 VS Code 的 **SecretStorage** 里（macOS 走钥匙串、Windows 走 DPAPI、Linux 走 libsecret），不会写进任何配置文件
- Cookie 只用来向福利吧发请求，不会发往任何第三方服务器
- 本扩展没有遥测，不收集任何数据
- 仓库源码里不存在任何硬编码的凭据

## 免责声明

本项目是非官方的第三方客户端，与福利吧论坛官方没有任何关系。

仅供学习和个人浏览使用。请遵守论坛的用户协议与 robots 规则，不要用它做批量抓取或其它给论坛添麻烦的事。使用本扩展产生的任何后果由使用者自行承担。

## License

[MIT](LICENSE)
