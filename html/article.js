(function () {
	const vscode = acquireVsCodeApi();

	/* ---------------- 工具栏与翻页 ---------------- */

	document.querySelectorAll('button[data-command]').forEach(function (btn) {
		btn.addEventListener('click', function () {
			vscode.postMessage({ command: btn.dataset.command });
		});
	});

	document.querySelectorAll('button.pg-art[data-page]').forEach(function (btn) {
		btn.addEventListener('click', function () {
			if (btn.disabled) {
				return;
			}
			const page = Number(btn.dataset.page);
			if (page >= 1) {
				vscode.postMessage({ command: 'articlePage', page: page });
			}
		});
	});

	/* ---------------- 正文图片：悬停预览 ---------------- */

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
		// 不带 Referer：门户的图走搜狗缩略图服务，但原图床是微博，带上来源容易吃 403
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

	/* ---------------- 点击：占位块 / 正文图 / 链接 ---------------- */

	document.addEventListener('click', function (event) {
		// 1. 正文占位块 → 展开成真图
		const slot = event.target.closest('.img-slot');
		if (slot) {
			event.preventDefault();
			expandImage(slot);
			return;
		}

		// 2. 已展开的正文图再点一次 → 全屏 / 还原。
		//    只管正文：评论区里的图多是表情，点一下就糊满屏幕反而碍事。
		const zoomable = event.target.closest('.article-body img');
		if (zoomable) {
			event.preventDefault();
			zoomable.classList.toggle('zoomed');
			return;
		}

		// 3. 链接：门户文章留在面板里读，其余交给系统浏览器（由扩展侧判定）
		const link = event.target.closest('a[href]');
		if (link) {
			event.preventDefault();
			const href = link.getAttribute('href');
			if (href && !/^#/.test(href)) {
				vscode.postMessage({ command: 'openUrl', url: href });
			}
		}
	});
})();
