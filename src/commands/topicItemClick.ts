import * as vscode from 'vscode';
import * as path from 'path';
import { renderPage } from '../render';
import { fetchThreadDetail, extractTid } from '../discuz';
import { LoginRequiredError, AccessDeniedError } from '../error';
import { ThreadDetail } from '../models';
import Global from '../global';
import { ensureAudioFixed, cachedFixPath, findFfmpeg, FfmpegMissingError } from '../audioFix';

/** 已打开的帖子面板，key 为 tid */
const panels = new Map<number, vscode.WebviewPanel>();

/**
 * 正文里的链接点击后走这里。
 * 站内帖子链接用插件自己打开，其余一律交给系统浏览器。
 */
function handleOpenUrl(url: string | undefined): void {
	if (!url) {
		return;
	}
	const tid = extractTid(url);
	if (tid && /thread-|mod=viewthread/.test(url)) {
		void openThread(tid);
		return;
	}
	if (/^https?:/i.test(url)) {
		void vscode.env.openExternal(vscode.Uri.parse(url));
		return;
	}
	void vscode.env.openExternal(vscode.Uri.parse(`${Global.getSiteUrl()}/${url.replace(/^\/+/, '')}`));
}

function shortTitle(title: string): string {
	return title.length <= 18 ? title : `${title.slice(0, 18)}…`;
}

function createPanel(tid: number, label: string): vscode.WebviewPanel {
	// 转好的音轨落在 globalStorage 里，也得放进 resourceRoots，
	// 否则 asWebviewUri 出来的地址会被 webview 的资源服务挡掉
	const roots = [vscode.Uri.file(path.join(Global.context!.extensionPath, 'html'))];
	const storage = Global.context?.globalStorageUri;
	if (storage) {
		roots.push(storage);
	}

	const panel = vscode.window.createWebviewPanel('fulibaThread', shortTitle(label), vscode.ViewColumn.Active, {
		enableScripts: true,
		retainContextWhenHidden: true,
		enableFindWidget: true,
		localResourceRoots: roots,
	});
	panel.iconPath = vscode.Uri.file(path.join(Global.context!.extensionPath, 'resources', 'icon.png'));
	panels.set(tid, panel);
	panel.onDidDispose(() => panels.delete(tid));
	return panel;
}

function renderError(panel: vscode.WebviewPanel, err: unknown): void {
	const isLogin = err instanceof LoginRequiredError;
	const isDenied = err instanceof AccessDeniedError;
	panel.webview.html = renderPage(panel.webview, 'error.html', {
		message: err instanceof Error ? err.message : '未知错误',
		showLogin: isLogin,
		showRefresh: !isDenied,
	});
}

function renderDetail(panel: vscode.WebviewPanel, detail: ThreadDetail): void {
	panel.title = shortTitle(detail.title);
	panel.webview.html = renderPage(panel.webview, 'thread.html', {
		thread: detail,
		pageNow: detail.pageNow,
		pageTotal: detail.pageTotal,
		siteUrl: Global.getSiteUrl(),
		showAvatar: Global.getShowAvatar(),
		player: Global.getPlayerSize(),
	});
}

async function loadThread(panel: vscode.WebviewPanel, tid: number, page: number): Promise<void> {
	panel.webview.html = renderPage(panel.webview, 'loading.html', {});
	try {
		const detail = await fetchThreadDetail(tid, page);
		// 面板可能在请求期间被关掉了
		if (panels.get(tid) !== panel) {
			return;
		}
		renderDetail(panel, detail);
	} catch (err) {
		if (panels.get(tid) !== panel) {
			return;
		}
		console.error('福利吧：加载帖子失败', err);
		renderError(panel, err);
	}
}

/**
 * 播放器尺寸是全局一份（存设置里），所以拖动之后要把新尺寸推给其它已打开的帖子面板，
 * 否则几个面板会各显示各的大小，看起来像没生效。
 */
async function savePlayerSize(origin: vscode.WebviewPanel, width: number, height: number): Promise<void> {
	if (!width || !height) {
		return;
	}
	await Global.setPlayerSize({ width, height });
	const size = Global.getPlayerSize();
	panels.forEach((panel) => {
		if (panel !== origin) {
			void panel.webview.postMessage({ command: 'playerSize', width: size.width, height: size.height });
		}
	});
}

/**
 * 页面打开时会问一次「哪些视频已经有转好的音轨了」。
 * 命中就直接换源 —— 同一个视频不该重复转。
 *
 * 空结果也要回：页面要等这条消息才知道「除这些之外，其余可以自动去修」，
 * 不回的话自动修复就得靠猜，会和缓存命中撞车、白转一遍。
 */
function replyAudioFixes(panel: vscode.WebviewPanel, urls: string[]): void {
	const map: Record<string, string> = {};
	for (const url of urls) {
		const file = cachedFixPath(url);
		if (file) {
			map[url] = panel.webview.asWebviewUri(vscode.Uri.file(file)).toString();
		}
	}
	void panel.webview.postMessage({
		command: 'audioFixes',
		map,
		// 没有 ffmpeg 时页面里的按钮本来就不存在，这个字段只是让页面能写清楚原因
		ffmpeg: !!findFfmpeg(),
		auto: Global.getAutoFixAudio(),
	});
}

/**
 * 同一个视频的转码只跑一趟。
 *
 * 两个场景会同时来要：自动修复会为页面上每个播放器各发一次请求，而同一个视频
 * 可能在多个楼层、甚至多个帖子面板里重复出现；再加上用户手动点按钮。
 * 用 URL 做 key 存一份 in-flight Promise，后来的直接复用，不再下一个副本。
 *
 * 存的是**本地文件路径**，不是 webview 地址 —— asWebviewUri 的结果是跟面板绑的，
 * 拿 A 面板的地址去喂 B 面板的 video，运气好能用、运气不好被判成越权资源。
 * 让每个调用方各自换各自的地址。
 */
const inFlightFixes = new Map<string, Promise<string>>();

/**
 * 转码串行排队。
 *
 * 一次帖子可能有六七个视频（「分享一些小视频」那类），全并发会把带宽和
 * ffmpeg 进程数同时顶上去，反而谁都转不完。串行之后首个视频最快出声，
 * 后面的排队等 —— 结果有缓存，第二次打开全是秒切。
 */
let fixChain: Promise<unknown> = Promise.resolve();

function enqueueFix<T>(task: () => Promise<T>): Promise<T> {
	const next = fixChain.then(task, task);
	// 链条本身不吞错误：失败要能传到调用方，同时保证后续任务不被卡住
	fixChain = next.catch(() => undefined);
	return next;
}

/**
 * 把视频音轨换成 MP3 并重新封装，再把新地址发回页面。
 * 画面轨是 copy 过去的，耗时几乎全在下载上，所以进度就按下载百分比报。
 *
 * quiet = 自动修复发起的那次：不弹通知、不弹错误框，把进度和失败都画进页面里，
 * 免得打开一个帖子被几个弹窗糊脸。手动点按钮时 quiet 为 false，保留明确反馈。
 */
async function fixAudio(panel: vscode.WebviewPanel, url: string | undefined, quiet = false): Promise<void> {
	if (!url) {
		return;
	}

	const report = (payload: Record<string, unknown>): void => {
		void panel.webview.postMessage({ command: 'audioFixState', url, ...payload });
	};

	let job = inFlightFixes.get(url);
	if (job) {
		report({ state: 'busy' });
	} else {
		job = enqueueFix(async () => {
			const run = async (progress?: vscode.Progress<{ message?: string }>): Promise<string> => {
				const result = await ensureAudioFixed(url, ({ received, total }) => {
					const percent = total > 0 ? Math.round((received / total) * 100) : 0;
					const message = total > 0 ? `${percent}%` : `${(received / 1024 / 1024).toFixed(1)} MB`;
					progress?.report({ message });
					report({ state: 'working', percent: total > 0 ? percent : 0, message });
				});
				return result.file;
			};

			if (quiet) {
				return run();
			}
			return vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: '福利吧：正在把音轨换成 MP3…',
					cancellable: false,
				},
				(progress) => run(progress)
			);
		});
		inFlightFixes.set(url, job);
		report({ state: 'busy' });
	}

	try {
		const file = await job;
		const src = panel.webview.asWebviewUri(vscode.Uri.file(file)).toString();
		void panel.webview.postMessage({ command: 'audioFixed', url, src });
	} catch (err) {
		const needsFfmpeg = err instanceof FfmpegMissingError;
		void panel.webview.postMessage({
			command: 'audioFixFailed',
			url,
			needsFfmpeg,
			message: err instanceof Error ? err.message : '未知错误',
		});

		// 自动模式下失败是静默的（页面里已经写了原因）；只有用户主动点了按钮才值得打断他
		if (!quiet) {
			if (needsFfmpeg) {
				const pick = await vscode.window.showWarningMessage(
					'没找到 ffmpeg，无法重新封装音轨。装上并重启 VS Code 之后就好了。',
					'去看安装说明'
				);
				if (pick) {
					void vscode.env.openExternal(vscode.Uri.parse('https://ffmpeg.org/download.html'));
				}
			} else {
				void vscode.window.showErrorMessage(`修复声音失败：${err instanceof Error ? err.message : err}`);
			}
		}
	} finally {
		inFlightFixes.delete(url);
	}
}

/**
 * 打开（或激活已打开的）帖子详情面板。
 * 返回的 Promise 在「已读」记录写入后 resolve，调用方可以据此刷新树上的已读标记。
 */
export default async function openThread(tid: number, label = `帖子 ${tid}`): Promise<void> {
	const existing = panels.get(tid);
	if (existing) {
		existing.reveal();
		return;
	}

	const panel = createPanel(tid, label);

	panel.webview.onDidReceiveMessage(
		(message: {
			command: string;
			page?: number;
			url?: string;
			width?: number;
			height?: number;
			urls?: string[];
			quiet?: boolean;
		}) => {
			switch (message.command) {
				case 'pageTurning':
					void loadThread(panel, tid, Number(message.page) || 1);
					break;
				case 'refresh':
					void loadThread(panel, tid, Number(message.page) || 1);
					break;
				case 'playerSize':
					void savePlayerSize(panel, Number(message.width) || 0, Number(message.height) || 0);
					break;
				case 'fixAudio':
					void fixAudio(panel, message.url, message.quiet === true);
					break;
				case 'audioFixes':
					replyAudioFixes(panel, Array.isArray(message.urls) ? message.urls : []);
					break;
				case 'login':
					void vscode.commands.executeCommand('fuliba.setCookie');
					break;
				case 'openUrl':
					handleOpenUrl(message.url);
					break;
				case 'openInBrowser':
					void vscode.env.openExternal(
						vscode.Uri.parse(`${Global.getSiteUrl()}/thread-${tid}-${Number(message.page) || 1}-1.html`)
					);
					break;
				case 'copyLink':
					void vscode.env.clipboard.writeText(
						`${Global.getSiteUrl()}/thread-${tid}-${Number(message.page) || 1}-1.html`
					);
					void vscode.window.showInformationMessage('链接已复制');
					break;
				default:
					break;
			}
		}
	);

	// 先发起请求，写入已读记录与它并行，不额外拖慢首屏
	void loadThread(panel, tid, 1);
	await Global.addReadTid(tid);
}

/** 关闭全部帖子面板，扩展停用时调用 */
export function disposeAllPanels(): void {
	panels.forEach((panel) => panel.dispose());
	panels.clear();
}
