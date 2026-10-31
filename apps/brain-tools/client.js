/**
 * @dsh-brain/brain-tools — Client 半边：设置页「外置大脑」面板。
 *
 * 做什么：给主人一个能点开的入口，跳到内嵌控制台 /dsh-brain（host 半边注册的路由）。
 *
 * 两个约定（踩过就知道）：
 *   1. 注册 id 必须等于 loader entry 的 name（也就是包名），否则 ModuleLoader 报
 *      "loaded without registering <name>"。
 *   2. 只依赖 slots 服务；数据走 host 路由，不在前端持有库连接。
 */
window.__ModuleLoader__.load({
  id: '@dsh-brain/brain-tools',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const CSS = [
      '.bt-panel{display:flex;flex-direction:column;gap:16px;padding:6px 2px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.bt-head{display:flex;align-items:center;gap:10px}',
      '.bt-title{font-size:15px;font-weight:600}',
      '.bt-badge{margin-left:auto;font-size:11.5px;padding:2px 9px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.bt-sub{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.65}',
      '.bt-card{display:flex;flex-direction:column;gap:14px;padding:16px 18px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}',
      '.bt-row{display:grid;grid-template-columns:88px 1fr;gap:12px;align-items:baseline}',
      '.bt-k{font-size:12px;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}',
      '.bt-v{font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}',
      '.bt-num{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.1}',
      '.bt-actions{display:flex;gap:10px;flex-wrap:wrap}',
      '.bt-btn{display:inline-flex;align-items:center;gap:7px;padding:9px 16px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer;text-decoration:none;transition:all .18s}',
      '.bt-btn:hover{border-color:#a8632f;color:#a8632f}',
      '.bt-btn.primary{background:#a8632f;border-color:#a8632f;color:#fff}',
      '.bt-btn.primary:hover{filter:brightness(1.06);color:#fff}',
      '.bt-note{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.6;padding-top:4px;border-top:1px dashed var(--dsw-alias-border-l1)}',
    ].join('\n')

    function ensureStyle() {
      const id = 'dsh-brain-tools-css'
      if (document.getElementById(id)) return
      const style = document.createElement('style')
      style.id = id
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function Panel() {
      ensureStyle()
      const [stats, setStats] = React.useState(null)
      const [failed, setFailed] = React.useState(false)
      // 治理服务（默认 7420）状态：它跑在 dsh web 进程内，不是独立进程，
      // 所以要靠一个接口问它「现在活着吗」，停/启也走同一组接口。
      const [gov, setGov] = React.useState(null)
      const [govBusy, setGovBusy] = React.useState(false)

      const loadGov = React.useCallback(() => {
        fetch('/dsh-brain/api/governance/status', { credentials: 'same-origin' })
          .then((r) => r.json())
          .then((d) => { if (d && d.ok) setGov(d) })
          .catch(() => { /* 拿不到就显示 …，不编状态 */ })
      }, [])

      React.useEffect(() => {
        let alive = true
        fetch('/dsh-brain/api/stats', { credentials: 'same-origin' })
          .then((r) => r.json())
          .then((d) => { if (alive) setStats(d) })
          .catch(() => { if (alive) setFailed(true) })
        return () => { alive = false }
      }, [])

      React.useEffect(() => { loadGov() }, [loadGov])

      const toggleGov = async () => {
        if (govBusy) return
        setGovBusy(true)
        try {
          const running = !!(gov && gov.running)
          const url = running ? '/dsh-brain/api/governance/stop' : '/dsh-brain/api/governance/start'
          const response = await fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-Brain-Action': '1' },
            body: '{}',
          })
          const data = await response.json().catch(() => ({ ok: false, message: '服务端返回的不是 JSON' }))
          if (!data || data.ok !== true) {
            window.alert(String((data && data.message) || '操作没成功'))
            return
          }
          loadGov()
        } catch (error) {
          window.alert(String(error && error.message ? error.message : error))
        } finally {
          setGovBusy(false)
        }
      }

      const openConsole = () => { window.open('/dsh-brain', '_blank', 'noopener') }

      const memText = failed ? '—' : (stats && stats.ok ? String(stats.memories) : '…')
      const idxText = failed ? '—' : (stats && stats.ok ? (stats.indexReady ? '正常' : '待建') : '…')

      return h('div', { className: 'bt-panel' },
        h('div', { className: 'bt-head' },
          h('div', { className: 'bt-title' }, '外置大脑'),
          h('div', { className: 'bt-badge' }, 'explicit'),
        ),
        h('div', { className: 'bt-sub' },
          '跨会话的长期记忆。只在需要时显式检索，不会自动往对话里塞东西。'),

        h('div', { className: 'bt-card' },
          h('div', { className: 'bt-row' },
            h('div', { className: 'bt-k' }, '记忆'),
            h('div', { className: 'bt-num' }, memText),
          ),
          h('div', { className: 'bt-row' },
            h('div', { className: 'bt-k' }, '索引'),
            h('div', { className: 'bt-v' }, idxText),
          ),
          h('div', { className: 'bt-row' },
            h('div', { className: 'bt-k' }, '工具'),
            h('div', { className: 'bt-v' }, 'brain_search / brain_remember / brain_forget'),
          ),
          h('div', { className: 'bt-row' },
            h('div', { className: 'bt-k' }, '库'),
            h('div', { className: 'bt-v' }, (stats && stats.dbPath) || '—'),
          ),
          h('div', { className: 'bt-row' },
            h('div', { className: 'bt-k' }, '治理服务'),
            h('div', { className: 'bt-v' },
              gov === null ? '…' : (gov.running ? '运行中（:' + gov.port + '）' : '已停止')),
          ),
        ),

        h('div', { className: 'bt-actions' },
          h('button', { className: 'bt-btn primary', onClick: openConsole }, '打开控制台'),
          gov !== null && gov.running
            ? h('button', {
              className: 'bt-btn',
              disabled: govBusy || !gov.controllable,
              onClick: toggleGov,
              title: gov.controllable ? '' : '这个端口是别的进程占着的，本插件只是代理过去',
            }, govBusy ? '处理中…' : (gov.controllable ? '停止治理服务' : '停止（端口非本进程）'))
            : h('button', {
              className: 'bt-btn',
              disabled: govBusy || !!(gov && gov.disabled),
              onClick: toggleGov,
            }, govBusy ? '处理中…' : '启动治理服务'),
          gov !== null && gov.running
            ? h('a', {
              className: 'bt-btn',
              href: 'http://127.0.0.1:' + gov.port + '/',
              target: '_blank',
              rel: 'noopener',
            }, '打开治理面板')
            : null,
        ),

        h('div', { className: 'bt-note' },
          '控制台是只读视图：能查、能看来源和版本。删除与恢复这类操作在治理面板里，' +
          '它跑在 dsh web 进程内（默认 7420，只监听本机回环），可以在这里启动或停止。'),
      )
    }

    // cordis 插件形态：拿 slots 用 ctx.get，不是 require 模块。照 fox-mood 的写法。
    const inject = ['slots']

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) {
        console.warn('[brain-tools] 没有 slots 服务，设置页入口未挂载')
        return
      }
      ensureStyle()
      try {
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'brain-tools', order: 27, label: '外置大脑' },
          () => h(Panel, null),
        ))
      } catch (error) {
        console.warn('[brain-tools] 设置页入口挂载失败:', error && error.message)
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.Panel = Panel
    return module.exports
  },
})
