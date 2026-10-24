// 时间祭坛（hexahedron:shrine_time）—— KubeJS 多祭坛并行版
//
// 触发：右键祭坛上的石按钮。
// 状态：按“祭坛输入方块坐标 + 维度”分别保存，每个祭坛独立倒计时，
//       不再使用全局的 clocking 标签 / time 计分板，所以多个祭坛可以同时运行。
//
// 注意：hexahedron:machines/shrine_time 已改为空函数，
//       防止原命令方块和这里同时结算、造成双倍产出。

const SHRINE_INPUTS = [
  'kubejs:vector_operator_empty',
  'minecraft:iron_block',
  'minecraft:emerald_block',
  'kubejs:vector_operator_step2'
]

const SHRINE_RECIPES = [
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

// key -> { dim, x, y, z, left }
const SHRINE_JOBS = {}

function shrineDimension (level) {
  // 兼容 KubeJS 的 level.dimension（字符串）与原生 ResourceKey
  const d = level.dimension
  if (typeof d === 'string') return d
  try {
    if (d && d.location) {
      const loc = (typeof d.location === 'function') ? d.location() : d.location
      return String(loc)
    }
  } catch (e) {}
  const s = String(d)
  const slash = s.indexOf('/ ')
  if (slash >= 0) return s.substring(slash + 2).replace(/\]$/, '')
  return s
}

function shrineKey (dim, pos) {
  return dim + '|' + pos.x + ',' + pos.y + ',' + pos.z
}

// 在按钮周围找“眼柱正上方放着祭坛材料”的那个方块
function findShrineInput (button) {
  for (let dy = -2; dy <= 4; dy++) {
    for (let dx = -9; dx <= 9; dx++) {
      for (let dz = -9; dz <= 9; dz++) {
        const b = button.offset(dx, dy, dz)
        if (!b || b.id !== 'kubejs:eye_pillar') continue
        const above = b.offset(0, 1, 0)
        if (above && SHRINE_INPUTS.indexOf(above.id) >= 0) return above
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
  const at = shrineAt(job)
  server.runCommandSilent(at + ' playsound supplementaries:block.clock.tick_1 master @a ~ ~ ~ 1 0')
  server.runCommandSilent(at + ' particle minecraft:enchant ~ ~1 ~ 3 3 3 0 10 force')
  if (second === 1) {
    server.runCommandSilent(at + ' playsound minecraft:entity.zombie_villager.converted master @a ~ ~ ~ 1 0')
  }
}

function shrineFinish (server, job) {
  const at = shrineAt(job)

  for (let i = 0; i < SHRINE_RECIPES.length; i++) {
    const r = SHRINE_RECIPES[i]
    const ok = server.runCommandSilent(
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

BlockEvents.rightClicked('minecraft:stone_button', event => {
  // 只处理主手，避免副手重复触发
  if (String(event.hand) !== 'MAIN_HAND') return

  const input = findShrineInput(event.block)
  if (!input) return

  const dim = shrineDimension(event.level)
  const key = shrineKey(dim, input)

  if (SHRINE_JOBS[key]) {
    event.cancel()
    event.player.tell(Text.translatable('cw.shrine.busy'))
    return
  }

  // 取消按钮交互，避免结构里的命令方块再走一遍旧逻辑（双倍结算）
  event.cancel()

  SHRINE_JOBS[key] = {
    dim: dim,
    x: input.x,
    y: input.y,
    z: input.z,
    left: 60
  }

  // 因为取消了按钮交互，这里补一个按钮音效
  event.server.runCommandSilent(
    'execute in ' + dim + ' positioned ' + (input.x + 0.5) + ' ' + (input.y + 0.5) + ' ' + (input.z + 0.5) +
    ' playsound minecraft:block.stone_button.click_on master @a ~ ~ ~ 0.6 1'
  )
})

ServerEvents.tick(event => {
  const keys = Object.keys(SHRINE_JOBS)
  if (keys.length === 0) return

  const server = event.server

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const job = SHRINE_JOBS[key]
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
