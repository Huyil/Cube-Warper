// 闪电祭坛（hexahedron:shrine_lightning）—— KubeJS 版（结构模板里已不再带命令方块）
//
// 原逻辑：结构内 1 个 impulse 命令方块 -> function hexahedron:machines/shrine_lightning
//         guard：塔顶铜魔像召唤方块 + 5 层 coil_lv + 满电 capacitor_lv{energy:100000}
//         通过后 positioned ~ ~28 ~ 调 shrine_lightning_sequence
// 现在：三个石按钮任意一个被右键时，由本脚本按同样的相对几何复现 guard，并调用同一个 sequence。
//
// 兼容旧存档：若该位置命令方块仍在（老世界已生成的结构），脚本直接让位，仍由命令方块处理，
//             避免一次按键触发两次仪式。

const L_CMD_OFFSETS = [
  [ 2, 0,  0],   // 按钮 (5,4,16) -> 命令方块 (7,4,16)
  [-2, 0,  0],   // 按钮 (9,4,16) -> 命令方块 (7,4,16)
  [ 0, 0, -2]    // 按钮 (7,4,18) -> 命令方块 (7,4,16)
]

const L_JOBS = {}       // key -> 到期 tick
const L_COOLDOWN = 60   // 一次仪式后 3 秒内不重复触发

function lDimension (level) {
  const d = level.dimension
  if (typeof d === 'string') return d
  try {
    if (d && d.location) {
      const loc = (typeof d.location === 'function') ? d.location() : d.location
      return String(loc)
    }
  } catch (e) {}
  const s = String(d)
  const i = s.indexOf('/ ')
  if (i >= 0) return s.substring(i + 2).replace(/\]$/, '')
  return s
}

function lTryRitual (server, level, dim, bx, by, bz) {
  const now = Date.now() / 50

  for (let i = 0; i < L_CMD_OFFSETS.length; i++) {
    const o = L_CMD_OFFSETS[i]
    const cx = bx + o[0], cy = by + o[1], cz = bz + o[2]
    const key = dim + '|' + cx + ',' + cy + ',' + cz

    // 旧存档兼容：命令方块还在 -> 让位
    let id = null
    try {
      const nb = level.getBlock(cx, cy, cz)
      id = nb ? String(nb.id) : null
    } catch (e) { id = null }
    if (id && id.indexOf('command_block') >= 0) return false

    if (L_JOBS[key] && L_JOBS[key] > now) return false

    const chain =
      'execute in ' + dim + ' positioned ' + (cx + 0.5) + ' ' + (cy + 0.5) + ' ' + (cz + 0.5) +
      ' if block ~ ~26 ~ #caverns_and_chasms:copper_golem_summon_blocks' +
      ' if block ~ ~25 ~ immersiveengineering:coil_lv' +
      ' if block ~ ~24 ~ immersiveengineering:coil_lv' +
      ' if block ~ ~23 ~ immersiveengineering:coil_lv' +
      ' if block ~ ~22 ~ immersiveengineering:coil_lv' +
      ' if block ~ ~21 ~ immersiveengineering:coil_lv' +
      ' if block ~ ~20 ~ immersiveengineering:capacitor_lv{energy:100000}' +
      ' positioned ~ ~28 ~ run function hexahedron:machines/shrine_lightning_sequence'

    const ok = server.runCommandSilent(chain)
    if (ok > 0) {
      L_JOBS[key] = now + L_COOLDOWN
      return true
    }
  }
  return false
}

BlockEvents.rightClicked('minecraft:stone_button', event => {
  if (String(event.hand) !== 'MAIN_HAND') return
  const b = event.block
  if (!b) return
  try {
    lTryRitual(event.server, event.level, lDimension(event.level), b.x, b.y, b.z)
  } catch (e) {
    console.warn('[ShrineLightning] ' + e)
  }
})
