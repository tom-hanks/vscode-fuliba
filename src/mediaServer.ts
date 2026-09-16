/**
 * 本地媒体服务：把转好的音轨用**标准 HTTP** 送进 webview。
 *
 * 为什么不用 asWebviewUri：
 * 同一个文件、同一个目录、同一种 asWebviewUri，**调试面板里能播**，
 * **帖子面板里 401 / Format error** —— 实测三种投递方式全灭：
 * `resource` → `error code=4`、`resource-plus` → `error code=4`、
 * `blob` → `fetch HTTP 401`。而两个面板的 localResourceRoots 都放行了
 * globalStorage，所以不是授权范围的问题；VS Code 资源代理内部怎么判的，
 * 在扩展里既看不到也改不了。
 *
 * 跟它耗没有意义，换成自己起一个只绑 127.0.0.1 的 HTTP 服务：
 * Chromium 面对的只是一次最普通的媒体请求，Range、大文件、seek 全按标准走，
 * 不再有任何自定义协议参与。社区里同类扩展（yutabee.unmute-video）就是这么做的。
 *
 * 安全边界：
 *  - 只绑 127.0.0.1，不对外网暴露
 *  - 路径里带一段随机 token，挡掉本机其它进程的顺手访问
 *  - 只服务缓存目录下、文件名形如 `xxx.fixed.mp4` 的文件，不接受任何子路径
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { cacheDir } from './audioFix';

/** 每次启动重新生成，进程退出即失效 */
const TOKEN = crypto.randomBytes(12).toString('hex');

/** 只认缓存产物的文件名形态，杜绝路径穿越 */
const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.mp4$/;

let server: http.Server | undefined;
let baseUrl: string | undefined;
let starting: Promise<string | undefined> | undefined;

function finish(res: http.ServerResponse, status: number, headers?: http.OutgoingHttpHeaders): void {
	res.writeHead(status, headers);
	res.end();
}

function serveFile(req: http.IncomingMessage, res: http.ServerResponse, full: string, size: number): void {
	const range = req.headers.range;

	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Accept-Ranges', 'bytes');
	res.setHeader('Content-Type', 'video/mp4');
	// 产物是本地缓存、每次打开都可能变，别让中间层留副本
	res.setHeader('Cache-Control', 'no-store');

	if (!range) {
		res.setHeader('Content-Length', String(size));
		res.writeHead(200);
		if (req.method === 'HEAD') {
			res.end();
			return;
		}
		fs.createReadStream(full).pipe(res);
		return;
	}

	const match = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
	let start: number;
	let end: number;
	if (!match) {
		// 语法不认识的 Range 按整份处理，比 416 更宽容
		res.setHeader('Content-Length', String(size));
		res.writeHead(200);
		fs.createReadStream(full).pipe(res);
		return;
	}
	if (match[1] === '') {
		// `bytes=-N`：最后 N 字节
		const tail = Number.parseInt(match[2], 10);
		start = Math.max(0, size - tail);
		end = size - 1;
	} else {
		start = Number.parseInt(match[1], 10);
		end = match[2] === '' ? size - 1 : Number.parseInt(match[2], 10);
	}
	if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
		finish(res, 416, { 'Content-Range': `bytes */${size}` });
		return;
	}
	end = Math.min(end, size - 1);

	res.writeHead(206, {
		'Content-Range': `bytes ${start}-${end}/${size}`,
		'Content-Length': String(end - start + 1),
	});
	if (req.method === 'HEAD') {
		res.end();
		return;
	}
	fs.createReadStream(full, { start, end }).pipe(res);
}

function handle(req: http.IncomingMessage, res: http.ServerResponse, root: string): void {
	try {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			finish(res, 405);
			return;
		}

		let pathname = (req.url || '/').split('?')[0];
		try {
			pathname = decodeURIComponent(pathname);
		} catch {
			finish(res, 400);
			return;
		}

		const parts = pathname.split('/').filter((seg) => seg.length > 0);
		if (parts.length !== 2 || parts[0] !== TOKEN) {
			finish(res, 403);
			return;
		}
		const name = parts[1];
		if (!SAFE_NAME.test(name)) {
			finish(res, 403);
			return;
		}

		const full = path.join(root, name);
		// 双保险：SAFE_NAME 已经排除了分隔符，这里再确认一次没跳出目录
		if (path.dirname(path.resolve(full)) !== path.resolve(root)) {
			finish(res, 403);
			return;
		}

		let stat: fs.Stats;
		try {
			stat = fs.statSync(full);
		} catch {
			finish(res, 404);
			return;
		}
		if (!stat.isFile() || stat.size <= 0) {
			finish(res, 404);
			return;
		}

		serveFile(req, res, full, stat.size);
	} catch {
		if (!res.headersSent) {
			finish(res, 500);
		} else {
			res.end();
		}
	}
}

/**
 * 启动服务并返回基地址（形如 `http://127.0.0.1:51234/<token>`）。
 * 幂等：并发调用共享同一次启动。拿不到缓存目录时返回 undefined。
 */
export function ensureMediaServer(): Promise<string | undefined> {
	if (baseUrl) {
		return Promise.resolve(baseUrl);
	}
	if (starting) {
		return starting;
	}
	const root = cacheDir();
	if (!root) {
		return Promise.resolve(undefined);
	}

	starting = new Promise<string | undefined>((resolve) => {
		const srv = http.createServer((req, res) => handle(req, res, root));
		srv.on('error', () => {
			// 端口被占之类：不影响「打开帖子」这件事，页面会退化成原始地址
			starting = undefined;
			server = undefined;
			resolve(undefined);
		});
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			if (!addr || typeof addr === 'string') {
				srv.close();
				starting = undefined;
				resolve(undefined);
				return;
			}
			server = srv;
			baseUrl = `http://127.0.0.1:${addr.port}/${TOKEN}`;
			resolve(baseUrl);
		});
	});
	return starting;
}

/** 磁盘产物 → 可播放地址。服务没起来时返回 undefined，调用方自行降级 */
export function mediaUrlFor(file: string): string | undefined {
	if (!baseUrl) {
		return undefined;
	}
	const name = path.basename(file);
	if (!SAFE_NAME.test(name)) {
		return undefined;
	}
	return `${baseUrl}/${encodeURIComponent(name)}`;
}

/** 扩展停用时收摊 */
export function disposeMediaServer(): void {
	server?.close();
	server = undefined;
	baseUrl = undefined;
	starting = undefined;
}
