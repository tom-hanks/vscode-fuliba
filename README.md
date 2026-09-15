# 福利吧 for VS Code

**写代码之余的摸鱼神器。**

在 VS Code 的侧边栏里刷[福利吧](https://www.wnflb2023.com)——不用切浏览器，不用 `Alt+Tab`，福利吧就挂在活动栏上。

等编译、等 `npm install`、等 AI 把那段代码写完……这些碎片时间本来就在那儿闲着，顺手翻两页刚刚好。

## 为什么值得装

- **不用切窗口**　浏览器一开，注意力就整个被接管了；这里只是编辑器左边多了一栏，鼠标点一下的事
- **图片默认不加载**　正文图只显示 `[图片] 点击加载` / `[表情包] 点击加载`，鼠标悬停出预览、点击就地展开。打开帖子时一张图都不会下载，不会突然糊你一屏，也不会拖慢加载
- **跟着主题走**　楼层、引用、代码块、表格全按当前编辑器主题排版，浅色深色都跟得上
- **已读自动标记**　刷过的帖子自动变对勾，也能手动标记；可选用「隐藏已读」把看过的折叠掉，不用重复翻
- **开源可审查**　全部源码在[仓库](https://github.com/tom-hanks/vscode-fuliba)里：没有遥测、不收集任何数据、没有任何硬编码凭据，Cookie 只进系统钥匙串

> 摸鱼有度。这个扩展只帮你少切一次窗口，不提供任何隐身或伪装能力——什么时候刷、刷多久，请自己拿捏 :)

## 功能

- **版块树**：侧边栏浏览全部版块与子版块，支持翻页、回到首页
- **排序方式**：版块内帖子可以按**最新发布 / 最新回复 / 热帖**排列，点标题栏的「排序方式」按钮切换
- **屏蔽置顶帖**：置顶帖常年霸占列表前排，一个开关就能让它们消失
- **只看想看的版块**：版块树可以自己勾选保留哪些，默认全部显示
- **已读标记**：看过的帖子自动变对勾，也可以手动标记；可选用「隐藏已读」把看过的折叠掉
- **帖子详情**：楼层、引用、代码块、表格都按当前编辑器主题排版，浅色深色都跟得上
- **视频内嵌**：B 站等白名单站点的播放器、论坛直传的 mp4、还有论坛自己那套 `detectPlayer` 播放器，都能在详情页里直接播（只认白名单域名，其它一律不嵌）
- **播放器可拖动缩放**：播放器右上角有一块斜纹，按住斜着拖就能放大缩小；**改一次全站通用**——所有帖子里的播放器（包括还开着的其它标签页）一起跟着变，尺寸记在设置里，下次打开还是这个大小
- **声音能修**：论坛视频的音轨基本都是 AAC，VS Code 内核解不出来，所以「有画面没声音、音量键还是灰的」。打开帖子会**自动**用 ffmpeg 把音轨转成 MP3 重新封装（画面轨原样搬运，不重编码），转完声音和音量键都正常，结果会缓存。**需要本机有 ffmpeg**，详见[关于视频没有声音](#关于视频没有声音)
- **附件也能看**：没插进正文的图片附件同样会渲染出来，悬停预览、点击展开；附件名和大小一并保留
- **图片按需加载**：正文图默认只显示 `[图片] 点击加载` / `[表情包] 点击加载`，鼠标悬停出预览、点击就地展开。打开帖子时一张图都不会下载
- **头像可选**：默认不显示，打开后每层显示头像（会拖慢加载）
- **搜索**：在 VS Code 里直接搜帖子

## 安装

### 从扩展市场安装（推荐）

在 VS Code 的扩展面板（`Ctrl/Cmd+Shift+X`）里搜索 **`福利吧`** 或 **`fuliba`**，点安装即可。

也可以直接打开[扩展页面](https://marketplace.visualstudio.com/items?itemName=laryers.fuliba)，或在命令行里：

```bash
code --install-extension laryers.fuliba
```

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

会在项目根目录生成 `fuliba-<版本号>.vsix`，在 VS Code 里 `Ctrl/Cmd+Shift+P` → `Extensions: Install from VSIX...` 选中它即可。

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

## 关于「视频没有声音」

论坛直传的视频音轨基本都是 **AAC**，而 VS Code 的 webview 跑在 Electron 自带的 Chromium 上，那份构建**不含 AAC 解码器**（[microsoft/vscode#167685](https://github.com/microsoft/vscode/issues/167685)；官方文档里 webview 只保证 Wav / Mp3 / Ogg / Flac 音轨）。H.264 画面走 macOS 的 VideoToolbox 平台解码器，照常能放——于是**画面正常、只有声音没有**；媒体控件里的音量键灰着、点不动，也是同一个原因（拿不到可播放音轨，控件就不给它接事件）。

直接查 VS Code 自带那份 `libffmpeg.dylib` 的导出符号就能看到：

| 解码器 | VS Code 的构建 |
| --- | --- |
| `ff_h264_decoder` / `ff_mp3_decoder` / `ff_flac_decoder` / `ff_vorbis_decoder` | ✅ 都在 |
| `ff_aac_decoder` / `ff_opus_decoder` | ❌ 都没有（只剩 `_ff_aac_profiles` 这张配置表） |

**那张配置表正是坑所在**：`canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')` 会回答 `probably`，WebCodecs 的 `AudioDecoder.isConfigSupported('mp4a.40.2')` 也返回 `true` —— **两个都是假阳性**，它们只查表不真解。真去解就露馅：隔离实例里 `decodeAudioData(原始 AAC mp4)` 直接抛 `EncodingError`，而同一窗口的 FLAC 能解出 105123 字节（所以不是测法的问题）。

所以**换播放器救不了**：xgplayer / video.js / artplayer 底下还是同一个 `<video>` / MSE 管线，跑在同一个 Chromium 里。给 `iframe` 加 `allow="autoplay"` 也没用——那是权限，不是编解码。

**能救，但得换编解码。** 打开帖子时会自动把音轨转成 MP3：用系统 ffmpeg，**画面轨 `-c:v copy` 原样搬运**（不重编码、不掉帧），重新封装成一个 mp4 交回原生播放器。换完之后声音和音量键都正常，而且整条链路就是原生控件，不需要额外做音视频同步。转码期间播放器下面会显示进度。

- 需要本机有 ffmpeg（macOS 上 `brew install ffmpeg`）。没找到时不会自动转，可以在设置里用 `fuliba.ffmpegPath` 指定路径
- 不想让它自动跑，把 `fuliba.autoFixAudio` 关掉，改用播放器下面那个「换 MP3 音轨（修声音）」按钮手动触发
- 转好的结果按视频缓存，同一个视频只会转一次；之后再打开这个帖子自动用上。缓存落在扩展的 globalStorage 里，卸载扩展时一起清掉
- 只对**论坛直传的 mp4** 有效。B 站那种嵌在 iframe 里的播放器修不了（音频在别人的播放器里拿不到），那一类下面只有「在浏览器里听」
- 音轨本来就是 MP3 / FLAC / Vorbis 的视频不受影响，本来就有声音

## 设置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `fuliba.siteUrl` | `https://www.wnflb2023.com` | 论坛站点地址 |
| `fuliba.threadSort` | `dateline` | 版块内帖子排序：`dateline` 最新发布 / `lastpost` 最新回复 / `heats` 热帖 |
| `fuliba.playerSize` | `480x270` | 帖子详情里播放器的尺寸，形如 `480x270`。也可以直接在播放器右上角拖动调整 |
| `fuliba.autoFixAudio` | `true` | 打开帖子时自动把视频音轨换成 MP3（需要本机有 ffmpeg）。关掉之后改成手动点「换 MP3 音轨」 |
| `fuliba.ffmpegPath` | （自动探测） | ffmpeg 路径，只有转音轨用得到。留空时自动在 `/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin` 和 `PATH` 里找 |
| `fuliba.hideStickyThreads` | `false` | 在帖子列表中屏蔽置顶帖 |
| `fuliba.hideReadThreads` | `false` | 在帖子列表中隐藏已读帖子 |
| `fuliba.showAvatar` | `false` | 在帖子详情里显示用户头像 |
| `fuliba.requestInterval` | `800` | 两次请求之间的最小间隔（毫秒），降低触发论坛风控的概率 |

排序、屏蔽置顶、版块筛选这三项在侧边栏标题栏上都有按钮，点一下就能切，不用翻设置。

## 隐私

- Cookie 只存在 VS Code 的 **SecretStorage** 里（macOS 走钥匙串、Windows 走 DPAPI、Linux 走 libsecret），不会写进任何配置文件
- Cookie 只用来向福利吧发请求，不会发往任何第三方服务器
- 本扩展没有遥测，不收集任何数据
- 仓库源码里不存在任何硬编码的凭据

整个扩展的源码都在[仓库](https://github.com/tom-hanks/vscode-fuliba)里，随时可以自己翻一遍再决定装不装——包括上面这几条，也可以直接对着代码核实。

## 免责声明

本项目是非官方的第三方客户端，与福利吧论坛官方没有任何关系。

仅供学习和个人浏览使用。请遵守论坛的用户协议与 robots 规则，不要用它做批量抓取或其它给论坛添麻烦的事。使用本扩展产生的任何后果由使用者自行承担。

## License

[MIT](LICENSE)
