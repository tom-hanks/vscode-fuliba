import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import Global from './global';

/**
 * 音轨重封装。
 *
 * 为什么需要这一层：论坛直传的视频（含 B 站）音轨基本都是 **AAC**，而 VS Code 的
 * webview 跑在 Electron 自带的 Chromium 上，那份构建不含 AAC 解码器 ——
 * 画面（H.264，走 macOS 的 VideoToolbox 平台解码器）照放，音轨解不出来。
 * 于是「有画面没声音」，而且媒体控件里的音量键会显示成灰的、点不动
 * （Chromium 的控件在拿不到可播放音轨时不给音量键接事件）。
 *
 * 实测证据（VS Code 1.137.0 / Electron 42.10.0 / Chromium 148，隔离实例里跑）：
 *   AudioContext.decodeAudioData(AAC mp4) → EncodingError: Unable to decode audio data
 *   AudioContext.decodeAudioData(MP3)     → 正常，RMS 0.27（确实有内容）
 *   媒体元素静音起播 800ms 再取消静音，看解码字节：
 *     原始 AAC  → 静音期 0 字节，取消静音后 0 字节，播放卡住
 *     MP3 音轨  → 静音期 17136 字节，取消静音后 +38870 字节，正常推进
 *   同一窗口里 FLAC 能解出 105123 字节，说明不是测法问题，就是 AAC 解不了。
 *
 * 解法：把音轨转成 MP3、**画面轨直接 copy** 重新封装成一个 mp4。
 * 「mp4 里塞 mp3 音轨」这条：
 *   - 渐进式 <video src> 走 ffmpeg demuxer，支持 → 实测能播（上表）
 *   - MSE 那条路不支持（isTypeSupported 返回 false），但我们不用 MSE
 * 不选 Opus/FLAC-in-MP4：源码上 MP4StreamParser 认它们，实测却没解出音频，不冒险。
 *
 * 副作用是好的：换完之后音轨能解，媒体控件的音量键也活了。
 * 依赖系统 ffmpeg，找不到时由上层给出安装提示（见 findFfmpeg）。
 */

export class FfmpegMissingError extends Error {
	constructor() {
		super('没有找到 ffmpeg，无法重新封装音轨');
		this.name = 'FfmpegMissingError';
	}
}

const UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * ffmpeg 的常见落点。
 * 从 Dock / Spotlight 启动的 VS Code 拿到的是精简 PATH（通常只有 /usr/bin:/bin:/usr/sbin:/sbin），
 * 直接 `which ffmpeg` 会扑空 —— 所以 Homebrew 那两个路径必须写死试一遍。
 */
const COMMON_FFMPEG = [
	'/opt/homebrew/bin/ffmpeg',
	'/usr/local/bin/ffmpeg',
	'/usr/bin/ffmpeg',
	'/snap/bin/ffmpeg',
	'/opt/local/bin/ffmpeg',
	'C:\\ffmpeg\\bin\\ffmpeg.exe',
];

/** undefined = 还没探测过，null = 探过但没有 */
let cachedFfmpeg: string | null | undefined;

function executable(target: string): boolean {
	try {
		fs.accessSync(target, fs.constants.X_OK);
		return fs.statSync(target).isFile();
	} catch {
		return false;
	}
}

/** 在 PATH 里按顺序找 */
function scanPath(): string | undefined {
	const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
	for (const dir of (process.env.PATH || '').split(path.delimiter)) {
		if (!dir) {
			continue;
		}
		const full = path.join(dir, exe);
		if (executable(full)) {
			return full;
		}
	}
	return undefined;
}

/**
 * 找 ffmpeg：设置项 > 常见路径 > PATH。
 * 同步返回，解析正文时就要用它决定要不要给「修复声音」的按钮。
 */
export function findFfmpeg(force = false): string | undefined {
	if (!force && cachedFfmpeg !== undefined) {
		return cachedFfmpeg ?? undefined;
	}

	let configured: string | undefined;
	try {
		configured = vscode.workspace.getConfiguration('fuliba').get<string>('ffmpegPath');
	} catch {
		configured = undefined;
	}
	if (configured && executable(configured)) {
		cachedFfmpeg = configured;
		return configured;
	}

	for (const candidate of COMMON_FFMPEG) {
		if (executable(candidate)) {
			cachedFfmpeg = candidate;
			return candidate;
		}
	}

	const fromPath = scanPath();
	cachedFfmpeg = fromPath ?? null;
	return fromPath;
}

/** 设置里改了路径、或上次跑失败时，丢掉缓存重新探 */
export function clearFfmpegCache(): void {
	cachedFfmpeg = undefined;
}

/**
 * 这个地址值不值得走「换音轨」这条路。
 * 只认 mp4 家族：webm 里的 Vorbis / Opus 本来就解得动，而 webm 的视频轨也塞不进 mp4。
 */
export function isFixableVideo(url: string): boolean {
	if (!/^https?:\/\//i.test(url)) {
		return false;
	}
	let pathname = url.split('?')[0];
	try {
		pathname = new URL(url).pathname;
	} catch {
		/* 解析不了就用去掉查询串的原串 */
	}
	return /\.(mp4|m4v|mov)$/i.test(pathname);
}

/**
 * 缓存目录：扩展的 globalStorage 下单独一层，卸载扩展时一起清掉。
 * 本地媒体服务要按同一个目录提供文件，所以导出。
 */
export function cacheDir(): string | undefined {
	const root = Global.context?.globalStorageUri?.fsPath;
	if (!root) {
		return undefined;
	}
	const dir = path.join(root, 'audio-fix');
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch {
		return undefined;
	}
	return dir;
}

/**
 * 缓存文件名。
 *
 * 不能用完整地址：论坛的视频直链带 md5 / expires 签名，每次打开都不一样，
 * 拿它当 key 等于每次都重新转一遍。去掉查询串之后文件名本身是稳定的
 * （形如 104549_1789440105_piWIBNFM.mp4），再叠一段短哈希防重名。
 */
function cacheKey(url: string): string {
	const base = url.split('?')[0].split('#')[0];
	const name = base.substring(base.lastIndexOf('/') + 1) || 'video.mp4';
	const safe = name.replace(/[^\w.-]/g, '_').slice(-60);
	const hash = crypto.createHash('sha1').update(base).digest('hex').slice(0, 8);
	return `${hash}-${safe}`;
}

/** 已经转好过就直接返回产物路径，省一次下载 + 转码 */
export function cachedFixPath(url: string): string | undefined {
	const dir = cacheDir();
	if (!dir) {
		return undefined;
	}
	const file = path.join(dir, `${cacheKey(url)}.fixed.mp4`);
	try {
		if (fs.statSync(file).size > 1024) {
			return file;
		}
	} catch {
		/* 没转过 */
	}
	return undefined;
}

/** 跑一次 -version，确认这个路径真能执行（设置里手填了个死链时在这里暴露） */
function verifyFfmpeg(bin: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, ['-version'], { windowsHide: true });
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`${bin} 执行超时`));
		}, 5000);
		let out = '';
		child.stdout?.on('data', (chunk) => {
			out += String(chunk);
		});
		child.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			if (code === 0 && /ffmpeg version/i.test(out)) {
				resolve();
			} else {
				reject(new Error(`${bin} 不是可用的 ffmpeg`));
			}
		});
	});
}

function runFfmpeg(bin: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { windowsHide: true });
		let stderr = '';
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error('ffmpeg 转码超时'));
		}, 120000);

		child.stderr?.on('data', (chunk) => {
			stderr += String(chunk);
			if (stderr.length > 8000) {
				stderr = stderr.slice(-8000);
			}
		});
		child.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve();
				return;
			}
			const tail = stderr.trim().split('\n').slice(-3).join(' / ');
			reject(new Error(`ffmpeg 退出码 ${code}${tail ? `：${tail}` : ''}`));
		});
	});
}

export interface DownloadProgress {
	received: number;
	/** 服务端没给 Content-Length 时为 0 */
	total: number;
}

/**
 * 把视频下到本地。
 * 不复用 http.ts 的 getBinary：那个是给图片用的，会在内存里攒整份、还带 20 秒超时和
 * 论坛限速；视频动辄几十兆，必须流式落盘、超时也得放宽。
 */
function download(url: string, dest: string, onProgress?: (p: DownloadProgress) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const follow = (target: string, redirects: number): void => {
			let parsed: URL;
			try {
				parsed = new URL(target);
			} catch {
				reject(new Error(`视频地址无法解析：${target.slice(0, 80)}`));
				return;
			}
			const mod = parsed.protocol === 'http:' ? http : https;
			const request = mod.get(
				{
					hostname: parsed.hostname,
					port: parsed.port,
					path: `${parsed.pathname}${parsed.search}`,
					headers: {
						'User-Agent': UA,
						Accept: '*/*',
						// 论坛的附件 CDN 会校验来源页
						Referer: `${Global.getSiteUrl()}/`,
					},
					timeout: 60000,
				},
				(response) => {
					const status = response.statusCode ?? 0;
					const location = response.headers.location;
					if (status >= 300 && status < 400 && location && redirects < 5) {
						response.resume();
						follow(new URL(location, target).toString(), redirects + 1);
						return;
					}
					if (status >= 400) {
						response.resume();
						reject(new Error(`视频下载失败：HTTP ${status}`));
						return;
					}

					const total = Number(response.headers['content-length'] || 0);
					let received = 0;
					const out = fs.createWriteStream(dest);
					response.on('data', (chunk: Buffer) => {
						received += chunk.length;
						onProgress?.({ received, total });
					});
					response.on('error', reject);
					out.on('error', reject);
					out.on('finish', () => out.close(() => resolve()));
					response.pipe(out);
				}
			);
			request.on('timeout', () => request.destroy(new Error('视频下载超时')));
			request.on('error', reject);
		};

		follow(url, 0);
	});
}

export interface AudioFixResult {
	/** 转好的 mp4 在本地的绝对路径 */
	file: string;
	/** true = 命中了上次的产物，没有重新下载转码 */
	cached: boolean;
}

/**
 * 把视频的音轨换成 MP3 并重新封装。
 * 画面轨 `-c:v copy` 直接搬运，所以耗的是下载时间，不是编码时间。
 * 结果按地址缓存，同一个视频只会转一次。
 */
export async function ensureAudioFixed(
	url: string,
	onProgress?: (progress: DownloadProgress) => void
): Promise<AudioFixResult> {
	const hit = cachedFixPath(url);
	if (hit) {
		return { file: hit, cached: true };
	}

	const bin = findFfmpeg(true);
	if (!bin) {
		throw new FfmpegMissingError();
	}
	await verifyFfmpeg(bin);

	const dir = cacheDir();
	if (!dir) {
		throw new Error('扩展存储目录不可用');
	}

	const key = cacheKey(url);
	const rawPath = path.join(dir, `${key}.download`);
	const outPath = path.join(dir, `${key}.fixed.mp4`);

	try {
		await download(url, rawPath, onProgress);
		await runFfmpeg(bin, [
			'-hide_banner',
			'-loglevel',
			'error',
			'-y',
			'-i',
			rawPath,
			'-map',
			'0:v:0?',
			'-map',
			'0:a:0?',
			// 画面不重编码：既不损画质，也把耗时压到几乎只有下载
			'-c:v',
			'copy',
			'-c:a',
			'libmp3lame',
			'-b:a',
			'128k',
			// 让 moov 放到文件头，边下边播时不用等整份
			'-movflags',
			'+faststart',
			outPath,
		]);

		if (fs.statSync(outPath).size < 1024) {
			throw new Error('ffmpeg 没有产出有效文件');
		}
	} finally {
		try {
			fs.unlinkSync(rawPath);
		} catch {
			/* 删不掉就留着，下次覆盖 */
		}
	}

	return { file: outPath, cached: false };
}
