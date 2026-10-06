// neovide-cursor.js

/**
 * ====================================================================
 * 核心实现原理 (Core Architecture & Physics)
 * ====================================================================
 * * 1. 分离式顶点追踪 (Mass-Spring Corner Tracking):
 * 本插件不将光标视为一个整体矩形, 而是将其拆解为四个独立的物理质点 (角点), 每个角点都绑定了
 * 一个独立的二阶阻尼弹簧振子系统, 这种设计允许光标在高速移动时发生剪切、拉伸和形变,
 * 从而还原 Neovide 那种充满弹性且有有机质感的视觉表现
 *
 * * 2. 动态优先级分级 (Rank-Based Dynamic Factor):
 * 当光标移动时, 系统会计算移动向量与每个角点向量的对齐度
 * - 领先角点 (Leading Corners): 对齐度高, 被赋予高 Rank, 响应最快
 * - 拖尾角点 (Trailing Corners): 对齐度低, 被赋予低 Rank, 产生明显的滞后
 * 通过这种分级控制, 光标在起始阶段会拉长, 在接近终点时会像橡皮筋一样收缩复位
 *
 * * 3. 尺寸锚定与解耦 (Dimensional Decoupling):
 * 在光标跨越不同宽度的字符 (如从单字节字符跳转到 Tab 或中文字符) 时, 若实时改变物理模型的
 * 目标尺寸会导致震荡, 插件在触发跳转 (Jump) 的瞬间锁定当前的 targetDim, 确保物理计算在
 * 局部坐标系内是稳定的, 直到下一次位置更新
 *
 * * 4. 虚拟 Canvas 渲染层 (Virtual Overlay Layer):
 * 由于 VSCode 原生光标无法实现非线性形变, 插件通过 CSS 禁用原生光标显示, 并创建一个
 * 覆盖全屏的 Canvas, Canvas 每一帧会实时抓取原生光标的 DOM 坐标作为引力中心, 驱动物理引擎,
 * 最终使用 polygon 绘制出经过物理形变后的光标图形
 */

// ====================================================================
// SECTION 1: 用户可自定义参数 (User Configurations)
// ====================================================================

// --- 颜色和外观 (Color and Appearance) ---
const tailColor = "#FFC0CB"; // 拖尾颜色 (十六进制) | 默认: "#FFC0CB"
const tailOpacity = 1; // 不透明度 (0-1) | 默认: 1

// --- 阴影辉光 (Shadow Glow) ---
const useShadow = true; // 辉光开关 (布尔值) | 默认: true (略微影响性能)
const shadowColor = tailColor; // 辉光颜色 (十六进制) | 默认: tailColor
const shadowBlurFactor = 0.75; // 模糊系数 (倍数) | 默认: 0.5

// --- 动画时间 (Animation Timing) ---
const animationLength = 0.25; // 标准动画时长 (秒/s) | 默认: 0.125
const shortAnimationLength = 0.125; // 短距离位移动画时长 (秒/s) | 默认: 0.05
const shortMoveThreshold = 8; // 短距离位移阈值 (像素/px) | 默认: 8

// --- 拖尾动态控制 (Trail Dynamics Control) ---
const rank0TrailFactor = 1.0; // 最拖尾角点速度因子 (倍数) | 默认: 1.0
const rank1TrailFactor = 0.9; // 次拖尾角点速度因子 (倍数) | 默认: 0.9
const rank2TrailFactor = 0.5; // 次领先角点速度因子 (倍数) | 默认: 0.5
const rank3TrailFactor = 0.3; // 最领先角点速度因子 (倍数) | 默认: 0.3

// --- 领先角点行为控制 (Leading Edge Behavior) ---
const useHardSnap = true; // 瞬移开关 (布尔值) | 默认: true (起稳定器的作用, 关闭会影响上方拖尾角点, 需重新调参)
const leadingSnapFactor = 0.1; // 瞬移系数 (倍数) | 默认: 0.1
const leadingSnapThreshold = 0.5; // 判定阈值 (0-1) | 默认: 0.5
const animationResetThreshold = 0.075; // 重置阈值 (秒/s) | 默认: 0.075
const maxTrailDistanceFactor = 100; // 最大拉伸 (倍数) | 默认: 100
const snapAnimationLength = 0.02; // 瞬移时长 (秒/s) | 默认: 0.02

// --- 全局管理 (Global Management) ---
const cursorUpdatePollingRate = 500; // 扫描频率 (毫秒/ms) | 默认: 100 (影响性能大, 不建议小于100毫秒)
const cursorDisappearDelay = 250; // 拖尾消失延迟 (毫秒/ms) | 默认: 50
const cursorFadeOutDuration = 0.125; // 拖尾渐隐时长 (秒/s) | 默认: 0.075

// --- 预设 CSS 字符串 (CSS Constants) ---
const canvasFadeTransitionCss = `opacity ${cursorFadeOutDuration}s ease-out`; // 拖尾消失过渡 (由上方渐隐时长决定, 让拖尾在停止运动后平滑淡出)
const nativeCursorDisappearTransitionCss = `opacity 0s ease-out`; // 原生光标瞬间消失 (当物理光标开始运动时, 立刻隐藏原生光标)
const nativeCursorRevealTransitionCss = `opacity 0.075s ease-in`; // 原生光标平滑恢复 (当动画结束进入静止状态, 慢慢显现原生光标以对齐文字)

// ====================================================================
// SECTION 2: 全局状态追踪 (Global State Tracking)
// ====================================================================

/**
 * globalCursorState 对象
 * 记录全局范围内光标最后一次出现的位置, 用于光标在不同编辑器实例或分屏
 * 之间切换时, 能够提供一个合理的动画起始点, 防止动画从 [0,0] 坐标飞入
 */
const globalCursorState = {
	lastX: null, // 最后记录的中心 X 坐标
	lastY: null, // 最后记录的中心 Y 坐标
	lastWidth: null, // 新增: 最后记录的光标宽度
	lastHeight: null, // 新增: 最后记录的光标高度
	lastUpdated: 0, // 最后更新时间戳
};

// ====================================================================
// SECTION 3: 基础工具函数 (Utility Functions)
// ====================================================================

/**
 * resolveColor 函数: 将 CSS 格式的 Hex 颜色转为 RGBA 分量对象
 * 逻辑: 拆解字符串, 将 16 进制数字转换为计算所需的 0-255 整数数值
 */
const resolveColor = (hex) => {
	let h = hex.startsWith("#")
		? hex.slice(1).toUpperCase()
		: hex.toUpperCase();
	if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
	if (h.length === 6) h += "FF";
	const r = parseInt(h.slice(0, 2), 16) >> 0,
		g = parseInt(h.slice(2, 4), 16) >> 0,
		b = parseInt(h.slice(4, 6), 16) >> 0,
		a = parseInt(h.slice(6, 8), 16) >> 0;
	return { r, g, b, a };
};

/**
 * rgbaToCss 函数: 将 RGBA 分量对象还原为 CSS 标准字符串
 */
const rgbaToCss = ({ r, g, b, a }) => `rgba(${r}, ${g}, ${b}, ${a / 255})`;

/**
 * clamp 函数: 数值限幅器
 * 逻辑: 确保一个数值被强制锁定在指定的最小和最大范围之间
 */
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * normalize 函数: 2D 向量归一化
 * 逻辑: 计算向量的长度并将其缩减为 1, 从而只提取出方向信息
 */
const normalize = (v) => {
	const l = Math.hypot(v.x, v.y);
	return l ? { x: v.x / l, y: v.y / l } : { x: 0, y: 0 };
};

// 定义光标四个角点的局部坐标参考系 (以中心点为原点)
const cursorRelativeCorners = [
	{ x: -0.5, y: -0.5 }, // 左上 (Top-Left)
	{ x: 0.5, y: -0.5 }, // 右上 (Top-Right)
	{ x: 0.5, y: 0.5 }, // 右下 (Bottom-Right)
	{ x: -0.5, y: 0.5 }, // 左下 (Bottom-Left)
];

// ====================================================================
// SECTION 4: 阻尼弹簧物理模型 (Damped Spring Animation)
// ====================================================================

/**
 * DampedSpringAnimation 类: 模拟受阻尼限制的物体运动
 * 采用临界阻尼公式, 能够确保物体以最快速度且不产生多次震荡的方式回归目标位置
 */
class DampedSpringAnimation {
	constructor(l) {
		this.position = 0; // 偏移量 (当前距离目标的距离, 为 0 代表已重合)
		this.velocity = 0; // 当前运动速度
		this.animationLength = l; // 时间常数 (数值越小, 弹簧越硬, 移动越快)
	}

	/**
	 * update 方法: 根据时间增量 dt 推进物理模拟
	 * 逻辑: 根据经典物理公式计算下一时刻的位置和速度
	 */
	update(dt) {
		if (this.animationLength <= dt || Math.abs(this.position) < 0.001) {
			this.reset();
			return false;
		}
		const o = 4.0 / this.animationLength,
			a = this.position,
			b = this.position * o + this.velocity,
			c = Math.exp(-o * dt);
		this.position = (a + b * dt) * c;
		this.velocity = c * (-a * o - b * dt * o + b);
		return Math.abs(this.position) >= 0.01;
	}

	/**
	 * reset 方法: 清除动能与位移, 瞬间静止
	 */
	reset() {
		this.position = 0;
		this.velocity = 0;
	}
}

// ====================================================================
// SECTION 5: 单个角点控制 (Corner Control)
// ====================================================================

/**
 * Corner 类: 管理光标的每一个独立角点
 * 负责处理该角点的局部坐标到全局坐标的投影、弹簧系统的调度以及对齐度计算
 */
class Corner {
	constructor(rp) {
		this.rp = rp; // 角点相对于光标中心的相对位置系数
		this.cp = { x: 0, y: 0 }; // 角点当前在屏幕上的实际位置
		this.pd = { x: -1e5, y: -1e5 }; // 角点上一帧锁定的目标位置
		this.ax = new DampedSpringAnimation(animationLength); // 左右(X轴)弹簧
		this.ay = new DampedSpringAnimation(animationLength); // 上下(Y轴)弹簧
		this.targetDim = { width: 8, height: 18 }; // 该角点认定的光标大小
	}

	/**
	 * getDest 方法: 计算该角点理想状态下(静止时)应该到达的目标坐标
	 */
	getDest(c, dim) {
		return {
			x: c.x + this.rp.x * dim.width,
			y: c.y + this.rp.y * dim.height,
		};
	}

	/**
	 * calculateDirectionAlignment 方法: 计算角点相对位移的方向对齐度
	 * 逻辑: 通过点积运算判断该角点是在移动方向的前端还是后端
	 */
	calculateDirectionAlignment(dim, destCenter) {
		const cornerDest = this.getDest(destCenter, dim);
		const travelDir = normalize({
			x: cornerDest.x - this.cp.x,
			y: cornerDest.y - this.cp.y,
		});
		const cornerDir = normalize(this.rp);
		return travelDir.x * cornerDir.x + travelDir.y * cornerDir.y;
	}

	/**
	 * jump 方法: 核心调度逻辑
	 * 逻辑: 当光标大范围位移时, 重新分配每个角点的权重, 决定谁该领先, 谁该拖后
	 */
	jump(c, dim, rank) {
		this.targetDim = { ...dim };
		const t = this.getDest(c, dim);
		const jv = {
			x: (t.x - this.pd.x) / dim.width,
			y: (t.y - this.pd.y) / dim.height,
		};
		// 判断是否为短距离移动 (如正常打字)
		const isShortMove =
			Math.abs(jv.x) <= shortMoveThreshold && Math.abs(jv.y) <= 0.001;
		const baseTime = isShortMove ? shortAnimationLength : animationLength;
		const leadingAlignment =
			normalize(jv).x * normalize(this.rp).x +
			normalize(jv).y * normalize(this.rp).y;

		let finalFactor;
		// 领先判定: 对齐度极高的前端角点执行快速响应 (Hard Snap)
		if (useHardSnap && leadingAlignment > leadingSnapThreshold) {
			finalFactor = leadingSnapFactor;
		} else {
			const factors = [
				rank0TrailFactor,
				rank1TrailFactor,
				rank2TrailFactor,
				rank3TrailFactor,
			];
			finalFactor = factors[rank] || 1.0;
		}

		let len =
			leadingAlignment > leadingSnapThreshold && useHardSnap
				? snapAnimationLength
				: baseTime * clamp(finalFactor, 0, 1);

		this.ax.animationLength = len;
		this.ay.animationLength = len;

		// 若动画时长较大, 则清空旧动能, 避免之前的运动惯性干扰本次跳转
		if (len > animationResetThreshold) {
			this.ax.reset();
			this.ay.reset();
		}
	}

	/**
	 * update 方法: 每一帧执行的物理位置迭代
	 */
	update(dim, c, dt, imm) {
		const dest = this.getDest(c, dim);
		// 如果目标点移动了, 将新的差值注入弹簧系统进行缓慢消化
		if (dest.x !== this.pd.x || dest.y !== this.pd.y) {
			this.ax.position = dest.x - this.cp.x;
			this.ay.position = dest.y - this.cp.y;
			this.pd = { ...dest };
		}
		// 如果在滚动状态, 强行同步位置以防止光标在页面滚动时掉队
		if (imm) {
			this.cp = dest;
			this.ax.reset();
			this.ay.reset();
			return false;
		}
		this.ax.update(dt);
		this.ay.update(dt);
		// 限制拉伸距离, 防止物理计算异常导致光标飞出屏幕
		const maxD = Math.max(dim.width, dim.height) * maxTrailDistanceFactor;
		this.ax.position = clamp(this.ax.position, -maxD, maxD);
		this.ay.position = clamp(this.ay.position, -maxD, maxD);
		// 最终绘制点 = 目标点 - 弹簧尚未消化的剩余距离
		this.cp.x = dest.x - this.ax.position;
		this.cp.y = dest.y - this.ay.position;
		return (
			Math.abs(this.ax.position) > 0.5 || Math.abs(this.ay.position) > 0.5
		);
	}
}

// ====================================================================
// SECTION 6: 单个光标实例创建器 (Cursor Instance Creator)
// ====================================================================

/**
 * createNeovideCursor 工厂函数: 负责生成并管理一个完整的光标渲染逻辑
 */
const createNeovideCursor = ({ canvas }) => {
	// 预计算颜色值, 减少绘图时的重复计算开销
	const colorObj = resolveColor(tailColor),
		finalColorCss = rgbaToCss({
			...colorObj,
			a: (colorObj.a * tailOpacity) >> 0,
		}),
		shadowColorCss = useShadow
			? shadowColor === tailColor
				? finalColorCss
				: rgbaToCss(resolveColor(shadowColor))
			: null;

	const context = canvas.getContext("2d");
	let cursorDimensions = { width: 8, height: 18 },
		centerDest = { x: 0, y: 0 },
		lastT = performance.now(),
		initialized = false,
		jumped = false;

	// 为该光标初始化四个独立物理角点
	const corners = cursorRelativeCorners.map((p) => new Corner(p));

	return {
		/**
		 * move 方法: 外部驱动接口, 告诉插件光标的目标坐标
		 */
		move: (x, y, fromSource = null) => {
			if ((x <= 0 && y <= 0) || isNaN(x) || isNaN(y)) return;
			const newCenter = {
				x: x + cursorDimensions.width / 2,
				y: y + cursorDimensions.height / 2,
			};
			// 修复: 将条件从 !initialized 改为 !initialized || fromSource
			// 原因: 在同窗口分屏跳转时, initialized 已为 true, 但仍需要重新初始化角点位置以触发过渡动画
			if (!initialized || fromSource) {
				const src =
					fromSource ||
					(globalCursorState.lastX
						? {
								x: globalCursorState.lastX,
								y: globalCursorState.lastY,
						  }
						: null);
				if (src) {
					const oldDim = {
						width:
							globalCursorState.lastWidth ||
							cursorDimensions.width,
						height:
							globalCursorState.lastHeight ||
							cursorDimensions.height,
					};
					corners.forEach((c) => {
						c.targetDim = { ...oldDim };
						const d = c.getDest({ x: src.x, y: src.y }, oldDim);
						c.cp = { ...d };
						c.pd = { ...d };
					});
				} else {
					// 无源坐标时, 直接在目标位置初始化
					corners.forEach((c) => {
						c.targetDim = { ...cursorDimensions };
						const d = c.getDest(newCenter, cursorDimensions);
						c.cp = { ...d };
						c.pd = { ...d };
					});
				}
				initialized = true;
			}
			centerDest = newCenter;
			jumped = true; // 触发 Rank 重新分配
			globalCursorState.lastX = newCenter.x;
			globalCursorState.lastY = newCenter.y;
			globalCursorState.lastWidth = cursorDimensions.width;
			globalCursorState.lastHeight = cursorDimensions.height;
			globalCursorState.lastUpdated = Date.now();
		},

		updateSize: (w, h) => {
			if (w > 0) {
				cursorDimensions.width = w;
				cursorDimensions.height = h;
			}
		},

		/**
		 * updateLoop 方法: 每一帧执行的 Canvas 绘图循环
		 */
		updateLoop: (isS, draw) => {
			if (!initialized) return false;
			const now = performance.now(),
				dt = Math.min((now - lastT) / 1000, 1 / 30);
			lastT = now;

			if (jumped) {
				// 根据对齐度对四个角点进行排序, 从而分配不同的滞后系数
				const ranks = corners
					.map((c, i) => ({
						i,
						v: c.calculateDirectionAlignment(
							cursorDimensions,
							centerDest
						),
					}))
					.sort((a, b) => a.v - b.v)
					.map((it, r) => ({ i: it.i, r }))
					.reduce((acc, cur) => {
						acc[cur.i] = cur.r;
						return acc;
					}, []);

				corners.forEach((c, i) =>
					c.jump(centerDest, cursorDimensions, ranks[i])
				);
				jumped = false;
			}

			let anim = false;
			corners.forEach((c) => {
				if (c.update(cursorDimensions, centerDest, dt, isS))
					anim = true;
			});

			if (draw) {
				// 执行 2D 绘图: 按照角点物理坐标描绘多边形并填充颜色
				context.beginPath();
				context.moveTo(corners[0].cp.x, corners[0].cp.y);
				for (let i = 1; i < 4; i++)
					context.lineTo(corners[i].cp.x, corners[i].cp.y);
				context.closePath();
				context.fillStyle = finalColorCss;
				if (useShadow) {
					context.shadowColor = shadowColorCss;
					context.shadowBlur =
						shadowBlurFactor *
						Math.max(
							cursorDimensions.width,
							cursorDimensions.height
						);
				}
				context.fill();
				context.shadowBlur = 0;
				context.shadowColor = "transparent";
			}
			return anim;
		},
	};
};

// ====================================================================
// SECTION 7: 全局光标管理器 (Global Cursor Manager)
// ====================================================================

/**
 * GlobalCursorManager 类: 系统的控制塔
 * 负责扫描 DOM 节点、同步多光标实例、控制原生光标的显隐以及渲染 Canvas
 */
class GlobalCursorManager {
	constructor() {
		this.cursors = new Map(); // 存储活跃光标实例及其对应的 DOM 元素
		this.canvas = document.createElement("canvas");
		this.ctx = this.canvas.getContext("2d");
		this.isScrolling = false; // 滚动状态锁
		this.init();
	}

	/**
	 * init 方法: 启动环境初始化
	 */
	init() {
		// 注入全局样式: 禁用原生的光标平滑过渡, 否则物理引擎无法接管
		const style = document.createElement("style");
		style.textContent = `
            .monaco-editor .cursor {
                transition: none !important;
            }
            .cursor-trail {
                opacity: 0 !important;
            }
        `;
		document.head.appendChild(style);

		// 设置全屏透明画板
		this.canvas.style.cssText = `
            pointer-events: none;
            position: fixed;
            top: 0;
            left: 0;
            z-index: 9999;
            opacity: 0;
            transition: none;
        `;
		document.body.appendChild(this.canvas);

		window.addEventListener("resize", () => {
			this.canvas.width = window.innerWidth;
			this.canvas.height = window.innerHeight;
		});
		this.canvas.width = window.innerWidth;
		this.canvas.height = window.innerHeight;

		// 全局滚动检测: 页面滚动时, 光标必须停止物理形变并紧贴行首
		document.addEventListener(
			"scroll",
			() => {
				this.isScrolling = true;
				clearTimeout(this.sT);
				this.sT = setTimeout(() => (this.isScrolling = false), 100);
			},
			{ capture: true, passive: true }
		);

		this.loop();
		setInterval(() => this.scan(), cursorUpdatePollingRate);
	}

	/**
	 * scan 方法: 探测并匹配 DOM 元素与物理实例
	 */
	scan() {
		const ids = new Set();
		const els = document.querySelectorAll(".monaco-editor .cursor");
		els.forEach((el) => {
			let id =
				el.dataset.cursorId ||
				"c" + Math.random().toString(36).slice(2, 7);
			el.dataset.cursorId = id;
			ids.add(id);

			// 如果发现新的光标 DOM, 立即创建对应的物理引擎对象
			if (!this.cursors.has(id)) {
				const r = el.getBoundingClientRect();
				const inst = createNeovideCursor({ canvas: this.canvas });
				if (r.left > 0 || r.top > 0) {
					inst.updateSize(r.width, r.height);
					inst.move(
						r.left,
						r.top,
						globalCursorState.lastX
							? {
									x: globalCursorState.lastX,
									y: globalCursorState.lastY,
							  }
							: null
					);
					this.cursors.set(id, {
						instance: inst,
						target: el,
						lastX: r.left,
						lastY: r.top,
						isActive: false,
					});
				}
			}
		});
		// 回收已经消失的 DOM 对应的实例
		for (const id of this.cursors.keys()) {
			if (!ids.has(id)) this.cursors.delete(id);
		}
	}

	/**
	 * loop 方法: 顶层渲染引擎, 控制每一帧的最终输出
	 */
	loop() {
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		let isAnyAnimating = false;

		for (const [id, data] of this.cursors) {
			if (!data.target || !data.target.isConnected) {
				this.cursors.delete(id);
				continue;
			}
			const r = data.target.getBoundingClientRect();
			const style = getComputedStyle(data.target);
			// 判定原生光标当前是否在界面上逻辑可见 (排除因分屏隐藏的光标)
			const isNowActive =
				style.visibility !== "hidden" &&
				style.display !== "none" &&
				!style.transform.includes("-10000px");
			const hasMoved = r.left !== data.lastX || r.top !== data.lastY;

			// 状态管理: 处理光标首次激活时的跳转引导
			if (isNowActive && !data.isActive) {
				data.isJumping = true;
				data.jumpSource = globalCursorState.lastX
					? { x: globalCursorState.lastX, y: globalCursorState.lastY }
					: null;
			}

			if (data.isJumping && hasMoved) {
				data.instance.updateSize(r.width, r.height);
				data.instance.move(r.left, r.top, data.jumpSource);
				data.isJumping = false;
				data.lastX = r.left;
				data.lastY = r.top;
			} else if (isNowActive && hasMoved) {
				data.instance.updateSize(r.width, r.height);
				data.instance.move(r.left, r.top);
				data.lastX = r.left;
				data.lastY = r.top;
			}

			data.isActive = isNowActive;
			if (isNowActive) {
				const anim = data.instance.updateLoop(
					this.isScrolling,
					r.left >= 0 && r.top >= 0 && r.left <= window.innerWidth
				);
				if (anim) isAnyAnimating = true;
				data.isAnimating = anim;
			} else {
				data.isAnimating = false;
			}
		}

		// 显隐逻辑策略:
		// 动画中: 隐藏原生光标, 渲染物理 Canvas
		// 静止后: 恢复原生光标 (确保清晰度), 渐隐物理 Canvas
		if (isAnyAnimating) {
			this.canvas.style.transition = "none";
			this.canvas.style.opacity = "1";
			this.cursors.forEach((d) => {
				if (d.isActive && d.target) {
					d.target.style.transition =
						nativeCursorDisappearTransitionCss;
					d.target.style.opacity = "0";
				}
			});
		} else {
			if (this.canvas.style.opacity === "1") {
				setTimeout(() => {
					this.canvas.style.transition = canvasFadeTransitionCss;
					this.canvas.style.opacity = "0";
				}, cursorDisappearDelay);
			}
			this.cursors.forEach((d) => {
				if (d.isActive && d.target) {
					d.target.style.transition = nativeCursorRevealTransitionCss;
					d.target.style.opacity = "1";
				}
			});
		}

		requestAnimationFrame(this.loop.bind(this));
	}
}
// 启动全局光标管理器（确保 DOM 已就绪）
function startNeovideCursor() {
    if (window.__neovideCursorStarted || window.__neovideCursorPending) return;

    if (!document.body || !document.head) {
        window.__neovideCursorPending = true;

        const retry = () => {
            window.__neovideCursorPending = false;
            startNeovideCursor();
        };

        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", retry, { once: true });
        } else {
            setTimeout(retry, 50);
        }
        return;
    }

    try {
        new GlobalCursorManager();
        window.__neovideCursorStarted = true;
    } catch (e) {
        console.error("Neovide cursor init failed:", e);
        window.__neovideCursorStarted = false;
    }
}

startNeovideCursor();