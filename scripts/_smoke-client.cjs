/**
 * _smoke-client.cjs — whalebuddy 客户端 bundle 冒烟测试（不进部署）。
 *
 * 用 window.__ModuleLoader__ 桩捕获注册 → 真实 factory(require('react' 桩)) 执行 →
 * 验证：exports 契约、apply() 注册卡片（slot key=whalebuddy）、组件在 scope ready 时
 * 渲染 li / 未 ready 时返回 null、以及暂存表单流（勾选 → 保存 → scope.set 落盘判定）。
 */
'use strict'
const assert = require('node:assert')
const path = require('node:path')
const fs = require('node:fs')

const CLIENT = path.join(__dirname, '..', 'whalebuddy', 'client', 'client.js')

// ── window 桩 ──
let registration = null
global.window = {
  __ModuleLoader__: {
    load: (reg) => { registration = reg },
  },
}

// ── react 桩：按调用序持久的 hook cells + 记录式 createElement ──
function makeReactStub() {
  const cells = []
  const effects = []
  const stub = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: (init) => {
      const i = stub.__cursor
      stub.__cursor += 1
      if (cells[i] === undefined) cells[i] = { value: typeof init === 'function' ? init() : init }
      const cell = cells[i]
      return [cell.value, (v) => { cell.value = typeof v === 'function' ? v(cell.value) : v }]
    },
    useEffect: (fn) => { effects.push(fn) },
    __cursor: 0,
    __beginRender: () => { stub.__cursor = 0 },
    __cells: cells,
    __effects: effects,
  }
  return stub
}

// ── mock settingsScope（按官方 SettingsScopeController 快照形状） ──
function makeMockScope() {
  const listeners = new Set()
  const doc = {
    status: 'ready',
    value: { autostart: false, launchOnDshStart: false, petPath: '', skin: 'dsh-black-whale' },
    base: { autostart: false, launchOnDshStart: false, petPath: '', skin: 'dsh-black-whale' },
    user: {},
    revision: 0,
    writable: true,
  }
  const writes = []
  return {
    writes,
    getSnapshot: () => doc,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    set: async (field, value) => {
      writes.push(['set', field, value])
      doc.user[field] = value          // 模拟 Host 接受写入
      doc.value[field] = value
      doc.revision += 1
      for (const fn of listeners) fn()
    },
    unset: async (field) => {
      writes.push(['unset', field])
      delete doc.user[field]
      doc.value[field] = doc.base[field]
      doc.revision += 1
      for (const fn of listeners) fn()
    },
    __setSnapshot: (patch) => { Object.assign(doc, patch); for (const fn of listeners) fn() },
  }
}

async function main() {
  // 1. 加载真实 client bundle
  const code = fs.readFileSync(CLIENT, 'utf8')
  new Function(code)() // 顶层只有 window.__ModuleLoader__.load(...) 注册
  assert.ok(registration, 'bundle 注册了 __ModuleLoader__.load')
  assert.strictEqual(registration.id, 'whalebuddy', 'module id = whalebuddy')

  const react = makeReactStub()
  const pluginExports = registration.factory((id) => {
    if (id === 'react') return react
    throw new Error('意外的 require: ' + id)
  })
  assert.deepStrictEqual(pluginExports.inject, ['slots', 'settingsScope'], 'client inject')

  // 2. apply()：mock slots + settingsScope
  const scope = makeMockScope()
  const slotInjects = []
  let slotRegistered = null
  const ctx = {
    settingsScope: { bind: (spec) => { assert.strictEqual(spec.namespace, 'whalebuddy'); return scope } },
    slots: {
      inject: (name, fn) => { slotInjects.push(name); fn() },
      register: (opts, component) => { slotRegistered = { opts, component }; return () => {} },
    },
  }
  pluginExports.apply(ctx)
  assert.deepStrictEqual(slotInjects, ['settings.plugin.item'], '注入 settings.plugin.item')
  assert.strictEqual(slotRegistered.opts.key, 'whalebuddy', '卡片 key = whalebuddy')

  // 3. 组件渲染：scope 未 ready → null
  // slot 组件 ConnectedCard 返回 {type: WhalebuddyCard, props}；渲染 = 调用函数组件本身
  const renderEl = (el) => (typeof el.type === 'function' ? el.type(el.props) : el)
  const render = () => { react.__beginRender(); return renderEl(Card({})) }
  scope.__setSnapshot({ status: 'loading' })
  const Card = slotRegistered.component
  let tree = render()
  assert.strictEqual(tree, null, 'scope 未 ready 返回 null')

  // 4. scope ready → 渲染 li（标题 + 描述 + 头部按钮）；点头部展开 body
  scope.__setSnapshot({ status: 'ready' })
  tree = render()
  assert.strictEqual(tree.type, 'li', '卡片根节点 li')
  const headerBtn = tree.props.children[0]
  assert.strictEqual(headerBtn.type, 'button', '头部为 button')
  const texts = JSON.stringify(tree)
  assert.ok(texts.includes('桌面宠物 whalebuddy'), '卡片标题')
  assert.ok(texts.includes('启动与运行状态'), '卡片描述')

  // 5. 暂存表单流：展开 → 找 checkbox（launchOnDshStart）→ 勾选 → 保存按钮 → scope.set
  headerBtn.props.onClick() // open=true
  tree = render()
  const nodes = []
  const btnText = (n) => {
    const c = n.props && n.props.children
    if (Array.isArray(c)) return c.filter((k) => typeof k === 'string').join('')
    return typeof c === 'string' ? c : ''
  }
  const walk = (n) => {
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (!n || typeof n !== 'object') return
    nodes.push(n)
    walk(n.props && n.props.children)
  }
  walk(tree)
  const checkboxes = nodes.filter((n) => n.type === 'input' && n.props.type === 'checkbox')
  assert.strictEqual(checkboxes.length, 2, '两个布尔开关')
  assert.strictEqual(checkboxes[0].props.checked, false, 'autostart 初始未勾选')
  assert.strictEqual(checkboxes[1].props.checked, false, 'launchOnDshStart 初始未勾选')
  assert.ok(nodes.some((n) => n.type === 'button' && btnText(n) === '立即启动'), '立即启动按钮')

  // 勾选 launchOnDshStart（第二个 checkbox 的 onChange）
  checkboxes[1].props.onChange({ target: { checked: true } })

  // 文本字段：petPath 输入（staged Map 在 form 闭包里持久，重渲染不丢）
  tree = render()
  nodes.length = 0
  walk(tree)
  const textInputs = nodes.filter((n) => n.type === 'input' && n.props.type === 'text')
  assert.strictEqual(textInputs.length, 2, '两个文本字段')
  textInputs[0].props.onChange({ target: { value: 'D:\\tools\\whalebuddy\\dsh-pet.exe' } })

  // 保存按钮（文本含「保存」且非「保存中…」）
  const buttons = nodes.filter((n) => n.type === 'button')
  const saveBtn = buttons.find((b) => btnText(b) === '保存')
  assert.ok(saveBtn, '保存按钮存在')
  await saveBtn.props.onClick()

  assert.deepStrictEqual(scope.writes, [
    ['set', 'launchOnDshStart', true],
    ['set', 'petPath', 'D:\\tools\\whalebuddy\\dsh-pet.exe'],
  ], '保存写入了两个暂存字段')
  console.log('✓ 暂存表单：勾选 + 输入 → 保存 → scope.set 按序写入')

  // 6. 覆盖徽标：写入后 user 层带键 → 「已覆盖」徽标文本 + ResetLink（函数组件，
  //    桩不执行其函数体，按形状断言：带 onClick 的函数节点）出现
  tree = render()
  nodes.length = 0
  walk(tree)
  const s = JSON.stringify(tree)
  assert.ok(s.includes('已覆盖'), '覆盖徽标')
  const resetLinks = nodes.filter((n) => typeof n.type === 'function' && n.props && typeof n.props.onClick === 'function')
  assert.strictEqual(resetLinks.length, 2, '两个覆盖字段各有一个恢复默认链接')
  console.log('✓ 覆盖徽标 + 恢复默认按 user 层存在性判定')

  // 7. 重置字段（第一个 ResetLink = launchOnDshStart，树序=BOOL_FIELDS 在前）→ 保存 → unset
  resetLinks[0].props.onClick()
  scope.writes.length = 0
  const saveBtn2 = nodes.find((n) => n.type === 'button' && btnText(n) === '保存')
  await saveBtn2.props.onClick()
  // 重置的是第一个 staged 的字段（launchOnDshStart，插入序）
  assert.deepStrictEqual(scope.writes, [['unset', 'launchOnDshStart']], '恢复默认 → unset')
  console.log('✓ 恢复默认 → scope.unset')

  console.log('\n客户端冒烟全部通过 ✔')
}

main().catch((e) => { console.error('CLIENT SMOKE FAILED:', e); process.exit(1) })



