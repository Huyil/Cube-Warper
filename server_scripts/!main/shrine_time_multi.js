// 时间祭坛（hexahedron:shrine_time）—— KubeJS 多祭坛并行版
//
// 触发（脉冲语义：一次脉冲 = 一次合成）：
//   1) 红石：kubejs:altar_signal 收到一次充能（上升沿）→ 当场全量扫一次找材料，
//      找到就建一个 job，找不到就安静返回。通电常开不会反复合成，也不做任何轮询。
//   2) 手动：右键 altar_signal；旧存档里的石按钮仍然可用。
//   材料输入方式保留“放置方块”：发射器 / deployer / 机械臂放一块料 + 给一次脉冲即可。
//
// 状态：按“祭坛输入方块坐标 + 维度”分别保存，每个祭坛独立倒计时，
//       不再使用全局的 clocking 标签 / time 计分板，所以多个祭坛可以同时运行。
//
// 注意：hexahedron:machines/shrine_time 已改为空函数，
//       防止原命令方块和这里同时结算、造成双倍产出。

var SHRINE_INPUTS = [
  'kubejs:vector_operator_empty',
  'minecraft:iron_block',
  'minecraft:emerald_block',
  'kubejs:vector_operator_step2'
]

var SHRINE_RECIPES = [
  {
    input: 'kubejs:vector_operator_empty',
    output: 'kubejs:vector_operator_basic',
    motion: '[0.1,0.4,0.05]',
    dust: '1 1 1 5 0.78 0.78 0.78'
  },
  {
    input: 'minecraft:iron_block',
    output: 'kubejs:block_shiny_ingot',
    motion: '[0.1,0.4,-0.05]',
    dust: '0 0.882 1 5 1 1 1'
  },
  {
    input: 'kubejs:vector_operator_step2',
    output: 'kubejs:vector_operator_step3',
    motion: '[-0.1,0.4,0.05]',
    dust: '0.702 0 0.792 5 0 0 0'
  }
]

// 进行中的合成：key(dim|材料坐标) -> { dim, x, y, z, left }
var SHRINE_JOBS = {}

function shrineDimension (level) {
  // 兼容 KubeJS 的 level.dimension（字符串）与原生 ResourceKey
  var d = level.dimension
  if (typeof d === 'string') return d
  try {
    if (d && d.location) {
      var loc = (typeof d.location === 'function') ? d.location() : d.location
      return String(loc)
    }
  } catch (e) {}
  var s = String(d)
  var slash = s.indexOf('/ ')
  if (slash >= 0) return s.substring(slash + 2).replace(/\]$/, '')
  return s
}

function shrineKey (dim, pos) {
  return dim + '|' + pos.x + ',' + pos.y + ',' + pos.z
}

// 在信号块周围找“眼柱正上方放着祭坛材料”的那个方块；没有就返回 null。
// 只认 SHRINE_INPUTS 里的方块，所以不会把眼柱柱身中间的空格当成材料位。
function findShrineInput (anchor) {
  for (var dy = -2; dy <= 4; dy++) {
    for (var dx = -9; dx <= 9; dx++) {
      for (var dz = -9; dz <= 9; dz++) {
        var b = anchor.offset(dx, dy, dz)
        if (!b || String(b.id) !== 'kubejs:eye_pillar') continue
        var above = b.offset(0, 1, 0)
        if (!above) continue
        if (SHRINE_INPUTS.indexOf(String(above.id)) >= 0) return above
      }
    }
  }
  return null
}

function shrineAt (job) {
  return 'execute in ' + job.dim +
    ' positioned ' + (job.x + 0.5) + ' ' + (job.y + 0.5) + ' ' + (job.z + 0.5)
}

function shrineSecond (server, job, second) {
  var at = shrineAt(job)
  server.runCommandSilent(at + ' playsound supplementaries:block.clock.tick_1 master @a ~ ~ ~ 1 0')
  server.runCommandSilent(at + ' particle minecraft:enchant ~ ~1 ~ 3 3 3 0 10 force')
  if (second === 1) {
    server.runCommandSilent(at + ' playsound minecraft:entity.zombie_villager.converted master @a ~ ~ ~ 1 0')
  }
}

function shrineFinish (server, job) {
  var at = shrineAt(job)

  for (var i = 0; i < SHRINE_RECIPES.length; i++) {
    var r = SHRINE_RECIPES[i]
    var ok = server.runCommandSilent(
      at + ' if block ~ ~ ~ ' + r.input +
      ' run summon item ~ ~ ~ {Motion:' + r.motion +
      ',Item:{id:"' + r.output + '",Count:1b}}'
    )
    if (ok > 0) {
      server.runCommandSilent(
        at + ' if block ~ ~ ~ ' + r.input +
        ' run particle dust_color_transition ' + r.dust + ' ~ ~ ~ 0.5 0.5 0.5 0 10 force'
      )
      server.runCommandSilent(at + ' if block ~ ~ ~ ' + r.input + ' run setblock ~ ~ ~ minecraft:air')
      break
    }
  }

  // 绿宝石块走原本的 time_stone（会自己清空并生成时间瓶）
  server.runCommandSilent(at + ' if block ~ ~ ~ minecraft:emerald_block run function hexahedron:effects/time_stone')

  server.runCommandSilent(at + ' playsound block.respawn_anchor.charge master @a ~ ~ ~ 1 0')
  server.runCommandSilent(at + ' particle minecraft:flash ~ ~ ~ 0 0 0 0 1 force')
}

// ---- 启动一次合成（三个触发入口共用）----
function shrineStartAt (server, dim, pos, player) {
  var key = shrineKey(dim, pos)

  if (SHRINE_JOBS[key]) {
    if (player) player.tell(Text.translatable('cw.shrine.busy'))
    return false
  }

  SHRINE_JOBS[key] = {
    dim: dim,
    x: pos.x,
    y: pos.y,
    z: pos.z,
    left: 60
  }

  // 因为取消了按钮交互，这里补一个按钮音效
  server.runCommandSilent(
    'execute in ' + dim + ' positioned ' + (pos.x + 0.5) + ' ' + (pos.y + 0.5) + ' ' + (pos.z + 0.5) +
    ' playsound minecraft:block.stone_button.click_on master @a ~ ~ ~ 0.6 1'
  )
  return true
}

// 一次性触发：扫一次找材料，找到就建 job，找不到安静返回（不做任何轮询/缓存）
function shrineTryStart (server, level, anchor, player) {
  var input = findShrineInput(anchor)
  if (!input) return false
  return shrineStartAt(server, shrineDimension(level), input, player)
}

// ---- 触发 ----
// 红石：kubejs:altar_signal 上升沿（一次脉冲）触发一次合成
BlockEvents.detectorPowered('altar_signal', event => {
  try {
    shrineTryStart(event.server, event.level, event.block, null)
  } catch (e) {
    console.warn('[ShrineTime] detectorPowered failed: ' + e)
  }
})

// 手动：右键 altar_signal 块
BlockEvents.rightClicked('kubejs:altar_signal', event => {
  if (String(event.hand) !== 'MAIN_HAND') return
  event.cancel()
  shrineTryStart(event.server, event.level, event.block, event.player)
})

// 旧存档兼容：石按钮
BlockEvents.rightClicked('minecraft:stone_button', event => {
  if (String(event.hand) !== 'MAIN_HAND') return
  if (!findShrineInput(event.block)) return
  event.cancel()
  shrineTryStart(event.server, event.level, event.block, event.player)
})

ServerEvents.tick(event => {
  var keys = Object.keys(SHRINE_JOBS)
  if (keys.length === 0) return

  var server = event.server

  for (var i = 0; i < keys.length; i++) {
    var key = keys[i]
    var job = SHRINE_JOBS[key]
    if (!job) continue

    job.left--

    if (job.left === 40 || job.left === 20 || job.left === 0) {
      shrineSecond(server, job, (60 - job.left) / 20)
    }

    if (job.left <= 0) {
      shrineFinish(server, job)
      delete SHRINE_JOBS[key]
    }
  }
})
