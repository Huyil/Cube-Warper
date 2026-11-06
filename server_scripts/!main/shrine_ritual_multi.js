// 仪式法阵（hexahedron:shrine_ritual_circle）—— KubeJS 多法阵版
//
// 原实现（三个 mcfunction，现已掏空成注释壳）：
//   !rightclickevents.js 右键 desolate_dagger / 活肉块
//     -> 5 格内找 marker[tag=ritual_marker]
//     -> unless entity @e[tag=active_ritual]
//     -> function hexahedron:machines/shrine_ritual
//          playsound + particle，给 marker 打 active_ritual
//          -> function shrine_ritual_sequence（立即执行一次 = time 1）
//   shrine_ritual_sequence：每秒 time+1，time=2..9 在 8 个方位各 consume 一次，
//     time=10 按“中心方块 + 计分”结算配方，time=11 摘 tag、清计分。
//   shrine_ritual_consume：扫原位方块 -> 计分板 +1 -> setblock air（方块直接湮灭）
//
// 本脚本用纯 JS 复刻同一套语义：
//   * 状态按“维度 + marker 方块坐标”存在内存里（RITUAL_JOBS），支持多个法阵并行；
//   * 倒计时用 ServerEvents.tick 自己数 tick（20 tick = 1 秒），不再写全局 time 计分板；
//   * 计分同样只存在内存里（job.scores），不再占用 marker 的 scoreboard；
//   * 所有 position 都显式写坐标 / `execute in <dim> positioned ...`，不依赖 @s；
//   * active_ritual 实体 tag 仍然照打/照摘，保持和其它数据包逻辑的互斥兼容。
//
// 接缝：!rightclickevents.js 里两条 `function hexahedron:machines/shrine_ritual` 调用
//       已替换为 ritualMultiTryStart(server, entity.level, entity.x, entity.y, entity.z)。
//
// 注意：本文件刻意只用 var（Rhino 的块级作用域在旧版本里不稳），循环体内不出现 let/const。

var RITUAL_TICK_INTERVAL = 20 // 20 tick = 1 秒（原 schedule function ... 1s）
var RITUAL_TAG = 'active_ritual'
var RITUAL_MARKER_TAG = 'ritual_marker'

// 8 个方位的水平偏移，顺序 = 原 sequence 的 time 2..9：
//   北(0,-15) 东北(11,-11) 东(15,0) 东南(11,11) 南(0,15) 西南(-11,11) 西(-15,0) 西北(-11,-11)
// y 固定为 marker.y - 2（原 `positioned ~ ~-2 ~...`）。
var RITUAL_RING = [
  [0, -15],
  [11, -11],
  [15, 0],
  [11, 11],
  [0, 15],
  [-11, 11],
  [-15, 0],
  [-11, -11]
]

// consume 的方块 -> 计分项映射（原 shrine_ritual_consume.mcfunction:19-29）
var RITUAL_SCORE_MAP = [
  ['kubejs:computer', 'computer'],
  ['kubejs:supercomputer', 'super_computer'],
  ['alexscaves:forsaken_idol', 'forsaken_idol'],
  ['kubejs:crimson_eye', 'eye'],
  ['darkerdepths:void_soul_jar', 'soul'],
  ['malum:block_of_living_flesh', 'flesh'],
  ['untagged_mobs:nullpoint_tiles', 'null'],
  ['malum:block_of_void_salts', 'salt'],
  ['untagged_mobs:nothing', 'nothing'],
  ['kubejs:modular_reactor', 'modular_reactor'],
  ['kubejs:vector_operator_lightning', 'vector']
]

// 原 time=10 的 7 条配方；中心方块 id 先读，再比内存计分。
// step9 -> step10 -> step11 -> step12 是主线，前 4 条是支线产物/效果。
var RITUAL_RECIPES = [
  {
    center: 'kubejs:vector_operator_empty',
    need: { super_computer: 3, modular_reactor: 2, forsaken_idol: 2, eye: 1 },
    out: 'kubejs:vector_operator_eye'
  },
  {
    center: 'kubejs:crimson_eye',
    need: { nothing: 2, 'null': 2, salt: 4 },
    effect: 'hexahedron:effects/pure_darkness_start'
  },
  {
    center: 'kubejs:recaptured_consciousness_empty',
    need: { eye: 1, computer: 4, vector: 3 },
    out: 'kubejs:recaptured_consciousness'
  },
  {
    center: 'enderio:ensouled_chassis',
    need: { nothing: 8 },
    effect: 'hexahedron:effects/missing_start'
  },
  {
    center: 'kubejs:vector_operator_step9',
    need: { modular_reactor: 8 },
    out: 'kubejs:vector_operator_step10'
  },
  {
    center: 'kubejs:vector_operator_step10',
    need: { forsaken_idol: 8 },
    out: 'kubejs:vector_operator_step11'
  },
  {
    center: 'kubejs:vector_operator_step11',
    need: { super_computer: 8 },
    out: 'kubejs:vector_operator_step12'
  }
]

// 进行中的仪式：key = 维度|marker 方块坐标
// { dim, x, y, z, bx, by, bz, step, left, scores }
var RITUAL_JOBS = {}

// 脚本刚加载完的第一 tick：清掉上一轮 /reload 前残留的 active_ritual tag（旧状态已经丢了）
var RITUAL_READY = false

// ---------------------------------------------------------------------------- 基础工具

// Level/实体所属维度。KubeJS 的 level.dimension 可能是字符串、ResourceLocation，
// 老版本也可能是 ResourceKey（String() 形如 ResourceKey[minecraft:dimension / minecraft:overworld]）。
function ritualDimOf (level) {
  var d = null
  try { d = level.dimension } catch (e) { d = null }
  if (d !== null && d !== undefined) {
    if (typeof d === 'string') return d
    try {
      if (typeof d.location === 'function') return String(d.location())
    } catch (e2) {}
    try {
      if (d.location) return String(d.location)
    } catch (e3) {}
    var s = String(d)
    var slash = s.indexOf('/ ')
    if (slash >= 0) return s.substring(slash + 2).replace(/\]$/, '')
    return s
  }
  try { return String(level.dimension().location()) } catch (e4) {}
  return 'minecraft:overworld'
}

function ritualHasTag (e, tag) {
  try {
    var tags = e.getTags()
    return tags !== null && tags !== undefined && tags.contains(tag)
  } catch (err) {
    return false
  }
}

function ritualEntityType (e) {
  try { return String(e.type) } catch (err) { return '' }
}

// 枚举已加载实体（cw_cubes.js 同款用法：server.entities 是 EntityArrayList）
function ritualAllEntities (server) {
  var out = []
  try {
    var it = server.entities.iterator()
    while (it.hasNext()) {
      var e = it.next()
      if (e) out.push(e)
    }
  } catch (err) {
    console.warn('[ShrineRitual] server.entities 不可用: ' + err)
  }
  return out
}

function ritualNewScores () {
  var s = {}
  for (var i = 0; i < RITUAL_SCORE_MAP.length; i++) s[RITUAL_SCORE_MAP[i][1]] = 0
  return s
}

// 5 格内、最近的 ritual_marker（原选择器 distance=..5,limit=1,sort=nearest）
function ritualFindMarker (server, dim, px, py, pz) {
  var list = ritualAllEntities(server)
  var best = null
  var bestD = 25.0001
  for (var i = 0; i < list.length; i++) {
    var e = list[i]
    var t = ritualEntityType(e)
    if (t !== '' && t.indexOf('marker') < 0) continue
    if (!ritualHasTag(e, RITUAL_MARKER_TAG)) continue
    if (ritualDimOf(e.level) !== dim) continue
    var dx = Number(e.x) - px
    var dy = Number(e.y) - py
    var dz = Number(e.z) - pz
    var d = dx * dx + dy * dy + dz * dz
    if (d <= bestD) {
      bestD = d
      best = e
    }
  }
  return best
}

// 原 `unless entity @e[tag=active_ritual]`（在 marker 所在维度执行）：同维度互斥。
// 另外 RITUAL_JOBS 是全局的，所以同一时间只会有一个法阵在跑（比原版更严，但不会双结算）。
function ritualAnyActive (server, dim) {
  if (Object.keys(RITUAL_JOBS).length > 0) return true
  try {
    if (server.runCommandSilent('execute in ' + dim + ' if entity @e[tag=' + RITUAL_TAG + ']') > 0) return true
  } catch (err) {}
  return false
}

// 以 marker 自身坐标执行命令（原 mcfunction 的 `at @s`）
function ritualAt (job) {
  return 'execute in ' + job.dim + ' positioned ' + job.x + ' ' + job.y + ' ' + job.z
}

function ritualTagCommand (job, action) {
  return 'execute in ' + job.dim + ' positioned ' + job.x + ' ' + job.y + ' ' + job.z +
    ' run tag @e[type=marker,tag=' + RITUAL_MARKER_TAG + ',distance=..0.6,limit=1,sort=nearest] ' +
    action + ' ' + RITUAL_TAG
}

function ritualStripTag (server, e) {
  try {
    e.removeTag(RITUAL_TAG)
    return true
  } catch (err) {}
  try {
    server.runCommandSilent('execute in ' + ritualDimOf(e.level) +
      ' positioned ' + e.x + ' ' + e.y + ' ' + e.z +
      ' run tag @e[tag=' + RITUAL_TAG + ',distance=..0.6,limit=1,sort=nearest] remove ' + RITUAL_TAG)
    return true
  } catch (err2) {}
  return false
}

// 用命令返回值读方块（避免依赖 level.getBlock / 区块对象；原逻辑也全在命令层）
function ritualBlockIs (server, dim, x, y, z, id) {
  try {
    return server.runCommandSilent('execute in ' + dim + ' if block ' + x + ' ' + y + ' ' + z + ' ' + id) > 0
  } catch (err) {
    return false
  }
}

function ritualSetBlock (server, dim, x, y, z, id) {
  server.runCommandSilent('execute in ' + dim + ' run setblock ' + x + ' ' + y + ' ' + z + ' ' + id)
}

// 给法阵附近的玩家一条提示（只读反馈，失败也绝不影响仪式状态）
function ritualTellNear (server, dim, x, y, z, msg) {
  try {
    server.runCommandSilent('execute in ' + dim + ' positioned ' + x + ' ' + y + ' ' + z +
      ' run tellraw @a[distance=..16] ' + JSON.stringify({ text: msg, color: 'gray' }))
  } catch (err) {}
}

// ---------------------------------------------------------------------------- 仪式主流程

// 按维度读方块 id（cw_cubes.js 同款 API：getLevel(ResourceLocation) + getBlock().id）
// getLevel 只吃 ResourceLocation，不能直接传字符串；读不到时返回 null，调用方按「不可判定」保守处理。
var RITUAL_RL = null
function ritualDimKey (dim) {
  if (!RITUAL_RL) RITUAL_RL = Java.loadClass('net.minecraft.resources.ResourceLocation')
  var s = String(dim)
  var i = s.indexOf(':')
  return i < 0 ? new RITUAL_RL('minecraft', s) : new RITUAL_RL(s.substring(0, i), s.substring(i + 1))
}
function ritualLevel (server, dim) {
  try { return server.getLevel(ritualDimKey(dim)) } catch (err) { return null }
}
function ritualBlockIdAt (server, dim, x, y, z) {
  try {
    var lv = ritualLevel(server, dim)
    if (!lv) return null
    var b = lv.getBlock(x, y, z)
    return b ? String(b.id) : null
  } catch (err) {
    return null
  }
}

// 只读扫描：以 marker 为基准，读中心方块 + 8 个方位方块，预测会累出的 scores。
// 全程不写任何方块、不播粒子，只用于启动前 preflight（结算时方位已被吞空，不重扫）。
function ritualScan (server, dim, bx, by, bz) {
  var scores = ritualNewScores()
  for (var i = 0; i < RITUAL_RING.length; i++) {
    var x = bx + RITUAL_RING[i][0]
    var y = by - 2
    var z = bz + RITUAL_RING[i][1]
    var id = ritualBlockIdAt(server, dim, x, y, z)
    if (id !== null) {
      for (var k = 0; k < RITUAL_SCORE_MAP.length; k++) {
        if (RITUAL_SCORE_MAP[k][0] === id) { scores[RITUAL_SCORE_MAP[k][1]] = scores[RITUAL_SCORE_MAP[k][1]] + 1; break }
      }
    }
  }
  var center = ritualBlockIdAt(server, dim, bx, by, bz)
  return { scores: scores, center: center }
}

// 判断「中心方块 id + 分数」是否恰好命中某条配方。
// 启动前用 scan 预测分数；结算时用 job 累计分数（此时材料已被吞，不能再重扫方位）。
function ritualMatchRecipe (center, scores) {
  if (center === null) return null
  for (var i = 0; i < RITUAL_RECIPES.length; i++) {
    var r = RITUAL_RECIPES[i]
    if (center !== r.center) continue
    if (ritualNeedMet({ scores: scores }, r.need)) return r
  }
  return null
}

// 右键入口（!rightclickevents.js 调这里）：level 是实体所在维度，px/py/pz 是玩家/假玩家坐标
function ritualMultiTryStart (server, level, px, py, pz) {
  return ritualMultiTryStartAt(server, ritualDimOf(level), px, py, pz)
}

// 与入口同义，但维度直接给字符串（测试/调试用，也方便跨维度调用）
function ritualMultiTryStartAt (server, dim, px, py, pz) {
  if (!dim || dim === '?') return false
  var marker = ritualFindMarker(server, dim, px, py, pz)
  if (!marker) return false
  if (ritualAnyActive(server, dim)) return false
  // ★ 启动前 preflight：只读预测分数，凑不出配方就拒绝启动——一个方块都不动、不吞材料。
  var bx = Math.floor(Number(marker.x)), by = Math.floor(Number(marker.y)), bz = Math.floor(Number(marker.z))
  var scan = ritualScan(server, dim, bx, by, bz)
  if (scan.center === null) {
    ritualTellNear(server, dim, bx, by, bz, '⟢ 仪式未启动：读不到法阵中心方块（区块未加载？）')
    return false
  }
  if (ritualMatchRecipe(scan.center, scan.scores) === null) {
    ritualTellNear(server, dim, bx, by, bz, '⟢ 仪式未启动：中心方块与 8 个方位材料不匹配任何配方（材料保持原样）')
    return false
  }
  return ritualMultiStartJob(server, dim, marker, scan)
}

function ritualMultiStartJob (server, dim, marker, scan) {
  var x = Number(marker.x)
  var y = Number(marker.y)
  var z = Number(marker.z)
  var bx = Math.floor(x)
  var by = Math.floor(y)
  var bz = Math.floor(z)
  var key = dim + '|' + bx + ',' + by + ',' + bz
  if (RITUAL_JOBS[key]) return false

  var job = {
    dim: dim,
    x: x,
    y: y,
    z: z,
    bx: bx,
    by: by,
    bz: bz,
    step: 1,
    left: RITUAL_TICK_INTERVAL,
    scores: ritualNewScores(),
    // ★ 分数在启动时就按 preflight 的真实摆法定稿，此后不再累加：
    //   逐秒 consume 只负责演出 + 记录吞了什么；玩家中途改动/重复启动不会让分数翻倍或漂移。
    finalScores: scan ? scan.scores : null,
    consumed: []          // 逐方位记录「吞掉的原始方块」，供结算失败时按原位返还
  }
  RITUAL_JOBS[key] = job

  // 原 shrine_ritual.mcfunction: 音效 + 顶部粒子 + 打 tag，然后立刻跑一次 sequence（time=1）
  server.runCommandSilent(ritualTagCommand(job, 'add'))
  ritualStartSounds(server, job)
  ritualRunStep(server, job, 1)
  return true
}

function ritualStartSounds (server, job) {
  var at = ritualAt(job)
  server.runCommandSilent(at + ' playsound malum:ritual_forms master @a ~ ~ ~ 30 1')
  server.runCommandSilent(at + ' playsound malum:ritual_begins master @a ~ ~ ~ 30 0')
  server.runCommandSilent(at + ' playsound malum:ritual_evolution_ambience master @a ~ ~ ~ 0.5 1.5')
  server.runCommandSilent(at + ' particle alexscaves:void_being_eye ~ ~2 ~ 0 0 0 0 1 force')
}

// n = 原 sequence 里的 time 值：1..10 每秒推进，11 收尾
function ritualRunStep (server, job, n) {
  var at = ritualAt(job)

  // 原 sequence 第一行之后的常驻粒子（time=1..10 都有）
  if (n <= 10) {
    server.runCommandSilent(at + ' particle minecraft:crimson_spore ~ ~-3.5 ~ 10 0 10 0 100 force')
  }

  // time=2..9：8 个方位逐秒 consume
  if (n >= 2 && n <= 9) {
    ritualConsume(server, job, RITUAL_RING[n - 2])
  }

  // time=10：音效 + 结算
  if (n === 10) {
    ritualResolve(server, job)
  }

  // time=11：摘 active_ritual（原 sequence:30；计分在内存里，随 job 一起丢）
  if (n >= 11) {
    server.runCommandSilent(ritualTagCommand(job, 'remove'))
  }
}

// 原 shrine_ritual_consume.mcfunction
function ritualConsume (server, job, off) {
  var bx = job.bx + off[0]
  var by = job.by - 2
  var bz = job.bz + off[1]
  var at = 'execute in ' + job.dim + ' positioned ' + (bx + 0.5) + ' ' + (by + 0.5) + ' ' + (bz + 0.5)

  server.runCommandSilent(at + ' playsound malum:ritual_absorbs_item master @a ~ ~ ~ 10 1')
  server.runCommandSilent(at + ' particle dust_color_transition 1 0 0 5 0 0 0 ~ ~ ~ 0.5 0.5 0.5 0 20 force')
  server.runCommandSilent(at + ' particle alexscaves:void_being_eye ~ ~1 ~ 0 0 0 0 1 force')

  // 先读真实方块 id 再湮灭：记进 job.consumed，失败时才知道要还原什么。
  // 读不到 id（区块刚好卸载等）记为 null → 保守视为空气，不参与返还计分。
  var eatenId = ritualBlockIdAt(server, job.dim, bx, by, bz)
  if (eatenId === null || eatenId === 'minecraft:air') eatenId = null
  var hit = null
  if (eatenId !== null) {
    for (var i = 0; i < RITUAL_SCORE_MAP.length; i++) {
      if (RITUAL_SCORE_MAP[i][0] === eatenId) { hit = RITUAL_SCORE_MAP[i][1]; break }
    }
  }
  // 不再累加 job.scores：分数已在启动时由 preflight 定稿（见 ritualMultiStartJob 的 finalScores）。
  job.consumed.push({ x: bx, y: by, z: bz, id: eatenId, score: hit })

  // 原第 31 行：不管认不认识这个方块，位置上的方块直接湮灭（不返还）。
  // 现在失败有兜底：结算不命中时 ritualRefund 按 job.consumed 原位返还。
  ritualSetBlock(server, job.dim, bx, by, bz, 'minecraft:air')
}

// 结算失败 → 把 ritualConsume 吞掉的方块按原位放回去。
// 原位若已被玩家/其它机制放上新方块：先 setblock air destroy 把占位方块破坏掉（掉落，
// 不会静默吞掉），再 setblock 放回原材料；两步都只用本仓已验证的 setblock 基础写法。
function ritualRefund (server, job) {
  var n = 0
  for (var i = 0; i < job.consumed.length; i++) {
    var c = job.consumed[i]
    if (!c || !c.id || c.id === 'minecraft:air') continue
    var cur = ritualBlockIdAt(server, job.dim, c.x, c.y, c.z)
    if (cur === null) continue   // 该格区块读不到，保守跳过（不盲写，避免把别处方块塞错）
    var base = 'execute in ' + job.dim + ' run setblock ' + c.x + ' ' + c.y + ' ' + c.z + ' '
    try {
      if (cur !== 'minecraft:air') server.runCommandSilent(base + 'minecraft:air destroy')
      server.runCommandSilent(base + c.id)
      n++
    } catch (err) {
      console.warn('[ShrineRitual] 返还失败 @' + c.x + ',' + c.y + ',' + c.z + ' ' + c.id + ': ' + err)
    }
  }
  return n
}

// 原 sequence:15-27：完成音效 + 7 条配方
function ritualResolve (server, job) {
  var at = ritualAt(job)

  // ★ 结算前复核：
  //   ① 分数用启动时 preflight 定稿的 finalScores —— 8 个方位此时已被吞成 air，
  //      重扫必然全 0；定稿分数也保证「重复启动 / 中途多放」不会让分数漂移。
  //   ② 中心方块读当前真实 id（演出期间可能被玩家敲掉/换掉）。
  //   ③ job.consumed 是逐秒吞材料时记下的真实方块 id：若有人中途改动了某个方位，
  //      真实累计分数会与定稿分数不一致 → 判定失败并返还，不硬凑产出。
  var finalScores = job.finalScores || job.scores
  var realScores = ritualNewScores()
  for (var ci = 0; ci < job.consumed.length; ci++) {
    var s = job.consumed[ci].score
    if (s) realScores[s] = realScores[s] + 1
  }
  var keys = Object.keys(finalScores)
  var tampered = false
  for (var ki = 0; ki < keys.length; ki++) {
    if (realScores[keys[ki]] !== finalScores[keys[ki]]) { tampered = true; break }
  }
  var centerNow = ritualBlockIdAt(server, job.dim, job.bx, job.by, job.bz)
  var matched = tampered ? null : ritualMatchRecipe(centerNow, finalScores)
  if (matched === null) {
    var n = ritualRefund(server, job)
    ritualTellNear(server, job.dim, job.bx, job.by, job.bz,
      '⟢ 仪式未完成：' + (tampered ? '材料在仪式过程中被改动' : '材料与配方不匹配') +
      '，已原位返还 ' + n + ' 个方块（材料没有损失）')
    console.warn('[ShrineRitual] 结算未命中 @' + job.bx + ',' + job.by + ',' + job.bz +
      ' (tampered=' + tampered + ') → 返还 ' + n + ' 个方块')
    return
  }

  server.runCommandSilent(at + ' playsound malum:ritual_completed master @a ~ ~ ~ 30 0')
  server.runCommandSilent(at + ' playsound untagged_mobs:misc.mutate master @a ~ ~ ~ 1 0')
  server.runCommandSilent(at + ' particle dust_color_transition 1 0 0 5 0 0 0 ~ ~ ~ 0.5 0.5 0.5 0 20 force')

  // 命中配方 → 材料正常湮灭（不返还）。只执行匹配到的那一条，避免同中心多配方互相顶掉。
  if (matched.out) {
    ritualSetBlock(server, job.dim, job.bx, job.by, job.bz, matched.out)
  }
  if (matched.effect) {
    server.runCommandSilent(at + ' run function ' + matched.effect)
  }
}

function ritualNeedMet (job, need) {
  var keys = Object.keys(need)
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i]
    if (job.scores[k] !== need[k]) return false
  }
  return true
}

// ---------------------------------------------------------------------------- tick 驱动

ServerEvents.tick(event => {
  var server = event.server

  // /reload 后第一 tick：上一代脚本的 job 已随作用域消失，残留 tag 必须清掉，否则永远互斥
  if (!RITUAL_READY) {
    RITUAL_READY = true
    if (Object.keys(RITUAL_JOBS).length === 0) {
      var stale = ritualAllEntities(server)
      for (var s = 0; s < stale.length; s++) {
        if (ritualHasTag(stale[s], RITUAL_TAG)) ritualStripTag(server, stale[s])
      }
    }
  }

  var keys = Object.keys(RITUAL_JOBS)
  if (keys.length === 0) return

  for (var i = 0; i < keys.length; i++) {
    var key = keys[i]
    var job = RITUAL_JOBS[key]
    if (!job) continue

    job.left--
    if (job.left > 0) continue

    job.left = RITUAL_TICK_INTERVAL
    job.step++
    ritualRunStep(server, job, job.step)

    // time=11 已跑完（摘 tag），job 出栈
    if (job.step >= 11) delete RITUAL_JOBS[key]
  }
})
