// ════════════════════════════════════════════════════════════════════════════
// cw_expand.js — 扩建模块（格子数据 / 重建 / 扩展器·拆除器 / 命令 / 旧存档迁移）
//
// 依赖 cw_cubes.js 末尾建立的只读桥 global.CWC；本脚本加载完成后填 global.CWE。
// 加载顺序：cw_cubes.js → cw_expand.js（文件名字典序 cw_c < cw_e）。
// 约束：只能在【函数体内部】读 global.CWC，禁止在顶层解构（KubeJS 每个脚本独立作用域）。
// ════════════════════════════════════════════════════════════════════════════

let C4_CWC_WARNED = false
function c4Cwc() {
  let c = global.CWC
  if (!c) {
    if (!C4_CWC_WARNED) {
      C4_CWC_WARNED = true
      console.error('[C4] cw_expand: global.CWC 未就绪（cw_cubes.js 必须先加载）')
    }
    return null
  }
  return c
}

// ════════════════════════════════════════════════════════════════════════════
// 格子化扩建（横向，无上限）
//   每格 16 深 × 17 高 × 16 宽（相邻格共享 1 格边框：17 = 16+1）
//   cells 存在 cube.cells：["0,0,0", "1,0,0", ...]（相对基地原点的格坐标）
//   只建【并集的外边界】：地板、外墙屏障、外框梁、外面那圈 structure_void；
//   相邻格之间的旧边框在新增时被清掉，内部保持连通。
// ════════════════════════════════════════════════════════════════════════════
const C4_CELL = 16
function c4CellKey(gx, gy, gz) { return gx + ',' + gy + ',' + gz }
function c4Cells(cube) {
  let a = (cube && cube.cells) || null
  if (!a || !a.length) return ['0,0,0']
  return a
}
// 单元格集合（对象当 Set 用，键 = "gx,gy,gz"）；没有 cells 时退化成原点一格
function c4CellSet(cube) {
  let set = {}
  c4Cells(cube).forEach(k => { set[k] = 1 })
  return set
}
function c4CellBox(slot, key) {
  let C = c4Cwc()
  let p = String(key).split(',')
  let gx = Number(p[0]) | 0, gy = Number(p[1]) | 0, gz = Number(p[2]) | 0
  let a = C.baseAnchor(slot)
  let X0 = a.x - 8 + C4_CELL * gx, Y0 = a.y + C4_CELL * gy, Z0 = a.z - 8 + C4_CELL * gz
  return { X0: X0, X1: X0 + C4_CELL, Y0: Y0, Y1: Y0 + C4_CELL, Z0: Z0, Z1: Z0 + C4_CELL, gx: gx, gy: gy, gz: gz }
}
function c4CellAt(slot, x, y, z) {
  let C = c4Cwc()
  let a = C.baseAnchor(slot)
  return c4CellKey(Math.floor((x - (a.x - 8)) / C4_CELL),
    Math.floor((y - a.y) / C4_CELL), Math.floor((z - (a.z - 8)) / C4_CELL))
}
// 所有格子（并集）的包围盒
function c4CellUnion(slot, keys) {
  let list = (keys && keys.length) ? keys : ['0,0,0']
  let X0 = 1e9, X1 = -1e9, Y0 = 1e9, Y1 = -1e9, Z0 = 1e9, Z1 = -1e9
  list.forEach(k => {
    let b = c4CellBox(slot, k)
    if (b.X0 < X0) X0 = b.X0
    if (b.X1 > X1) X1 = b.X1
    if (b.Y0 < Y0) Y0 = b.Y0
    if (b.Y1 > Y1) Y1 = b.Y1
    if (b.Z0 < Z0) Z0 = b.Z0
    if (b.Z1 > Z1) Z1 = b.Z1
  })
  return { X0: X0, X1: X1, Y0: Y0, Y1: Y1, Z0: Z0, Z1: Z1 }
}
// 重建并集外边界（幂等；不动已被相邻格包住的内部）
function c4RebuildCells(server, cube) {
  let C = c4Cwc()
  if (!C || !cube) return 0
  let slot = Number(cube.slot)
  let keys = c4Cells(cube), set = c4CellSet(cube)
  let run = (cmd) => { try { server.runCommandSilent('execute in minecraft:overworld run ' + cmd) } catch (e) {} }
  let u = c4CellUnion(slot, keys)
  // 先把并集范围 forceload（否则超出范围的 fill 会静默失败——地板不铺、屏障不刷）
  try { run('forceload add ' + (u.X0 - 16) + ' ' + (u.Z0 - 16) + ' ' + (u.X1 + 16) + ' ' + (u.Z1 + 16)) } catch (eFL) {}
  // 注意：不处理 ny（底面）——底面是地板，铺 barrier 会把地板变成屏障
  let DIRS = [['px', 1, 0, 0], ['nx', -1, 0, 0], ['pz', 0, 0, 1], ['nz', 0, 0, -1], ['py', 0, 1, 0]]
  keys.forEach(k => {
    let b = c4CellBox(slot, k)
    // ② 每个"没有邻居"的面：屏障 + 框梁边 + 外面一圈结构空位
    DIRS.forEach(dd => {
      let nk = c4CellKey(b.gx + dd[1], b.gy + dd[2], b.gz + dd[3])
      if (set[nk]) return
      let dir = dd[0]
      let x0, x1, y0, y1, z0, z1, sx0, sx1, sy0, sy1, sz0, sz1
      if (dir === 'px') { x0 = x1 = b.X1; y0 = b.Y0; y1 = b.Y1; z0 = b.Z0; z1 = b.Z1; sx0 = sx1 = b.X1 + 1; sy0 = b.Y0; sy1 = b.Y1; sz0 = b.Z0; sz1 = b.Z1 }
      else if (dir === 'nx') { x0 = x1 = b.X0; y0 = b.Y0; y1 = b.Y1; z0 = b.Z0; z1 = b.Z1; sx0 = sx1 = b.X0 - 1; sy0 = b.Y0; sy1 = b.Y1; sz0 = b.Z0; sz1 = b.Z1 }
      else if (dir === 'pz') { z0 = z1 = b.Z1; x0 = b.X0; x1 = b.X1; y0 = b.Y0; y1 = b.Y1; sz0 = sz1 = b.Z1 + 1; sx0 = b.X0; sx1 = b.X1; sy0 = b.Y0; sy1 = b.Y1 }
      else if (dir === 'nz') { z0 = z1 = b.Z0; x0 = b.X0; x1 = b.X1; y0 = b.Y0; y1 = b.Y1; sz0 = sz1 = b.Z0 - 1; sx0 = b.X0; sx1 = b.X1; sy0 = b.Y0; sy1 = b.Y1 }
      else if (dir === 'py') { y0 = y1 = b.Y1; x0 = b.X0; x1 = b.X1; z0 = b.Z0; z1 = b.Z1; sy0 = sy1 = b.Y1 + 1; sx0 = b.X0; sx1 = b.X1; sz0 = b.Z0; sz1 = b.Z1 }
      else { y0 = y1 = b.Y0; x0 = b.X0; x1 = b.X1; z0 = b.Z0; z1 = b.Z1; sy0 = sy1 = b.Y0 - 1; sx0 = b.X0; sx1 = b.X1; sz0 = b.Z0; sz1 = b.Z1 }
      // 屏障（不可见、有碰撞）：把外表面封住，人走不出去。
      // 侧面从地板上一格开始（Y0+1），否则会把地板那层也刷成屏障。
      let by0 = (dir === 'py') ? y0 : (y0 + 1)
      run('fill ' + x0 + ' ' + by0 + ' ' + z0 + ' ' + x1 + ' ' + y1 + ' ' + z1 + ' minecraft:barrier')
      // 底面下方那格：结构空位（不再放屏障）
      if (b.gy === 0) run('fill ' + b.X0 + ' ' + (b.Y0 - 1) + ' ' + b.Z0 + ' ' + b.X1 + ' ' + (b.Y0 - 1) + ' ' + b.Z1 + ' minecraft:structure_void')
      // 外面一圈结构空位（挡透视/放置）
      run('fill ' + sx0 + ' ' + sy0 + ' ' + sz0 + ' ' + sx1 + ' ' + sy1 + ' ' + sz1 + ' minecraft:structure_void')
      // 框梁：这一面四条边（让外壳看起来还是立方体）
      if (dir === 'px' || dir === 'nx') {
        run('fill ' + x0 + ' ' + b.Y1 + ' ' + z0 + ' ' + x1 + ' ' + b.Y1 + ' ' + z1 + ' kubejs:warping_frame')
        run('fill ' + x0 + ' ' + b.Y0 + ' ' + z0 + ' ' + x1 + ' ' + b.Y0 + ' ' + z1 + ' kubejs:warping_frame')
        run('fill ' + x0 + ' ' + b.Y0 + ' ' + z0 + ' ' + x1 + ' ' + b.Y1 + ' ' + z0 + ' kubejs:warping_frame')
        run('fill ' + x0 + ' ' + b.Y0 + ' ' + z1 + ' ' + x1 + ' ' + b.Y1 + ' ' + z1 + ' kubejs:warping_frame')
      } else if (dir === 'pz' || dir === 'nz') {
        run('fill ' + x0 + ' ' + b.Y1 + ' ' + z0 + ' ' + x1 + ' ' + b.Y1 + ' ' + z1 + ' kubejs:warping_frame')
        run('fill ' + x0 + ' ' + b.Y0 + ' ' + z0 + ' ' + x1 + ' ' + b.Y0 + ' ' + z1 + ' kubejs:warping_frame')
        run('fill ' + x0 + ' ' + b.Y0 + ' ' + z0 + ' ' + x0 + ' ' + b.Y1 + ' ' + z1 + ' kubejs:warping_frame')
        run('fill ' + x1 + ' ' + b.Y0 + ' ' + z0 + ' ' + x1 + ' ' + b.Y1 + ' ' + z1 + ' kubejs:warping_frame')
      } else if (dir === 'py') {
        run('fill ' + x0 + ' ' + y0 + ' ' + z0 + ' ' + x1 + ' ' + y0 + ' ' + z0 + ' kubejs:warping_frame')
        run('fill ' + x0 + ' ' + y0 + ' ' + z1 + ' ' + x1 + ' ' + y0 + ' ' + z1 + ' kubejs:warping_frame')
        run('fill ' + x0 + ' ' + y0 + ' ' + z0 + ' ' + x0 + ' ' + y0 + ' ' + z1 + ' kubejs:warping_frame')
        run('fill ' + x1 + ' ' + y0 + ' ' + z0 + ' ' + x1 + ' ' + y0 + ' ' + z1 + ' kubejs:warping_frame')
      }
    })
    // 地板最后铺：这一层必须是 platform（侧面屏障只到 Y0+1，不会覆盖它）
    if (b.gy === 0) {
      run('fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X1 + ' ' + b.Y0 + ' ' + b.Z1 + ' kubejs:warping_frame_platform')
      if (b.gx === 0 && b.gz === 0) {
        let FX = Math.floor((b.X0 + b.X1) / 2), FZ = Math.floor((b.Z0 + b.Z1) / 2)
        run('fill ' + (FX - 1) + ' ' + b.Y0 + ' ' + (FZ - 1) + ' ' + (FX + 1) + ' ' + b.Y0 + ' ' + (FZ + 1) + ' minecraft:air')
      }
    }
  })
  // 最后统一铺一遍地板（整个并集包围盒，一次覆盖）——避免逐格顺序/边界列被屏障盖住
  try {
    run('fill ' + u.X0 + ' ' + u.Y0 + ' ' + u.Z0 + ' ' + u.X1 + ' ' + u.Y0 + ' ' + u.Z1 + ' kubejs:warping_frame_platform replace minecraft:air')
    let a0 = C.baseAnchor(slot)
    let FX = a0.x, FZ = a0.z
    run('fill ' + (FX - 1) + ' ' + u.Y0 + ' ' + (FZ - 1) + ' ' + (FX + 1) + ' ' + u.Y0 + ' ' + (FZ + 1) + ' minecraft:air')
  } catch (eF2) {}
  console.info('[C4] 格子重建 slot=' + slot + ' cells=' + keys.join(' | '))
  return keys.length
}
// 加一格：先 forceload，打通共享边框那一层，再重建外边界
function c4AddCell(server, cube, dir, player) {
  let C = c4Cwc()
  if (!C || !cube) return false
  let slot = Number(cube.slot)
  let set = c4CellSet(cube)
  // 玩家在基地外 / 命令执行（无玩家）→ 从原点那格算
  let cur = player ? c4CellAt(slot, Math.floor(player.x), Math.floor(player.y), Math.floor(player.z)) : '0,0,0'
  let g = String(cur).split(',').map(Number)
  if (!set[cur]) { g = [0, 0, 0] }
  let n = [g[0] + (dir === 'px' ? 1 : dir === 'nx' ? -1 : 0),
           g[1] + (dir === 'py' ? 1 : 0),
           g[2] + (dir === 'pz' ? 1 : dir === 'nz' ? -1 : 0)]
  let key = c4CellKey(n[0], n[1], n[2])
  if (set[key]) { C.deny(player, '那个方向已经是基地的一部分了'); return false }
  let b = c4CellBox(slot, key)
  // 只 forceload，不再清空整格（清空会把玩家在新格里的方块一起铲掉）
  try {
    server.runCommandSilent('execute in minecraft:overworld run forceload add ' + (b.X0 - 16) + ' ' + (b.Z0 - 16) + ' ' + (b.X1 + 16) + ' ' + (b.Z1 + 16))
  } catch (eFL2) {}
  // 打通共享边框那一层（旧格的外墙）：只在这一层清成 air
  try {
    if (dir === 'px') server.runCommandSilent('execute in minecraft:overworld run fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X0 + ' ' + b.Y1 + ' ' + b.Z1 + ' minecraft:air')
    else if (dir === 'nx') server.runCommandSilent('execute in minecraft:overworld run fill ' + b.X1 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X1 + ' ' + b.Y1 + ' ' + b.Z1 + ' minecraft:air')
    else if (dir === 'pz') server.runCommandSilent('execute in minecraft:overworld run fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X1 + ' ' + b.Y1 + ' ' + b.Z0 + ' minecraft:air')
    else if (dir === 'nz') server.runCommandSilent('execute in minecraft:overworld run fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z1 + ' ' + b.X1 + ' ' + b.Y1 + ' ' + b.Z1 + ' minecraft:air')
    else if (dir === 'py') server.runCommandSilent('execute in minecraft:overworld run fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X1 + ' ' + b.Y0 + ' ' + b.Z1 + ' minecraft:air')
  } catch (e0) {}
  set[key] = 1
  cube.cells = Object.keys(set)
  C.save()
  c4RebuildCells(server, cube)
  return true
}

// ── 旧存档迁移：只有 cube.ext、没有 cube.cells 的老存档 → 矩形展开成格子并补外边界 ──
// 幂等：cellsMigrated 由【重建成功之后】的回调置位；中途崩服/停服 → 下次启动会重新迁移，
// 且此时 cells 已存在 → 直接沿用（不会把 L 形基地压回矩形）。
function c4CubeBySlot(slot) {
  let C = c4Cwc()
  if (!C) return null
  try {
    let db = C.db(), cubes = (db && db.cubes) || {}
    for (let k in cubes) if (cubes[k] && Number(cubes[k].slot) === Number(slot)) return cubes[k]
  } catch (e) {}
  return null
}
function c4MigrateExtToCells(server, cube) {
  if (!cube || !cube.provisioned) return 0
  if (cube.cellsMigrated) return 0
  let C = c4Cwc()
  if (!C) return 0
  let ext = C.ext(cube)
  let adopt = !!(cube.cells && cube.cells.length)
  if (!adopt) {
    let set = {}
    // 旧模型是"矩形"：gx ∈ [-nx..px]，gz ∈ [-nz..pz]，gy ∈ [0..py]
    for (let gy = 0; gy <= ext.py; gy++)
      for (let gx = -ext.nx; gx <= ext.px; gx++)
        for (let gz = -ext.nz; gz <= ext.pz; gz++)
          set[gx + ',' + gy + ',' + gz] = 1
    cube.cells = Object.keys(set)
  }
  let n = cube.cells.length
  cube.ext = { px: 0, nx: 0, pz: 0, nz: 0, py: 0 }   // 旧字段归零（仅作兼容占位）
  C.save()
  console.info('[C4] 旧存档迁移 slot=' + cube.slot + ' ext=' + JSON.stringify(ext)
    + ' → cells=' + n + ' 格' + (adopt ? '（沿用已有 cells）' : ''))

  let slot0 = Number(cube.slot)
  // forceload 是异步生效的：先申请常加载，留 40t 再重建，避免 fill 静默失败（屏障/地板没刷上）
  try {
    let u = c4CellUnion(slot0, cube.cells)
    server.runCommandSilent('execute in minecraft:overworld run forceload add '
      + (u.X0 - 16) + ' ' + (u.Z0 - 16) + ' ' + (u.X1 + 16) + ' ' + (u.Z1 + 16))
  } catch (eFL) {}
  server.scheduleInTicks(40, () => {
    try {
      let C2 = c4Cwc()
      if (!C2) return
      let live = c4CubeBySlot(slot0) || cube
      let built = c4RebuildCells(server, live)
      live.cellsMigrated = 1
      C2.save()
      console.info('[C4] 旧存档迁移补建完成 slot=' + slot0 + '（' + built + ' 格，外边界已重算）')
    } catch (eM) { console.warn('[C4] 迁移重建失败 slot=' + slot0 + ': ' + eM) }
  })
  return n
}
// 服务端启动 / `/reload` 后的第一个 tick 都会跑到这里
let C4_MIG_TICKED = false
function c4MigrateAllCubes(server) {
  let C = c4Cwc()
  if (!C) return 0
  let db = C.db(), cubes = (db && db.cubes) || {}, n = 0
  for (let k in cubes) {
    try { if (c4MigrateExtToCells(server, cubes[k])) n++ } catch (e1) {
      console.warn('[C4] 迁移异常 slot=' + (cubes[k] && cubes[k].slot) + ': ' + e1)
    }
  }
  if (n > 0) console.info('[C4] 扩建迁移完成：' + n + ' 台（ext → cells）')
  return n
}
ServerEvents.tick(event => {
  if (C4_MIG_TICKED) return
  C4_MIG_TICKED = true
  try { c4MigrateAllCubes(event.server) } catch (e) { console.warn('[C4] 扩建迁移异常: ' + e) }
})

// ════════════════════════════════════════════════════════════════════════════
// 扩展器 / 拆除器
// ════════════════════════════════════════════════════════════════════════════
let C4_EXP_CLICK = {}
let C4_HOLE_CLICK = {}   // 3×3 连接洞二次确认
let C4_EXT_TS = {}       // 每槽最近一次扩展时间（软锁：<400ms 视为抢跑）

function c4DoExpand(server, cube, face, player) {
  let C = c4Cwc()
  if (!C || !cube) return
  let slot = Number(cube.slot)          // ⚠ 原来这里直接用 slot，是 ReferenceError（工具右键永远失败）
  let ext = C.ext(cube)
  // S4：物品路径同样无上限，每次只加一级（+16）
  // 横向四面：格子化（每次加一格 16 深，按玩家所在格吸附）
  if (face === 'px' || face === 'nx' || face === 'pz' || face === 'nz') {
    let ok = c4AddCell(server, cube, face, player)
    if (ok) C.deny(player, '扩建完成：+16 格（' + face + '，当前 ' + c4Cells(cube).length + ' 格）')
    return
  }
  if (face === 'py') {
    let ok = c4AddCell(server, cube, 'py', player)
    try { if (ok && player && player.tell) C.deny(player, '扩建完成：向上 +16 格（共 ' + c4Cells(cube).length + ' 格）') } catch (e2) {}
    return
  }
  { C.deny(player, '该面不可扩展'); return }
  let nowMs2 = Date.now()
  if (C4_EXT_TS[slot] && (nowMs2 - C4_EXT_TS[slot]) < 400) { C.deny(player, '上一次扩展还在施工（<0.4s）'); return }
  C4_EXT_TS[slot] = nowMs2
  try {
    if (!player.isCreative()) {
      let st = player.mainHandItem
      if (!st || st.count <= 0 || String(st.id) !== 'kubejs:cube_expander') { C.deny(player, '手里没有扩展器'); return }
      st.shrink(1)
    }
  } catch (e) { console.warn('[C4] 扣扩展器失败: ' + e) }
  // 修法 1：物品路径也在命令时同步落盘
  let oldExt = C.ext(cube)
  cube.ext = ext
  C.save()
  C.applyExt(server, cube, ext, player, face, '扩展', oldExt)
}

function c4DoReduce(server, cube, face, player) {
  let C = c4Cwc()
  if (!C || !cube) return
  let ext = C.ext(cube)
  if (face === 'px') { if (ext.px <= 0) { C.deny(player, '+x 没有可拆的扩展'); return } ext.px-- }
  else if (face === 'nx') { if (ext.nx <= 0) { C.deny(player, '-x 没有可拆的扩展'); return } ext.nx-- }
  else if (face === 'nz') { if (ext.nz <= 0) { C.deny(player, '-z 没有可拆的扩展'); return } ext.nz-- }
  else if (face === 'py') { if (ext.py <= 0) { C.deny(player, '顶面没有可拆的扩展'); return } ext.py-- }
  else { C.deny(player, '该面不可拆除'); return }
  C.applyExt(server, cube, ext, player, face, '拆除', C.ext(cube))   // 拆除不返还材料
}

// /cube expand <slot> <px|nx|pz|nz|py> [force]（root 级；/cube admin expand 保留为别名）
// force 参数保留签名兼容，格子化路径不再有"内腔有建筑"安全闸。
function c4CmdExpand(ctx, face, force) {
  let C = c4Cwc()
  if (!C) return 0
  let server = ctx.source.server
  if (face !== 'nz' && face !== 'px' && face !== 'nx' && face !== 'py' && face !== 'pz') { C.reply(ctx, '该面不可扩展'); return 0 }
  C.refreshDb()
  let slot = Number(C.slot(ctx))
  let info = C.teamOfSlot(slot)
  if (!info || !info.cube) { C.reply(ctx, '槽位 ' + slot + ' 没有登记'); return 0 }
  // 横向四面 → 格子化（只扩基地，绝不动传送器）
  if (face === 'px' || face === 'nx' || face === 'pz' || face === 'nz') {
    let ok = c4AddCell(server, info.cube, face, null)
    C.reply(ctx, ok ? ('扩展 ' + face + ' 完成（格子 +1，共 ' + c4Cells(info.cube).length + ' 格）') : '该方向已有格子，未扩建')
    return 1
  }
  // 向上：同样格子化（按控制台/原点格向上加一格）
  let okPy = c4AddCell(server, info.cube, 'py', null)
  C.reply(ctx, okPy ? ('扩展 py 完成（格子 +1，共 ' + c4Cells(info.cube).length + ' 格）') : '那格已经在基地里了')
  return 1
}

// /cube rebuild <slot>（root 级，自愈：按 cells 重算并集外边界，幂等）
function c4CmdRebuild(ctx) {
  let C = c4Cwc()
  if (!C) return 0
  C.refreshDb()
  let slot = Number(C.slot(ctx))
  let info = C.teamOfSlot(slot)
  if (!info || !info.cube) { C.reply(ctx, '槽位 ' + slot + ' 没有登记'); return 0 }
  if (!info.cube.cells || !info.cube.cells.length) { C.reply(ctx, '槽位 ' + slot + ' 还没有格子数据（先 /cube expand 或等旧存档迁移）'); return 0 }
  let n = c4RebuildCells(ctx.source.server, info.cube)
  C.reply(ctx, '格子重建 slot' + slot + '：' + n + ' 格（外边界已重算）')
  return 1
}

// 操控台在 +z 面中心（x+0.5, 98, 8），必须站在它前面 3.5 格内操作
// 是否在【基地】盒内（扩展/拆除只认基地；传送器固定 17³ 不允许改）
function c4InBase(p, slot) {
  let C = c4Cwc()
  if (!C) return false
  try {
    if (C.dimOf(p) !== 'minecraft:overworld') return false
    let info = C.teamOfSlot(slot)
    let keys = c4Cells(info ? info.cube : null)
    let b = c4CellUnion(slot, keys)
    return p.x >= b.X0 - 1 && p.x <= b.X1 + 2 && p.z >= b.Z0 - 1 && p.z <= b.Z1 + 2
      && p.y >= b.Y0 - 1 && p.y <= b.Y1 + 2
  } catch (e) { return false }
}
function c4AtConsole(p, cube) {
  let C = c4Cwc()
  if (!C) return false
  // 站在【按钮锚点派生的舱体】内部就能操作
  let b = C.btnPos(cube.slot)
  let cx = b.x + 0.5, cz = b.z - 6.5
  return Math.abs(p.x - cx) <= 7.5 && Math.abs(p.z - cz) <= 7.5 && p.y >= b.y - 1 && p.y <= b.y + 15
}

function c4ToolUse(event, reduce) {
  try {
    let C = c4Cwc()
    if (!C) return
    let p = event.player, server = event.server
    let t = C.team(p), key = t ? C.teamKey(t) : null
    let cube = key ? C.cubeOfTeam(key) : null
    if (!cube) { C.deny(p, '你还没有立方体'); return }
    // 视线朝下 + 洞口附近双击：扩展器 = 激活 3×3，拆除器 = 拆掉 3×3
    if (Number(p.pitch) > 55) {
      let nearHole = (a) => {
        let dd = Math.sqrt(Math.pow(p.x - (a.x + 0.5), 2) + Math.pow(p.z - (a.z + 0.5), 2))
        return dd < 5.5 && Math.abs(p.y - a.y) < 7
      }
      if (nearHole(C.baseAnchor(cube.slot)) || nearHole(C.teleAnchor(cube.slot))) {
        let now0 = Date.now(), k0 = 'hole:' + (reduce ? 'r:' : 'e:') + C.name(p) + ':' + cube.slot
        let last0 = C4_HOLE_CLICK[k0]
        if (!last0 || now0 - last0 > 5000) {
          C4_HOLE_CLICK[k0] = now0
          C.deny(p, reduce ? '隧道: 再右键一次确认【拆除】' : '隧道: 再右键一次确认激活')
          return
        }
        C4_HOLE_CLICK[k0] = 0
        if (reduce) C.deactivateHole(server, cube.slot, p)
        else C.activateHole(server, cube.slot, p)
        return
      }
    }
    // 不朝下：只能在【基地】内用（传送器固定 17³，不许改）
    if (!c4InBase(p, cube.slot)) { C.deny(p, '扩展/拆除只能在基地内部使用'); return }
    let yaw = ((Number(p.yaw) % 360) + 360) % 360
    let pitch = Number(p.pitch)
    let face = null
    // MC 的 XRot：正 = 低头，负 = 抬头
    if (pitch < -50) face = 'py'
    else if (pitch > 50) { C.deny(p, '底面不可操作'); return }
    else face = ['z', 'nx', 'nz', 'px'][Math.round(yaw / 90) % 4]   // +z/-x/-z/+x 四面都能扩
    // +z 面原来是操控台那一面：只有传送器按钮已经搬到 y=11（新布局）时才允许扩基地 +z
    if (face === 'z' && Math.floor(C.btnPos(cube.slot).y) !== 11) {
      C.deny(p, '+z 面要等传送器搬到 y=11 之后才能扩（旧基地请先按一次旧按钮完成迁移）')
      return
    }
    let now = Date.now(), k = (reduce ? 'r:' : 'e:') + C.name(p)
    let last = C4_EXP_CLICK[k]
    if (!last || last.face !== face || now - last.t > 2000) {
      C4_EXP_CLICK[k] = { face: face, t: now }
      C.deny(p, (reduce ? '拆除' : '扩展') + ' ' + face + '：再右键一次确认（2 秒内）')
      return
    }
    C4_EXP_CLICK[k] = null
    if (reduce) c4DoReduce(server, cube, face, p)
    else c4DoExpand(server, cube, face, p)
  } catch (e) { console.warn('[C4] 工具右键: ' + e) }
}

ItemEvents.rightClicked('kubejs:cube_expander', event => c4ToolUse(event, false))

ItemEvents.rightClicked('kubejs:cube_reducer', event => c4ToolUse(event, true))

// 供 cw_cubes.js 的命令树 / 其它脚本使用（运行时才读取）
global.CWE = {
  cells: c4Cells,
  cellKey: c4CellKey,
  cellSet: c4CellSet,
  cellBox: c4CellBox,
  cellAt: c4CellAt,
  cellUnion: c4CellUnion,
  rebuild: c4RebuildCells,
  addCell: c4AddCell,
  migrateExtToCells: c4MigrateExtToCells,
  migrateAll: c4MigrateAllCubes,
  cmdExpand: c4CmdExpand,
  cmdRebuild: c4CmdRebuild,
  expand: c4DoExpand,
  reduce: c4DoReduce,
  inBase: c4InBase,
  atConsole: c4AtConsole,
}
