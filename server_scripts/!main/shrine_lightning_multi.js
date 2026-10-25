// 闪电祭坛（hexahedron:shrine_lightning）—— KubeJS 版（结构模板里已不再带命令方块）
//
// 触发：kubejs:altar_signal 被红石充能（上升沿）/ 右键 altar_signal / 右键旧存档石按钮
// 守卫（沿用原命令链，已实测可用）：塔顶 #caverns_and_chasms:copper_golem_summon_blocks
//       + 5 层 immersiveengineering:coil_lv + 满电 immersiveengineering:capacitor_lv{energy:100000}
//
// 原 hexahedron:machines/shrine_lightning、machines/shrine_lightning_sequence、
// effects/lightning 的逻辑全部搬到这里；三个 mcfunction 已掏空成注释壳，避免双份执行。
//
// 与旧 mcfunction 的差别（都是实测出来的真 bug）：
//   A) 旧 sequence 先 setblock ~ ~-8 ~ air 再放回 capacitor_lv，会连带把 sideConfig_1..6
//      （玩家设的输入/输出朝向）重置成默认值。现在只在守卫通过时 data merge {energy:0}，
//      方块本体与配置原样保留。
//   B) 旧 effects/lightning 每次执行都 schedule 自己 1s 后再跑，仪式结束后留下永久 1Hz 空转
//      函数链。现在用 ServerEvents.tick 按 job 倒计时推进（t=3s 落雷），收尾即删，不再自调度。
//   C) 基座不再硬编码 N/S/W/E 四个坐标：仪式触发时在基座层（塔基准-29）以塔为中心 33×33
//      扫 supplementaries:pedestal，一次性读 NBT 后按配方 data merge 写回。
//   D) 不再 summon marker、不用 scoreboard time：雷击/粒子/音效由本脚本直接发，收尾无 marker 残留。
//
// Rhino 约束：全文只用 var（循环体内更不能用 let/const），node --check 必须过。

var L_CMD_OFFSETS = [
  [ 2, 0,  0],   // 石按钮 (55,29,-16) / altar_signal -> 塔 (57,29,-16)
  [-2, 0,  0],   // 石按钮 (59,29,-16) -> 塔
  [ 0, 0, -2],   // 旧存档按钮 (57,29,-14) -> 塔
  [ 0, 0,  2]    // 石按钮 (57,29,-18) -> 塔
]

var L_SEQ_DY = 28         // sequence 执行点（塔顶雷击点）相对塔基准的 y 偏移
var L_PED_DY = -29        // 基座层相对 sequence 执行点的 y 偏移
var L_CAP_DY = 20         // capacitor_lv 相对塔基准的 y 偏移
var L_SCAN_RADIUS = 16    // 基座层 33×33 扫描半径
var L_STRIKE_TICKS = 60   // 触发后 3s 落雷（对应原 scoreboard time=3）

var L_PED_RECIPES = [
  { from: 'minecraft:glass_bottle', to: 'kubejs:bottled_lightning' },
  { from: 'kubejs:vector_operator_step6', to: 'kubejs:vector_operator_step7' },
  { from: 'thermal:copper_dust', to: 'thermal:lightning_charge' }
]

var L_FIREWORK = '{FireworksItem:{id:"firework_rocket",Count:1,tag:{Fireworks:{Explosions:[{Type:4,Flicker:1b,Trail:1b,Colors:[I;16777215],FadeColors:[I;10092536]}]}}}}'

// key(dim|塔坐标) -> { dim, tx, ty, tz, mx, my, mz, py, pedestals, left }
var L_JOBS = {}

function lDimension (level) {
  var d = level.dimension
  if (typeof d === 'string') return d
  try {
    if (d && d.location) {
      var loc = (typeof d.location === 'function') ? d.location() : d.location
      return String(loc)
    }
  } catch (e) {}
  var s = String(d)
  var i = s.indexOf('/ ')
  if (i >= 0) return s.substring(i + 2).replace(/\]$/, '')
  return s
}

function lCmd (server, cmd) {
  try {
    return server.runCommandSilent(cmd)
  } catch (e) {
    console.warn('[ShrineLightning] runCommandSilent 失败: ' + e)
    return 0
  }
}

// execute in <dim> positioned <x> <y> <z> run ...
function lAt (dim, x, y, z) {
  return 'execute in ' + dim + ' positioned ' + x + ' ' + y + ' ' + z + ' run '
}

function lBlockId (level, x, y, z) {
  try {
    var b = level.getBlock(x, y, z)
    if (!b) return ''
    return String(b.id)
  } catch (e) { return '' }
}

// 读基座首格的物品：{ id, count }；读不到（无方块/API 不支持）返回 null，用来切谓词回退。
function lStackAt (level, x, y, z) {
  var b = null
  try { b = level.getBlock(x, y, z) } catch (e0) { return null }
  if (!b) return null

  var nbt = null
  try { if (typeof b.getNbt === 'function') nbt = b.getNbt() } catch (e1) { nbt = null }
  if (!nbt) { try { if (typeof b.getEntityData === 'function') nbt = b.getEntityData() } catch (e2) { nbt = null } }
  if (!nbt) { try { if (b.nbt) nbt = b.nbt } catch (e3) { nbt = null } }

  if (nbt) {
    var list = null
    try { if (typeof nbt.getList === 'function') list = nbt.getList('Items', 10) } catch (e4) { list = null }
    if (list) {
      var size = 0
      try { size = Number(list.size()) } catch (e5) { size = 0 }
      if (size <= 0) return { id: '', count: 0 }
      var tag = null
      try { tag = list.getCompound(0) } catch (e6) { tag = null }
      if (!tag) return null
      var id = ''
      try { id = String(tag.getString('id')) } catch (e7) { id = '' }
      var count = 1
      try { count = Number(tag.getByte('Count')) } catch (e8) { count = 1 }
      return { id: id, count: count }
    }
  }

  // 兜底：方块容器自带 inventory（有些版本 getNbt 不可用）
  try {
    if (typeof b.getInventory === 'function') {
      var inv = b.getInventory()
      if (inv) {
        var st = inv.getStackInSlot(0)
        if (!st) return { id: '', count: 0 }
        var sid = st.id ? String(st.id) : ''
        var sc = st.count ? Number(st.count) : 1
        return { id: sid, count: sc }
      }
    }
  } catch (e9) {}

  return null
}

function lMergePedestal (server, dim, x, y, z, to) {
  return lCmd(server, 'execute in ' + dim + ' run data merge block ' + x + ' ' + y + ' ' + z +
    ' {Items:[{Slot:0b,id:"' + to + '",Count:1b}]}')
}

// 单个基座：读 NBT -> 按配方改写。返回 direct / fallback / none
function lRewritePedestal (server, level, dim, x, y, z) {
  var st = lStackAt(level, x, y, z)

  if (st) {
    if (!st.id || st.count !== 1) return 'none'
    for (var i = 0; i < L_PED_RECIPES.length; i++) {
      if (st.id === L_PED_RECIPES[i].from) {
        return lMergePedestal(server, dim, x, y, z, L_PED_RECIPES[i].to) > 0 ? 'direct' : 'none'
      }
    }
    return 'none'
  }

  // NBT 读不出来（KubeJS 版本 API 差异）：回退成原 mcfunction 的方块谓词写法，语义完全一致
  var hit = 0
  for (var j = 0; j < L_PED_RECIPES.length; j++) {
    var n = lCmd(server, 'execute in ' + dim +
      ' if block ' + x + ' ' + y + ' ' + z +
      ' supplementaries:pedestal{Items:[{Slot:0b,id:"' + L_PED_RECIPES[j].from + '",Count:1b}]}' +
      ' run data merge block ' + x + ' ' + y + ' ' + z +
      ' {Items:[{Slot:0b,id:"' + L_PED_RECIPES[j].to + '",Count:1b}]}')
    if (n > 0) hit++
  }
  return hit > 0 ? 'fallback' : 'none'
}

// 基座层 33×33 一次扫（以塔为中心）
function lScanPedestals (level, tx, py, tz) {
  var out = []
  for (var dx = -L_SCAN_RADIUS; dx <= L_SCAN_RADIUS; dx++) {
    for (var dz = -L_SCAN_RADIUS; dz <= L_SCAN_RADIUS; dz++) {
      var x = tx + dx
      var z = tz + dz
      if (lBlockId(level, x, py, z) === 'supplementaries:pedestal') {
        out.push({ x: x, y: py, z: z })
      }
    }
  }
  return out
}

// t=0：原 shrine_lightning_sequence —— 音效 + 基座扫描/改写（电容清零已在守卫链里做掉）
function lStartRitual (server, level, dim, tx, ty, tz) {
  var key = dim + '|' + tx + ',' + ty + ',' + tz
  var mx = tx + 0.5
  var my = ty + L_SEQ_DY + 0.5
  var mz = tz + 0.5
  var py = ty + L_SEQ_DY + L_PED_DY

  var atTop = lAt(dim, mx, my, mz)
  lCmd(server, atTop + 'playsound item.trident.thunder weather @a[distance=..100] ~ ~ ~ 30 0')
  lCmd(server, atTop + 'playsound item.trident.return weather @a[distance=..100] ~ ~ ~ 30 0')
  lCmd(server, atTop + 'playsound immersiveengineering:charge_slow weather @a[distance=..100] ~ ~ ~ 30 1')

  var peds = []
  var direct = 0
  var fallback = 0
  var none = 0
  try {
    peds = lScanPedestals(level, tx, py, tz)
    for (var i = 0; i < peds.length; i++) {
      var r = lRewritePedestal(server, level, dim, peds[i].x, peds[i].y, peds[i].z)
      if (r === 'direct') direct++
      else if (r === 'fallback') fallback++
      else none++
    }
  } catch (e) {
    console.warn('[ShrineLightning] 基座扫描失败: ' + e)
  }

  L_JOBS[key] = {
    dim: dim,
    key: key,
    tx: tx, ty: ty, tz: tz,
    mx: mx, my: my, mz: mz,
    py: py,
    pedestals: peds,
    left: L_STRIKE_TICKS
  }

  console.info('[ShrineLightning] 仪式开始 ' + dim + ' ' + tx + ',' + ty + ',' + tz +
    ' | 基座=' + peds.length + ' 直读改写=' + direct + ' 谓词改写=' + fallback + ' 未改写=' + none)
  return true
}

// t=3s：原 effects/lightning 的 time=3 分支（雷击 + 烟花 + 每个基座的粒子/火箭），只跑一次
function lStrike (server, job) {
  var atTop = lAt(job.dim, job.mx, job.my, job.mz)
  lCmd(server, atTop + 'summon minecraft:lightning_bolt')
  lCmd(server, atTop + 'particle minecraft:firework ~ ~ ~ 0 0 0 0.5 100 force')
  lCmd(server, atTop + 'summon minecraft:firework_rocket ~ ~1 ~ ' + L_FIREWORK)
  lCmd(server, atTop + 'playsound soundofrain:thunder_close weather @a[distance=..100] ~ ~ ~ 30 0')

  for (var i = 0; i < job.pedestals.length; i++) {
    var p = job.pedestals[i]
    var dx = p.x - job.tx
    var dz = p.z - job.tz
    var len = Math.sqrt(dx * dx + dz * dz)
    var ux = 0
    var uz = 0
    if (len > 0.001) { ux = dx / len; uz = dz / len }
    // 原版：粒子在离塔心 7 格处（~ ~-29.5 ~-7 / ~7），散布沿基座方向 3 格
    var fx = job.tx + 0.5 + ux * 7
    var fz = job.tz + 0.5 + uz * 7
    var sx = 3 * Math.abs(ux)
    var sz = 3 * Math.abs(uz)
    var atP = lAt(job.dim, fx, p.y, fz)
    lCmd(server, atP + 'particle minecraft:firework ~ ~ ~ ' + sx + ' 0 ' + sz + ' 0.05 100 force')
    lCmd(server, atP + 'particle minecraft:campfire_signal_smoke ~ ~ ~ ' + sx + ' 0 ' + sz + ' 0 100 force')
    lCmd(server, lAt(job.dim, p.x + 0.5, p.y + 1.5, p.z + 0.5) + 'summon minecraft:firework_rocket ~ ~ ~ ' + L_FIREWORK)
  }

  console.info('[ShrineLightning] 落雷 ' + job.dim + ' ' + job.tx + ',' + job.ty + ',' + job.tz +
    ' | 基座特效=' + job.pedestals.length)
}

function lTryRitual (server, level, block) {
  if (!block) return false

  var dim = lDimension(level)
  var bx = Math.floor(block.x)
  var by = Math.floor(block.y)
  var bz = Math.floor(block.z)

  for (var i = 0; i < L_CMD_OFFSETS.length; i++) {
    var o = L_CMD_OFFSETS[i]
    var cx = bx + o[0]
    var cy = by + o[1]
    var cz = bz + o[2]
    var key = dim + '|' + cx + ',' + cy + ',' + cz

    if (L_JOBS[key]) return false

    // 旧存档兼容：该位置命令方块还在 -> 让位，仍由命令方块处理，避免双触发
    if (lBlockId(level, cx, cy, cz).indexOf('command_block') >= 0) return false

    // 守卫 + bug A：守卫通过时顺手把电容能量清零（只改 NBT，不动方块本身）
    var chain =
      'execute in ' + dim +
      ' positioned ' + (cx + 0.5) + ' ' + (cy + 0.5) + ' ' + (cz + 0.5) +
      ' if block ~ ~26 ~ #caverns_and_chasms:copper_golem_summon_blocks' +
      ' if block ~ ~25 ~ immersiveengineering:coil_lv' +
      ' if block ~ ~24 ~ immersiveengineering:coil_lv' +
      ' if block ~ ~23 ~ immersiveengineering:coil_lv' +
      ' if block ~ ~22 ~ immersiveengineering:coil_lv' +
      ' if block ~ ~21 ~ immersiveengineering:coil_lv' +
      ' if block ~ ~20 ~ immersiveengineering:capacitor_lv{energy:100000}' +
      ' run data merge block ' + cx + ' ' + (cy + L_CAP_DY) + ' ' + cz + ' {energy:0}'

    if (lCmd(server, chain) > 0) {
      return lStartRitual(server, level, dim, cx, cy, cz)
    }
  }
  return false
}

// ---- 触发 ----
// 红石：kubejs:altar_signal 被充能即尝试仪式；手动：右键该块；旧存档石按钮仍可用
function lHandle (server, level, block) {
  if (!block) return false
  try {
    return lTryRitual(server, level, block)
  } catch (e) {
    console.warn('[ShrineLightning] ' + e)
    return false
  }
}

BlockEvents.detectorPowered('altar_signal', event => {
  lHandle(event.server, event.level, event.block)
})

BlockEvents.rightClicked('kubejs:altar_signal', event => {
  if (String(event.hand) !== 'MAIN_HAND') return
  lHandle(event.server, event.level, event.block)
})

BlockEvents.rightClicked('minecraft:stone_button', event => {
  if (String(event.hand) !== 'MAIN_HAND') return
  lHandle(event.server, event.level, event.block)
})

// ---- 推进：只在整个仪式窗口内存在 job，落雷后即删（修 bug B：不再自调度）----
ServerEvents.tick(event => {
  var keys = Object.keys(L_JOBS)
  if (keys.length === 0) return

  var server = event.server
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i]
    var job = L_JOBS[key]
    if (!job) continue
    job.left--
    if (job.left <= 0) {
      try {
        lStrike(server, job)
      } catch (e) {
        console.warn('[ShrineLightning] 落雷失败: ' + e)
      }
      delete L_JOBS[key]
    }
  }
})
