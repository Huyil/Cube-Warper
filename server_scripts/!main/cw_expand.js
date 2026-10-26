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
// 格子化扩建（横向 ±x/±z + 向下 ny，无上限；2026-10 起禁用向上 py）
//   每格 16 深 × 17 高 × 16 宽（相邻格共享 1 格边框：17 = 16+1）
//   cells 存在 cube.cells：["0,0,0", "1,0,0", "0,-1,0", ...]（相对基地原点的格坐标）
//   只建【并集的外边界】：地板、外墙屏障、外框梁、外面那圈 structure_void；
//   相邻格之间的旧边框在新增时被清掉，内部保持连通。
//   向下 ny：共享层 = 新格顶面（旧格地板），Y0 下移 16、Y1 不变；目标格是地形 → 直接挖空内部。
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
// 旧存档只有 ext、没有 cells 时，按矩形展开成 cells（幂等；由显式重建/扩建触发，不再开机自动跑）
function c4EnsureCells(cube) {
  if (!cube) return []
  if (cube.cells && cube.cells.length) return cube.cells
  let C = c4Cwc()
  let ext = C ? C.ext(cube) : { px: 0, nx: 0, pz: 0, nz: 0, py: 0 }
  let n = (Number(ext.px) | 0) + (Number(ext.nx) | 0) + (Number(ext.pz) | 0) + (Number(ext.nz) | 0) + (Number(ext.py) | 0)
  if (n <= 0) return ['0,0,0']
  // ⚠ 新模型不允许向上扩建：旧 ext.py 一律忽略，只展开 gy=0（否则会在舱体位置生成向上格，把按钮/舱体刷掉）
  let set = {}
  if ((Number(ext.py) | 0) > 0) console.warn('[C4] slot=' + cube.slot + ' 旧 ext.py=' + ext.py + ' 已忽略（不再支持向上扩建）')
  for (let gx = -(Number(ext.nx) | 0); gx <= (Number(ext.px) | 0); gx++)
    for (let gz = -(Number(ext.nz) | 0); gz <= (Number(ext.pz) | 0); gz++)
      set[c4CellKey(gx, 0, gz)] = 1
  cube.cells = Object.keys(set)
  try { if (C && C.save) C.save() } catch (e0) {}
  console.info('[C4] 旧 ext 展开成 cells：slot=' + cube.slot + ' → ' + cube.cells.length + ' 格（' + cube.cells.join(' | ') + '）')
  return cube.cells
}
function c4RebuildCells(server, cube) {
  let C = c4Cwc()
  if (!C || !cube) return 0
  let slot = Number(cube.slot)
  c4EnsureCells(cube)
  // ★ 封墙之前先判断：外表面（马上要被填成框梁的那一圈）上如果已经有东西（玩家方块/地形），
  //   就自动在那个方向免费扩 1 格，把这些方块包进房间，而不是直接封墙把它们埋掉。
  try { c4AutoExpandForBorderItems(server, cube) } catch (eB) { console.warn('[C4] 封墙前边框判断失败: ' + eB) }
  let keys = c4Cells(cube), set = c4CellSet(cube)
  let run = (cmd) => { try { server.runCommandSilent('execute in minecraft:overworld run ' + cmd) } catch (e) {} }
  // 旧版隐形壳：minecraft:barrier / minecraft:structure_void / kubejs:hexahedron_filling。
  // 新方案不再生成它们（污染：看不见、拆不掉、占位），顺手把旧档里的清干净。
  let LEGACY = ['minecraft:barrier', 'minecraft:structure_void', 'kubejs:hexahedron_filling']
  let clearLegacy = (x0, y0, z0, x1, y1, z1) => {
    LEGACY.forEach(t => run('fill ' + x0 + ' ' + y0 + ' ' + z0 + ' ' + x1 + ' ' + y1 + ' ' + z1 + ' minecraft:air replace ' + t))
  }
  let u = c4CellUnion(slot, keys)
  // 先把并集范围 forceload（否则超出范围的 fill 会静默失败）
  try { run('forceload add ' + (u.X0 - 16) + ' ' + (u.Z0 - 16) + ' ' + (u.X1 + 16) + ' ' + (u.Z1 + 16)) } catch (eFL) {}
  // 并集外再扩 2 格，把旧版外壳留在房间外面的屏障/结构空位/正方体一并清掉（分片，避免 fill 超 32768）
  try {
    let ex = 2
    let w = (u.X1 + ex) - (u.X0 - ex) + 1, d = (u.Z1 + ex) - (u.Z0 - ex) + 1
    let step = Math.max(1, Math.floor(28000 / Math.max(1, w * d)))
    for (let yy = u.Y0 - ex; yy <= u.Y1 + ex; yy += step) {
      let y2 = Math.min(yy + step - 1, u.Y1 + ex)
      LEGACY.forEach(t => run('fill ' + (u.X0 - ex) + ' ' + yy + ' ' + (u.Z0 - ex) + ' '
        + (u.X1 + ex) + ' ' + y2 + ' ' + (u.Z1 + ex) + ' minecraft:air replace ' + t))
    }
  } catch (eBig) { console.warn('[C4] 外壳全清失败: ' + eBig) }
  // 6 邻接：有邻居 = 连接面（打通）；没邻居 = 外表面（整面封死）
  let DIRS = [['px', 1, 0, 0], ['nx', -1, 0, 0], ['pz', 0, 0, 1], ['nz', 0, 0, -1], ['py', 0, 1, 0], ['ny', 0, -1, 0]]
  let stamped = 0
  keys.forEach(k => {
    let b = c4CellBox(slot, k)
    // ① 清掉这一格里的旧版隐形方块 + 旧结构残留的框梁/半砖/通风口（只 replace 这几种，玩家方块不动）
    clearLegacy(b.X0, b.Y0, b.Z0, b.X1, b.Y1, b.Z1)
    // 房间内部（不含六面壳）：凸起的诡异框架/半砖/通风口也清掉，避免初始基地里留一圈"凸起"
    ;['kubejs:warping_frame', 'kubejs:warping_frame_platform', 'kubejs:warping_vent',
      'kubejs:launch_button', 'kubejs:launch_button_pressed',
      'kubejs:warping_controls', 'kubejs:warping_interface', 'kubejs:warping_disc_drive'].forEach(t => {
      run('fill ' + (b.X0 + 1) + ' ' + (b.Y0 + 1) + ' ' + (b.Z0 + 1) + ' '
        + (b.X1 - 1) + ' ' + (b.Y1 - 1) + ' ' + (b.Z1 - 1) + ' minecraft:air replace ' + t)
    })
    // ② 预制封闭立方体：六面逐面判断
    DIRS.forEach(dd => {
      let dir = dd[0]
      let nk = c4CellKey(b.gx + dd[1], b.gy + dd[2], b.gz + dd[3])
      let x0 = b.X0, x1 = b.X1, y0 = b.Y0, y1 = b.Y1, z0 = b.Z0, z1 = b.Z1
      if (dir === 'px') x0 = x1 = b.X1
      else if (dir === 'nx') x0 = x1 = b.X0
      else if (dir === 'pz') z0 = z1 = b.Z1
      else if (dir === 'nz') z0 = z1 = b.Z0
      else if (dir === 'py') y0 = y1 = b.Y1
      else if (dir === 'ny') y0 = y1 = b.Y0
      if (set[nk]) {
        // 连接面：只开【内圈 15×15】，保留最外一圈框梁。
        // 整面全开会把共享层那一圈墙也挖掉 → 上下扩建时 Y97 会留一圈缝隙直接漏到外面（实测过）。
        let cx0 = x0, cx1 = x1, cy0 = y0, cy1 = y1, cz0 = z0, cz1 = z1
        if (dir === 'px' || dir === 'nx') { cy0++; cy1--; cz0++; cz1-- }
        else if (dir === 'pz' || dir === 'nz') { cy0++; cy1--; cx0++; cx1-- }
        else { cx0++; cx1--; cz0++; cz1-- }   // py / ny：只开中间 15×15
        run('fill ' + cx0 + ' ' + cy0 + ' ' + cz0 + ' ' + cx1 + ' ' + cy1 + ' ' + cz1 + ' minecraft:air replace kubejs:warping_frame')
        run('fill ' + cx0 + ' ' + cy0 + ' ' + cz0 + ' ' + cx1 + ' ' + cy1 + ' ' + cz1 + ' minecraft:air replace kubejs:warping_frame_platform')
        run('fill ' + cx0 + ' ' + cy0 + ' ' + cz0 + ' ' + cx1 + ' ' + cy1 + ' ' + cz1 + ' minecraft:air replace kubejs:warping_vent')
        clearLegacy(cx0, cy0, cz0, cx1, cy1, cz1)
        return
      }
      // 地板也用整块框架（用户明确不要 warping_frame_platform 半砖）
      let blk = 'kubejs:warping_frame'
      clearLegacy(x0, y0, z0, x1, y1, z1)
      if (dir === 'ny') {
        // 地板：整面整块框架（不是半砖；这是新格的底，不会盖到玩家方块）
        run('fill ' + x0 + ' ' + y0 + ' ' + z0 + ' ' + x1 + ' ' + y1 + ' ' + z1 + ' ' + blk)
      } else {
        // 墙/顶：整面 frame（只补空气：玩家放的方块保留，已有框梁保留）。
        // 基地原点格也一样封死——6 面大传送门在【传送仓】上，基地只是住人的封闭盒。
        run('fill ' + x0 + ' ' + y0 + ' ' + z0 + ' ' + x1 + ' ' + y1 + ' ' + z1 + ' ' + blk + ' replace minecraft:air')
      }
      // 旧版外表面再外 1 格的屏障/结构空位环：清掉，不再生成
      if (dir === 'px') clearLegacy(b.X1 + 1, b.Y0, b.Z0, b.X1 + 1, b.Y1, b.Z1)
      else if (dir === 'nx') clearLegacy(b.X0 - 1, b.Y0, b.Z0, b.X0 - 1, b.Y1, b.Z1)
      else if (dir === 'pz') clearLegacy(b.X0, b.Y0, b.Z1 + 1, b.X1, b.Y1, b.Z1 + 1)
      else if (dir === 'nz') clearLegacy(b.X0, b.Y0, b.Z0 - 1, b.X1, b.Y1, b.Z0 - 1)
      else if (dir === 'py') clearLegacy(b.X0, b.Y1 + 1, b.Z0, b.X1, b.Y1 + 1, b.Z1)
      else if (dir === 'ny') clearLegacy(b.X0, b.Y0 - 1, b.Z0, b.X1, b.Y0 - 1, b.Z1)
    })
    // ③ 基地原点格：天花板中央 3×3 = 隧道洞（上面没格才留）
    if (b.gx === 0 && b.gz === 0 && b.gy === 0 && !set[c4CellKey(b.gx, b.gy + 1, b.gz)]) {
      let HX = Math.floor((b.X0 + b.X1) / 2), HZ = Math.floor((b.Z0 + b.Z1) / 2)
      run('fill ' + (HX - 1) + ' ' + b.Y1 + ' ' + (HZ - 1) + ' ' + (HX + 1) + ' ' + b.Y1 + ' ' + (HZ + 1) + ' minecraft:air')
    }
    // ④ 隐藏光源：天花板下 1 格，每 5 格一颗（只放在空气里，和传送仓同款）
    let ly = b.Y1 - 1
    let CX = Math.floor((b.X0 + b.X1) / 2), CZ = Math.floor((b.Z0 + b.Z1) / 2)
    run('fill ' + CX + ' ' + ly + ' ' + CZ + ' ' + CX + ' ' + ly + ' ' + CZ + ' minecraft:light replace minecraft:air')
    for (let lx = b.X0 + 2; lx <= b.X1 - 2; lx += 5) {
      for (let lz = b.Z0 + 2; lz <= b.Z1 - 2; lz += 5) {
        run('fill ' + lx + ' ' + ly + ' ' + lz + ' ' + lx + ' ' + ly + ' ' + lz + ' minecraft:light replace minecraft:air')
      }
    }
    stamped++
  })
  console.info('[C4] 格子重建 slot=' + slot + ' cells=' + keys.join(' | ')
    + '（封闭立方体×' + stamped + '，无 barrier/structure_void/filling）')
  return keys.length
}
// ── 目标格空气检查 ───────────────────────────────────────────────────────────
// 扩建：除“共享边框那一层”外，整格只允许 air / light / structure_void（旧外壳）。
// 拆除：只扫内部 15³（边界是基地自己的框梁/地板/屏障），air/light/空位/kubejs/barrier 放行。
function c4CellIdAt(lv, x, y, z) {
  try { let bl = lv.getBlock(x, y, z); return bl ? String(bl.id) : '' } catch (e) { return '' }
}
// 扩建：只有"边框/六个面"会被写，判断时放行这些"扩建时会清掉"的方块 + 水/熔岩
function c4CellEmptyForExpand(id) {
  return !id || id === 'minecraft:air' || id === 'minecraft:cave_air' || id === 'minecraft:void_air'
    || id === 'minecraft:light' || id === 'minecraft:structure_void'
    || id === 'kubejs:hexahedron_filling'    // 旧版立方体外壳（隐形、无碰撞的“正方体”）
    || id === 'minecraft:barrier'            // 旧版屏障
    || id === 'kubejs:warping_frame'         // 世界 16 格网格/旧壳的框梁
    || id === 'kubejs:warping_frame_platform' // 旧档地板半砖
    || id === 'kubejs:warping_vent'           // 诡异通风口（装饰）
    || id === 'kubejs:launch_button' || id === 'kubejs:launch_button_pressed'  // 旧版残留红色按钮（直接覆盖）
    || id === 'kubejs:warping_controls' || id === 'kubejs:warping_interface' || id === 'kubejs:warping_disc_drive'  // 按钮附着的面板三件套
    || id === 'minecraft:water' || id === 'minecraft:lava'   // 流体：扩建时清掉
}
// 拆除：整格逐块判断——只放行空气/隐藏光源 + 基地自己的外壳（扩建时本来就会重建/清掉的那些），
// 其余（玩家方块、石头、水/熔岩、其它模组方块）统统算占位，绝不静默擦除。
function c4CellEmptyForReduce(id) {
  return !id || id === 'minecraft:air' || id === 'minecraft:cave_air' || id === 'minecraft:void_air'
    || id === 'minecraft:light'
    || id === 'kubejs:warping_frame' || id === 'kubejs:warping_frame_platform' || id === 'kubejs:warping_vent'
    || id === 'minecraft:barrier' || id === 'minecraft:structure_void' || id === 'kubejs:hexahedron_filling'
    || id === 'minecraft:water' || id === 'minecraft:lava'   // 流体不算占位（拆除时直接清掉）
    || id === 'kubejs:launch_button' || id === 'kubejs:launch_button_pressed'
    || id === 'kubejs:warping_controls' || id === 'kubejs:warping_interface' || id === 'kubejs:warping_disc_drive'
}
function c4CellScan(server, b, dir, forReduce) {
  let C = c4Cwc()
  if (!C) return { ok: false, msg: '扩建模块未就绪' }
  let lv = C.owLevel(server)
  if (!lv) return { ok: true }        // 读不到方块就不拦（避免误伤）
  let okId = forReduce ? c4CellEmptyForReduce : c4CellEmptyForExpand
  let bad = 0, firstId = '', fx = 0, fy = 0, fz = 0
  let check = (x, y, z) => {
    let id = c4CellIdAt(lv, x, y, z)
    if (okId(id)) return
    bad++
    if (!firstId) { firstId = id; fx = x; fy = y; fz = z }
  }
  if (forReduce) {
    // 拆除：整个格子逐块扫（含 6 个边界平面——拆除会把整格 fill 成空气，
    // 边界上玩家放的方块也会被清掉，所以必须一起判断）
    for (let y = b.Y0; y <= b.Y1; y++) {
      for (let x = b.X0; x <= b.X1; x++) {
        for (let z = b.Z0; z <= b.Z1; z++) check(x, y, z)
      }
    }
  } else {
    // 扩建：只判断【六个面】——扩建只会写这些面（其余内部不动，玩家方块不会被覆盖）
    let planes = [
      [b.X0, b.X0, b.Y0, b.Y1, b.Z0, b.Z1],   // -x
      [b.X1, b.X1, b.Y0, b.Y1, b.Z0, b.Z1],   // +x
      [b.X0, b.X1, b.Y0, b.Y0, b.Z0, b.Z1],   // 地板
      [b.X0, b.X1, b.Y1, b.Y1, b.Z0, b.Z1],   // 天花板
      [b.X0, b.X1, b.Y0, b.Y1, b.Z0, b.Z0],   // -z
      [b.X0, b.X1, b.Y0, b.Y1, b.Z1, b.Z1]    // +z
    ]
    planes.forEach(pl => {
      for (let y = pl[2]; y <= pl[3]; y++) {
        for (let x = pl[0]; x <= pl[1]; x++) {
          for (let z = pl[4]; z <= pl[5]; z++) check(x, y, z)
        }
      }
    })
  }
  return bad ? { ok: false, msg: bad + ' 格非空（首个 ' + firstId + ' @' + fx + ',' + fy + ',' + fz + '）',
                 firstId: firstId, x: fx, y: fy, z: fz, bad: bad } : { ok: true, firstId: '', bad: 0 }
}
// 统一占位提示：物品名用 JEI 的 item_stack 形式，方便直接点/查
function c4OccupyMsg(chk) {
  let id = (chk && chk.firstId) ? chk.firstId : 'minecraft:air'
  return '被占位: 需移除 [JEI:v1:item_stack;' + id + '] (' + ((chk && chk.x) | 0) + ',' + ((chk && chk.y) | 0) + ',' + ((chk && chk.z) | 0) + ')'
}
// 6 邻接连通性（拆掉某格后基地必须还是一整块）
function c4CellsConnected(set, start) {
  if (!set[start]) return false
  let seen = {}, q = [start], cnt = 0
  seen[start] = 1
  let dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  while (q.length) {
    let k = q.shift()
    cnt++
    let g = String(k).split(',').map(Number)
    for (let i = 0; i < dirs.length; i++) {
      let nk = c4CellKey(g[0] + dirs[i][0], g[1] + dirs[i][1], g[2] + dirs[i][2])
      if (set[nk] && !seen[nk]) { seen[nk] = 1; q.push(nk) }
    }
  }
  return cnt === Object.keys(set).length
}
// 生存消耗 1 个扩展器（主手优先，其次副手）；创造/命令路径不扣
// 拆除返还 1 个扩展器（创造不还）；用 /give，背包满会掉在脚下
// 加格前清掉新格里的“模组自己”的填充：旧外壳 structure_void + 旧版正方体填充。
// 只 replace 这两种方块，玩家方块/地形一格不碰（它们会先被空气检查拦下）。
function c4ClearNewCellFill(server, b) {
  let run = (cmd) => { try { server.runCommandSilent('execute in minecraft:overworld run ' + cmd) } catch (e) {} }
  run('fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X1 + ' ' + b.Y1 + ' ' + b.Z1 + ' minecraft:air replace minecraft:structure_void')
  run('fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X1 + ' ' + b.Y1 + ' ' + b.Z1 + ' minecraft:air replace kubejs:hexahedron_filling')
  // 边框外 1 格那层屏障（新格子里会落进去的那一面）也要一起清掉
  run('fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X1 + ' ' + b.Y1 + ' ' + b.Z1 + ' minecraft:air replace minecraft:barrier')
  run('fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X1 + ' ' + b.Y1 + ' ' + b.Z1 + ' minecraft:air replace kubejs:warping_frame')
  run('fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X1 + ' ' + b.Y1 + ' ' + b.Z1 + ' minecraft:air replace kubejs:warping_frame_platform')
  run('fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X1 + ' ' + b.Y1 + ' ' + b.Z1 + ' minecraft:air replace kubejs:warping_vent')
  run('fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X1 + ' ' + b.Y1 + ' ' + b.Z1 + ' minecraft:air replace kubejs:launch_button')
  run('fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X1 + ' ' + b.Y1 + ' ' + b.Z1 + ' minecraft:air replace kubejs:launch_button_pressed')
  run('fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X1 + ' ' + b.Y1 + ' ' + b.Z1 + ' minecraft:air replace kubejs:warping_interface')
  run('fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X1 + ' ' + b.Y1 + ' ' + b.Z1 + ' minecraft:air replace kubejs:warping_controls')
  run('fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X1 + ' ' + b.Y1 + ' ' + b.Z1 + ' minecraft:air replace kubejs:warping_disc_drive')
  // 水和熔岩：判断时放行，真正扩建时清掉（不然会灌进新房间）
  run('fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X1 + ' ' + b.Y1 + ' ' + b.Z1 + ' minecraft:air replace minecraft:water')
  run('fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X1 + ' ' + b.Y1 + ' ' + b.Z1 + ' minecraft:air replace minecraft:lava')
}
// 拆掉一格：清整格体积 + 该格外表面那两圈（外 1 格屏障 / 外 2 格结构空位），随后由 c4RebuildCells 把并集外边界补回
function c4ClearRemovedCell(server, b, set2) {
  let run = (cmd) => { try { server.runCommandSilent('execute in minecraft:overworld run ' + cmd) } catch (e) {} }
  run('fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X1 + ' ' + b.Y1 + ' ' + b.Z1 + ' minecraft:air')
  let DIRS = [['px', 1, 0, 0], ['nx', -1, 0, 0], ['pz', 0, 0, 1], ['nz', 0, 0, -1], ['py', 0, 1, 0], ['ny', 0, -1, 0]]
  DIRS.forEach(dd => {
    let nk = c4CellKey(b.gx + dd[1], b.gy + dd[2], b.gz + dd[3])
    if (set2[nk]) return
    let dir = dd[0]
    // 外侧那两圈：±1（屏障）和 ±2（结构空位），两种方块各 replace 一次
    let bx0 = b.X0, bx1 = b.X1, by0 = b.Y0, by1 = b.Y1, bz0 = b.Z0, bz1 = b.Z1
    if (dir === 'px') { bx0 = b.X1 + 1; bx1 = b.X1 + 2; bz0 = b.Z0 - 1; bz1 = b.Z1 + 1 }
    else if (dir === 'nx') { bx0 = b.X0 - 2; bx1 = b.X0 - 1; bz0 = b.Z0 - 1; bz1 = b.Z1 + 1 }
    else if (dir === 'pz') { bx0 = b.X0 - 1; bx1 = b.X1 + 1; bz0 = b.Z1 + 1; bz1 = b.Z1 + 2 }
    else if (dir === 'nz') { bx0 = b.X0 - 1; bx1 = b.X1 + 1; bz0 = b.Z0 - 2; bz1 = b.Z0 - 1 }
    else if (dir === 'py') { bx0 = b.X0 - 1; bx1 = b.X1 + 1; by0 = b.Y1 + 1; by1 = b.Y1 + 2; bz0 = b.Z0 - 1; bz1 = b.Z1 + 1 }
    else if (dir === 'ny') { bx0 = b.X0 - 1; bx1 = b.X1 + 1; by0 = b.Y0 - 2; by1 = b.Y0 - 1; bz0 = b.Z0 - 1; bz1 = b.Z1 + 1 }
    ;['minecraft:barrier', 'minecraft:structure_void'].forEach(t => {
      run('fill ' + bx0 + ' ' + by0 + ' ' + bz0 + ' ' + bx1 + ' ' + by1 + ' ' + bz1 + ' minecraft:air replace ' + t)
    })
  })
  run('fill ' + b.X0 + ' ' + (b.Y0 - 1) + ' ' + b.Z0 + ' ' + b.X1 + ' ' + (b.Y0 - 1) + ' ' + b.Z1 + ' minecraft:air replace minecraft:structure_void')
}

// 加一格：先验空/扣物品，再 forceload、打通共享边框、清旧壳，最后重建外边界
function c4AddCell(server, cube, dir, player, force) {
  let C = c4Cwc()
  if (!C || !cube) return { ok: false, reason: 'error' }
  let slot = Number(cube.slot)
  c4EnsureCells(cube)
  let set = c4CellSet(cube)
  // 玩家必须在某个已登记格里；命令执行（无玩家）从原点格算
  let cur = player ? c4CellAt(slot, Math.floor(player.x), Math.floor(player.y), Math.floor(player.z)) : '0,0,0'
  if (player && !set[cur]) { C.deny(player, '你不在基地的格子里，扩建已取消'); return { ok: false, reason: 'outside' } }
  let g = String(cur).split(',').map(Number)
  let n = [g[0] + (dir === 'px' ? 1 : dir === 'nx' ? -1 : 0),
           g[1] + (dir === 'py' ? 1 : dir === 'ny' ? -1 : 0),
           g[2] + (dir === 'pz' ? 1 : dir === 'nz' ? -1 : 0)]
  let key = c4CellKey(n[0], n[1], n[2])
  if (set[key]) { C.deny(player, '那个方向已经是基地的一部分了'); return { ok: false, reason: 'exists' } }
  let b = c4CellBox(slot, key)
  // 向下扩建：不许低于维度最低可建高度（地板/结构空位/屏障都要留位置）
  if (dir === 'ny') {
    let minY = -64
    try { let lv = C.owLevel(server); if (lv) minY = Number(lv.getMinBuildHeight()) } catch (eMin) {}
    if (b.Y0 - 1 < minY + 1) {
      C.deny(player, '已经到世界最低高度了（下限 ' + minY + '），不能再向下扩建')
      return { ok: false, reason: 'ymin' }
    }
  }
  // ① 目标格必须是空的（force 仅给 /cube admin expand ... force 用）
  //    例外：ny（向下）= 往地里挖，目标格本来就会是实心地形 → 不检查，改为自动把内部 15³ 挖空
  if (!force && dir !== 'ny') {
    let chk = c4CellScan(server, b, dir, false)
    if (!chk.ok) {
      let occupyMsg = c4OccupyMsg(chk)
      if (player && C.chat) C.chat(player, occupyMsg)
      else C.deny(player, occupyMsg)
      return { ok: false, reason: 'air', msg: chk.msg, firstId: chk.firstId, x: chk.x, y: chk.y, z: chk.z, bad: chk.bad }
    }
  }
  // ② 扩建不再检查/消耗扩展器物品（按需求忽略物品检测）
  // ③ 只 forceload，不再清空整格（目标格已验空）
  try {
    server.runCommandSilent('execute in minecraft:overworld run forceload add ' + (b.X0 - 16) + ' ' + (b.Z0 - 16) + ' ' + (b.X1 + 16) + ' ' + (b.Z1 + 16))
  } catch (eFL2) {}
  // ④ 打通共享边框那一层（旧格的外墙）
  try {
    if (dir === 'px') server.runCommandSilent('execute in minecraft:overworld run fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X0 + ' ' + b.Y1 + ' ' + b.Z1 + ' minecraft:air')
    else if (dir === 'nx') server.runCommandSilent('execute in minecraft:overworld run fill ' + b.X1 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X1 + ' ' + b.Y1 + ' ' + b.Z1 + ' minecraft:air')
    else if (dir === 'pz') server.runCommandSilent('execute in minecraft:overworld run fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X1 + ' ' + b.Y1 + ' ' + b.Z0 + ' minecraft:air')
    else if (dir === 'nz') server.runCommandSilent('execute in minecraft:overworld run fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z1 + ' ' + b.X1 + ' ' + b.Y1 + ' ' + b.Z1 + ' minecraft:air')
    else if (dir === 'py') server.runCommandSilent('execute in minecraft:overworld run fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X1 + ' ' + b.Y0 + ' ' + b.Z1 + ' minecraft:air')
    else if (dir === 'ny') server.runCommandSilent('execute in minecraft:overworld run fill ' + b.X0 + ' ' + b.Y1 + ' ' + b.Z0 + ' ' + b.X1 + ' ' + b.Y1 + ' ' + b.Z1 + ' minecraft:air')
  } catch (e0) {}
  // ④.5 向下扩建：把新格内部 15³ 挖成空气（地板 Y0 + 四壁/共享层 Y1 由 c4RebuildCells 统一铺）
  if (dir === 'ny') {
    try {
      server.runCommandSilent('execute in minecraft:overworld run fill ' + (b.X0 + 1) + ' ' + (b.Y0 + 1) + ' ' + (b.Z0 + 1)
        + ' ' + (b.X1 - 1) + ' ' + (b.Y1 - 1) + ' ' + (b.Z1 - 1) + ' minecraft:air')
      console.info('[C4] 向下扩建挖空内部 slot=' + slot + ' cell=' + key + ' y ' + (b.Y0 + 1) + '..' + (b.Y1 - 1))
    } catch (eDig) { console.warn('[C4] 向下扩建挖空失败: ' + eDig) }
  }
  // ⑤ 清掉新格里的旧外壳/旧版填充（只动这两种方块）
  c4ClearNewCellFill(server, b)
  set[key] = 1
  cube.cells = Object.keys(set)
  C.save()
  c4RebuildCells(server, cube)
  return { ok: true }
}

// 只清并集包围盒【内部】的 structure_void —— 旧格子扩建留下的成片空位。
//   · 外表面那圈壳在包围盒外（X0-1 / X1+1 / Y0-1 / Y1+1 / Z0-1 / Z1+1），不会被碰到；
//   · 凹形基地“凹口里的外表面壳”虽然在包围盒内，但调用方随后必须 c4RebuildCells，
//     重建会把外表面重新刷回来；单独调用它（不重建）可能给凹口开洞。
//   · 只 replace structure_void，不碰玩家方块/框梁/屏障/地板。
function c4ClearInnerVoid(server, cube) {
  let C = c4Cwc()
  if (!C || !cube) return 0
  let slot = Number(cube.slot)
  let keys = c4Cells(cube)
  if (!keys || !keys.length) return 0
  let b = c4CellUnion(slot, keys)
  let run = (cmd) => {
    try { return Number(server.runCommandSilent('execute in minecraft:overworld run ' + cmd)) || 0 } catch (e) { return 0 }
  }
  // 单条 fill 上限 32768：按 y 分层，和 c4RebuildCells/清环带同一套路
  let w = b.X1 - b.X0 + 1, d = b.Z1 - b.Z0 + 1
  let step = Math.max(1, Math.floor(30000 / Math.max(1, w * d)))
  let n = 0
  for (let y = b.Y0; y <= b.Y1; y += step) {
    let y2 = Math.min(y + step - 1, b.Y1)
    n += run('fill ' + b.X0 + ' ' + y + ' ' + b.Z0 + ' ' + b.X1 + ' ' + y2 + ' ' + b.Z1
      + ' minecraft:air replace minecraft:structure_void')
  }
  if (n > 0) console.info('[C4] 清理内部结构空位 slot=' + slot + '：' + n + ' 格')
  return n
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
// ── 旧存档升级：老基地只有"边框"（整面框梁中间 15×15 是空的，玩家能在边框平面放方块）──
// 新模型会把整面封成框梁 → 边框平面上的玩家方块会被埋进墙里。
// 规则：哪一面边框上有人放的方块，就在那一面免费扩 1 格（16 格），把这些方块包进房间内部。
function c4BorderPlaneHasItems(lv, b, dir) {
  let x0 = b.X0, x1 = b.X1, y0 = b.Y0 + 1, y1 = b.Y1 - 1, z0 = b.Z0 + 1, z1 = b.Z1 - 1
  if (dir === 'px') { x1 = x0 = b.X1 }
  else if (dir === 'nx') { x1 = x0 = b.X0 }
  else if (dir === 'pz') { z1 = z0 = b.Z1 }
  else if (dir === 'nz') { z1 = z0 = b.Z0 }
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        let id = c4CellIdAt(lv, x, y, z)
        if (!c4CellEmptyForExpand(id)) return { id: id, x: x, y: y, z: z }
      }
    }
  }
  return null
}
function c4AutoExpandForBorderItems(server, cube) {
  let C = c4Cwc()
  if (!C || !cube) return 0
  let slot = Number(cube.slot)
  if (!(slot >= 1)) return 0          // slot0 = 出生大厅，不动
  let lv = C.owLevel(server)
  if (!lv) return 0
  let keys = c4Cells(cube), set = c4CellSet(cube)
  let added = []
  keys.forEach(k => {
    let b = c4CellBox(slot, k)
    ;[['px', 1, 0], ['nx', -1, 0], ['pz', 0, 1], ['nz', 0, -1]].forEach(dd => {
      let nk = c4CellKey(b.gx + dd[1], b.gy, b.gz + dd[2])
      if (set[nk] || added.indexOf(nk) >= 0) return
      let hit = c4BorderPlaneHasItems(lv, b, dd[0])
      if (!hit) return
      set[nk] = 1
      added.push(nk)
      console.info('[C4] 旧存档边框升级 slot=' + slot + ' ' + dd[0] + '：边框有 ' + hit.id + ' @'
        + hit.x + ',' + hit.y + ',' + hit.z + ' → 免费扩 1 格 (' + nk + ')')
    })
  })
  if (added.length) {
    cube.cells = Object.keys(set)
    C.save()
  }
  return added.length
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
    // 旧模型是"矩形"：gx ∈ [-nx..px]，gz ∈ [-nz..pz]；新模型不允许向上，py 忽略（只 gy=0）
    if (ext.py > 0) console.warn('[C4] 迁移 slot=' + cube.slot + ' 旧 ext.py=' + ext.py + ' 已忽略（不再支持向上）')
    for (let gx = -ext.nx; gx <= ext.px; gx++)
      for (let gz = -ext.nz; gz <= ext.pz; gz++)
        set[gx + ',0,' + gz] = 1
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
      // 旧存档升级：边框平面有玩家方块 → 免费扩 1 格，把这些方块包进新房间（不被新墙埋掉）
      let grown = 0
      try { grown = c4AutoExpandForBorderItems(server, live) } catch (eGr) { console.warn('[C4] 边框扩格失败: ' + eGr) }
      // 先清旧格子扩建留在内部的成片结构空位，再重建外边界（凹形壳会被重建刷回）
      let cleared = c4ClearInnerVoid(server, live)
      let built = c4RebuildCells(server, live)
      live.cellsMigrated = 1
      C2.save()
      // 迁移也包含上下通道：重新建 5×5 管道 + 两扇互指 3×3（幂等，不碰 17×17）
      let hole = 0
      try { hole = C2.activateHole(server, slot0, null) } catch (eH) { console.warn('[C4] 迁移补通道失败 slot=' + slot0 + ': ' + eH) }
      console.info('[C4] 旧存档迁移补建完成 slot=' + slot0 + '（' + built + ' 格，清内部空位 ' + cleared + ' 格，边框扩格 ' + grown + '，通道门=' + hole + '，外边界已重算）')
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
  // ★ 不再在服务端启动/`/reload` 时自动迁移重建旧存档：
  //   按钮/扩建/拆除/显式命令之前，基地必须保持原样（用户要求"按钮还没按不应该有变化"）。
  //   需要迁移时：按旧基地按钮（旧按钮迁移路径会自动重建外壳）或 /cube admin rebuild <slot> / migrateall。
})

// ════════════════════════════════════════════════════════════════════════════
// 扩展器 / 拆除器
// ════════════════════════════════════════════════════════════════════════════
let C4_EXP_CLICK = {}
let C4_HOLE_CLICK = {}   // 3×3 连接洞二次确认

function c4DoExpand(server, cube, face, player) {
  let C = c4Cwc()
  if (!C || !cube) return
  if (face === 'py') { C.deny(player, '已禁用向上扩展，只能向下（ny）'); return }
  if (face !== 'px' && face !== 'nx' && face !== 'pz' && face !== 'nz' && face !== 'ny') {
    C.deny(player, '该面不可扩展')
    return
  }
  let r = c4AddCell(server, cube, face, player, false)
  if (r && r.ok) C.deny(player, '扩建完成：+16 格（' + face + '，当前 ' + c4Cells(cube).length + ' 格）')
}

// 拆除：目标 = 玩家所在格 + 朝向相邻格；起始 17³(0,0,0) 不可拆；拆完必须连通；格内必须为空
function c4DoReduce(server, cube, face, player) {
  let C = c4Cwc()
  if (!C || !cube) return
  if (!player) { C.deny(player, '拆除需要玩家执行'); return }
  if (face === 'py') { C.deny(player, '已禁用向上扩展，只能向下（ny）'); return }
  if (face !== 'px' && face !== 'nx' && face !== 'pz' && face !== 'nz' && face !== 'ny') {
    C.deny(player, '该面不可拆除')
    return
  }
  let slot = Number(cube.slot)
  let set = c4CellSet(cube)
  let cur = c4CellAt(slot, Math.floor(player.x), Math.floor(player.y), Math.floor(player.z))
  if (!set[cur]) { C.deny(player, '你不在基地的格子里，拆除已取消'); return }
  let g = String(cur).split(',').map(Number)
  let n = [g[0] + (face === 'px' ? 1 : face === 'nx' ? -1 : 0),
           g[1] + (face === 'py' ? 1 : face === 'ny' ? -1 : 0),
           g[2] + (face === 'pz' ? 1 : face === 'nz' ? -1 : 0)]
  let key = c4CellKey(n[0], n[1], n[2])
  if (!set[key]) { C.deny(player, '那个方向没有可拆的格子'); return }
  if (key === '0,0,0') { C.deny(player, '起始 17³ 房间不能拆除'); return }
  let set2 = Object.assign({}, set)
  delete set2[key]
  if (!c4CellsConnected(set2, cur)) { C.deny(player, '拆掉这一格会把基地分成两块，已取消'); return }
  let b = c4CellBox(slot, key)
  let chk = c4CellScan(server, b, face, true)
  if (!chk.ok) {
    let occupyMsg = c4OccupyMsg(chk)
    if (player && C.chat) C.chat(player, occupyMsg)
    else C.deny(player, occupyMsg)
    return
  }
  c4ClearRemovedCell(server, b, set2)
  delete set[key]
  cube.cells = Object.keys(set)
  C.save()
  c4RebuildCells(server, cube)
  C.deny(player, '拆除完成：-16 格（剩余 ' + cube.cells.length + ' 格）')
}

// /cube expand <slot> <px|nx|pz|nz|py> [force]（root 级；/cube admin expand 保留为别名）
// force = 跳过“目标格必须为空”的检查（/cube admin expand ... force，OP 自担风险）。
function c4CmdExpand(ctx, face, force) {
  let C = c4Cwc()
  if (!C) return 0
  let server = ctx.source.server
  // 2026-10：只允许向下（ny）；py 保留入口但明确拒绝
  if (face === 'py') { C.reply(ctx, '已禁用向上扩展，只能向下（ny）'); return 0 }
  if (face !== 'nz' && face !== 'px' && face !== 'nx' && face !== 'ny' && face !== 'pz') {
    C.reply(ctx, '该面不可扩展（可用 nx/px/nz/pz/ny）'); return 0
  }
  C.refreshDb()
  let slot = Number(C.slot(ctx))
  let info = C.teamOfSlot(slot)
  if (!info || !info.cube) { C.reply(ctx, '槽位 ' + slot + ' 没有登记'); return 0 }
  // 四面 + 向下都走格子化（只扩基地，绝不动传送器）
  let r = c4AddCell(server, info.cube, face, null, force)
  if (r.ok) {
    C.reply(ctx, '扩展 ' + face + ' 完成（格子 +1，共 ' + c4Cells(info.cube).length + ' 格）')
  } else if (r.reason === 'exists') {
    C.reply(ctx, '该方向已有格子，未扩建')
  } else if (r.reason === 'air') {
    C.reply(ctx, c4OccupyMsg(r))
  } else if (r.reason === 'ymin') {
    C.reply(ctx, '已到世界最低高度，不能再向下扩建')
  } else {
    C.reply(ctx, '扩建失败（' + (r.reason || 'error') + '）')
  }
  return 1
}

// /cube admin pruneup <slot>：清掉历史遗留的向上格（gy>0，旧 ext.py 产生，会压到舱体/按钮），再重建
function c4CmdPruneUp(ctx) {
  let C = c4Cwc()
  if (!C) return 0
  let server = ctx.source.server
  C.refreshDb()
  let slot = Number(C.slot(ctx))
  let info = C.teamOfSlot(slot)
  if (!info || !info.cube) { C.reply(ctx, '槽位 ' + slot + ' 没有登记'); return 0 }
  let cube = info.cube
  let cs = cube.cells || []
  let keep = []
  for (let i = 0; i < cs.length; i++) {
    let gy = Number(String(cs[i]).split(',')[1]) | 0
    if (gy > 0) continue
    keep.push(cs[i])
  }
  let removed = cs.length - keep.length
  cube.cells = keep
  C.save()
  let n = 0
  try { n = c4RebuildCells(server, cube) } catch (e) { console.warn('[C4] pruneup 重建失败: ' + e) }
  console.info('[C4] pruneup slot=' + slot + '：移除向上格 ' + removed + '，剩余 ' + n + ' 格')
  C.reply(ctx, 'pruneup slot' + slot + '：移除向上格 ' + removed + '，剩余 ' + n + ' 格')
  return 1
}

// /cube admin borderfix <slot>：旧存档升级——边框平面若有玩家方块，免费扩 1 格把这些方块包进房间
function c4CmdBorderFix(ctx) {
  let C = c4Cwc()
  if (!C) return 0
  let server = ctx.source.server
  C.refreshDb()
  let slot = Number(C.slot(ctx))
  let info = C.teamOfSlot(slot)
  if (!info || !info.cube) { C.reply(ctx, '槽位 ' + slot + ' 没有登记'); return 0 }
  let cube = info.cube
  if (!cube.cells || !cube.cells.length) { C.reply(ctx, '槽位 ' + slot + ' 还没有格子数据'); return 0 }
  try {
    let u = c4CellUnion(slot, c4Cells(cube))
    server.runCommandSilent('execute in minecraft:overworld run forceload add '
      + (u.X0 - 16) + ' ' + (u.Z0 - 16) + ' ' + (u.X1 + 16) + ' ' + (u.Z1 + 16))
  } catch (eFL) {}
  C.reply(ctx, '边框升级 slot' + slot + '：检查中（40t 后重建）')
  server.scheduleInTicks(40, () => {
    try {
      let added = c4AutoExpandForBorderItems(server, cube)
      let n = c4RebuildCells(server, cube)
      console.info('[C4] 边框升级 slot=' + slot + '：新增 ' + added + ' 格（共 ' + n + ' 格）')
    } catch (e) { console.warn('[C4] 边框升级失败 slot=' + slot + ': ' + e) }
  })
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
  if ((!info.cube.cells || !info.cube.cells.length)) {
    let had = (info.cube.ext && (info.cube.ext.px || info.cube.ext.nx || info.cube.ext.pz || info.cube.ext.nz || info.cube.ext.py))
    if (!had) { C.reply(ctx, '槽位 ' + slot + ' 还没有格子数据（先 /cube expand）'); return 0 }
    c4EnsureCells(info.cube)
  }
  let n = c4RebuildCells(ctx.source.server, info.cube)
  let hole = 0
  try { if (C.activateHole) hole = C.activateHole(ctx.source.server, slot, null) } catch (eH) { console.warn('[C4] rebuild 补通道失败: ' + eH) }
  C.reply(ctx, '格子重建 slot' + slot + '：' + n + ' 格（外边界已重算，通道门=' + hole + '）')
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
    // 洞口双击：基地天花板洞 = 仰视（pitch < -50）；传送仓地板洞 = 俯视（pitch > 50）
    // 扩展器 = 激活 3×3 隧道，拆除器 = 拆掉隧道
    let nearHole = (a) => {
      let dd = Math.sqrt(Math.pow(p.x - (a.x + 0.5), 2) + Math.pow(p.z - (a.z + 0.5), 2))
      return dd < 5.5 && p.y >= a.y - 1 && p.y <= a.y + 17
    }
    let pitchNow = Number(p.pitch)
    // 基地天花板洞：仰视才能激活；传送舱里：任意朝向右键都算（用户要求“随意方向”）
    let atBaseHole = pitchNow < -50 && nearHole(C.baseAnchor(cube.slot))
    let atTeleHole = nearHole(C.teleAnchor(cube.slot))
    if (atBaseHole || atTeleHole) {
      let now0 = Date.now(), k0 = 'hole:' + (reduce ? 'r:' : 'e:') + C.name(p) + ':' + cube.slot
      let last0 = C4_HOLE_CLICK[k0]
      if (!last0 || now0 - last0 > 5000) {
        C4_HOLE_CLICK[k0] = now0
        C.deny(p, reduce ? '隧道: 再右键一次确认【拆除】' : '隧道: 再右键一次确认激活')
        return
      }
      C4_HOLE_CLICK[k0] = 0
      if (reduce) { C.deactivateHole(server, cube.slot, p); return }
      // 激活要消耗 1 个扩展器（创造模式不扣）
      try {
        if (!p.isCreative()) {
          let st = p.mainHandItem
          if (!st || st.count <= 0 || String(st.id) !== 'kubejs:cube_expander') { C.deny(p, '手里没有立方体扩展器'); return }
          st.shrink(1)
        }
      } catch (eC) { console.warn('[C4] 扣扩展器失败: ' + eC) }
      C.activateHole(server, cube.slot, p)
      return
    }
    // 只能在【基地】内用（传送仓固定 17³，不许改）
    if (!c4InBase(p, cube.slot)) { C.deny(p, '扩展/拆除只能在基地内部使用'); return }
    let yaw = ((Number(p.yaw) % 360) + 360) % 360
    let pitch = pitchNow
    let face = null
    // MC 的 XRot：正 = 低头，负 = 抬头
    // 2026-10：只允许向下扩建（朝下 = ny）；抬头 = 原来的 py → 禁用
    if (pitch < -50) { C.deny(p, '已禁用向上扩展，只能向下（ny）'); return }
    if (pitch > 50) face = 'ny'
    else face = ['pz', 'nx', 'nz', 'px'][Math.round(yaw / 90) % 4]   // +z/-x/-z/+x 四面都能扩
    // +z 面原来是操控台那一面：只要传送仓已经搬离基地（按钮不在基地层 BASE_FLOOR+1）就允许扩 +z
    // （以前写死 y=11，传送仓改到 y=79 之后就全被挡住了）
    if (face === 'pz' && Math.floor(C.btnPos(cube.slot).y) === (C.BASE_FLOOR + 1)) {
      C.deny(p, '+z 面要先把传送仓搬离基地（旧存档请先按一次旧按钮完成迁移）')
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
  clearInnerVoid: c4ClearInnerVoid,
  addCell: c4AddCell,
  migrateExtToCells: c4MigrateExtToCells,
  migrateAll: c4MigrateAllCubes,
  cmdExpand: c4CmdExpand,
  cmdRebuild: c4CmdRebuild,
  cmdBorderFix: c4CmdBorderFix,
  cmdPruneUp: c4CmdPruneUp,
  rebuildCells: (server, cube) => c4RebuildCells(server, cube),
  migrateAll: (server) => c4MigrateAllCubes(server),
  expand: c4DoExpand,
  reduce: c4DoReduce,
  inBase: c4InBase,
  atConsole: c4AtConsole,
}
