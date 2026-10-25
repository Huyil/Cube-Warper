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

// ---------------------------------------------------------------------------- 仪式主流程

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
  return ritualMultiStartJob(server, dim, marker)
}

function ritualMultiStartJob (server, dim, marker) {
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
    scores: ritualNewScores()
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

  for (var i = 0; i < RITUAL_SCORE_MAP.length; i++) {
    var m = RITUAL_SCORE_MAP[i]
    if (ritualBlockIs(server, job.dim, bx, by, bz, m[0])) {
      job.scores[m[1]] = job.scores[m[1]] + 1
      break
    }
  }

  // 原第 31 行：不管认不认识这个方块，位置上的方块直接湮灭（不返还）
  ritualSetBlock(server, job.dim, bx, by, bz, 'minecraft:air')
}

// 原 sequence:15-27：完成音效 + 7 条配方
function ritualResolve (server, job) {
  var at = ritualAt(job)
  server.runCommandSilent(at + ' playsound malum:ritual_completed master @a ~ ~ ~ 30 0')
  server.runCommandSilent(at + ' playsound untagged_mobs:misc.mutate master @a ~ ~ ~ 1 0')
  server.runCommandSilent(at + ' particle dust_color_transition 1 0 0 5 0 0 0 ~ ~ ~ 0.5 0.5 0.5 0 20 force')

  for (var i = 0; i < RITUAL_RECIPES.length; i++) {
    var r = RITUAL_RECIPES[i]
    if (!ritualBlockIs(server, job.dim, job.bx, job.by, job.bz, r.center)) continue
    if (!ritualNeedMet(job, r.need)) continue

    if (r.out) {
      ritualSetBlock(server, job.dim, job.bx, job.by, job.bz, r.out)
    }
    if (r.effect) {
      server.runCommandSilent(at + ' run function ' + r.effect)
    }
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
