import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import Global from './global';
import { EMBED_HOSTS } from './discuz';

// art-template 4.x：默认导出传「文件路径」会自行读取并编译；
// template.render 则只接受模板字符串，传路径进去会把路径原样返回。
const template = require('art-template') as (filename: string, data?: Record<string, unknown>) => string;

/** 生成一次性 CSP nonce，避免在 webview 里放开 unsafe-inline */
export function createNonce(): string {
	return crypto.randomBytes(16).toString('base64');
}

/** webview 引用扩展内 html 目录的根地址 */
export function getContextPath(webview: vscode.Webview): string {
	return webview
		.asWebviewUri(vscode.Uri.file(path.join(Global.context!.extensionPath, 'html')))
		.toString();
}

/**
 * 扩展内任意文件的 webview 地址。
 * 记得把所在目录放进面板的 localResourceRoots，否则资源服务会挡掉。
 */
export function getResourceUri(webview: vscode.Webview, ...segments: string[]): string {
	return webview
		.asWebviewUri(vscode.Uri.file(path.join(Global.context!.extensionPath, ...segments)))
		.toString();
}

/** 用 art-template 渲染 html 目录下的模板 */
export function renderPage(
	webview: vscode.Webview,
	templateName: string,
	data: Record<string, unknown> = {}
): string {
	const templatePath = path.join(Global.context!.extensionPath, 'html', templateName);
	return template(templatePath, {
		nonce: createNonce(),
		cspSource: webview.cspSource,
		contextPath: getContextPath(webview),
		// CSP 的 frame-src 白名单与 discuz.ts 里嵌入播放器的判断共用一份，避免两处不同步
		embedHosts: EMBED_HOSTS.map((host) => `https://${host}`).join(' '),
		...data,
	});
}
