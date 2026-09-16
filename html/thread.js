(function () {
	const vscode = acquireVsCodeApi();
	const pageNow = Number(document.body.dataset.page || 1);

	// 工具栏 / 翻页按钮
	document.querySelectorAll('button[data-command]').forEach(function (btn) {
		btn.addEventListener('click', function () {
			vscode.postMessage({ command: btn.dataset.command, page: pageNow });
		});
	});

	document.querySelectorAll('button[data-page]').forEach(function (btn) {
		btn.addEventListener('click', function () {
			const page = Number(btn.dataset.page);
			if (page >= 1) {
				vscode.postMessage({ command: 'pageTurning', page: page });
			}
		});
	});

	/* ---------------- 图片：默认占位，悬停预览，点击展开 ---------------- */

	// 悬停多久才弹预览。太短会在扫读时闪一堆图，太长又像没反应。
	const PREVIEW_DELAY = 180;

	// 浮层全局只有一个，挂在 body 上。CSS 里给了 pointer-events:none —— 否则鼠标
	// 移到浮层上就算离开了占位块，浮层消失、鼠标又落回占位块，来回闪。
	const preview = document.createElement('div');
	preview.id = 'img-preview';
	preview.hidden = true;
	document.body.appendChild(preview);

	let previewTimer = null;
	let previewSlot = null;

	function closePreview() {
		clearTimeout(previewTimer);
		previewTimer = null;
		previewSlot = null;
		preview.hidden = true;
		preview.textContent = '';
	}

	/** 摆在占位块下方；下方放不下就翻到上方，右边越界就往左靠 */
	function placePreview(slot) {
		const GAP = 8;
		const anchor = slot.getBoundingClientRect();
		// getBoundingClientRect 会强制同步布局，即使浮层刚显示也能量到真实尺寸
		const box = preview.getBoundingClientRect();

		let top = anchor.bottom + GAP;
		if (top + box.height > window.innerHeight - GAP) {
			top = anchor.top - GAP - box.height;
		}
		let left = anchor.left;
		if (left + box.width > window.innerWidth - GAP) {
			left = window.innerWidth - GAP - box.width;
		}

		preview.style.top = Math.max(GAP, top) + 'px';
		preview.style.left = Math.max(GAP, left) + 'px';
	}

	function openPreview(slot) {
		const src = slot.dataset.src;
		if (!src) {
			return;
		}

		// 先把浮层亮出来，大图加载期间也有个反馈，不至于悬停了半天没动静
		preview.textContent = '加载中…';
		preview.hidden = false;
		placePreview(slot);

		const img = document.createElement('img');
		// 不带 Referer，绕过论坛图片防盗链
		img.referrerPolicy = 'no-referrer';
		img.addEventListener('load', function () {
			// 加载完时鼠标可能已经移开了
			if (previewSlot !== slot) {
				return;
			}
			preview.textContent = '';
			preview.appendChild(img);
			placePreview(slot); // 换成真图后尺寸变了，重新摆一次
		});
		img.addEventListener('error', function () {
			if (previewSlot === slot) {
				closePreview();
			}
		});
		img.src = src;
	}

	/** 点占位块 → 就地换成真图 */
	function expandImage(slot) {
		const src = slot.dataset.src;
		if (!src) {
			return;
		}
		closePreview();
		const img = document.createElement('img');
		img.src = src;
		img.alt = '';
		img.referrerPolicy = 'no-referrer';
		slot.replaceWith(img);
	}

	document.querySelectorAll('.img-slot').forEach(function (slot) {
		slot.addEventListener('mouseenter', function () {
			closePreview();
			previewSlot = slot;
			previewTimer = setTimeout(function () {
				// 计时器跑完时鼠标可能已经移走了
				if (previewSlot === slot) {
					openPreview(slot);
				}
			}, PREVIEW_DELAY);
		});

		slot.addEventListener('mouseleave', function () {
			if (previewSlot === slot) {
				closePreview();
			}
		});
	});

	// 一滚动浮层就和占位块错位了，直接收掉
	window.addEventListener('scroll', closePreview, true);
	window.addEventListener('resize', closePreview);

	/* ---------------- 播放器：拖右上角改尺寸，改一次全站通用 ---------------- */

	// 拖动的上下限。比这更小就只剩个黑框，更大则一屏塞不下。
	const SIZE_MIN = { w: 200, h: 120 };
	const SIZE_MAX = { w: 1600, h: 1200 };

	function clamp(value, min, max) {
		return Math.min(max, Math.max(min, Math.round(value)));
	}

	/** 尺寸只落在 :root 的两个变量上，页面上所有 .media-stage 都读它，所以一次拖动全体生效 */
	function applySize(w, h) {
		document.documentElement.style.setProperty('--media-w', w + 'px');
		document.documentElement.style.setProperty('--media-h', h + 'px');
	}

	// 拖动过程中每一帧都写配置会很浪费，松手后延迟一下再落盘
	let saveTimer = null;
	function scheduleSave(w, h) {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(function () {
			vscode.postMessage({ command: 'playerSize', width: w, height: h });
		}, 400);
	}

	document.querySelectorAll('.media-grip').forEach(function (grip) {
		grip.addEventListener('pointerdown', function (event) {
			event.preventDefault();
			event.stopPropagation();

			const stage = grip.closest('.media-stage');
			if (!stage) {
				return;
			}

			const box = stage.getBoundingClientRect();
			const startX = event.clientX;
			const startY = event.clientY;
			const startW = box.width;
			const startH = box.height;
			let latest = null;

			// 抓住指针，鼠标划过 iframe 也不会把事件弄丢；CSS 里再补一刀 pointer-events:none。
			// 合成事件（比如自动化测试里派发的）没有真实指针，抓取会抛错，不能让它打断拖动。
			try {
				if (grip.setPointerCapture) {
					grip.setPointerCapture(event.pointerId);
				}
			} catch (err) {
				/* 抓不到就算了，后面还有 pointer-events:none 兜着 */
			}
			document.body.classList.add('resizing');

			function onMove(moveEvent) {
				// 拖动块在右上角：往右加宽、往上加高
				latest = {
					w: clamp(startW + (moveEvent.clientX - startX), SIZE_MIN.w, SIZE_MAX.w),
					h: clamp(startH - (moveEvent.clientY - startY), SIZE_MIN.h, SIZE_MAX.h),
				};
				applySize(latest.w, latest.h);
			}

			let done = false;
			function onEnd() {
				if (done) {
					return;
				}
				done = true;
				grip.removeEventListener('pointermove', onMove);
				grip.removeEventListener('pointerup', onEnd);
				grip.removeEventListener('pointercancel', onEnd);
				window.removeEventListener('pointerup', onEnd, true);
				window.removeEventListener('pointercancel', onEnd, true);
				window.removeEventListener('blur', onEnd);
				document.body.classList.remove('resizing');
				if (latest) {
					scheduleSave(latest.w, latest.h);
				}
			}

			grip.addEventListener('pointermove', onMove);
			grip.addEventListener('pointerup', onEnd);
			grip.addEventListener('pointercancel', onEnd);
			/*
			 * 兜底收尾。`resizing` 期间 CSS 会把播放器的指针事件全部关掉
			 * （拖动时鼠标划过 video/iframe，事件会被跨域文档吃掉，拖动会断），
			 * 而摘掉这个 class 原本只挂在 grip 自己的 pointerup 上 —— 一旦那次抬起
			 * 没落在 grip 上（指针滑出面板后在别处松开、被系统抢走、窗口失焦），
			 * class 就永久留在 body 上：**之后整页播放器都点不动，连播放键都按不了**，
			 * 只能刷新页面。所以 window 上也挂一份，并加失焦兜底。
			 */
			window.addEventListener('pointerup', onEnd, true);
			window.addEventListener('pointercancel', onEnd, true);
			window.addEventListener('blur', onEnd);
		});
	});

	/* ---------------- 播放器：AAC 音轨换成 MP3，把声音救回来 ---------------- */

	/*
	 * VS Code 的 webview 跑在 Electron 自带的 Chromium 上，那份构建不含 AAC 解码器，
	 * 论坛直传的 mp4 因此全是「有画面没声音、音量键灰着点不动」。
	 * 扩展那边用 ffmpeg 把音轨换成 MP3 再封装回 mp4（画面轨直接 copy，不重编码），
	 * 页面这里只负责发起请求、换源，并把那条说明改成结果。
	 */

	/**
	 * 同一个视频可能被贴在多个楼层，所以这里是**一批**而不是一个。
	 * 只修第一个的话，用户如果正在看后面那层，就会以为「修了没用」。
	 */
	function figuresBySrc(src) {
		const figures = document.querySelectorAll('figure.media-embed[data-media-src]');
		const out = [];
		for (let i = 0; i < figures.length; i++) {
			if (figures[i].dataset.mediaSrc === src) {
				out.push(figures[i]);
			}
		}
		return out;
	}

	function figureBySrc(src) {
		const all = figuresBySrc(src);
		return all.length ? all[0] : null;
	}

	/** 把按钮切到「转码中」，并支持重复调用（缓存命中时不会再走这里） */
	function markBusy(figure) {
		if (!figure) {
			return;
		}
		const link = figure.querySelector('.fix-audio');
		if (link) {
			link.classList.add('is-busy');
			link.textContent = '转码中…';
		}
	}

	/** 进度写在按钮后面那一小块里，不占额外高度 */
	function markProgress(figure, text) {
		if (!figure) {
			return;
		}
		const state = figure.querySelector('.fix-state');
		if (state) {
			state.textContent = text;
		}
	}

	/** 修好了：收掉警告文案，改成正向反馈，并保留原视频的出口 */
	function markDone(figure) {
		const note = figure.querySelector('.media-note');
		if (!note) {
			return;
		}
		const original = note.querySelector('a[target="_blank"]');
		const href = original ? original.getAttribute('href') : '';
		note.classList.add('media-note-ok');
		note.textContent = '音轨已换成 MP3，画面未重编码 —— 声音和音量键都正常。';
		if (href) {
			const link = document.createElement('a');
			link.href = href;
			link.target = '_blank';
			link.textContent = '看原视频';
			note.appendChild(link);
		}
	}

	// 页面侧记一份「已经要过的地址」。
	// 不能靠按钮上的 is-busy 来防重复点击 —— 排队期间按钮也会被锁上，
	// 一旦失败解锁、用户再点，就会往队列里塞重复任务。
	const requested = new Set();

	function requestAudioFix(src, quiet) {
		if (requested.has(src)) {
			return;
		}
		requested.add(src);
		markBusy(figureBySrc(src));
		vscode.postMessage({ command: 'fixAudio', url: src, quiet: !!quiet });
	}

	/** 等元素把新源读进来（loadedmetadata），或者报错 / 超时 */
	function waitForSource(video, timeoutMs) {
		return new Promise(function (resolve) {
			let settled = false;
			function finish(state) {
				if (settled) {
					return;
				}
				settled = true;
				video.removeEventListener('loadedmetadata', onReady);
				video.removeEventListener('error', onError);
				clearTimeout(timer);
				resolve(state);
			}
			function onReady() {
				finish('ok');
			}
			function onError() {
				finish('error');
			}
			const timer = setTimeout(function () {
				finish('timeout');
			}, timeoutMs);
			video.addEventListener('loadedmetadata', onReady);
			video.addEventListener('error', onError);
		});
	}

	function loadSource(video, src, timeoutMs) {
		video.removeAttribute('src');
		video.src = src;
		video.load();
		return waitForSource(video, timeoutMs);
	}

	/**
	 * 逐个投递方式试过去，返回第一个真能播成的。
	 *
	 * 地址现在是扩展自己起的本地 HTTP 服务（`http://127.0.0.1:<port>/<token>/…`），
	 * 不再走 VS Code 的 webview 资源代理 —— 那条路在这个面板里会被拒：
	 * `resource` 与 `resource-plus` 都是 `error code=4`，`blob` 那条 `fetch HTTP 401`。
	 * 同一个文件在调试面板里却能播，机制在扩展侧既看不到也改不了，索性整个绕开。
	 *
	 * 留一条 blob 兜底：万一本机 HTTP 被拦（防火墙、安全策略），
	 * fetch 下来直接喂元素还能救回来。
	 */

	// 第一次探出哪种投递能用之后，后面的视频直接用那一种，不再逐个试一遍
	let preferredDelivery = null;

	async function tryCandidate(video, item) {
		if (item.name !== 'blob') {
			return await loadSource(video, item.src, 2500);
		}
		const res = await fetch(item.next, { cache: 'no-store' });
		if (!res.ok) {
			return { state: 'fetch-http-' + res.status, detail: 'fetch HTTP ' + res.status };
		}
		const buf = await res.arrayBuffer();
		const objectUrl = URL.createObjectURL(new Blob([buf], { type: 'video/mp4' }));
		const state = await loadSource(video, objectUrl, 4000);
		return { state: state, detail: buf.byteLength + ' 字节 / ' + state };
	}

	async function deliverSource(video, nextSrc) {
		const attempts = [];
		function record(name, ok, detail) {
			attempts.push({ name: name, ok: ok, detail: detail || '' });
		}

		const all = [{ name: 'http', src: nextSrc }, { name: 'blob', next: nextSrc }];
		// 已知可行的排到最前；其余保持原顺序
		const order = preferredDelivery
			? all
					.filter(function (item) {
						return item.name === preferredDelivery;
					})
					.concat(
						all.filter(function (item) {
							return item.name !== preferredDelivery;
						})
					)
			: all;

		for (let i = 0; i < order.length; i++) {
			const item = order[i];
			if (item.name !== 'blob' && (!item.src || (i > 0 && item.src === order[i - 1].src))) {
				continue;
			}
			let outcome;
			try {
				outcome = await tryCandidate(video, item);
			} catch (err) {
				record(item.name, false, (err && err.name) + ': ' + (err && err.message));
				continue;
			}
			const state = typeof outcome === 'string' ? outcome : outcome.state;
			const detail = (typeof outcome === 'string' ? state : outcome.detail) || state;
			record(item.name, state === 'ok', detail + (video.error ? ' code=' + video.error.code : ''));
			if (state === 'ok') {
				preferredDelivery = item.name;
				return { winner: item.name, attempts: attempts };
			}
		}

		return { winner: null, attempts: attempts };
	}

	/**
	 * 换源。要接住播放位置：视频元素一旦改 src 就会回到 0，
	 * 用户看到一半的视频被拉回开头，比没声音更烦。
	 */
	async function applyAudioFix(url, nextSrc) {
		const figures = figuresBySrc(url);
		if (!figures.length) {
			diagPush('fix-arrived-but-no-figure', { url: url, nextSrc: nextSrc });
			reportDiag('fix-no-figure');
			return;
		}

		for (let i = 0; i < figures.length; i++) {
			const figure = figures[i];
			const video = figure.querySelector('video');
			if (!video) {
				markDone(figure);
				continue;
			}

			const at = video.currentTime;
			const wasPlaying = !video.paused && !video.ended;
			const original = figure.dataset.mediaSrc || url;

			/*
			 * 音轨换成 MP3 之后必须显式解除静音。
			 *
			 * 论坛模板里 `<video muted>` 很常见（绕自动播放拦截的写法），而 `muted`
			 * 是属性级的：它写进 defaultMuted，光换 src 不会让它失效。表现就是
			 * 「画面正常、换了音轨还是没声音」，而且完全看不出哪一步错了。
			 * 音量 0 同理 —— 只要用户想听声音，这里就该是可听的默认值。
			 */
			video.muted = false;
			video.defaultMuted = false;
			video.removeAttribute('muted');
			if (!video.volume) {
				video.volume = 1;
			}

			const outcome = await deliverSource(video, nextSrc);

			if (!outcome.winner) {
				// 三种都没成：把原始地址放回去，至少画面还在，并把原因写在说明里
				video.src = original;
				video.load();
				markFixFailed(figure, outcome.attempts);
				continue;
			}

			if (at > 0.1) {
				try {
					video.currentTime = Math.min(at, video.duration || at);
				} catch (e) {
					/* duration 没就绪就算了，从 0 开始不影响听声音 */
				}
			}
			if (wasPlaying) {
				const played = video.play();
				if (played && played.catch) {
					played.catch(function () {});
				}
			}
			markDone(figure);
		}

		reportDiag('after-fix');
		// 等新音源起来再探一次，这样同一支视频能拿到「换源前 / 换源后」两组字节数
		setTimeout(function () {
			void probeDecode();
		}, 1500);
	}

	/** 三种投递都没成：保留出口，并把每种报的错摆出来 */
	function markFixFailed(figure, attempts) {
		const note = figure.querySelector('.media-note');
		if (!note) {
			return;
		}
		const original = note.querySelector('a[target="_blank"]');
		const href = original ? original.getAttribute('href') : '';
		const detail = attempts
			.map(function (item) {
				return item.name + '=' + (item.ok ? 'ok' : item.detail);
			})
			.join(' / ');
		note.textContent = '音轨已备好，但这个地址编辑器读不出来（' + detail + '）。';
		if (href) {
			const link = document.createElement('a');
			link.href = href;
			link.target = '_blank';
			link.textContent = '看原视频';
			note.appendChild(link);
		}
	}

	function showAudioFixError(url, message, needsFfmpeg) {
		const figure = figureBySrc(url);
		if (!figure) {
			return;
		}
		// 从「已要过」里抹掉，让用户能手动重试
		requested.delete(url);
		const link = figure.querySelector('.fix-audio');
		if (link) {
			// 手动点的那次要让按钮能再点一次；自动模式失败也留着，用户想重试还有路
			link.classList.remove('is-busy');
			link.textContent = '换 MP3 音轨（修声音）';
		}
		markProgress(figure, needsFfmpeg ? '本机没装 ffmpeg' : '失败：' + message);
	}

	// 自动修复只发一轮，别被重复的 audioFixes 消息触发第二遍
	let autoRequested = false;

	// 打开页面就问一次：哪些视频上次已经转好了。命中的直接换源，不用再转。
	(function () {
		const srcs = [];
		document.querySelectorAll('figure.media-embed[data-media-src]').forEach(function (figure) {
			if (figure.dataset.mediaSrc) {
				srcs.push(figure.dataset.mediaSrc);
			}
		});
		if (srcs.length) {
			vscode.postMessage({ command: 'audioFixes', urls: srcs });
		}
	})();

	/**
	 * 缓存没覆盖到、又确实可修的（图里有「换 MP3 音轨」按钮 = 本机能修），
	 * 开着自动修复就自己排上队 —— 默认就该有声，不该指望用户先点一下。
	 * 转码是扩展那边串行做的，这里只管把请求都发出去。
	 */
	function autoFixRest(fixed) {
		if (autoRequested) {
			return;
		}
		autoRequested = true;
		document.querySelectorAll('figure.media-embed[data-media-src]').forEach(function (figure) {
			const src = figure.dataset.mediaSrc;
			if (!src || fixed[src] || !figure.querySelector('.fix-audio')) {
				return;
			}
			requestAudioFix(src, true);
		});
	}

	/* ---------- 支持楼主 ---------- */

	/*
	 * 论坛的「支持楼主」（第三方插件 she_btps，底层是 Discuz 原生评分）。
	 *
	 * 页面只负责发消息、显示结果 —— 提交必须由扩展侧带 Cookie 发：
	 * webview 里没有登录态，CSP 也不允许直接请求论坛。
	 * 要提交的字段（formhash / 评分项 / 理由）由模板注入到 window.__fulibaSupport，
	 * 点一次就原样回传一次，页面自己不拼也不改。
	 */
	const supportBox = document.getElementById('thread-support');
	const supportButton = document.getElementById('support-btn');
	const supportHint = document.getElementById('support-hint');
	const supportCountEl = document.getElementById('support-count');

	function setSupportCount(next) {
		if (typeof next !== 'number' || isNaN(next)) {
			return;
		}
		if (supportCountEl) {
			supportCountEl.textContent = next + ' 人支持';
		}
		const meter = supportBox && supportBox.querySelector('.support-meter');
		if (meter) {
			meter.style.setProperty('--count', String(next));
		}
	}

	/** state：done 表示成功/已支持，retry 表示可以再点一次 */
	function settleSupport(state, text) {
		if (!supportBox) {
			return;
		}
		supportBox.classList.remove('is-busy');
		if (supportButton) {
			supportButton.disabled = state !== 'retry';
		}
		if (supportHint) {
			supportHint.textContent = text || '';
			supportHint.classList.toggle('is-error', state === 'retry');
		}
	}

	if (supportButton) {
		supportButton.addEventListener('click', function () {
			if (supportButton.disabled) {
				return;
			}
			supportButton.disabled = true;
			supportBox.classList.add('is-busy');
			if (supportHint) {
				supportHint.textContent = '正在提交…';
				supportHint.classList.remove('is-error');
			}
			vscode.postMessage({
				command: 'supportThread',
				support: window.__fulibaSupport || null,
			});
		});
	}

	// 别的帖子面板拖动播放器 / 修好音轨后，扩展会把消息广播过来
	window.addEventListener('message', function (event) {
		const msg = event.data;
		if (!msg) {
			return;
		}
		if (msg.command === 'playerSize') {
			applySize(Number(msg.width) || 0, Number(msg.height) || 0);
			return;
		}
		if (msg.command === 'threadSupportResult') {
			if (!supportBox) {
				return;
			}
			if (msg.ok) {
				setSupportCount(msg.count);
				supportBox.classList.add('is-done');
				settleSupport('done', msg.message || '支持成功');
			} else if (msg.alreadyDone) {
				// 「已经支持过」不是错误而是一种状态，照已支持显示即可
				supportBox.classList.add('is-done');
				settleSupport('done', msg.message);
			} else {
				settleSupport('retry', msg.message);
			}
			return;
		}
		if (msg.command === 'audioFixState') {
			const figure = figureBySrc(msg.url);
			if (figure) {
				markBusy(figure);
				// 按钮上已经写着「转码中…」，这里只补数字，别再重复一遍
				markProgress(figure, msg.state === 'working' ? msg.message || '' : '');
			}
			return;
		}
		if (msg.command === 'audioFixed') {
			void applyAudioFix(msg.url, msg.src);
			return;
		}
		if (msg.command === 'audioFixFailed') {
			showAudioFixError(msg.url, msg.message, msg.needsFfmpeg);
			return;
		}
		if (msg.command === 'audioFixes' && msg.map) {
			Object.keys(msg.map).forEach(function (url) {
				void applyAudioFix(url, msg.map[url]);
			});
			if (msg.auto !== false) {
				autoFixRest(msg.map);
			}
		}
	});

	/*
	 * 点击按优先级分流，写在同一个监听器里而不是各挂一个：
	 * 各挂一个的话，点在「包着链接的图片」上会同时触发图片和外链两个分支。
	 */
	document.addEventListener('click', function (event) {
		// 0. 「换 MP3 音轨」要抢在下面的外链分支之前，否则 href="#" 会被当成普通链接丢给浏览器
		const fixLink = event.target.closest('.fix-audio');
		if (fixLink) {
			event.preventDefault();
			const src = fixLink.dataset.src;
			// 去重交给 requestAudioFix：已经在转的不再发第二次
			if (src) {
				requestAudioFix(src, false);
			}
			return;
		}

		// 1. 占位块 → 展开成真图
		const slot = event.target.closest('.img-slot');
		if (slot) {
			event.preventDefault();
			expandImage(slot);
			return;
		}

		// 2. 已展开的图 → 全屏放大，再点还原
		const img = event.target.closest('.post-content img');
		if (img) {
			event.preventDefault();
			img.classList.toggle('zoomed');
			return;
		}

		// 3. 正文外链交给系统浏览器，避免在 webview 里被拦
		const link = event.target.closest('.post-content a[href]');
		if (link) {
			event.preventDefault();
			vscode.postMessage({ command: 'openUrl', url: link.getAttribute('href') });
		}
	});
})();
