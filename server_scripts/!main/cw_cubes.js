// priority: 900
// =============================================================================================
//  Cube Warper · v4「API 驱动」控制器  (cw_cubes.js)
//  MC 1.20.1 · Forge 47.4.23 · KubeJS 2001.6.5 · FTB Teams 2001.3.2 · Immersive Portals 3.0.7
//
//  与 v2/v3 的本质区别：
//    v2/v3 靠"改数据包 + /portal 命令 + 全局选择器"搬门；
//    v4 直接调 Immersive Portals 的官方 API，对门实体对象操作。
//    → 不再需要 tag=core 改名、不需要 distance=..30 收窄、不需要 cw_flying 串行标记。
//      数据包里所有"动门/杀门"的指令由 v4_strip_portal_cmds.py 注释，KubeJS 独占门状态。
//
//  API 事实（对 3.0.7 jar 逐个签名核验）：
//    PortalAPI.setPortalTransformation(Portal, ResourceKey<Level>, Vec3 dest, DQuaternion rot, double scale)
//    PortalAPI.getPortalOrientationQuaternion(Portal) -> DQuaternion
//    PortalAPI.createReversePortal(Portal) -> Portal
//    PortalAPI.teleportEntity(Entity, ServerLevel, Vec3) -> Entity        // IP 自己的无加载画面传送
//    PortalAPI.addGlobalChunkLoader(MinecraftServer, ChunkLoader)         // 替代 forceload
//    Portal.setIsVisible(Z) / reloadAndSyncToClient() / reloadAndSyncToClientNextTick()
//    ⚠ 直接改字段【不会】自动同步客户端 → 每次改完必须 reloadAndSyncToClient()
//
//  分工：
//    数据包 = 选维度（三格插槽→dimension_seed）+ summon outer_core + 5 秒后 spreadplayers
//             找地表 + 重建"镜像笼子"（fill hexahedron_filling / light / 17x17）
//    KubeJS = 门指向 / 反向门 / 可见性 / 玩家传送 / 区块加载 / 槽位·大厅·队列
// =============================================================================================

// ---------------------------------------------------------------------------- 常量
const C4_SPACING = 4000           // 槽位间距（格）
const C4_X0 = 8                   // 槽位 1.. 的 x 基准偏移：让 17 格立方体近似落在区块中心
const C4_Z = 0
const C4_BASE_Y = 100.5           // 17x17 构建基准（地板 y=97，站立 y=98）
const C4_CORE_Y = 105.5
const C4_FACE = 8.51              // 立方体自己 6 扇门的平面：方块中心 ±8.51（原包 cb_make_portal 实测值，壳外 0.01）
const C4_DEST_FACE = 8.51         // 目的地平面 = 门面本身（原包实测：反向门的 destination 就是它自己的位置 8.51；
//                                 用 8.45 会把反向门塞进地板/框梁里 0.06，从外面看不到门）
const C4_HALF = 7.9
const C4_Y_MIN = 96.0
const C4_Y_MAX = 114.0
// 立方体登记跟着【存档】走（world/），不要放 config/：删档 = 重新开始，不会带着幽灵立方体
const C4_CFG = 'world/cubarper-cubes.json'
const C4_STATE_PATH = 'world/cubarper-state.json'
const C4_DEST_MIN_SEP = 1200   // 必须 > 1000：原包 hex_anchor 的复用半径是 1000，小于它就会偷到别人的落点
const C4_DEST_RETRY = 5        // 重新随机挑坐标最多 5 次
const C4_DEST_NUDGE = 1024     // 撞车 → 单调外移（+x 方向，第 i 次偏移 i*1024）
const C4_DEST_JITTER = 768     // 每次跃迁的随机抖动半径（原包只有 spreadplayers ±100，且会被 anchor 固定住）
const C4_PORTAL_SPAN = 17       // 门面边长（原包 cb_make_portal 17 17）
const C4_PORTAL_INSET = 0     // 原包门就是 17 宽、平面在壳外 0.01；再内缩会让门边和框梁之间露出黑缝
const C4_T_PRELOAD = 186      // unfold(t=185) 之后 1 tick：用【最终】坐标做真实预载
const C4_T_RETARGET = 195      // 数据包 85 选维度、185 建好笼子 → 186 预载、195 指门
const C4_T_END = 225

let C4_RL = null
let C4_J = {}
let C4_FTB = { tried: false, api: null, ok: false }
let C4_DB = null
let C4_Q = []
let C4_BUSY = null
let C4_STATE = { worldStarted: false }
let C4_WARNED = {}

// ---------------------------------------------------------------------------- Java 类
function c4Cls(name) {
  if (!C4_J[name]) C4_J[name] = Java.loadClass(name)
  return C4_J[name]
}
function c4PortalAPI() { return c4Cls('qouteall.imm_ptl.core.api.PortalAPI') }
function c4PortalCls() { return c4Cls('qouteall.imm_ptl.core.portal.Portal') }
function c4Vec(x, y, z) { return new (c4Cls('net.minecraft.world.phys.Vec3'))(x, y, z) }
function c4Rl(id) {
  if (!C4_RL) C4_RL = c4Cls('net.minecraft.resources.ResourceLocation')
  let s = String(id)
  let i = s.indexOf(':')
  if (i < 0) return new C4_RL('minecraft', s)
  return new C4_RL(s.substring(0, i), s.substring(i + 1))
}

// ---------------------------------------------------------------------------- i18n
// 所有玩家可见文本走语言文件：kubejs/assets/cw/lang/{zh_cn,en_us}.json
// 规则：键名在这里，文案在语言文件里；控制台另打一份键名+参数便于排障。
function c4t(k)          { try { return Text.translatable(k) }              catch (e) { return Text.of(k) } }
function c4t1(k, a)      { try { return Text.translatable(k, String(a)) }   catch (e) { return Text.of(k + ' ' + a) } }
function c4t2(k, a, b)   { try { return Text.translatable(k, String(a), String(b)) } catch (e) { return Text.of(k + ' ' + a + ' ' + b) } }
function c4t3(k, a, b, c){ try { return Text.translatable(k, String(a), String(b), String(c)) } catch (e) { return Text.of(k) } }

// ---------------------------------------------------------------------------- 基础
function c4Name(p) {
  try { if (p.username) return String(p.username) } catch (e) {}
  try { let n = p.name; if (n && n.getString) { let s = String(n.getString()); if (s.length) return s } } catch (e) {}
  try { return String(p.uuid) } catch (e) {}
  return '?'
}
function c4DimOf(t) {
  // KubeJS: LevelKJS.kjs$getDimension() -> ResourceLocation，脚本里是属性 level.dimension（不是方法）
  try { let d = t.level.dimension; if (d !== null && d !== undefined) return String(d) } catch (e) {}
  try { let d = t.level.dimension; if (typeof d === 'function') return String(d.call(t.level)) } catch (e) {}
  try { return String(t.level.dimension().location()) } catch (e) {}
  return '?'
}
function c4CubeX(slot) { return slot === 0 ? 0 : (slot * C4_SPACING + C4_X0) }
function c4InCube(p, slot) {
  if (c4DimOf(p) !== 'minecraft:overworld') return false
  let cx = c4CubeX(slot)
  return Math.abs(p.x - cx) <= C4_HALF && Math.abs(p.z - C4_Z) <= C4_HALF && p.y >= C4_Y_MIN && p.y <= C4_Y_MAX
}
function c4Dist2(ax, ay, az, bx, by, bz) {
  let dx = ax - bx, dy = ay - by, dz = az - bz
  return dx * dx + dy * dy + dz * dz
}

// ---------------------------------------------------------------------------- 实体枚举
function c4All(server) {
  let out = []
  try {
    let it = server.entities.iterator()
    while (it.hasNext()) out.push(it.next())
  } catch (e) {
    if (!C4_WARNED.ent) { C4_WARNED.ent = true; console.warn('[C4] server.entities 不可用: ' + e) }
  }
  return out
}
function c4HasTag(e, tag) {
  try { return e.getTags() != null && e.getTags().contains(tag) } catch (err) { return false }
}

// 是否是 IP 的传送门实体（不依赖 Portal 类的静态 isInstance —— 本版 KubeJS 调不通）
function c4IsPortal(e) {
  try { if (String(e.type) === 'immersive_portals:portal') return true } catch (err) {}
  try { if (String(e.type).indexOf('immersive_portals') >= 0) return true } catch (err) {}
  try {
    let cn = e.getCustomName()
    if (cn !== null && cn !== undefined) {
      let t = String(cn.getString())
      if (t.indexOf('main_cube') >= 0) return true
    }
  } catch (err) {}
  try { if (e.getTags() != null && e.getTags().contains('main_cube')) return true } catch (err) {}
  return false
}

// 本台 6 扇门：IP Portal + 在 overworld + 距核心 < 30
function c4PortalsNear(server, cx, cy, cz) {
  let out = []
  c4All(server).forEach(e => {
    if (!c4IsPortal(e)) return
    if (c4DimOf(e) !== 'minecraft:overworld') return
    // 半径 96：扩展后门面最远到 8.51+16*4 ≈ 72.5，30 格半径根本看不到顶门
    if (c4Dist2(e.x, e.y, e.z, cx, cy, cz) > 9216) return
    let dir = null
    ;['y', '-y', 'x', '-x', 'z', '-z'].forEach(d => { if (c4HasTag(e, d)) dir = d })
    out.push({ entity: e, dir: dir })
  })
  return out
}

function c4CountPortals(server, dim, x, y, z, r) {
  let n = 0
  c4All(server).forEach(e => {
    if (!c4IsPortal(e)) return
    if (c4DimOf(e) !== dim) return
    if (c4Dist2(e.x, e.y, e.z, x, y, z) > r * r) return
    n++
  })
  return n
}

function c4Cores(server) {
  let out = []
  c4All(server).forEach(e => {
    if (!(c4HasTag(e, 'cw_core') || c4HasTag(e, 'core'))) return
    if (c4DimOf(e) !== 'minecraft:overworld') return
    let slot = Math.round(Number(e.x) / C4_SPACING)
    try {
      let it = e.getTags().iterator()
      while (it.hasNext()) {
        let t = String(it.next())
        if (t.indexOf('cw_slot') === 0) slot = Number(t.substring(7))
      }
    } catch (err) {}
    out.push({ entity: e, slot: slot, x: e.x, y: e.y, z: e.z })
  })
  return out
}
function c4CoreOfSlot(server, slot) {
  let arr = c4Cores(server)
  for (let i = 0; i < arr.length; i++) if (arr[i].slot === Number(slot)) return arr[i]
  return null
}
// 按钮归属：只按"按钮坐标是否落在某台车厢范围内"判定。
// 不再用"最近核心 60 格"（多台靠近时会认错车），也不再用 cubeX 反推（按钮被复制/挪动会误判）。
// C4_Y_MIN/C4_Y_MAX 是车厢内部高度范围；x/z 半宽 8.6 覆盖内壁 ±8.3875。
function c4SlotForButton(bx, by, bz) {
  if (by < C4_Y_MIN || by > C4_Y_MAX) return null
  // 出生大厅固定 x=0（原包那台）
  if (Math.abs(bx) <= 8.6 && Math.abs(bz - C4_Z) <= 8.6) return 0
  let s = Math.round((bx - C4_X0) / C4_SPACING)
  if (!(s > 0)) return null
  if (Math.abs(bx - c4CubeX(s)) <= 8.6 && Math.abs(bz - C4_Z) <= 8.6) return s
  return null
}

// 审计日志：按钮的每一次允许/拒绝都留一条，事后能直接查到是谁、哪台车
function c4BtnLog(ok, clicker, slot, reason) {
  let who = c4Name(clicker)
  let team = '无'
  try { let t = c4Team(clicker); team = t ? String(c4TeamKey(t)) : '无' } catch (e) {}
  let info = slot === null ? null : c4TeamOfSlot(slot)
  let label = (info && info.cube) ? info.cube.name : '-'
  if (ok) console.info('[C4] 按钮允许：' + who + ' 队伍=' + team + ' → slot ' + slot + '《' + label + '》')
  else console.info('[C4] 按钮拒绝：' + who + ' 队伍=' + team + ' → slot ' + slot + '《' + label + '》 原因=' + reason)
}

// outer_core 是数据包每次跃迁 summon 的"目的地核心"，原包不清它 → 会越积越多，
// 于是 c4OuterCore 可能拿到上一次跃迁遗留的那个（落点漂到旧位置、看到别人的笼子）。
function c4PurgeOuterCores(server) {
  let n = 0
  c4All(server).forEach(e => {
    if (!c4HasTag(e, 'outer_core')) return
    try { e.discard(); n++ } catch (err) { try { e.kill(); n++ } catch (e2) {} }
  })
  return n
}

function c4OuterCore(server) {
  let arr = c4All(server)
  for (let i = 0; i < arr.length; i++) if (c4HasTag(arr[i], 'outer_core')) return arr[i]
  return null
}

// ---------------------------------------------------------------------------- FTB Teams
function c4Ftb() {
  if (C4_FTB.tried) return C4_FTB
  C4_FTB.tried = true
  try {
    let api = c4Cls('dev.ftb.mods.ftbteams.api.FTBTeamsAPI').api()
    if (api.getManager() === null || !api.isManagerLoaded()) { C4_FTB.tried = false; return C4_FTB }
    C4_FTB.api = api
    C4_FTB.ok = true
    console.info('[C4] FTB Teams 已接入')
  } catch (e) {
    C4_FTB.ok = false
    console.warn('[C4] 未接入 FTB Teams: ' + e)
  }
  return C4_FTB
}
function c4Team(p) {
  if (!c4Ftb().ok) return null
  try { let o = C4_FTB.api.getManager().getTeamForPlayer(p); return (o && o.isPresent()) ? o.get() : null } catch (e) { return null }
}
function c4TeamKey(t) {
  if (!t) return null
  try { return String(t.getTeamId()) } catch (e) {}
  try { return String(t.getId()) } catch (e) {}
  return null
}
// 队名会被塞进 SNBT 单引号里的 JSON —— 引号/撇号/反斜杠会让整条 summon 静默失败。
function c4CleanName(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/["'\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function c4TeamLabel(t) {
  if (!t) return '?'
  // 优先用 display name：FTB 会把非 ASCII 的 shortName 清洗成 "_____#hash"
  try { let n = c4CleanName(t.getName().getString()); if (n.length && !/^[_\s]*$/.test(n)) return n } catch (e) {}
  try { let s = c4CleanName(t.getShortName()); if (s.length) return s } catch (e) {}
  try { return c4CleanName(t.getName().getString()) || '队伍' } catch (e) {}
  return '队伍'
}
function c4TeamOnline(t) {
  let out = []
  if (!t) return out
  try { let it = t.getOnlineMembers().iterator(); while (it.hasNext()) out.push(it.next()) } catch (e) {}
  return out
}
function c4IsParty(t) {
  if (!t) return false
  try { if (t.isPartyTeam()) return true } catch (e) {}
  try { if (t.isServerTeam()) return true } catch (e) {}     // /ftbteams server create 出来的也算
  try { return t.getMembers().size() > 1 } catch (e) {}
  return false
}

// ---------------------------------------------------------------------------- 槽位库
function c4Db() {
  if (C4_DB) return C4_DB
  let d = null
  try { d = JsonIO.read(C4_CFG) } catch (e) { d = null }
  // 旧位置（config/）一次性迁移过来
  if (!d || typeof d !== 'object') {
    try { d = JsonIO.read('config/cubarper-cubes.json') } catch (e) { d = null }
    if (d && typeof d === 'object') { try { JsonIO.write(C4_CFG, d) } catch (e) {} }
  }
  if (!d || typeof d !== 'object') d = {}
  if (d.nextSlot === undefined) d.nextSlot = 1
  if (!d.cubes || typeof d.cubes !== 'object') d.cubes = {}
  if (d.requireParty === undefined) d.requireParty = true
  d._comment = '键 = FTB 队伍 UUID；slot 决定坐标 (slot*spacing, ?, z)。slot 0 = 出生点大厅/领车台。'
  C4_DB = d
  return d
}
function c4Save() { try { JsonIO.write(C4_CFG, c4Db()) } catch (e) { console.error('[C4] 写库失败 ' + e) } }
function c4CubeOfTeam(key) { return c4Db().cubes[key] || null }
function c4TeamByKey(key) {
  try {
    let it = C4_FTB.api.getManager().getTeams().iterator()
    while (it.hasNext()) { let t = it.next(); if (t && c4TeamKey(t) === String(key)) return t }
  } catch (e) {}
  return null
}
// FTB 会把非 ASCII 的队名清洗成 "______#hash"；旧存档里的 cube.name 可能已经存成了这种，
// 这里在启动时尝试用队伍 display name 修回来（修不动就保留原值）。
function c4HealCubeNames() {
  let db = c4Db(), changed = 0
  for (let k in db.cubes) {
    let c = db.cubes[k]; if (!c) continue
    let n = String(c.name || '')
    // 顺手清掉队名里带进来的引号/撇号（会破坏 SNBT 并让显示变成 《"名字"》）
    let cleaned = c4CleanName(n)
    if (cleaned !== n && cleaned.length) {
      console.info('[C4] 基地名清洗：' + n + ' → ' + cleaned)
      c.name = cleaned; n = cleaned; changed++
    }
    if (n && n.indexOf('#') < 0 && !/^[_\s]*$/.test(n)) continue
    let t = c4TeamByKey(k)
    let l = t ? c4TeamLabel(t) : ''
    if (l && l !== '队伍' && l.indexOf('#') < 0 && !/^[_\s]*$/.test(l)) {
      console.info('[C4] 基地名自愈：' + n + ' → ' + l + '（槽位 ' + c.slot + '）')
      c.name = l; changed++
    }
  }
  if (changed) c4Save()
  return changed
}

// 只发给本队在线成员：队名、玩家名这类信息不该广播给其它队伍。
// 队里没人在线时什么都不发（控制台的 [C4] 诊断行仍然照常输出）。
// 直接读数据包算好的 dimension_seed（scoreboard players get 的返回值就是分数）。
// 注意：数据包在 pre_runtime=215 会把种子清零，所以必须在 195 读。
function c4SeedOf(server, slot) {
  try {
    let v = server.runCommandSilent('scoreboard players get @e[type=marker,tag=cw_slot' + slot + '] dimension_seed')
    let n = Number(v)
    return isFinite(n) ? n : null
  } catch (e) { return null }
}

// 出生大厅（slot 0）不是可跃迁的基地，它那 6 扇门只会在贴墙处闪烁。
// 启动时清掉大厅区域内的传送门实体即可，别处（各队基地）不受影响。
function c4PurgeLobbyPortals(server) {
  // [TEST-HOLD] 出生点现在被当成"原版双向门"的对照样机：不杀门、不补屏障。
  // 验证完再恢复（否则每次 /reload 都会杀掉那 6 扇门并重新糊上 1131 格屏障）。
  return 0
  try {
    let core = c4CoreOfSlot(server, 0)
    if (!core) return 0
    let cmd = 'execute in minecraft:overworld positioned '
      + Math.floor(core.x) + ' ' + Math.floor(core.y) + ' ' + Math.floor(core.z)
      + ' run kill @e[type=immersive_portals:portal,distance=..24]'
    let n = 0
    try { n = Number(server.runCommandSilent(cmd)) } catch (e) { n = 0 }
    if (n > 0) console.info('[C4] 出生大厅传送门清理: ' + n + ' 扇')
    // 六面补屏障：只把空气换成屏障，不会覆盖台上已有的机器
    let fills = [
      'fill -8 97 -8 -8 113 8', 'fill 8 97 -8 8 113 8',
      'fill -8 97 -8 8 113 -8', 'fill -8 97 8 8 113 8',
      'fill -8 97 -8 8 97 8', 'fill -8 113 -8 8 113 8'
    ]
    let sealed = 0
    fills.forEach(f => {
      try { sealed += Number(server.runCommandSilent('execute in minecraft:overworld run ' + f + ' minecraft:barrier replace minecraft:air')) } catch (e) {}
    })
    if (sealed > 0) console.info('[C4] 出生大厅补屏障: ' + sealed + ' 格')
    return n
  } catch (e) { console.warn('[C4] 大厅门清理失败: ' + e); return 0 }
}

function c4TellTeam(server, slot, msg) {
  try {
    let info = c4TeamOfSlot(slot)
    let t = info ? c4TeamByKey(info.key) : null
    if (t) {
      let ms = c4TeamOnline(t)
      if (ms.length) { ms.forEach(m => { try { m.tell(msg) } catch (e) {} }); return }
    }
  } catch (e) {}
}

function c4TeamOfSlot(slot) {
  let c = c4Db().cubes
  for (let k in c) if (c[k] && Number(c[k].slot) === Number(slot)) return { key: k, cube: c[k] }
  return null
}
function c4Claim(slot, team, id) {
  if (Number(slot) === 0) return null
  let key = c4TeamKey(team)
  if (!key) return null
  let db = c4Db()
  if (db.cubes[key]) return db.cubes[key]
  if (c4TeamOfSlot(slot)) return null
  let cubeId = id || ('cube' + slot)
  for (let k in db.cubes) if (db.cubes[k] && db.cubes[k].id === cubeId) return null
  let cube = { slot: Number(slot), id: cubeId, name: c4TeamLabel(team), x: c4CubeX(slot), z: C4_Z, provisioned: false, claimedAt: Date.now(),
    ext: { px: 0, nx: 0, pz: 0, nz: 0, py: 0 } }
  db.cubes[key] = cube
  if (Number(slot) >= db.nextSlot) db.nextSlot = Number(slot) + 1
  c4Save()
  return cube
}

function c4LoadState() {
  let s = null
  try { s = JsonIO.read(C4_STATE_PATH) } catch (e) { s = null }
  if (s && typeof s === 'object') C4_STATE.worldStarted = !!s.worldStarted
  return C4_STATE
}
function c4SaveState() {
  try { JsonIO.write(C4_STATE_PATH, { worldStarted: C4_STATE.worldStarted, savedAt: Date.now() }) } catch (e) {}
}

// ---------------------------------------------------------------------------- 区块加载（API，替代 forceload）
let C4_CL_OK = null      // null=未知 true=可用 false=不可用
function c4ChunkLoader(server, slot) {
  if (C4_CL_OK === false) return false
  try {
    let lvl = c4OwLevel(server)
    if (lvl === null) throw new Error('取不到主世界 ServerLevel')
    let dc = new (c4Cls('qouteall.imm_ptl.core.chunk_loading.DimensionalChunkPos'))(
      c4DimKey('minecraft:overworld'), Math.floor(c4CubeX(slot) / 16), Math.floor(C4_Z / 16))
    let loader = new (c4Cls('qouteall.imm_ptl.core.chunk_loading.ChunkLoader'))(dc, 1)
    c4PortalAPI().addGlobalChunkLoader(server, loader)
    C4_CL_OK = true
    return true
  } catch (e) {
    C4_CL_OK = false
    console.warn('[C4] ChunkLoader 不可用，改用 forceload（只提示一次）: ' + e)
    return false
  }
}

function c4ForceloadBox(slot, add) {
  let x = c4CubeX(slot)
  let x0 = Math.floor((x - 16) / 16) * 16, x1 = Math.floor((x + 16) / 16) * 16 + 15
  let z0 = Math.floor((C4_Z - 16) / 16) * 16, z1 = Math.floor((C4_Z + 16) / 16) * 16 + 15
  return `forceload ${add ? 'add' : 'remove'} ${x0} ${z0} ${x1} ${z1}`
}

// ---------------------------------------------------------------------------- 门操作（v4 核心）
// 直接用 ResourceKey.create(Registries.DIMENSION, rl) 造维度 key —— 不需要 ServerLevel
function c4DimKey(id) {
  try {
    let rl = (typeof id === 'string') ? c4Rl(id) : id
    let RK = c4Cls('net.minecraft.resources.ResourceKey')
    let REG = c4Cls('net.minecraft.core.registries.Registries')
    return RK.create(REG.DIMENSION, rl)
  } catch (e) {
    console.error('[C4] 造维度 key 失败 ' + id + ': ' + e)
    return null
  }
}

// 主世界 ServerLevel（KubeJS 里 server.overworld 可能是值也可能是方法，两种都试）
function c4OwLevel(server) {
  try { let v = server.overworld; if (v !== null && v !== undefined && typeof v !== 'function') return v } catch (e) {}
  try { let v = server.overworld; if (typeof v === 'function') return v() } catch (e) {}
  try { let v = server.getLevel(c4Rl('minecraft:overworld')); if (v !== null && v !== undefined) return v } catch (e) {}
  return null
}

function c4Level(server, dimId) {
  try { return server.getLevel(c4Rl(dimId)) } catch (e) { console.error('[C4] 取维度失败 ' + dimId + ': ' + e); return null }
}
function c4Sync(portal) {
  try { portal.reloadAndSyncToClient() } catch (e) {
    try { portal.reloadAndSyncToClientNextTick() } catch (e2) { console.warn('[C4] 同步失败: ' + e2) }
  }
}
function c4Hide(server, cx, cy, cz) {
  let n = 0
  c4PortalsNear(server, cx, cy, cz).forEach(p => {
    try { p.entity.setIsVisible(false); c4Sync(p.entity); n++ } catch (e) { console.warn('[C4] hide: ' + e) }
  })
  return n
}
function c4KillReverses(server, idName) {
  let n = 0
  let own = idName ? ('cw_rev_' + idName) : null
  c4All(server).forEach(e => {
    if (!c4HasTag(e, 'cw_rev')) return
    if (own && !c4HasTag(e, own)) {
      // 别人的反向门：只要它带归属 tag 就留着；没有归属 tag 的旧遗留才清
      let hasOwner = false
      try { e.getTags().forEach(t => { if (String(t).indexOf('cw_rev_') === 0) hasOwner = true }) } catch (err) {}
      if (hasOwner) return
    }
    try { e.discard(); n++ } catch (err) { try { e.kill(); n++ } catch (e2) {} }
  })
  return n
}

// —— 能力探测（每种通道第一次用的时候记一笔，!cube api 可查）
let C4_CAP = { apiStatic: null, instSetter: null, cmdSet: null }
function c4CapLog(k, v) {
  if (C4_CAP[k] !== v) { C4_CAP[k] = v; console.info('[C4] 通道 ' + k + ' = ' + v) }
}

// 把单扇门指向 dest：三级阶梯
function c4ApplyPortal(server, portal, destId, destKey, destPos, coreX, coreY, coreZ) {
  // ① API 静态方法（rotation 传 null = 保持两侧同向平行，与原包 set_portal_destination 行为一致）
  try {
    c4PortalAPI().setPortalTransformation(portal, destKey, destPos, null, 1.0)
    c4CapLog('apiStatic', 'OK')
    return true
  } catch (e1) { c4CapLog('apiStatic', 'FAIL: ' + e1) }

  // ② Portal 实例 setter（entity 对象一定是 NativeJavaObject，实例方法必然可用）
  try {
    portal.setDestinationDimension(destKey)   // 只改"另一侧在哪"，不动门的朝向/旋转变换
    portal.setDestination(destPos)
    portal.setScaleTransformation(1.0)
    c4CapLog('instSetter', 'OK')
    return true
  } catch (e2) { c4CapLog('instSetter', 'FAIL: ' + e2) }

  // ③ 退回指令（按"离核心 30 格"精确限定，不会点到别台）
  try {
    server.runCommandSilent(
      `execute as @e[type=immersive_portals:portal,name=main_cube,distance=..30] at @s run portal set_portal_destination ${destId} ${destPos.x} ${destPos.y} ${destPos.z}`)
    c4CapLog('cmdSet', 'OK')
    return true
  } catch (e3) { c4CapLog('cmdSet', 'FAIL: ' + e3) }
  return false
}

// 目的地准备：① 与其它队伍的上个落点做距离检查（撞车就往 +x 推）② 提前 forceload 目的地区块
function c4DestConflicts(ownKey, dimId, x, y, z) {
  let out = []
  let cubes = c4Db().cubes
  for (let k in cubes) {
    if (!cubes[k] || k === ownKey) continue
    let d = cubes[k].dest
    if (!d || d.dim !== dimId) continue
    let dx = d.x - x, dz = d.z - z
    if (dx * dx + dz * dz < C4_DEST_MIN_SEP * C4_DEST_MIN_SEP && Math.abs(d.y - y) < 64) {
      out.push('slot' + cubes[k].slot)
    }
  }
  return out
}

function c4PrepareDest(server, slot, job) {
  // 目标：让每次跃迁都落在【不同的地方】，同时保证与其它台的落点相距 > hex_anchor 的复用半径。
  // 原包只有 spreadplayers ±100，而且一旦有 hex_anchor 就直接 tp 过去 —— 所以每次落点几乎一样。
  let outer = c4OuterCore(server)
  if (!outer) { console.warn('[C4] 目的地预判：还没看到 outer_core'); return }
  let dimId = c4DimOf(outer)
  // 以【自己立方体的 X】为基准做抖动，而不是以 outer_core 当前坐标为准 ——
  // 后者可能已经被数据包的 hex_anchor 挪到别的台附近，导致"落点跑到别人家门口"。
  let baseX = c4CubeX(slot), baseZ = C4_Z
  let y = Math.round(outer.y)
  let own = c4TeamOfSlot(slot)
  let ownKey = own ? own.key : null

  let moveTo = (x, z, why) => {
    server.runCommandSilent('execute in ' + dimId + ' positioned ' + (x + 0.5) + ' ' + y + ' ' + (z + 0.5) +
      ' run kill @e[type=marker,tag=hex_anchor,distance=..' + C4_DEST_MIN_SEP + ']')
    server.runCommandSilent('execute in ' + dimId + ' run tp @e[type=marker,tag=outer_core] ' + (x + 0.5) + ' ' + y + ' ' + (z + 0.5))
    let cx = Math.floor(x / 16) * 16, cz = Math.floor(z / 16) * 16
    server.runCommandSilent('execute in ' + dimId + ' run forceload add ' + cx + ' ' + cz)
    if (job) { job.nudgeFORCELOAD = { dim: dimId, cx: cx, cz: cz }; job.destPlan = { dim: dimId, x: x, y: y, z: z, cx: cx, cz: cz } }
    console.info('[C4] 落点' + why + ' → ' + dimId + ' @' + x + ',' + y + ',' + z)
  }

  // ① 随机抖动（每次跃迁不同）
  let jx = Math.round((Math.random() * 2 - 1) * C4_DEST_JITTER)
  let jz = Math.round((Math.random() * 2 - 1) * C4_DEST_JITTER)
  let x = baseX + jx, z = baseZ + jz
  moveTo(x, z, '随机抖动 ±' + C4_DEST_JITTER)

  // ② 撞车：与其它台已记录的落点 < MIN_SEP → 沿 +x 单调外移
  for (let i = 1; i <= 5; i++) {
    let bad = c4DestConflicts(ownKey, dimId, x, y, z)
    if (bad.length === 0) break
    console.warn('[C4] 落点与 ' + bad.join(',') + ' 相距 <' + C4_DEST_MIN_SEP + ' → 外移 ' + (i * C4_DEST_NUDGE))
    x = baseX + i * C4_DEST_NUDGE
    z = baseZ + jz
    moveTo(x, z, '避让外移 ×' + i)
  }
}

// t=186：此时 unfold 已跑完，outer_core 才是【最终落点】——在这里做真实预载 + 记录
function c4PreloadFinal(server, slot, job) {
  let outer = c4OuterCore(server)
  let dimId, x, y, z
  if (outer) {
    dimId = c4DimOf(outer)
    x = Math.round(outer.x); y = Math.round(outer.y); z = Math.round(outer.z)
  } else if (job && job.destPlan) {
    let p = job.destPlan
    dimId = p.dim; x = p.x; y = p.y; z = p.z
    console.warn('[C4] 预载：没有 outer_core，回退到预判落点 @' + x + ',' + y + ',' + z)
  } else { console.warn('[C4] 最终预载：拿不到 outer_core 且无预判落点'); return }
  // 笼子横跨 17 格，最多压 2×2 区块；t=180 那次 forceload 的是【预判落点】的区块，
  // 数据包 unfold 之后实际落点可能已经飘出去几十格 → 那些区块没加载 → fill/setblock 全落空，
  // 结果就是"门在、笼子不在"，走进去直接掉虚空。这里按【最终落点】把 3×3 区块全部常加载。
  let bx = (outer ? Number(outer.x) : job.destPlan.x + 0.5)
  let by = (outer ? Number(outer.y) : job.destPlan.y) - 5
  let bz = (outer ? Number(outer.z) : job.destPlan.z + 0.5)   // 17x17 的构建基准 = 核心 - 5
  let cx = Math.floor(x / 16) * 16, cz = Math.floor(z / 16) * 16
  server.runCommandSilent('execute in ' + dimId + ' run forceload add ' + (x - 16) + ' ' + (z - 16) + ' ' + (x + 16) + ' ' + (z + 16))
  // 补建一次笼子（幂等；数据包那次大概率因为区块没加载而全部失败）
  server.scheduleInTicks(2, () => {
    try {
      server.runCommandSilent('execute in ' + dimId + ' positioned ' + bx + ' ' + by + ' ' + bz + ' run function hexahedron:build_hexahedron/17x17')
      server.runCommandSilent('execute in ' + dimId + ' positioned ' + bx + ' ' + by + ' ' + bz + ' run setblock ~ ~8 ~ minecraft:light[level=15]')
      server.runCommandSilent('execute in ' + dimId + ' positioned ' + bx + ' ' + by + ' ' + bz + ' run fill ~-1 ~-3 ~-1 ~1 ~-3 ~1 kubejs:hexahedron_filling')
      console.info('[C4] 目的地笼子补建 @' + bx + ',' + by + ',' + bz + ' dim=' + dimId)
    } catch (e) { console.warn('[C4] 目的地笼子补建失败: ' + e) }
  })
  job.dest = { dim: dimId, x: x, y: y, z: z, cx: cx, cz: cz }
  console.info('[C4] 目的地最终预载 dim=' + dimId + ' @' + x + ',' + y + ',' + z + '（区块 ' + cx + ',' + cz + '）')
}

// 把 6 扇门指到 destCenter（目标维度 level）。ext 必须传：扩展过的门面会外移 16*n、
// 门面中心会随房间几何中心平移 8*n，用固定 ±8.51 会把第二次扩展的门又拽回去。
function c4Retarget(server, cx, cy, cz, destKey, dx, dy, dz, withReverse, destId, idName, ext, moveSrc) {
  if (!destKey) { console.error('[C4] retarget: destKey 为空'); return 0 }
  let e = c4Ext({ ext: ext })
  let D = C4_DEST_FACE
  let scx = cx + 8 * (e.px - e.nx), scy = cy + 8 * e.py, scz = cz + 8 * (e.pz - e.nz)
  let srcPos = {
    // 顶面必须跟着 py 上移：少了 16*py 的话，c4MakeRoomPortals 刚把门建到 130.01，
    // 这里又把它拽回 114.01 —— 就是你看到的"顶部门错位"。
    'y':  [scx, cy + C4_FACE + 16 * e.py, scz],
    '-y': [scx, cy - C4_FACE, scz],
    'x':  [cx + C4_FACE + 16 * e.px, scy, scz],
    '-x': [cx - C4_FACE - 16 * e.nx, scy, scz],
    'z':  [scx, scy, cz + C4_FACE + 16 * e.pz],
    '-z': [scx, scy, cz - C4_FACE - 16 * e.nz]
  }
  let dcx = dx + 8 * (e.px - e.nx), dcy = dy + 8 * e.py, dcz = dz + 8 * (e.pz - e.nz)
  // 上下门按【同面】映射（原包语义）：顶门→对面顶面、底门→对面底面。
  // 落点被塞进地板/天花板时由 adjustPositionAfterTeleport 抬到安全位置；
  // 地板洞在落点侧已封（hexahedron_filling），不会再出现"一直下落"的循环。
  let dstPos = {
    'y':  [dcx, dy + D + 16 * e.py, dcz],
    '-y': [dcx, dy - D, dcz],
    'x':  [dx + D + 16 * e.px, dcy, dcz],
    '-x': [dx - D - 16 * e.nx, dcy, dcz],
    'z':  [dcx, dcy, dz + D + 16 * e.pz],
    '-z': [dcx, dcy, dz - D - 16 * e.nz]
  }
  let done = 0
  let ps = c4PortalsNear(server, cx, cy, cz).filter(p => !c4HasTag(p.entity, 'cw_lobby'))
  let own = idName ? ps.filter(p => c4HasTag(p.entity, 'cw_id_' + idName)) : ps
  if (idName && own.length === 0 && ps.length > 0) {
    // 本台的门没有归属标签（历史遗留/被数据包重建过）→ 按位置收编，别整次跃迁作废
    console.warn('[C4] 门没有 cw_id_' + idName + ' 标签 → 收编附近 ' + ps.length + ' 扇')
    own = ps
    ps.forEach(p => { try { p.entity.addTag('cw_id_' + idName) } catch (e) {} })
  }
  own.forEach(p => {
    if (!p.dir) {
      // 没有方向 tag 时按相对核心的方位补
      let dx0 = p.entity.x - cx, dy0 = p.entity.y - cy, dz0 = p.entity.z - cz
      let ax = Math.abs(dx0), ay = Math.abs(dy0), az = Math.abs(dz0)
      let dir = (ay >= ax && ay >= az) ? (dy0 > 0 ? 'y' : '-y') : (ax >= az ? (dx0 > 0 ? 'x' : '-x') : (dz0 > 0 ? 'z' : '-z'))
      try { p.entity.addTag(dir) } catch (e) {}
      p.dir = dir
    }
    if (!srcPos[p.dir]) return
    let sp = srcPos[p.dir], dp = dstPos[p.dir]
    // 只有【扩展/拆除】才挪主世界的门；跃迁只改 destination，主世界的门必须原地不动
    if (moveSrc) {
      try {
        p.entity.setOriginPos(c4Vec(sp[0], sp[1], sp[2]))
        p.entity.setPos(sp[0], sp[1], sp[2])
      } catch (e2) { console.warn('[C4] 门面落位失败 ' + p.dir + ': ' + e2) }
    }
    let pos = c4Vec(dp[0], dp[1], dp[2])
    if (!c4ApplyPortal(server, p.entity, destId, destKey, pos, cx, cy, cz)) {
      console.error('[C4] retarget 失败 dir=' + p.dir)
      return
    }
    try { p.entity.setIsVisible(true); c4Sync(p.entity) } catch (e) { console.warn('[C4] show: ' + e) }
    done++
  })
  if (done === 0) console.warn('[C4] retarget: 没找到门 @ ' + cx + ',' + cy + ',' + cz)
  return done
}

// ---------------------------------------------------------------------------- 玩家传送（IP API）
function c4Tp(server, player, dimId, x, y, z) {
  let want = String(dimId)
  let lv = null
  try { if (c4DimOf(player) === want) lv = player.level } catch (e) {}
  if (lv === null) lv = (want === 'minecraft:overworld') ? c4OwLevel(server) : c4Level(server, want)
  if (lv === null) lv = c4OwLevel(server)
  if (lv === null) { console.error('[C4] 取不到目标 ServerLevel: ' + want); return false }
  // 传送不能改玩家的朝向/俯仰：先记下来，兜底通道用原值
  let yaw = 0.0, pitch = 0.0
  try { yaw = Number(player.yaw); pitch = Number(player.pitch) } catch (e0) {}
  if (!isFinite(yaw)) yaw = 0.0
  if (!isFinite(pitch)) pitch = 0.0
  try {
    c4PortalAPI().teleportEntity(player, lv, c4Vec(x, y, z))
    try { player.setYRot(yaw); player.setXRot(pitch) } catch (e3) {}
    return true
  } catch (e1) {
    try {
      player.teleportTo(c4Rl(dimId), x, y, z, yaw, pitch)
      return true
    } catch (e2) {
      console.error('[C4] 传送失败 ' + c4Name(player) + ': ' + e1 + ' / ' + e2)
      return false
    }
  }
}
function c4Seat(slot, i, n) {
  let cx = c4CubeX(slot) + 0.5, cz = C4_Z + 0.5
  // 落点抬高 1 格：新建立方体是异步建造的（forceload 20 tick + 建房间），
  // 传送太早/贴地会被卡进未建好的地板，甚至直接掉进虚空。
  if (n <= 1) return { x: cx, y: 99.0, z: cz + 6.0 }
  let r = n <= 4 ? 2.6 : (n <= 8 ? 3.6 : 5.0)
  let a = (2 * Math.PI * i) / n - Math.PI / 2
  return { x: cx + Math.cos(a) * r, y: 98.0, z: cz + Math.sin(a) * r }
}
function c4SendToCube(server, players, slot) {
  c4ClearStrayPreRuntime(server)
  let n = Math.max(1, players.length), ok = 0
  players.forEach((p, i) => {
    // 已经在基地里（同维度 + 在舱体范围内）就不动他，避免打断走动和视角。
    // 不计入返回值：返回值只表示"真的被传送了几个人"。
    if (c4InCube(p, slot)) return
    let s = c4Seat(slot, i, n)
    if (c4Tp(server, p, 'minecraft:overworld', s.x, s.y, s.z)) ok++
  })
  return ok
}

// ---------------------------------------------------------------------------- 孤儿车厢：队伍已不存在，但车厢和里面的东西都还在
function c4LiveTeamKeys() {
  let out = {}
  if (!c4Ftb().ok) return out
  try {
    let col = C4_FTB.api.getManager().getTeams()
    let it = col.iterator()
    while (it.hasNext()) {
      let t = it.next()
      let k = c4TeamKey(t)
      if (k) out[k] = c4TeamLabel(t)
    }
  } catch (e) { console.warn('[C4] 枚举队伍失败: ' + e) }
  return out
}

function c4OrphanSlots() {
  let live = c4LiveTeamKeys()
  let out = []
  let cubes = c4Db().cubes
  for (let k in cubes) {
    if (!cubes[k]) continue
    if (!live[k]) out.push({ key: k, cube: cubes[k] })
  }
  return out
}

// ---------------------------------------------------------------------------- 供给：造一台立方体
function c4Provision(server, slot, teamName, idName, force) {
  // 保护：已经建造过的车厢默认不允许重建 —— 重建 = 清空 19×21×19 内部，会连机器一起铲掉
  let h = c4TeamOfSlot(slot)
  if (!force && h && h.cube && h.cube.provisioned) {
    console.warn('[C4] 拒绝重建已存在的基地 slot=' + slot + '（未加 force）')
    console.info('[C4] 已有基地：force 会清空内部，请走 /cwp build ' + slot + ' force 二次确认')
    return
  }
  // chat 事件有可能在工作线程触发，而 runCommandSilent/实体枚举必须在主线程 → 统一延后 1 tick
  server.scheduleInTicks(1, () => {
    try { c4ProvisionOnThread(server, slot, teamName, idName) }
    catch (e) { console.error('[C4] 建造失败 slot=' + slot + ': ' + e) }
  })
}

// 轮询等待门真正出现（创建后实体入表有延迟，固定 2 tick 不可靠）
function c4WaitPortals(server, cx, cy, cz, tries, cb) {
  let n = 0
  try { n = c4PortalsNear(server, cx, cy, cz).length } catch (e) {}
  if (n >= 6 || tries <= 0) { cb(n); return }
  server.scheduleInTicks(5, () => c4WaitPortals(server, cx, cy, cz, tries - 1, cb))
}

function c4ProvisionOnThread(server, slot, teamName, idName) {
  let x = c4CubeX(slot)
  // 自愈：早期槽位坐标没有 +8 偏移，DB 里记的 x 可能和 c4CubeX 不一致，
  // 导致"一半门按旧坐标、一半门按新坐标"。建造时以 c4CubeX 为准并回写。
  try {
    let h = c4TeamOfSlot(slot)
    if (h && h.cube && Number(h.cube.x) !== Number(x)) {
      console.warn('[C4] 槽位 ' + slot + ' 坐标自愈：' + h.cube.x + ' → ' + x)
      h.cube.x = x; h.cube.z = C4_Z; c4Save()
    }
  } catch (e) {}
  console.info('[C4] 建造槽位 ' + slot + ' @ x=' + x + ' id=' + idName)
  // 永久强制加载：server.entities 只枚举"已加载区块"里的实体，远端立方体一旦卸载，
  // 之后所有 /cwp、!cube 的实体查询都会"找不到核心"。每台只占 2×2 区块。
  server.runCommandSilent(c4ForceloadBox(slot, true))
  // forceload 是异步的：2 tick 时区块往往还没进内存，fill / summon marker 会全部落空
  // （第一次见到就是"造门 = 0 扇"、立方体整块没生成）。等 1 秒再建。
  server.scheduleInTicks(20, () => {
    try { c4ProvisionBody(server, slot, teamName, idName) }
    catch (e) { console.error('[C4] 建造主体失败 slot=' + slot + ': ' + e) }
  })
}

// 原包 hexahedron_setup 的做法：6 个带朝向的 marker → portal cb_make_portal 17 17。
// IP 的 cb_make_portal 会按 marker 朝向算 axisW/axisH，并做 cluster / parallelPortalId 等内部登记；
// 手写 NBT summon 出来的门在轴向上和它并不等价（门缝、朝向、"看不到外面"多半出在这）。
function c4MakePortals(server, slot, idName) {
  let cx = c4CubeX(slot) + 0.5, cy = C4_CORE_Y, cz = C4_Z + 0.5
  let t = 'c4mk' + slot
  // 位置 = 门面 ±8.51；Rotation 与原包 hexahedron_setup 完全一致
  let rot = [
    ['y',  '~ ~8.51 ~',  0.0, -90.0],
    ['-y', '~ ~-8.51 ~', 0.0,  90.0],
    ['x',  '~8.51 ~ ~',  270.0, 0.0],
    ['-x', '~-8.51 ~ ~', 90.0,  0.0],
    ['z',  '~ ~ ~8.51',  0.0,  0.0],
    ['-z', '~ ~ ~-8.51', 180.0, 0.0]
  ]
  rot.forEach(r => {
    server.runCommandSilent(`execute positioned ${cx} ${cy} ${cz} run summon marker ${r[1]} {Rotation:[${r[2]}f,${r[3]}f],NoGravity:1b,Tags:["${t}","${r[0]}"]}`)
  })
  try {
    server.runCommandSilent(`execute as @e[type=marker,tag=${t}] at @s run portal cb_make_portal ${C4_PORTAL_SPAN} ${C4_PORTAL_SPAN} @s @s main_cube`)
  } catch (e) { console.warn('[C4] cb_make_portal 失败: ' + e) }
  server.runCommandSilent(`kill @e[type=marker,tag=${t}]`)
  // cb_make_portal 偶尔漏一扇（那面所在的区块在 summon 那一刻还没加载完）→ 15 tick 后按缺的面补一次
  let retry = (tries) => {
    if (tries <= 0) return
    server.scheduleInTicks(15, () => {
      try {
        let have = {}
        c4PortalsNear(server, cx, cy, cz).forEach(p => { if (p.dir) have[p.dir] = true })
        let miss = []
        ;['y', '-y', 'x', '-x', 'z', '-z'].forEach(d => { if (!have[d]) miss.push(d) })
        if (miss.length === 0) return
        console.info('[C4] 槽位 ' + slot + ' 补门: ' + miss.join(','))
        miss.forEach(d => {
          let r = null
          ;rot.forEach(x => { if (x[0] === d) r = x })
          if (!r) return
          let mt = 'c4fx' + slot + d.replace('-', 'n')
          server.runCommandSilent(`execute positioned ${cx} ${cy} ${cz} run summon marker ${r[1]} {Rotation:[${r[2]}f,${r[3]}f],NoGravity:1b,Tags:["${mt}"]}`)
          server.runCommandSilent(`execute as @e[type=marker,tag=${mt}] at @s run portal cb_make_portal ${C4_PORTAL_SPAN} ${C4_PORTAL_SPAN} @s @s main_cube`)
          server.runCommandSilent(`kill @e[type=marker,tag=${mt}]`)
        })
        retry(tries - 1)
      } catch (e) { console.warn('[C4] 补门失败: ' + e) }
    })
  }
  retry(2)

  // cb_make_portal 不带方向 tag：按门相对核心的方位补 y/-y/x/-x/z/-z 和 cw_id_xxx
  let made = 0
  c4PortalsNear(server, cx, cy, cz).forEach(p => {
    if (!p.dir) {
      let dx = p.entity.x - cx, dy = p.entity.y - cy, dz = p.entity.z - cz
      let ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz)
      let dir = (ay >= ax && ay >= az) ? (dy > 0 ? 'y' : '-y')
        : (ax >= az ? (dx > 0 ? 'x' : '-x') : (dz > 0 ? 'z' : '-z'))
      try { p.entity.addTag(dir) } catch (e) {}
      p.dir = dir
    }
    try { p.entity.addTag('cw_id_' + idName) } catch (e) {}
    made++
  })
  return made
}

// 反向门交给 IP 自己：portal complete_bi_way_portal。
// IP 按 createReversePortal 的规则在 destPos 生成另一侧（axisW 取反、parallelPortalId 互链、cluster 归属），
// 和手写 NBT summon 出来的门不是一回事。
function c4MakeReverse(server, slot, dimId, dx, dy, dz, idName) {
  // 先清掉落点附近的旧反向门：complete_bi_way_portal 只增不删，重建几次就会叠出 6×N 扇
  try {
    server.runCommandSilent('execute in ' + dimId + ' positioned ' + dx + ' ' + dy + ' ' + dz + ' run kill @e[type=immersive_portals:portal,distance=..100,tag=!cw_lobby]')
  } catch (e) { console.warn('[C4] 清旧反向门失败: ' + e) }
  try {
    server.runCommandSilent('execute as @e[type=immersive_portals:portal,tag=cw_id_' + idName + '] at @s run portal complete_bi_way_portal')
  } catch (e) { console.warn('[C4] complete_bi_way_portal 失败: ' + e) }
  // 给目的地那侧的新门打归属标记（按维度 + 落点范围，主世界那 6 扇不在这个维度里）
  try {
    server.runCommandSilent('execute in ' + dimId + ' positioned ' + dx + ' ' + dy + ' ' + dz +
      ' run tag @e[type=immersive_portals:portal,distance=..100] add cw_rev')
    server.runCommandSilent('execute in ' + dimId + ' positioned ' + dx + ' ' + dy + ' ' + dz +
      ' run tag @e[type=immersive_portals:portal,distance=..100] add cw_rev_' + idName)
    server.runCommandSilent('execute in ' + dimId + ' positioned ' + dx + ' ' + dy + ' ' + dz +
      ' run tag @e[type=immersive_portals:portal,distance=..100] add cw_id_' + idName)
  } catch (e) { console.warn('[C4] 反向门打标记失败: ' + e) }
  let n = 0
  try { n = c4PortalsNear(server, dx, dy, dz).length } catch (e) {}
  console.info('[C4] 反向门：complete_bi_way_portal 完成，落点附近 ' + n + ' 扇')
  // 目的地区块可能还没加载完 → IP 一扇都没造出来。30 tick 后再试一次（有就不补，避免叠门）
  if (n === 0) {
    server.scheduleInTicks(30, () => {
      try {
        if (c4PortalsNear(server, dx, dy, dz).length > 0) return
        server.runCommandSilent('execute as @e[type=immersive_portals:portal,tag=cw_id_' + idName + '] at @s run portal complete_bi_way_portal')
        let m = c4PortalsNear(server, dx, dy, dz).length
        console.info('[C4] 反向门重试：' + m + ' 扇')
      } catch (e) { console.warn('[C4] 反向门重试失败: ' + e) }
    })
  }
  return n
}

function c4ProvisionBody(server, slot, teamName, idName) {
  let x = c4CubeX(slot)
  // 幂等：清掉这一格附近的旧门/旧 marker（此时区块已加载，kill 才会命中）
  server.runCommandSilent(`execute in minecraft:overworld positioned ${x} ${C4_CORE_Y} ${C4_Z} run kill @e[type=immersive_portals:portal,distance=..30,tag=!cw_lobby]`)
  server.runCommandSilent(`kill @e[type=marker,tag=cw_p${slot}]`)
  server.runCommandSilent(`kill @e[type=marker,tag=cw_slot${slot}]`)

  // ★ 整块清空：把 19×21×19 的立方体体积全部变空气
  //   原因：hexahedron_filling("正方体") 只是"生成瞬间遮住主世界"的临时遮挡；
  //   不清掉的话玩家进舱后会被一层隐形方块包住（看起来就是一堵"屏障"），
  //   而且目标坐标若有地形/旧外壳残留也会卡在里面。清空后由 17x17 重建外壳+地板+面板+按钮。
  //   19×21×19 = 7581 格，远低于 fill 上限 32768。
  server.runCommandSilent(
    `execute in minecraft:overworld positioned ${x} ${C4_BASE_Y} ${C4_Z} run fill ~-9 ~-5 ~-9 ~9 ~14 ~9 air`)
  c4ChunkLoader(server, slot)

  // 1) 外壳/地板/面板/按钮/排气口（在刚清空的体积里重建；17x17 里的 hexahedron_filling 只补地板 3×3 洞）
  server.runCommandSilent(`execute positioned ${x} ${C4_BASE_Y} ${C4_Z} run function hexahedron:build_hexahedron/17x17`)
  // 1.5) 把 3×3 地板洞下方那格 hexahedron_filling 之外的残余再清一次内部（保险）
  server.runCommandSilent(`execute in minecraft:overworld positioned ${x} ${C4_BASE_Y} ${C4_Z} run fill ~-7 ~-2 ~-7 ~7 ~12 ~7 air replace kubejs:hexahedron_filling`)
  // 1.6) 外壳（贴着框梁外表面那一格）整体替换成 hexahedron_filling —— 与 c4BuildRoom(false) 同一套几何，
  //      17x17 只负责房间内部，外层在这里补，门边才不会和框梁 z-fighting。
  if (Number(slot) > 0) {
    try {
      c4ShellFill(server, 'minecraft:overworld', c4RoomBox(x + 0.5, C4_CORE_Y, C4_Z + 0.5, { px: 0, nx: 0, pz: 0, nz: 0, py: 0 }), 'kubejs:hexahedron_filling')
      console.info('[C4] 槽位 ' + slot + ' 外壳 filling 已铺')
    } catch (e) { console.warn('[C4] 外壳 filling 失败: ' + e) }
  }

  // 2) 6 个门面 marker（只带本槽位专属 tag，避免和别台混）
  let t = 'cw_p' + slot
  let rot = [
    ['y', '~ ~8.51 ~', 0.0, -90.0], ['-y', '~ ~-8.51 ~', 0.0, 90.0],
    ['x', '~8.51 ~ ~', 270.0, 0.0], ['-x', '~-8.51 ~ ~', 90.0, 0.0],
    ['z', '~ ~ ~8.51', 0.0, 0.0], ['-z', '~ ~ ~-8.51', 180.0, 0.0]
  ]
  rot.forEach(r => {
    server.runCommandSilent(`execute positioned ${x} ${C4_CORE_Y} ${C4_Z} run summon marker ${r[1]} {Rotation:[${r[2]}f,${r[3]}f],NoGravity:1b,Tags:["portal","${r[0]}","${t}"]}`)
  })

  // 3) 造 6 扇门（全流程只有这里用一次命令；运行期全走 API）
  let made = c4MakePortals(server, slot, idName)
  console.info('[C4] 槽位 ' + slot + ' 造门 = ' + made + ' 扇')

  // 4) 核心 marker：core(原包兼容) + cw_core + cw_slotN + cw_id_xxx + 显示名
  //    房间中心是方块中心 (x+0.5, z+0.5)，与出生点那台原版立方体一致（核心 0.5,105.5,0.5）。
  //    以前用整数 x/z 召核心、并用整数中心 retarget，6 扇门整体偏了半格。
  let safeName = c4CleanName(teamName) || ('cube' + slot)
  let dj = JSON.stringify({ text: safeName })   // 单引号 SNBT 内不要转义双引号
  const MX = x + 0.5, MZ = C4_Z + 0.5
  server.runCommandSilent(`execute positioned ${MX} ${C4_CORE_Y} ${MZ} run summon marker ~ ~ ~ {CustomName:'${dj}',Rotation:[0.0f,-90.0f],NoGravity:1b,Tags:["core","cw_core","cw_slot${slot}","cw_id_${idName}"]}`)

  // 5) 清临时 marker
  server.runCommandSilent(`kill @e[type=marker,tag=${t}]`)

  // 6) 轮询等待 6 扇门就绪，再打身份 tag + 初次指向（bedrock_bottom，与原包开局一致）
  c4WaitPortals(server, MX, C4_CORE_Y, MZ, 20, (n) => {
    console.info('[C4] 槽位 ' + slot + ' 门就绪数量 = ' + n)
    c4PortalsNear(server, MX, C4_CORE_Y, MZ).forEach(p => {
      try { p.entity.addTag('cw_id_' + idName) } catch (e) {}
    })
    // 起点：每台立方体在【自己的 x 位置、基岩维度】有一间私有笼子，构造与出生点 0,0 那间完全一致。
    // 先把 3×3 区块常加载（fill 才不会落空），2 tick 后建笼子，然后把 6 扇门指过去并让 IP 生成反向门。
    const CAGE = 'hexahedron:bedrock_bottom'
    // forceload 只吃整数坐标：MX/MZ 是 x+0.5，直接拼会解析失败（整块笼子因此没加载、也没建出来）
    let fx = Math.floor(MX), fz = Math.floor(MZ)
    server.runCommandSilent('execute in ' + CAGE + ' run forceload add ' + (fx - 16) + ' ' + (fz - 16) + ' ' + (fx + 16) + ' ' + (fz + 16))
    // forceload 是异步的：等 1 秒区块真进内存，建笼子 / 让 IP 在目的地生成反向门才不会落空
    server.scheduleInTicks(20, () => {
      try {
        server.runCommandSilent('execute in ' + CAGE + ' positioned ' + MX + ' ' + (C4_CORE_Y - 5) + ' ' + MZ + ' run function hexahedron:build_hexahedron/17x17')
        // 落点侧封洞（详见 c4BuildRoom 注释）
        server.runCommandSilent('execute in ' + CAGE + ' positioned ' + MX + ' ' + (C4_CORE_Y - 5) + ' ' + MZ + ' run fill ~-1 ~-3 ~-1 ~1 ~-3 ~1 kubejs:hexahedron_filling')
        // 目的地外壳清成 air（与 c4BuildRoom(true) 一致：目的地不放 filling）
        try { c4ShellFill(server, CAGE, c4RoomBox(MX, C4_CORE_Y, MZ, { px: 0, nx: 0, pz: 0, nz: 0, py: 0 }), 'minecraft:air') } catch (e) {}
        console.info('[C4] 槽位 ' + slot + ' 起点笼子已建 @' + MX + ',105.5,' + MZ + ' dim=' + CAGE)
      } catch (e) { console.warn('[C4] 起点笼子建造失败: ' + e) }
      let made = c4Retarget(server, MX, C4_CORE_Y, MZ, c4DimKey(CAGE), MX, C4_CORE_Y, MZ, false, CAGE, idName, { px: 0, nx: 0, pz: 0, nz: 0, py: 0 }, true)
      try { c4MakeReverse(server, slot, CAGE, MX, C4_CORE_Y, MZ, idName) } catch (e) { console.warn('[C4] 起点反向门失败: ' + e) }
      console.info('[C4] 槽位 ' + slot + ' 初次指门完成 = ' + made + ' 扇 → ' + CAGE)
    })
  })

  // 7) forceload 常驻（不要撤销，见上面的注释）
}

// ---------------------------------------------------------------------------- 大厅（槽位 0 = 领车台）
function c4Lobby(server, player) {
  let db = c4Db()
  if (!c4Ftb().ok) { player.tell(c4t('cw.lobby.no_team')); return }
  let t = c4Team(player)
  if (!t) { player.tell(c4t('cw.home.no_team')); return }
  if (db.requireParty && !c4IsParty(t)) {
    // 原来三句压成一句
    player.tell(c4t('cw.lobby.need_team'))
    return
  }

  let key = c4TeamKey(t), label = c4TeamLabel(t)
  let cube = c4CubeOfTeam(key)

  if (cube) {
    if (!cube.provisioned) {
      c4TellTeam(server, cube.slot, c4t1('cw.lobby.building', label))
      c4Provision(server, cube.slot, cube.name, cube.id, true)   // 首次建造：空的，允许
      cube.provisioned = true
      c4Save()
    } else {
      c4TellTeam(server, cube.slot, c4t1('cw.lobby.exists', label))
    }
    server.scheduleInTicks(4, () => {
      c4SendToCube(server, c4TeamOnline(t), cube.slot)
      c4TeamOnline(t).forEach(m => m.tell(c4t1('cw.lobby.seated', label)))
    })
    return
  }

  let slot = Number(db.nextSlot), guard = 0
  while (c4TeamOfSlot(slot) && guard++ < 200) slot++
  if (slot === 0) slot = 1
  cube = c4Claim(slot, t)
  if (!cube) { player.tell(c4t('cw.lobby.alloc_fail')); return }

  c4Provision(server, slot, cube.name, cube.id)
  cube.provisioned = true
  c4Save()

  // 先让目标区块真正加载完再传送：否则客户端一次性收 5×5 区块 + 服务端现场生成地形，
  // 就会出现"卡在空中"和网络冲击。这里 forceload 5×5 区块，再等 2 秒才送人。
  try {
    let sx = Math.floor(c4CubeX(slot)), sz = Math.floor(C4_Z)
    server.runCommandSilent('execute in minecraft:overworld run forceload add ' + (sx - 40) + ' ' + (sz - 40) + ' ' + (sx + 40) + ' ' + (sz + 40))
  } catch (e) {}
  server.scheduleInTicks(100, () => {
    c4SendToCube(server, c4TeamOnline(t), slot)
    c4TeamOnline(t).forEach(m => {
      m.tell(c4t1('cw.lobby.ready', label))
    })
  })
}

// 向量运算符 → 维度（原包 seed 表；空槽/其它方块 = +0 → seed 0 = graveyard）
const C4_SEED_DIMS = {
  0: 'hexahedron:hexahedron_graveyard', 1: 'hexahedron:dry_ocean', 2: 'hexahedron:stacked_rocks',
  3: 'hexahedron:copper_remains', 4: 'hexahedron:dark_rocks', 5: 'hexahedron:toxic_caves',
  6: 'hexahedron:magnetic_ceiling', 7: 'hexahedron:endless_hoard', 8: 'hexahedron:pine_forrest',
  9: 'hexahedron:magma_plateau', 10: 'hexahedron:brimstone_veil', 12: 'hexahedron:snowstorm',
  13: 'hexahedron:dusk', 14: 'hexahedron:endless_rainbows', 16: 'hexahedron:blood_ocean',
  17: 'hexahedron:forsaken_planes', 18: 'hexahedron:silver_forest', 24: 'hexahedron:the_sugarscape',
  32: 'hexahedron:the_azurewood', 36: 'hexahedron:soul_valley', 48: 'hexahedron:the_umbral_sea',
  64: 'hexahedron:carrion_485', 72: 'hexahedron:gronglegrowth', 96: 'hexahedron:lavender_fields',
  128: 'hexahedron:alpha_islands',
  // 原包 ticket_selection 的两个特殊分支：eye = 999.. → the_edge_of_reality，infinite = ..-999 → overworld
  999: 'hexahedron:the_edge_of_reality',
  '-999': 'minecraft:overworld'
}

// ---------------------------------------------------------------------------- 三格插槽（原包 runtime_effects）
// 台面（warping_controls/interface/disc_drive）在 y=98，算子方块坐在它上面一格 y=99，z=+8。
// 原包读取/消耗顺序（pre_runtime=20/40/60）：x=+1（界面）→ x=0（控制台）→ x=-1（光盘驱动器）。
const C4_SLOT_Y = 99
const C4_OP_PREFIX = 'kubejs:vector_operator_'
// 只有 #kubejs:vector 的 8 个成员会被消耗（infinite 不在标签里）；dust 是原包 runtime_effects 的粒子颜色
const C4_VECTOR_OPS = {
  basic:     { op: '+', v: 1,   dust: '1 1 1 3 0.514 0.514 0.514' },
  charged:   { op: '*', v: 3,   dust: '1 0.816 0 3 0.455 0.373 0.008' },
  fluix:     { op: '+', v: 2,   dust: '0.635 0 1 3 0.31 0 0.373' },
  nuclear:   { op: '*', v: 4,   dust: '0.318 1 0 3 0.075 0.373 0' },
  blaze:     { op: '*', v: 6,   dust: '1 0.451 0 3 0.706 0.224 0' },
  lightning: { op: '*', v: 8,   dust: '0 0.969 1 3 0 0.373 0.62' },
  eye:       { op: '=', v: 999, dust: '1 0 0 3 0.373 0 0' },
  crimson:   { op: null, v: 0,  dust: null }   // 在标签里 → 会被消耗，但原包没有它的运算/粒子行
}
function c4SlotX(slot, i) { return Math.floor(c4CubeX(slot)) + i }
// 操控台贴着 +z 内壁：基础 z=8；若立方体在 +z 方向扩过，操控台跟着 Z1 外移（每级 +16）
function c4SlotZ(slot) {
  let z = C4_Z + 8
  try {
    let h = c4TeamOfSlot(slot)
    if (h && h.cube) z += 16 * c4Ext(h.cube).nz
  } catch (e) {}
  return Math.floor(z)
}
// 读一格插槽：返回 {id, key, op}；op 只覆盖 #kubejs:vector 的 8 个成员
function c4OpAt(server, slot, i) {
  let lv = c4OwLevel(server)
  let id = ''
  if (lv) { try { id = String(lv.getBlock(c4SlotX(slot, i), C4_SLOT_Y, c4SlotZ(slot)).id) } catch (e) { id = '' } }
  if (id.indexOf(C4_OP_PREFIX) !== 0) return { id: id, key: null, op: null }
  let key = id.substring(C4_OP_PREFIX.length)
  return { id: id, key: key, op: C4_VECTOR_OPS[key] || null }
}
// 原包 processor_calculation：+1 → 0 → -1 的固定顺序；infinite 直接把种子设 -999（且不消耗）
// 原包 processor_calculation 的单格运算：把一个插槽的算子作用到种子上
function c4ApplyOp(o, seed) {
  if (!o) return seed
  if (o.op) {
    if (o.op.op === '+') return seed + o.op.v
    if (o.op.op === '*') return seed * o.op.v
    if (o.op.op === '=') return o.op.v
    return seed
  }
  if (o.key === 'infinite') return -999
  return seed
}
function c4ReadSeed(server, slot) {
  let seed = 0
  for (let i = 1; i >= -1; i--) seed = c4ApplyOp(c4OpAt(server, slot, i), seed)
  return seed
}

// 原包 runtime_effects 的"一格插槽"：先音效，再粒子，最后 setblock empty（setblock 无 destroy → 不掉物品）。
// 空槽 / 非 #kubejs:vector（含 infinite）走失败分支：evoker + beacon.deactivate + small_colored_dust，不 setblock。
function c4ConsumeSlot(server, slot, i) {
  let o = c4OpAt(server, slot, i)
  let x = c4SlotX(slot, i)
  // 与核心 (x+0.5, 105.5, 0.5) 同基准：~1 ~-6 ~8 = 方块中心 (x+i+0.5, 99.5, Z1+0.5)
  let at = 'execute in minecraft:overworld positioned ' + (x + 0.5) + ' 99.5 ' + (c4SlotZ(slot) + 0.5) + ' run '
  if (o.op) {
    server.runCommandSilent(at + 'playsound block.end_portal_frame.fill master @a ~ ~ ~ 1 1')
    if (o.op.dust) server.runCommandSilent(at + 'particle dust_color_transition ' + o.op.dust + ' ~ ~ ~ 0.2 0.2 0.2 0.1 10 force')
    server.runCommandSilent(at + 'setblock ~ ~ ~ kubejs:vector_operator_empty')
    console.info('[C4] 槽位 ' + slot + ' 消耗格子 ' + i + '：' + o.key + ' → vector_operator_empty')
    return true
  }
  server.runCommandSilent(at + 'playsound minecraft:entity.evoker.cast_spell master @a ~ ~ ~ 1 2')
  server.runCommandSilent(at + 'playsound minecraft:block.beacon.deactivate master @a ~ ~ ~ 1 2')
  server.runCommandSilent(at + 'particle alexscaves:small_colored_dust ~ ~ ~ 0.2 0.2 0.2 10 10 force')
  console.info('[C4] 槽位 ' + slot + ' 空格子 ' + i + '：' + (o.key || o.id || 'air') + '（不消耗）')
  return false
}

// 动作条：`排队 N · 正在前往维度 #seed`（排队为 0 时省略前半段；seed 是最终种子，不是 1..4 计数）
function c4TravelText(job) {
  let q = C4_Q.length
  let seed = (job && job.seedShown !== undefined) ? job.seedShown : 0
  return (q > 0 ? ('排队 ' + q + ' · ') : '') + '正在前往维度 #' + seed
}
function c4StartTravelBar(server, slot, job, seed) {
  try {
    job.seedShown = seed
    let x = Math.floor(c4CubeX(slot))
    server.runCommandSilent('scoreboard players set @e[type=marker,tag=cw_slot' + slot + '] dimension_seed ' + seed)
    server.runCommandSilent('execute in minecraft:overworld positioned ' + x + ' ' + C4_CORE_Y + ' ' + C4_Z + ' run tag @a[distance=..50] add travel_actionbar')
    console.info('[C4] 槽位 ' + slot + ' 动作条：' + c4TravelText(job) + '（seed=' + seed + '）')
  } catch (e) { console.warn('[C4] 动作条启动失败: ' + e) }
  c4TravelBarTick(server, slot, job, 0)
}
function c4TravelBarTick(server, slot, job, n) {
  if (!job || C4_BUSY !== job || n > 600) return
  try {
    server.runCommandSilent('title @a[tag=travel_actionbar] actionbar {"text":"' + c4TravelText(job) + '","color":"aqua","bold":true}')
  } catch (e) { console.warn('[C4] 动作条 tick 失败: ' + e) }
  server.scheduleInTicks(1, () => c4TravelBarTick(server, slot, job, n + 1))
}

// 自主跃迁：选维度（安全白名单）+ 高度图找地表（方案 A：不整平地形）
const C4_SAFE_DIMS = [
  'hexahedron:hexahedron_graveyard', 'hexahedron:stacked_rocks', 'hexahedron:copper_remains',
  'hexahedron:dark_rocks', 'hexahedron:magma_plateau', 'hexahedron:pine_forrest',
  'hexahedron:snowstorm', 'hexahedron:silver_forest'
]
function c4PickDest(server, slot) {
  let seed = 0
  try { seed = c4ReadSeed(server, slot) } catch (e) { seed = 0 }
  return c4PickDestForSeed(server, slot, seed)
}
// 已经算出 seed 时用它选目的地（消耗是逐 tick 的，t=60 的最终 seed 才是权威值）
function c4PickDestForSeed(server, slot, seed) {
  let dim = C4_SEED_DIMS[seed] || C4_SEED_DIMS[0]
  if (!C4_SEED_DIMS[seed]) console.warn('[C4] 未知 seed=' + seed + '，回退 seed 0（graveyard）')
  console.info('[C4] 槽位 ' + slot + ' 运算符 seed=' + seed + ' → ' + dim)
  let x = c4CubeX(slot) + Math.round((Math.random() * 2 - 1) * C4_DEST_JITTER)
  let z = C4_Z + Math.round((Math.random() * 2 - 1) * C4_DEST_JITTER)
  let y = 100
  try {
    let lv = c4Level(server, dim)
    if (lv) {
      let HM = c4Cls('net.minecraft.world.level.levelgen.Heightmap$Types')
      let h = lv.getHeight(HM.MOTION_BLOCKING, x, z)
      if (h && Number(h) > -50) y = Number(h) + 1
    }
  } catch (e) { console.warn('[C4] 高度图不可用，回退 y=100: ' + e) }
  return { dim: dim, x: x, y: y, z: z, seed: seed }
}

// ---------------------------------------------------------------------------- 跃迁（串行队列）
// 这台车是否正在跃迁/排队：按钮按下期间不再接受第二次触发
function c4SlotInFlight(slot) {
  if (C4_BUSY && Number(C4_BUSY.slot) === Number(slot)) return true
  for (let i = 0; i < C4_Q.length; i++) if (Number(C4_Q[i].slot) === Number(slot)) return true
  return false
}
function c4Enqueue(server, slot, teamKey, clickerName) {
  for (let i = 0; i < C4_Q.length; i++) if (C4_Q[i].slot === slot) { C4_Q.splice(i, 1); break }
  C4_Q.push({ slot: slot, teamKey: teamKey, clicker: clickerName || null, riders: [] })
  c4Pump(server)
}
function c4Pump(server) {
  if (C4_BUSY) return
  if (C4_Q.length === 0) return
  let job = C4_Q.shift()
  C4_BUSY = job
  c4Warp(server, job)
}

function c4Warp(server, job) {
  try { c4WarpBody(server, job) }
  catch (e) {
    console.error('[C4] 跃迁异常 slot=' + (job && job.slot) + ': ' + e)
    try { c4TellTeam(server, slot, c4t('cw.warp.abort')) } catch (e2) {}
    C4_BUSY = null
  }
}

function c4WarpBody(server, job) {
  let slot = job.slot
  let own = c4TeamOfSlot(slot)
  if (own && job.teamKey && own.key !== job.teamKey) {
    console.warn('[C4] 拒绝跨队操作：job.teamKey=' + job.teamKey + ' 属于岗位 ' + slot + ' 的队伍=' + own.key)
    c4TellTeam(server, slot, c4t1('cw.warp.wrong_team', (own && own.cube) ? own.cube.name : ('基地')))
    C4_BUSY = null
    return
  }
  let core = c4CoreOfSlot(server, slot)
  let info = c4TeamOfSlot(slot)
  let label = info ? info.cube.name : ('槽位' + slot)
  if (!core) {
    c4TellTeam(server, slot, c4t('cw.warp.no_core'))
    C4_BUSY = null
    return
  }

  // ⓪ 确保本台区块加载（否则 c4PortalsNear 看不到门 → "关门 0 扇"）
  server.runCommandSilent(c4ForceloadBox(slot, true))

  // ⓪.5 清掉本台上一次落点的镜像笼子（原包只建不拆，多跳会留下一串副本）
  try {
    let prev = (info && info.cube) ? info.cube.dest : null
    if (prev && prev.dim) {
      let busy = false
      server.players.forEach(pl => {
        try {
          if (c4DimOf(pl) === prev.dim && c4Dist2(pl.x, pl.y, pl.z, prev.x, prev.y, prev.z) < 900) busy = true
        } catch (e) {}
      })
      if (busy) console.info('[C4] 上次落点有人，跳过清理 ' + prev.dim + ' @' + prev.x + ',' + prev.y + ',' + prev.z)
      else {
        server.runCommandSilent('execute in ' + prev.dim + ' positioned ' + prev.x + ' ' + prev.y + ' ' + prev.z + ' run kill @e[type=immersive_portals:portal,distance=..30]')
        server.runCommandSilent('execute in ' + prev.dim + ' positioned ' + prev.x + ' ' + prev.y + ' ' + prev.z + ' run fill ~-9 ~-9 ~-9 ~9 ~9 ~9 air')
        console.info('[C4] 已清除上次落点笼子 ' + prev.dim + ' @' + prev.x + ',' + prev.y + ',' + prev.z)
      }
    }
  } catch (e) { console.warn('[C4] 清理上次落点失败: ' + e) }

  // ① 关门 + 清上次反向门
  // ⚠ 不再调用 c4Hide：setIsVisible(false)+reloadAndSync 之后，KubeJS 这边的 server.entities
  // 立刻就枚举不到这些门了（日志：关门 6 扇 → 2 秒后 retarget 没找到门），
  // 跃迁因此必定失败。门保持可见，反正指门后画面会立刻切到目的地。
  let hidden = 0
  let killed = c4KillReverses(server, (info && info.cube && info.cube.id) ? info.cube.id : ('cube' + slot))
  console.info('[C4] 槽位 ' + slot + ' 起飞：关门 ' + hidden + ' 扇 / 清反向门 ' + killed + ' 个')

  // ② 乘客 = 此刻就在这节车厢里的人（不要求队伍全员到齐；外面的人留在原维度，
  //    可以用 FTB Essentials 的 /home /tpa 或其它传送指令自己回来）
  let riders = []
  let absent = []
  let outsiders = []
  server.players.forEach(p => {
    let mine = c4TeamKey(c4Team(p))
    let sameTeam = (job.teamKey === null) || (mine === job.teamKey)
    if (c4InCube(p, slot)) {
      // 舱里但属于别的队伍：不带走（避免把访客扔进跃迁）
      if (!sameTeam) { outsiders.push(p); return }
      riders.push(p)
    } else if (sameTeam) {
      absent.push(p)
    }
  })
  if (riders.length === 0) {
    console.info('[C4] 槽位 ' + slot + ' 跃迁取消：舱内无人（启动者必须站在舱内）')
    c4TellTeam(server, slot, c4t('cw.warp.empty'))
    c4WarpEnd(server, slot, label, job)
    return
  }
  // 轮到本台才走到这里：队列里的作业在此之前不读插槽、不消耗（c4Pump 串行发放）
  console.info('[C4] 槽位 ' + slot + ' 轮到（前方队列剩 ' + C4_Q.length + '）：舱内 ' + riders.length + ' / 外待机 ' + absent.length + ' / 他队 ' + outsiders.length)
  job.riders = riders.map(x => c4Name(x))
  // 聊天框保持安静：倒计时/排队只走动作条，聊天只留失败提示（见 perform 的回滚分支）

  // —— 自主跃迁（KubeJS 控制）：选维度 → 高度图找地表 → 建笼 → 逐面指门 + 反向门 ——
  let idName = (info && info.cube && info.cube.id) ? info.cube.id : ('cube' + slot)
  let ext = (info && info.cube) ? c4Ext(info.cube) : { px: 0, nx: 0, pz: 0, nz: 0, py: 0 }
  let d = c4PickDest(server, slot)
  // 高度图给的是整数方块 y；核心必须落在方块中心（x.5），否则 ±8.51 会整体低半格，
  // 表现就是"目的地门比框架低半格"。
  let dx = d.x + 0.5, dz = d.z + 0.5, dy = d.y + 0.5
  let fx = Math.floor(dx), fz = Math.floor(dz)
  server.runCommandSilent('execute in ' + d.dim + ' run forceload add ' + (fx - 40) + ' ' + (fz - 40) + ' ' + (fx + 40) + ' ' + (fz + 40))
  // 剧场版时间轴（对齐原包 processors/runtime）：按键音已在右键那一刻播过，这里只做
  // 按下动画 + 动作条，“t=20/40/60 逐格结算+消耗，t=80 粒子爆发后进入自主跃迁”。
  let bx = c4CubeX(slot)
  let atCore = `execute in minecraft:overworld positioned ${bx} ${C4_CORE_Y} ${C4_Z} run `
  server.scheduleInTicks(1, () => {
    if (C4_BUSY !== job) return
    try {
      server.runCommandSilent(atCore + 'setblock ~ ~-7 ~' + (c4SlotZ(slot) - 1) + ' kubejs:launch_button_pressed')
      server.runCommandSilent(atCore + 'setblock ~1 ~-7 ~' + c4SlotZ(slot) + ' kubejs:warping_interface_running')
      // 倒计时文字只走动作条：正在前往维度 #seed（排队数实时刷新）
      c4StartTravelBar(server, slot, job, d.seed)
    } catch (e) { console.warn('[C4] 按下动画失败: ' + e) }
  })
  // 原包 runtime.mcfunction:21-23：+1 → 0 → -1，每格 1 秒；种子按消耗顺序逐格累加
  // （原包就是"读一格 → 结算 → 消耗"，倒计时期间被放进去的算子也会被算上）
  let seedAcc = 0
  server.scheduleInTicks(20, () => {
    if (C4_BUSY !== job) return
    try {
      seedAcc = c4ApplyOp(c4OpAt(server, slot, 1), seedAcc)
      c4ConsumeSlot(server, slot, 1)
    } catch (e) { console.warn('[C4] 消耗失败: ' + e) }
  })
  server.scheduleInTicks(40, () => {
    if (C4_BUSY !== job) return
    try {
      seedAcc = c4ApplyOp(c4OpAt(server, slot, 0), seedAcc)
      c4ConsumeSlot(server, slot, 0)
    } catch (e) { console.warn('[C4] 消耗失败: ' + e) }
  })
  server.scheduleInTicks(60, () => {
    if (C4_BUSY !== job) return
    try {
      seedAcc = c4ApplyOp(c4OpAt(server, slot, -1), seedAcc)
      c4ConsumeSlot(server, slot, -1)
    } catch (e) { console.warn('[C4] 消耗失败: ' + e) }
    // 倒计时期间插槽可能被改动：以 t=60 的最终 seed 为准，重选目的地（原包 t=85 才选维度）
    if (seedAcc !== d.seed) {
      console.warn('[C4] 槽位 ' + slot + ' 倒计时期间插槽被改动：seed ' + d.seed + ' → ' + seedAcc + '，按新 seed 重选目的地')
      try {
        d = c4PickDestForSeed(server, slot, seedAcc)
        dx = d.x + 0.5; dz = d.z + 0.5; dy = d.y + 0.5
        fx = Math.floor(dx); fz = Math.floor(dz)
        server.runCommandSilent('execute in ' + d.dim + ' run forceload add ' + (fx - 40) + ' ' + (fz - 40) + ' ' + (fx + 40) + ' ' + (fz + 40))
        console.info('[C4] 槽位 ' + slot + ' 最终目的地 → ' + d.dim + ' @' + d.x + ',' + d.y + ',' + d.z)
      } catch (e) { console.warn('[C4] 重选目的地失败: ' + e) }
    }
    // 动作条在 t=1 就已经跑起来，这里只把显示值换成最终 seed（循环下一 tick 自动刷新）
    job.seedShown = seedAcc
    console.info('[C4] 槽位 ' + slot + ' 最终 seed=' + seedAcc + '，动作条：' + c4TravelText(job))
  })
  console.info('[C4] 槽位 ' + slot + ' 剧场版时间轴：t=1 按下 / t=20,40,60 消耗 / t=80 跃迁（seed=' + d.seed + '）')
  console.info('[C4] 槽位 ' + slot + ' 自主跃迁 → ' + d.dim + ' @' + d.x + ',' + d.y + ',' + d.z)

  let perform = (phase) => {
    try {
      try { server.runCommandSilent(c4ForceloadBox(slot, true)) } catch (e0) {}
      let cur = c4CoreOfSlot(server, slot)
      if (!cur) {
        c4TellTeam(server, slot, c4t('cw.warp.abort'))
        c4WarpEnd(server, slot, label, job)
        return
      }

      // 主世界 6 扇门丢失（之前某次失败/区块卸载导致）→ 先补建 6 扇再继续，别直接判失败
      let have = 0
      try { have = c4PortalsNear(server, cur.x, cur.y, cur.z).length } catch (e) {}
      if (have === 0 && phase < 2) {
        console.warn('[C4] 主世界 6 扇门缺失 → 重建后重试（phase ' + phase + '）')
        try { c4MakeRoomPortals(server, slot, idName, ext) } catch (e) { console.warn('[C4] 重建门失败: ' + e) }
        server.scheduleInTicks(20, () => perform(phase + 1))
        return
      }

      c4BuildRoom(server, d.dim, dx, dy, dz, ext, true)
      // 只改 destination，不动主世界的门（moveSrc=false）
      let n = c4Retarget(server, cur.x, cur.y, cur.z, c4DimKey(d.dim), dx, dy, dz, false, d.dim, idName, ext, false)
      try { c4MakeReverse(server, slot, d.dim, dx, dy, dz, idName) } catch (e) { console.warn('[C4] 反向门失败: ' + e) }
      let rev = 0
      try { rev = c4CountPortals(server, d.dim, dx, dy, dz, 40) } catch (e) {}
      if (n < 6 || rev === 0) {
        console.warn('[C4] 跃迁校验失败：正向=' + n + ' 反向=' + rev + ' → 回滚到私有笼子')
        c4TellTeam(server, slot, c4t('cw.warp.abort'))   // 失败才在聊天框说话
        try { c4RestoreHome(server, slot, idName) } catch (e2) {}
        c4WarpEnd(server, slot, label, job)
        return
      }
      try { if (info && info.cube) { info.cube.dest = { dim: d.dim, x: d.x, y: d.y, z: d.z }; c4Save() } } catch (e) {}
      console.info('[C4] 跃迁完成 slot' + slot + ' 指门=' + n + ' → ' + d.dim + ' @' + d.x + ',' + d.y + ',' + d.z)
      server.scheduleInTicks(10, () => c4WarpEnd(server, slot, label, job))
    } catch (e) {
      console.warn('[C4] 自主跃迁失败: ' + e)
      c4TellTeam(server, slot, c4t('cw.warp.abort'))
      try { c4RestoreHome(server, slot, idName) } catch (e2) {}
      c4WarpEnd(server, slot, label, job)
    }
  }
  // 倒计时已改为原包时间轴（t=1 按下音 / t=20,40,60 逐格消耗 / t=60 起动作条），
  // 这里只剩 t=80 的跃迁瞬间：粒子爆发 + 传送音，然后进入自主跃迁。
  server.scheduleInTicks(80, () => {
    try {
      let bx = c4CubeX(slot)
      server.runCommandSilent(`execute in minecraft:overworld positioned ${bx} ${C4_CORE_Y} ${C4_Z} run particle minecraft:portal ~ ~ ~ 8 8 8 0.5 200 force`)
      server.runCommandSilent(`execute in minecraft:overworld positioned ${bx} ${C4_CORE_Y} ${C4_Z} run particle minecraft:end_rod ~ ~ ~ 6 6 6 0.2 120 force`)
      server.runCommandSilent(`execute in minecraft:overworld positioned ${bx} ${C4_CORE_Y} ${C4_Z} run playsound minecraft:entity.enderman.teleport master @a ~ ~ ~ 1 0.8`)
    } catch (e) {}
    perform(0)
  })
}

// 跃迁失败：把 6 扇门指回本队私有基岩笼子（否则门会停在数据包随手挑的 dry_ocean 之类维度，看出去是虚空）
function c4RestoreHome(server, slot, idName) {
  let cx = c4CubeX(slot) + 0.5, cz = C4_Z + 0.5
  let CAGE = 'hexahedron:bedrock_bottom'
  let h = c4TeamOfSlot(slot)
  let ext = c4Ext(h && h.cube ? h.cube : { ext: {} })
  let fx = Math.floor(cx), fz = Math.floor(cz)
  server.runCommandSilent('execute in ' + CAGE + ' run forceload add ' + (fx - 40) + ' ' + (fz - 40) + ' ' + (fx + 40) + ' ' + (fz + 40))
  server.scheduleInTicks(5, () => {
    try {
      c4BuildRoom(server, CAGE, cx, C4_CORE_Y, cz, ext, true)
      let made = c4Retarget(server, cx, C4_CORE_Y, cz, c4DimKey(CAGE), cx, C4_CORE_Y, cz, false, CAGE, idName, ext, true)
      try { c4MakeReverse(server, slot, CAGE, cx, C4_CORE_Y, cz, idName) } catch (e) {}
      console.info('[C4] 跃迁失败 → 门已指回私有笼子（' + made + ' 扇）')
    } catch (e) { console.warn('[C4] 指回笼子失败: ' + e) }
  })
}

function c4WarpEnd(server, slot, label, job) {
  // 动画/跃迁彻底结束才把按钮、界面弹回来（按下期间按钮一直是 pressed，右键不会再触发）
  try {
    let bx = c4CubeX(slot)
    server.runCommandSilent(`execute in minecraft:overworld positioned ${bx} ${C4_CORE_Y} ${C4_Z} run setblock ~ ~-7 ~${c4SlotZ(slot) - 1} kubejs:launch_button[facing=north]`)
    server.runCommandSilent(`execute in minecraft:overworld positioned ${bx} ${C4_CORE_Y} ${C4_Z} run setblock ~1 ~-7 ~${c4SlotZ(slot)} kubejs:warping_interface`)
  } catch (e) {}
  // 清掉数据包残留的"正在前往维度"actionbar 状态（否则聊天框/动作条会一直显示"维度:"）
  try {
    server.runCommandSilent('tag @a remove travel_actionbar')
    server.runCommandSilent('scoreboard players set @a travel_actionbar 0')
  } catch (e) {}
  server.runCommandSilent(`tag @e[type=marker,tag=cw_slot${slot}] remove pre_runtime`)
  server.runCommandSilent(`scoreboard players set @e[type=marker,tag=cw_slot${slot}] pre_runtime 0`)
  server.runCommandSilent(`scoreboard players set @e[type=marker,tag=cw_slot${slot}] dimension_seed 0`)
  // 防延迟丢人：把这次登船的人重新按回舱内座位（跃迁后至少保证按按钮的人在立方体里）
  try {
    if (job && job.riders && job.riders.length > 0) {
      let ps = []
      server.players.forEach(p => { if (job.riders.indexOf(c4Name(p)) >= 0) ps.push(p) })
      let n = ps.length > 0 ? c4SendToCube(server, ps, slot) : 0
      if (n > 0) console.info('[C4] 收尾：把 ' + n + ' 人拉回舱内')
    }
  } catch (e) { console.warn('[C4] 收尾复位失败: ' + e) }

  // 清掉本次残留的 outer_core
  try { c4PurgeOuterCores(server) } catch (e) {}

  // 释放"撞车平移"临时加载的区块
  try {
    if (job && job.nudgeFORCELOAD) {
      let nf = job.nudgeFORCELOAD
      server.scheduleInTicks(1200, () => {
        try { server.runCommandSilent('execute in ' + nf.dim + ' run forceload remove ' + nf.cx + ' ' + nf.cz) } catch (e) {}
      })
    }
  } catch (e) {}

  // 记录本队落点（供下一台做撞车检查）并延迟释放目的地 forceload
  try {
    if (job && job.dest) {
      let info2 = c4TeamOfSlot(slot)
      if (info2 && info2.cube) { info2.cube.dest = job.dest; c4Save() }
      let d = job.dest
      server.runCommandSilent('execute in ' + d.dim + ' run forceload add ' + d.cx + ' ' + d.cz)
      console.info('[C4] 落点已记录 dim=' + d.dim + ' @' + d.x + ',' + d.y + ',' + d.z)
      server.scheduleInTicks(1200, () => {
        try { server.runCommandSilent('execute in ' + d.dim + ' run forceload remove ' + d.cx + ' ' + d.cz) } catch (e) {}
      })
    }
  } catch (e) { console.warn('[C4] 落点记录失败: ' + e) }

  C4_BUSY = null
  // 成功路径不往聊天框发任何东西（倒计时/排队都在动作条），失败提示已在各自分支发出
  c4Pump(server)
}

// ---------------------------------------------------------------------------- 事件：按钮
BlockEvents.rightClicked('kubejs:launch_button', event => {
  try { if (event.hand && String(event.hand).indexOf('MAIN') < 0) return } catch (e) {}
  try { event.cancel() } catch (e) {}

  let server = event.server, clicker = event.player
  let bx = event.block.x, by = event.block.y, bz = event.block.z
  let slot = c4SlotForButton(bx, by, bz)

  // 认不到归属：既不是大厅、也不在任何车厢范围内 → 直接拒绝，不猜
  if (slot === null) {
    c4BtnLog(false, clicker, null, '按钮不在任何车厢范围内 @' + bx + ',' + by + ',' + bz)
    clicker.tell(Text.of('⟢ 这不是有效的发射按钮'))
    return
  }

  if (slot === 0) { c4Lobby(server, clicker); return }

  // 正在跃迁/已在队列里：直接忽略这次右键（静默，不刷聊天框）
  if (c4SlotInFlight(slot)) {
    c4BtnLog(false, clicker, slot, '该基地正在跃迁/排队中，忽略重复按下')
    return
  }

  let info = c4TeamOfSlot(slot)
  if (!info) {
    c4BtnLog(false, clicker, slot, '该槽位没有登记队伍')
    clicker.tell(c4t('cw.warp.unbound'))
    return
  }
  if (!c4Ftb().ok) {
    c4BtnLog(false, clicker, slot, 'FTB Teams 未接入')
    clicker.tell(c4t('cw.warp.wrong_team', info.cube.name))
    return
  }
  let tk = c4TeamKey(c4Team(clicker))
  if (tk === null) {
    c4BtnLog(false, clicker, slot, '按按钮的人没有队伍')
    clicker.tell(c4t('cw.button.not_yours', info.cube.name))
    return
  }
  if (tk !== info.key) {
    c4BtnLog(false, clicker, slot, '队伍不符')
    clicker.tell(c4t1('cw.button.not_yours', info.cube.name))
    return
  }
  if (!c4InCube(clicker, slot)) {
    c4BtnLog(false, clicker, slot, '启动者不在舱内')
    clicker.tell(c4t('cw.button.must_inside'))
    return
  }
  if (C4_Q.length >= 8) {
    c4BtnLog(false, clicker, slot, '队列已满')
    clicker.tell(c4t('cw.button.queue_full'))
    return
  }

  c4BtnLog(true, clicker, slot, '')
  // 按键音放在"进队列"之前：按下瞬间就播（排队时也能立刻听到反馈，不等到轮到自己）
  try {
    let cx = c4CubeX(slot)
    let at = `execute in minecraft:overworld positioned ${cx} ${C4_CORE_Y} ${C4_Z} run `
    let atBeep = `execute in minecraft:overworld positioned ${cx} ${C4_CORE_Y - 4} ${C4_Z + 4} run `
    server.runCommandSilent(at + 'playsound block.bamboo_wood_button.click_on master @a ~ ~ ~ 0 1')
    server.runCommandSilent(at + 'playsound mekanism:tile.machine.antiprotonic_nucleosynthesizer master @a ~ ~ ~ 1 0')
    server.runCommandSilent(atBeep + 'playsound mekanism:gui.digital_beep master @a ~ ~ ~ 1 0')
    server.runCommandSilent(atBeep + 'playsound mekanism:gui.digital_beep master @a ~ ~ ~ 1 0')
  } catch (e) {}
  // 按下即锁：按钮保持 launch_button_pressed，直到整套动画/跃迁结束由 c4WarpEnd 复位；
  // 期间方块已不是 launch_button，右键事件根本不会再进来（c4SlotInFlight 只是双保险）。
  try {
    let cx = c4CubeX(slot)
    server.runCommandSilent(`execute in minecraft:overworld positioned ${cx} ${C4_CORE_Y} ${C4_Z} run setblock ~ ~-7 ~${c4SlotZ(slot) - 1} kubejs:launch_button_pressed`)
  } catch (e) {}
  c4Enqueue(server, slot, info.key, c4Name(clicker))
})

// ---------------------------------------------------------------------------- 事件：登录/重生
let C4_SELF_ONCE = false
PlayerEvents.loggedIn(event => {
  let p = event.player
  if (!C4_SELF_ONCE) {
    C4_SELF_ONCE = true
    event.server.scheduleInTicks(40, () => { try { c4SelfTest(event.server) } catch (e) {} })
  }
  let key = c4TeamKey(c4Team(p))
  let cube = key ? c4CubeOfTeam(key) : null
  if (!cube || !cube.provisioned) return
  event.server.scheduleInTicks(10, () => {
    if (c4Tp(event.server, p, 'minecraft:overworld', c4CubeX(cube.slot) + 0.5, 98.0, C4_Z + 6.0)) {
      p.tell(c4t1('cw.home.ok', cube.name))
    }
  })
})
PlayerEvents.respawned(event => {
  let p = event.player
  let key = c4TeamKey(c4Team(p))
  let cube = key ? c4CubeOfTeam(key) : null
  if (!cube || !cube.provisioned) return
  c4Tp(event.server, p, 'minecraft:overworld', c4CubeX(cube.slot) + 0.5, 98.0, C4_Z + 6.0)
})

// ---------------------------------------------------------------------------- 事件：!party（兜底建队，绕过 FTB Teams 的 API-only 开关）
function c4PartyCmd(event) {
  let msg = String(event.message).trim()
  if (msg.indexOf('!party') !== 0) return
  try { event.cancel() } catch (ee) { /* KubeJS 用 EventExit 中止事件，吞掉继续跑 */ }
  event.server.scheduleInTicks(1, () => { try { c4PartyRun(event) } catch (e) { console.error('[C4] !party: ' + e) } })
}

function c4PartyRun(event) {
  let msg = String(event.message).trim()
  let p = event.player, server = event.server
  let parts = msg.split(/\s+/)
  let sub = (parts[1] || 'info').toLowerCase()

  if (!c4Ftb().ok) { p.tell(c4t('cw.home.no_team')); return }

  if (sub === 'info') {
    let t = c4Team(p)
    p.tell(c4t1('cw.party.info', (t ? c4TeamLabel(t) : '-')))
    if (t) p.tell(c4t2('cw.party.meta', (c4IsParty(t) ? Text.translatable('cw.party.type_party').getString() : Text.translatable('cw.party.type_solo').getString()), (t.getMembers() ? t.getMembers().size() : '?')))
    p.tell(c4t('cw.party.hint'))
    return
  }

  if (sub === 'create') {
    let nm = parts.slice(2).join(' ').trim()
    if (!nm) { p.tell(c4t('cw.party.usage')); return }
    if (nm.length > 24) { p.tell(c4t('cw.party.too_long')); return }
    if (/[^\x00-\x7F]/.test(nm)) {
      p.tell(c4t('cw.party.ascii'))
      p.tell(c4t('cw.party.ascii_hint'))
      return
    }
    let cur = c4Team(p)
    if (c4IsParty(cur)) { p.tell(c4t('cw.party.already_in')); return }
    try {
      let mgr = C4_FTB.api.getManager()
      let color = null
      try {
        let C = c4Cls('dev.ftb.mods.ftblibrary.icon.Color4I')
        color = C.rgb(0x3CB371)
      } catch (e) { color = null }
      let team = null
      try { team = mgr.createPartyTeam(p, nm, '由车厢系统创建', color) }
      catch (e1) {
        // 有些版本 Color4I 参数不允许为 null，再试一次纯色
        try { team = mgr.createPartyTeam(p, nm, '由车厢系统创建', c4Cls('dev.ftb.mods.ftblibrary.icon.Color4I').WHITE) } catch (e2) {
          p.tell(c4t1('cw.party.fail', e2))
          console.error('[C4] createPartyTeam 失败: ' + e1 + ' / ' + e2)
          return
        }
      }
      p.tell(c4t1('cw.party.created', (team ? c4TeamLabel(team) : nm)))
      p.tell(c4t('cw.party.created_hint'))
    } catch (e) {
      p.tell(c4t1('cw.party.error', e))
      console.error('[C4] party create 异常: ' + e)
    }
    return
  }

  p.tell(c4t('cw.party.usage'))
}

PlayerEvents.chat(event => {
  try { c4PartyCmd(event) } catch (e) {
    if (String(e).indexOf('EventExit') >= 0) return
    try { event.player.tell(c4t1('cw.cmd.internal', e)) } catch (e2) {}
    console.error('[C4] !party 异常: ' + e)
  }
})

// ---------------------------------------------------------------------------- 事件：命令
// /cwp name <显示名>（队长或 OP）
function c4CmdName(ctx, nm) {
  let p = c4SrcPlayer(ctx)
  if (!p) { c4ReplyT(ctx, 'cw.cmd.need_player'); return }
  let t = c4Team(p), key = c4TeamKey(t)
  let cube = key ? c4CubeOfTeam(key) : null
  if (!cube) { c4ReplyT(ctx, 'cw.name.no_cube'); return }
  if (!p.op) {
    let owner = null
    try { owner = String(t.getOwner()) } catch (e) {}
    if (owner !== null && owner !== String(p.uuid)) { c4ReplyT(ctx, 'cw.name.owner_only'); return }
  }
  if (!nm || nm.length === 0) { c4ReplyT(ctx, 'cw.cmd.usage', ['/' + 'cwp name <名字>']); return }
  cube.name = nm
  c4Save()
  let dj = JSON.stringify({ text: nm })
  ctx.source.server.runCommandSilent('execute as @e[type=marker,tag=cw_slot' + cube.slot + '] run data merge entity @s {CustomName:\'' + dj + '\'}')
  c4ReplyT(ctx, 'cw.name.done', [nm])
}

// /cwp partyreq on|off（OP）
function c4CmdPartyReq(ctx, on) {
  let db = c4Db()
  db.requireParty = !!on
  c4Save()
  c4ReplyT(ctx, 'cw.partyreq.set', [on ? 'cw.partyreq.on' : 'cw.partyreq.off'])
}

// 旧 !cube 聊天命令已退役：给个提示指向真命令
PlayerEvents.chat(event => {
  let msg = String(event.message).trim()
  if (msg.indexOf('!cube') !== 0) return
  try { event.cancel() } catch (e) {}
  let p = event.player
  let hint = '⟢ /cwp info · /cwp home · /cwp portals <槽位> · /cwp warp <槽位>'
  if (p) p.tell(Text.of(hint))
})

// ---------------------------------------------------------------------------- 命令：/cwp 与 /cube（同一棵树注册两次）
ServerEvents.commandRegistry(event => {
  try {
    let cmdRoot = event.commands
    let IAT = c4Cls('com.mojang.brigadier.arguments.IntegerArgumentType')
    let names = ['cube']
    for (let i = 0; i < names.length; i++) {
      let root = cmdRoot.literal(names[i]).requires(src => src.hasPermission(4))
      c4AttachSubs(root, cmdRoot, IAT, names[i])
      event.register(root)
    }
    console.info('[C4] 已注册 /cwp 与 /cube')
  } catch (e) {
    console.warn('[C4] 注册命令失败: ' + e)
  }
})

function c4AttachSubs(root, cmdRoot, IAT, rootName) {
  root.then(cmdRoot.literal('info').executes(ctx => { c4CmdInfo(ctx); return 1 }))

  root.then(cmdRoot.literal('home').executes(ctx => { c4CmdHome(ctx); return 1 }))

  // /cwp spawn · /cube spawn：回到出生点（基岩 0,0 的出生笼子）
  root.then(cmdRoot.literal('spawn').executes(ctx => { c4CmdSpawn(ctx); return 1 }))
  // 管理命令统一挂到 /cube admin（权限 4）；root 重新指向 admin 后，
  // 下面所有 root.then(...) 都会注册到 admin 子树里。
  let cubeRoot = root
  let admin = cmdRoot.literal('admin').requires(src => src.hasPermission(4))
  root = admin

  // 附近传送门参数
  root.then(cmdRoot.literal('near').executes(ctx => { c4CmdNear(ctx); return 1 }))

  root.then(cmdRoot.literal('home').requires(src => src.hasPermission(2))
    .then(cmdRoot.argument('slot', IAT.integer(0)).executes(ctx => {
      c4CmdHomeSlot(ctx, IAT.getInteger(ctx, 'slot')); return 1
    })))

  root.then(cmdRoot.literal('api').executes(ctx => {
    try { c4SelfTest(ctx.source.server) } catch (e) { console.warn('[C4] api: ' + e) }
    c4Reply(ctx, '通道: apiStatic=' + C4_CAP.apiStatic + ' instSetter=' + C4_CAP.instSetter
      + ' cmdSet=' + C4_CAP.cmdSet + ' chunkLoader=' + C4_CL_OK)
    return 1
  }))

  root.then(cmdRoot.literal('test').executes(ctx => {
    let p = c4SrcPlayer(ctx)
    if (!p) { c4ReplyT(ctx, 'cw.cmd.need_player'); return 0 }
    let ok = c4Tp(ctx.source.server, p, 'minecraft:overworld', p.x, p.y + 0.2, p.z)
    c4Reply(ctx, 'teleportEntity=' + (ok ? 'OK' : 'FAIL') + '  FTB=' + (c4Ftb().ok ? 'OK' : 'no')
      + '  requireParty=' + c4Db().requireParty + '  spacing=' + C4_SPACING)
    return 1
  }))

  root.then(cmdRoot.literal('portals').then(cmdRoot.argument('slot', IAT.integer(0)).executes(ctx => {
    c4CmdPortals(ctx, IAT.getInteger(ctx, 'slot')); return 1
  })))

  // /cwp doors <slot>：只重建 6 扇正向门并指回初始维度，【不触碰内部方块】
  root.then(cmdRoot.literal('doors').requires(src => src.hasPermission(2))
    .then(cmdRoot.argument('slot', IAT.integer(0)).executes(ctx => {
      c4CmdDoors(ctx, IAT.getInteger(ctx, 'slot')); return 1
    })))

  root.then(cmdRoot.literal('build').requires(src => src.hasPermission(2))
    .then(cmdRoot.argument('slot', IAT.integer(0))
      .executes(ctx => { c4CmdBuild(ctx, IAT.getInteger(ctx, 'slot'), false); return 1 })
      .then(cmdRoot.literal('force').executes(ctx => { c4CmdBuild(ctx, IAT.getInteger(ctx, 'slot'), true); return 1 }))))

  root.then(cmdRoot.literal('warp').requires(src => src.hasPermission(2))
    .then(cmdRoot.argument('slot', IAT.integer(0)).executes(ctx => {
      let slot = IAT.getInteger(ctx, 'slot')
      if (!c4CanOperate(ctx, slot)) { c4ReplyT(ctx, 'cw.cmd.not_allowed', [c4OwnerLabel(slot)]); return 0 }
      let p = c4SrcPlayer(ctx)
      if (p && !c4InCube(p, slot)) { c4ReplyT(ctx, 'cw.button.must_inside'); return 0 }
      let h = c4TeamOfSlot(slot)
      c4Enqueue(ctx.source.server, slot, h ? h.key : null, p ? c4Name(p) : null)
      c4ReplyT(ctx, 'cw.cmd.queued', [])
      return 1
    })))

  root.then(cmdRoot.literal('tp').then(cmdRoot.argument('slot', IAT.integer(0)).executes(ctx => {
    let p = c4SrcPlayer(ctx)
    if (!p) { c4ReplyT(ctx, 'cw.cmd.need_player'); return 0 }
    let slot = IAT.getInteger(ctx, 'slot')
    if (!c4CanOperate(ctx, slot)) { c4ReplyT(ctx, 'cw.cmd.not_allowed', [c4OwnerLabel(slot)]); return 0 }
    let s = c4Seat(slot, 0, 1)
    if (c4Tp(ctx.source.server, p, 'minecraft:overworld', s.x, s.y, s.z)) c4ReplyT(ctx, 'cw.cmd.tp_ok', [])
    else c4ReplyT(ctx, 'cw.cmd.tp_fail')
    return 1
  })))

  root.then(cmdRoot.literal('expand').requires(src => src.hasPermission(4))
    .then(cmdRoot.argument('slot', IAT.integer(0))
      .then(cmdRoot.literal('py').executes(ctx => { c4CmdExpand(ctx, IAT.getInteger(ctx, 'slot'), 'py'); return 1 }))
      .then(cmdRoot.literal('px').executes(ctx => { c4CmdExpand(ctx, IAT.getInteger(ctx, 'slot'), 'px'); return 1 }))
      .then(cmdRoot.literal('nx').executes(ctx => { c4CmdExpand(ctx, IAT.getInteger(ctx, 'slot'), 'nx'); return 1 }))
      .then(cmdRoot.literal('nz').executes(ctx => { c4CmdExpand(ctx, IAT.getInteger(ctx, 'slot'), 'nz'); return 1 }))))

  root.then(cmdRoot.literal('flush').requires(src => src.hasPermission(2)).executes(ctx => {
    C4_Q = []; C4_BUSY = null
    ctx.source.server.runCommandSilent('tag @e[type=marker,tag=cw_core] remove pre_runtime')
    ctx.source.server.runCommandSilent('tag @e[type=marker,tag=core] remove pre_runtime')
    c4ReplyT(ctx, 'cw.cmd.flushed')
    return 1
  }))

  root.then(cmdRoot.literal('orphans').requires(src => src.hasPermission(2)).executes(ctx => {
    let os = c4OrphanSlots()
    if (os.length === 0) { c4Reply(ctx, '没有孤儿车厢'); return 1 }
    c4Reply(ctx, '孤儿车厢 ' + os.length + ' 台（内部方块保留）：')
    os.forEach(o => c4Reply(ctx, '  slot' + o.cube.slot + ' id=' + (o.cube.id || '?')
      + ' 《' + o.cube.name + '》 原队伍 ' + o.key + (o.cube.provisioned ? '' : ' [未建造]')))
    return 1
  }))

  let SAT = c4Cls('com.mojang.brigadier.arguments.StringArgumentType')
  root.then(cmdRoot.literal('name')
    .then(cmdRoot.argument('name', SAT.greedyString()).executes(ctx => {
      c4CmdName(ctx, String(SAT.getString(ctx, 'name'))); return 1
    })))

  root.then(cmdRoot.literal('partyreq').requires(src => src.hasPermission(2))
    .then(cmdRoot.literal('on').executes(ctx => { c4CmdPartyReq(ctx, true); return 1 }))
    .then(cmdRoot.literal('off').executes(ctx => { c4CmdPartyReq(ctx, false); return 1 })))

  root.then(cmdRoot.literal('adopt').requires(src => src.hasPermission(2))
    .then(cmdRoot.argument('slot', IAT.integer(0)).executes(ctx => {
      c4CmdAdopt(ctx, IAT.getInteger(ctx, 'slot')); return 1
    })))

  // 关键：admin 的子树全部挂完后再整体挂到 /cube 上（先挂空节点、后加子节点有时不生效）
  cubeRoot.then(admin)
}

function c4CanOperate(ctx, slot) {
  let p = c4SrcPlayer(ctx)
  if (!p) return true
  if (p.op) return true
  let info = c4TeamOfSlot(slot)
  if (!info) return false
  let mine = c4TeamKey(c4Team(p))
  return mine !== null && mine === info.key
}

function c4OwnerLabel(slot) {
  let info = c4TeamOfSlot(slot)
  return info ? ('《' + info.cube.name + '》') : '（未绑定）'
}

function c4SrcPlayer(ctx) {
  try { let p = ctx.source.player; if (p !== null && p !== undefined) return p } catch (e) {}
  return null
}

function c4Reply(ctx, msg) {
  try { ctx.source.sendSuccess(Text.of('⟢ ' + msg), false) } catch (e) { console.info('[C4] ' + msg) }
}

function c4ReplyT(ctx, key, args) {
  let a = args || []
  let c = null
  try {
    if (a.length === 0) c = Text.translatable(key)
    else if (a.length === 1) c = Text.translatable(key, String(a[0]))
    else if (a.length === 2) c = Text.translatable(key, String(a[0]), String(a[1]))
    else c = Text.translatable(key, String(a[0]), String(a[1]), String(a[2]))
  } catch (e) { c = Text.of(key) }
  try { ctx.source.sendSuccess(c, false) } catch (e2) {}
  console.info('[C4] ' + key + (a.length ? ' ' + a.join(' ') : ''))
}

function c4CmdHome(ctx) {
  let p = c4SrcPlayer(ctx)
  if (!p) { c4ReplyT(ctx, 'cw.cmd.need_player'); return }
  if (!c4Ftb().ok) { c4ReplyT(ctx, 'cw.home.no_team'); return }
  let t = c4Team(p)
  if (!t) { c4ReplyT(ctx, 'cw.home.no_team'); c4ReplyT(ctx, 'cw.home.hint'); return }
  let key = c4TeamKey(t)
  let cube = key ? c4CubeOfTeam(key) : null
  if (!cube) { c4ReplyT(ctx, 'cw.home.no_cube', [c4TeamLabel(t)]); return }
  if (!cube.provisioned) { c4ReplyT(ctx, 'cw.home.not_ready'); return }
  let s = c4Seat(cube.slot, 0, 1)
  if (c4Tp(ctx.source.server, p, 'minecraft:overworld', s.x, s.y, s.z)) c4ReplyT(ctx, 'cw.home.ok', [cube.name])
  else c4ReplyT(ctx, 'cw.home.fail')
}

function c4CmdHomeSlot(ctx, slot) {
  let p = c4SrcPlayer(ctx)
  if (!p) { c4ReplyT(ctx, 'cw.cmd.need_player'); return }
  let s = c4Seat(slot, 0, 1)
  if (c4Tp(ctx.source.server, p, 'minecraft:overworld', s.x, s.y, s.z)) c4ReplyT(ctx, 'cw.cmd.tp_ok', [])
  else c4ReplyT(ctx, 'cw.cmd.tp_fail')
}

function c4CmdDoors(ctx, slot) {
  let server = ctx.source.server
  let core = c4CoreOfSlot(server, slot)
  if (!core) { c4Reply(ctx, '槽位 ' + slot + ' 无核心信标'); return }
  let h = c4TeamOfSlot(slot)
  let idName = (h && h.cube && h.cube.id) ? h.cube.id : ('cube' + slot)
  let x = c4CubeX(slot)
  // 只清门，不动方块
  server.runCommandSilent('execute in minecraft:overworld positioned ' + x + ' ' + C4_CORE_Y + ' ' + C4_Z + ' run kill @e[type=immersive_portals:portal,distance=..30]')
  let n = 0
  try { n = c4MakePortals(server, slot, idName) } catch (e) { c4Reply(ctx, '造门异常: ' + e); return }
  let aimed = 0
  try {
    aimed = c4Retarget(server, core.x, core.y, core.z, c4DimKey('hexahedron:bedrock_bottom'),
      x, C4_CORE_Y, C4_Z, false, 'hexahedron:bedrock_bottom', idName, c4Ext(h && h.cube ? h.cube : { ext: {} }), true)
  } catch (e2) { console.warn('[C4] doors retarget: ' + e2) }
  console.info('[C4] /cwp doors ' + slot + '：造门 ' + n + ' 扇，指向 ' + aimed + ' 扇')
  c4Reply(ctx, '槽位 ' + slot + '：造门 ' + n + ' / 指向 ' + aimed + '（内部未改动）')
}

function c4CmdBuild(ctx, slot, force) {
  let h = c4TeamOfSlot(slot)
  if (!force && h && h.cube && h.cube.provisioned) {
    c4ReplyT(ctx, 'cw.build.exists', [slot])
    c4ReplyT(ctx, 'cw.build.force_hint', [slot])
    return
  }
  c4Provision(ctx.source.server, slot, h ? h.cube.name : ('slot' + slot), h && h.cube.id ? h.cube.id : ('cube' + slot), force)
  if (h) { h.cube.provisioned = true; c4Save() }
  c4ReplyT(ctx, force ? 'cw.build.force_queued' : 'cw.build.queued', [slot])
}

function c4CmdAdopt(ctx, slot) {
  let p = c4SrcPlayer(ctx)
  let t = p ? c4Team(p) : null
  let newKey = c4TeamKey(t)
  if (!newKey) { c4ReplyT(ctx, 'cw.home.no_team'); return }
  let db = c4Db()
  if (db.cubes[newKey]) { c4Reply(ctx, '本队已有槽位 ' + db.cubes[newKey].slot); return }
  let cur = c4TeamOfSlot(slot)
  if (!cur) { c4Reply(ctx, '槽位 ' + slot + ' 没有登记的车厢'); return }
  let cube = cur.cube
  delete db.cubes[cur.key]
  cube.name = c4TeamLabel(t)
  cube.adoptedFrom = cur.key
  cube.adoptedAt = Date.now()
  db.cubes[newKey] = cube
  c4Save()
  let dj = JSON.stringify({ text: cube.name })
  ctx.source.server.runCommandSilent('execute as @e[type=marker,tag=cw_slot' + slot + '] run data merge entity @s {CustomName:\'' + dj + '\'}')
  c4Reply(ctx, '槽位 ' + slot + ' 已改绑到《' + cube.name + '》· 内部物资保留')
}

function c4CmdSpawn(ctx) {
  let p = c4SrcPlayer(ctx)
  if (!p) { c4ReplyT(ctx, 'cw.cmd.need_player'); return }
  c4ClearStrayPreRuntime(ctx.source.server)
  if (c4Tp(ctx.source.server, p, 'minecraft:overworld', 0.5, 98.0, 5.5)) c4ReplyT(ctx, 'cw.cmd.tp_ok', [])
  else c4ReplyT(ctx, 'cw.cmd.tp_fail')
}

// 数据包的倒计时是看 core 上的 pre_runtime 标签/分数；跃迁被中断或残留时会自己开始倒计时，
// 表现就是"刚被传送回家、立方体就开始倒计时，然后又被送回 spawn"。清理残留（跃迁进行中不动）。
function c4ClearStrayPreRuntime(server) {
  if (C4_BUSY) return
  try {
    server.runCommandSilent('tag @e[type=marker,tag=pre_runtime] remove pre_runtime')
    server.runCommandSilent('scoreboard players set @e[type=marker,tag=core] pre_runtime 0')
  } catch (e) {}
}

function c4CmdNear(ctx) {
  let p = c4SrcPlayer(ctx)
  let server = ctx.source.server
  if (!p) { c4Reply(ctx, '需要玩家上下文（控制台请用 /cube admin near 以玩家身份执行）'); return }
  let dim = c4DimOf(p)
  let list = []
  c4All(server).forEach(e => {
    if (!c4IsPortal(e)) return
    if (c4DimOf(e) !== dim) return
    if (c4Dist2(e.x, e.y, e.z, p.x, p.y, p.z) > 48 * 48) return
    let line = '  @' + Number(e.x).toFixed(2) + ',' + Number(e.y).toFixed(2) + ',' + Number(e.z).toFixed(2)
    try { line += ' W=' + Number(e.width) + ' H=' + Number(e.height) } catch (err) {}
    try {
      let dd = e.getDestDim()
      line += ' → ' + String(dd.location ? dd.location() : dd)
      line += ' ' + String(e.getDestPos())
    } catch (err) {}
    let tg = []
    try { e.getTags().forEach(t => { if (String(t).indexOf('cw_') === 0 || String(t).length <= 2) tg.push(String(t)) }) } catch (err) {}
    if (tg.length) line += ' [' + tg.join(',') + ']'
    list.push(line)
  })
  c4Reply(ctx, '附近传送门 ' + list.length + ' 扇（48 格内 · ' + dim + '）')
  list.slice(0, 20).forEach(l => c4Reply(ctx, l))
  if (list.length > 20) c4Reply(ctx, '  …还有 ' + (list.length - 20) + ' 扇')
}

function c4CmdInfo(ctx) {
  let server = ctx.source.server
  let db = c4Db()
  let cores = c4Cores(server)
  c4Reply(ctx, 'v4 · 登记 ' + Object.keys(db.cubes).length + ' 节 · 核心 ' + cores.length + ' 个')
  let labels = []
  cores.forEach(c => labels.push('slot' + c.slot + '@' + Math.round(c.x)))
  c4Reply(ctx, '核心: ' + (labels.length ? labels.join('  ') : '（无）'))
  for (let k in db.cubes) {
    let c = db.cubes[k]
    let dd = c.dest ? ('  落点 ' + c.dest.dim + '@' + c.dest.x + ',' + c.dest.y + ',' + c.dest.z) : ''
    c4Reply(ctx, 'slot' + c.slot + ' id=' + (c.id || '?') + ' x=' + c.x + ' 《' + c.name + '》' + (c.provisioned ? '' : ' [未建造]') + dd)
  }
  let orphans = c4OrphanSlots()
  if (orphans.length > 0) c4Reply(ctx, '孤儿车厢 ' + orphans.length + ' 台: ' + orphans.map(o => 'slot' + o.cube.slot).join(' '))
  c4Reply(ctx, '队列 ' + C4_Q.length + (C4_BUSY ? (' · 正在飞 slot' + C4_BUSY.slot) : ''))
}

function c4CmdPortals(ctx, slot) {
  let server = ctx.source.server
  let core = c4CoreOfSlot(server, slot)
  if (!core) { c4Reply(ctx, '槽位 ' + slot + ' 无核心信标'); return }
  let ps = c4PortalsNear(server, core.x, core.y, core.z)
  c4Reply(ctx, '槽位 ' + slot + ' · ' + ps.length + ' 条通道')
  ps.forEach(x => {
    let d = '?', dp = '?'
    try { d = String(x.entity.getDestDim().location()) } catch (e) {}
    try { dp = String(x.entity.getDestPos()) } catch (e) {}
    c4Reply(ctx, '  ' + x.dir + ' → ' + d + ' @ ' + dp)
  })
}

function c4SelfTest(server) {
  let step = (name, fn) => {
    try { console.info('[C4] 自检 ' + name + ' = ' + fn()) }
    catch (e) { console.warn('[C4] 自检 ' + name + ' FAIL: ' + e) }
  }
  step('owLevel', () => { let o = c4OwLevel(server); return o ? 'OK' : 'NULL' })
  step('dimKey', () => { let k = c4DimKey('minecraft:overworld'); return k ? String(k) : 'NULL' })
  step('cores', () => c4Cores(server).length)
  let cores = []
  try { cores = c4Cores(server) } catch (e) {}
  if (cores.length === 0) return
  cores.forEach(c => step('seed(slot' + c.slot + ')', () => c4ReadSeed(server, c.slot)))
  // 动作条文本（无排队 / 有排队）；临时压两个假 job 只为取样，同步取完立即还原
  step('动作条(无排队)', () => c4TravelText({ seedShown: 7 }))
  step('动作条(有排队)', () => {
    let base = C4_Q.length
    C4_Q.push({ slot: -101 }, { slot: -102 })
    let s = c4TravelText({ seedShown: 7 })
    C4_Q.length = base
    return s
  })
  step('按钮锁', () => {
    C4_Q.push({ slot: -103 })
    let a = c4SlotInFlight(-103)
    C4_Q.pop()
    return '自锁=' + a + ' 空槽=' + c4SlotInFlight(-104)
  })
  let c0 = cores[0]
  step('core0', () => 'slot' + c0.slot + ' dim=' + c4DimOf(c0.entity) + ' @' + Math.round(c0.x))
  step('slot' + c0.slot + '门数量', () => c4PortalsNear(server, c0.x, c0.y, c0.z).length)
  let ps = []
  try { ps = c4PortalsNear(server, c0.x, c0.y, c0.z) } catch (e) {}
  if (ps.length > 0) {
    let pe = ps[0].entity
    step('实例 getDestDim', () => String(pe.getDestDim()))
    step('实例 setIsVisible', () => { pe.setIsVisible(true); pe.reloadAndSyncToClient(); return 'OK' })
  }
  console.info('[C4] 通道状态: apiStatic=' + C4_CAP.apiStatic + ' instSetter=' + C4_CAP.instSetter
    + ' cmdSet=' + C4_CAP.cmdSet + ' chunkLoader=' + C4_CL_OK)
}

// ---------------------------------------------------------------------------- 立方体扩展（每面 +16 格）
let C4_EXT_TMP = {}   // 未登记槽位的临时扩展状态（仅测试用）
function c4Ext(cube) {
  let e = (cube && cube.ext) || {}
  return {
    px: Math.max(0, Number(e.px) | 0), nx: Math.max(0, Number(e.nx) | 0),
    pz: Math.max(0, Number(e.pz) | 0), nz: Math.max(0, Number(e.nz) | 0),
    py: Math.max(0, Number(e.py) | 0)
  }
}
function c4RoomBox(cx, cy, cz, ext) {
  // Y 必须跟着核心走：原来写死 97..113 只适合主世界的立方体，
  // 目的地核心在别的 y（地表高度）时，笼子会建在 y=97 —— 和门差出几十格，就是你看到的错位。
  return {
    X0: Math.floor(cx - 8 - 16 * ext.nx), X1: Math.floor(cx + 8 + 16 * ext.px),
    Z0: Math.floor(cz - 8 - 16 * ext.nz), Z1: Math.floor(cz + 8 + 16 * ext.pz),
    Y0: Math.floor(cy - 8), Y1: Math.floor(cy + 8) + 16 * ext.py
  }
}
// 外壳 = 外盒 − 内盒：贴着框梁外表面的那一格
// （X0-1 / X1+1 / Z0-1 / Z1+1 / Y0-1 / Y1+1）。下面 6 条 fill 的并集正好是
// 6 个面 + 12 条棱 + 8 个角，内盒（框梁/地板/面板/门）一格都不会被覆盖。
// 每条按 y 分段，单条最多 ~30000 格，扩展后的立方体也不会撞 32768 上限。
function c4ShellFill(server, dimId, b, block) {
  let run = (cmd) => { try { server.runCommandSilent('execute in ' + dimId + ' run ' + cmd) } catch (e) { console.warn('[C4] 外壳: ' + e) } }
  let box = (x0, y0, z0, x1, y1, z1) => {
    let w = x1 - x0 + 1, d = z1 - z0 + 1
    let step = Math.max(1, Math.floor(30000 / Math.max(1, w * d)))
    for (let y = y0; y <= y1; y += step) {
      let y2 = Math.min(y + step - 1, y1)
      run(`fill ${x0} ${y} ${z0} ${x1} ${y2} ${z1} ${block}`)
    }
  }
  // ±x 面（连带这两侧的竖棱包边）
  box(b.X0 - 1, b.Y0, b.Z0 - 1, b.X0 - 1, b.Y1, b.Z1 + 1)
  box(b.X1 + 1, b.Y0, b.Z0 - 1, b.X1 + 1, b.Y1, b.Z1 + 1)
  // ±z 面（连带另外两侧的竖棱）
  box(b.X0 - 1, b.Y0, b.Z0 - 1, b.X1 + 1, b.Y1, b.Z0 - 1)
  box(b.X0 - 1, b.Y0, b.Z1 + 1, b.X1 + 1, b.Y1, b.Z1 + 1)
  // 顶面 / 底面整层（连带 8 条横棱与 8 个角）
  box(b.X0 - 1, b.Y0 - 1, b.Z0 - 1, b.X1 + 1, b.Y0 - 1, b.Z1 + 1)
  box(b.X0 - 1, b.Y1 + 1, b.Z0 - 1, b.X1 + 1, b.Y1 + 1, b.Z1 + 1)
}

// 与 17x17 同一套方块：地板 / 顶圈 / 四角立柱 / +z 操控台
function c4BuildRoom(server, dimId, cx, cy, cz, ext, fillHole) {
  let b = c4RoomBox(cx, cy, cz, ext), FX = Math.floor(cx), FZ = Math.floor(cz)
  let run = (cmd) => { try { server.runCommandSilent('execute in ' + dimId + ' run ' + cmd) } catch (e) { console.warn('[C4] 房间: ' + e) } }
  // 大尺寸房间整块 fill 会超过 32768 上限（49×17×49=40817）→ 命令静默失败、旧方块留在原地。
  // 按 8 格一层清，单条最大 49×8×49=19208。
  for (let yy = b.Y0; yy <= b.Y1; yy += 8) {
    let y2 = Math.min(yy + 7, b.Y1)
    run(`fill ${b.X0} ${yy} ${b.Z0} ${b.X1} ${y2} ${b.Z1} minecraft:air`)
  }
  run(`fill ${b.X0} ${b.Y0} ${b.Z0} ${b.X1} ${b.Y0} ${b.Z1} kubejs:warping_frame_platform`)
  // 目的地那一侧必须把 3×3 洞口封上（原包用 hexahedron_filling）：否则从天花板落进来的人
  // 会继续穿过地板洞 → 反向门 → 又被送回起点，形成"一直下落"的死循环。起飞侧保持洞口敞开。
  if (fillHole) run(`fill ${FX - 1} ${b.Y0} ${FZ - 1} ${FX + 1} ${b.Y0} ${FZ + 1} kubejs:hexahedron_filling`)
  else run(`fill ${FX - 1} ${b.Y0} ${FZ - 1} ${FX + 1} ${b.Y0} ${FZ + 1} minecraft:air`)
  run(`fill ${b.X0} ${b.Y1} ${b.Z0} ${b.X1} ${b.Y1} ${b.Z0} kubejs:warping_frame`)
  run(`fill ${b.X0} ${b.Y1} ${b.Z1} ${b.X1} ${b.Y1} ${b.Z1} kubejs:warping_frame`)
  run(`fill ${b.X0} ${b.Y1} ${b.Z0} ${b.X0} ${b.Y1} ${b.Z1} kubejs:warping_frame`)
  run(`fill ${b.X1} ${b.Y1} ${b.Z0} ${b.X1} ${b.Y1} ${b.Z1} kubejs:warping_frame`)
  run(`fill ${b.X0} ${b.Y0} ${b.Z0} ${b.X0} ${b.Y1} ${b.Z0} kubejs:warping_frame`)
  run(`fill ${b.X1} ${b.Y0} ${b.Z1} ${b.X1} ${b.Y1} ${b.Z1} kubejs:warping_frame`)
  run(`fill ${b.X0} ${b.Y0} ${b.Z1} ${b.X0} ${b.Y1} ${b.Z1} kubejs:warping_frame`)
  run(`fill ${b.X1} ${b.Y0} ${b.Z0} ${b.X1} ${b.Y1} ${b.Z0} kubejs:warping_frame`)
  run(`setblock ${FX} ${b.Y0 + 1} ${b.Z1} kubejs:warping_controls`)
  run(`setblock ${FX + 1} ${b.Y0 + 1} ${b.Z1} kubejs:warping_interface`)
  run(`setblock ${FX - 1} ${b.Y0 + 1} ${b.Z1} kubejs:warping_disc_drive`)
  run(`setblock ${FX} ${b.Y0 + 1} ${b.Z1 - 1} kubejs:launch_button[facing=north]`)
  // 隐形光源：不加的话房间里/透过门看到的目的地笼子是全黑的（看起来就像"门坏了"）
  run(`setblock ${FX} ${b.Y0 + 8} ${FZ} minecraft:light[level=15]`)
  // 排气孔（原包 17x17 的 warping_vent 位置，按当前尺寸换算到四个角附近）
  try {
    run(`setblock ${b.X1} ${b.Y0 + 1} ${b.Z1} kubejs:warping_vent`)
    run(`setblock ${b.X0} ${b.Y0 + 5} ${b.Z1} kubejs:warping_vent`)
    run(`setblock ${b.X1} ${b.Y1 - 5} ${b.Z0} kubejs:warping_vent`)
    run(`setblock ${b.X0} ${b.Y1} ${FZ} kubejs:warping_vent`)
    run(`setblock ${FX + 4} ${b.Y1} ${b.Z1} kubejs:warping_vent`)
    run(`setblock ${b.X0} ${b.Y0} ${FZ - 4} kubejs:warping_vent`)
  } catch (e) {}
  if (fillHole) {
    // 目的地：内侧墙面只把框梁之间的空气补成 filling（不动框梁/地板/面板/门）
    run(`fill ${b.X1} ${b.Y0 + 1} ${b.Z0 + 1} ${b.X1} ${b.Y1 - 1} ${b.Z1 - 1} kubejs:hexahedron_filling replace minecraft:air`)
    run(`fill ${b.X0} ${b.Y0 + 1} ${b.Z0 + 1} ${b.X0} ${b.Y1 - 1} ${b.Z1 - 1} kubejs:hexahedron_filling replace minecraft:air`)
    run(`fill ${b.X0 + 1} ${b.Y0 + 1} ${b.Z1} ${b.X1 - 1} ${b.Y1 - 1} ${b.Z1} kubejs:hexahedron_filling replace minecraft:air`)
    run(`fill ${b.X0 + 1} ${b.Y0 + 1} ${b.Z0} ${b.X1 - 1} ${b.Y1 - 1} ${b.Z0} kubejs:hexahedron_filling replace minecraft:air`)
    run(`fill ${b.X0 + 1} ${b.Y1} ${b.Z0 + 1} ${b.X1 - 1} ${b.Y1} ${b.Z1 - 1} kubejs:hexahedron_filling replace minecraft:air`)
  }
  // 外壳（贴着框梁外表面的那一格，6 面 + 12 棱 + 8 角）：
  //   主世界 → 整体替换成 hexahedron_filling（不是只填空气，门边就不会和框梁 z-fighting）
  //   目的地 → 整体清成 air（不放 filling）
  try { c4ShellFill(server, dimId, b, fillHole ? 'minecraft:air' : 'kubejs:hexahedron_filling') }
  catch (e) { console.warn('[C4] 外壳填充失败: ' + e) }
  return b
}
// 6 扇门：位置/尺寸都按当前 ext 算（矩形门）
// 6 个门面的期望坐标/尺寸（扩展/校验/建门共用同一张表）
function c4FaceTargets(cx, cy, cz, ext) {
  let b = c4RoomBox(cx, cy, cz, ext)
  let wx = b.X1 - b.X0 + 1, wz = b.Z1 - b.Z0 + 1, wy = b.Y1 - b.Y0 + 1
  let ccx = cx + 8 * (ext.px - ext.nx), ccy = cy + 8 * ext.py, ccz = cz + 8 * (ext.pz - ext.nz)
  return {
    'y':  { p: [ccx, b.Y1 + 1.01, ccz], w: wx, h: wz, rot: [0, -90] },
    '-y': { p: [ccx, b.Y0 - 0.01, ccz], w: wx, h: wz, rot: [0, 90] },
    'x':  { p: [b.X1 + 1.01, ccy, ccz], w: wz, h: wy, rot: [270, 0] },
    '-x': { p: [b.X0 - 0.01, ccy, ccz], w: wz, h: wy, rot: [90, 0] },
    'z':  { p: [ccx, ccy, b.Z1 + 1.01], w: wx, h: wy, rot: [0, 0] },
    '-z': { p: [ccx, ccy, b.Z0 - 0.01], w: wx, h: wy, rot: [180, 0] }
  }
}

function c4MakeRoomPortals(server, slot, idName, ext) {
  let cx = c4CubeX(slot) + 0.5, cz = C4_Z + 0.5, cy = C4_CORE_Y
  let T = c4FaceTargets(cx, cy, cz, ext)
  let list = []
  ;['y', '-y', 'x', '-x', 'z', '-z'].forEach(d => {
    let f = T[d]
    list.push([d, f.p[0], f.p[1], f.p[2], f.rot[0], f.rot[1], f.w, f.h])
  })
  server.runCommandSilent(`execute in minecraft:overworld positioned ${cx} ${cy} ${cz} run kill @e[type=immersive_portals:portal,distance=..80,tag=!cw_lobby]`)
  let t = 'c4rm' + slot
  list.forEach(f => {
    server.runCommandSilent(`execute in minecraft:overworld positioned ${f[1]} ${f[2]} ${f[3]} run summon marker ~ ~ ~ {Rotation:[${f[4]}.0f,${f[5]}.0f],NoGravity:1b,Tags:["${t}","c4f_${f[0]}"]}`)
  })
  list.forEach(f => {
    server.runCommandSilent(`execute in minecraft:overworld as @e[type=marker,tag=${t},tag=c4f_${f[0]}] at @s run portal cb_make_portal ${f[6]} ${f[7]} @s @s main_cube`)
  })
  server.runCommandSilent(`kill @e[type=marker,tag=${t}]`)
  let made = 0
  c4PortalsNear(server, cx, cy, cz).forEach(p => {
    if (!p.dir) {
      let dx = p.entity.x - cx, dy = p.entity.y - cy, dz = p.entity.z - cz
      let ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz)
      let dir = (ay >= ax && ay >= az) ? (dy > 0 ? 'y' : '-y') : (ax >= az ? (dx > 0 ? 'x' : '-x') : (dz > 0 ? 'z' : '-z'))
      try { p.entity.addTag(dir) } catch (e) {}
      p.dir = dir
    }
    try { p.entity.addTag('cw_id_' + idName) } catch (e) {}
    made++
  })
  return made
}
// /cwp expand <slot> <y|-y|x|-x|z|-z>：测试/管理入口（物品路径之后接）
function c4CmdExpand(ctx, slot, face) {
  let server = ctx.source.server
  let info = c4TeamOfSlot(slot)
  let ext = info ? c4Ext(info.cube) : c4Ext({ ext: C4_EXT_TMP[slot] })
  if (face === 'nz') { if (ext.nz >= 2) { c4Reply(ctx, '-z 已达上限'); return } ext.nz++ }
  else if (face === 'px') { if (ext.px >= 1) { c4Reply(ctx, '+x 已达上限'); return } ext.px++ }
  else if (face === 'nx') { if (ext.nx >= 1) { c4Reply(ctx, '-x 已达上限'); return } ext.nx++ }
  else if (face === 'py') { if (ext.py >= 4) { c4Reply(ctx, '顶部已达上限'); return } ext.py++ }
  else { c4Reply(ctx, '该面不可扩展（+z 是操控台）'); return }
  if (info) { info.cube.ext = ext; c4Save() } else { C4_EXT_TMP[slot] = ext }
  let cx = c4CubeX(slot) + 0.5, cz = C4_Z + 0.5
  // 先把扩展后的范围 forceload（block 坐标，必须整数），20 tick 后再建，不然 fill/summon 全落空
  let X0 = Math.floor(cx - 8 - 16 * ext.nx), X1 = Math.floor(cx + 8 + 16 * ext.px)
  let Z0 = Math.floor(cz - 8 - 16 * ext.nz), Z1 = Math.floor(cz + 8 + 16 * ext.pz)
  server.runCommandSilent('execute in minecraft:overworld run forceload add ' + (X0 - 8) + ' ' + (Z0 - 8) + ' ' + (X1 + 8) + ' ' + (Z1 + 8))
  let idName = info ? info.cube.id : ('cube' + slot)
  server.scheduleInTicks(20, () => {
    try {
      c4BuildRoom(server, 'minecraft:overworld', cx, C4_CORE_Y, cz, ext, false)
      let n = c4MakeRoomPortals(server, slot, idName, ext)
      console.info('[C4] 扩展 slot' + slot + ' ' + JSON.stringify(ext) + ' 门=' + n)
    } catch (e) { console.warn('[C4] 扩展失败: ' + e) }
  })
  c4Reply(ctx, '扩展已排队：' + face + '（20 tick 后生效）')
}

// ---------------------------------------------------------------------------- 启动
ServerEvents.loaded(event => {
  let server = event.server
  c4Db(); c4LoadState(); c4Ftb()
  c4SaveState()

  // 出生点那台 core 补身份 tag —— 只认 (0,105.5,0) 附近这一个！
  // 以前写成 @e[tag=core] 全量打，重启后所有队伍立方体的 core 都被打上 cw_slot0，
  // 出生点逻辑就会挑到别人的核心，甚至把出生点的门当成自己的门去指（门被挪走就是这么来的）。
  server.runCommandSilent('execute in minecraft:overworld positioned 0.5 105.5 0.5 run tag @e[type=marker,tag=core,distance=..3] add cw_core')
  server.runCommandSilent('execute in minecraft:overworld positioned 0.5 105.5 0.5 run tag @e[type=marker,tag=cw_core,distance=..3] add cw_slot0')
  server.runCommandSilent('execute in minecraft:overworld positioned 0.5 105.5 0.5 run tag @e[type=marker,tag=cw_core,distance=..3] add cw_id_lobby')
  // 修复旧账：非出生点的 core 身上误加的 cw_slot0 去掉
  server.runCommandSilent('execute in minecraft:overworld positioned 0.5 105.5 0.5 run tag @e[type=marker,tag=cw_slot0,distance=8..] remove cw_slot0')
  // 出生点的 6 扇门锁死（cw_lobby），造门/指门/清门都跳过
  server.runCommandSilent('execute in minecraft:overworld positioned 0.5 105.5 0.5 run tag @e[type=immersive_portals:portal,name=main_cube,distance=..15] add cw_lobby')
  // 清掉出生点 core 上残留的倒计时（否则按钮一按就自己开始跃迁，把出生点的门指走）
  server.runCommandSilent('execute in minecraft:overworld positioned 0.5 105.5 0.5 run tag @e[type=marker,tag=cw_core,distance=..3] remove pre_runtime')
  server.runCommandSilent('execute in minecraft:overworld positioned 0.5 105.5 0.5 run scoreboard players set @e[type=marker,tag=cw_core,distance=..3] pre_runtime 0')

  // 放开"指令创建队伍"：FTB Teams 有个 API-only 开关，打开时 /ftbteams party create 会被拒
  if (c4Db().allowPartyCommand !== false) {
    try {
      c4Cls('dev.ftb.mods.ftbteams.api.FTBTeamsAPI').api().setPartyCreationFromAPIOnly(false)
      console.info('[C4] 已放开 /ftbteams party create（setPartyCreationFromAPIOnly(false)）')
    } catch (e) {
      console.warn('[C4] 放开队伍指令失败（不影响 GUI 建队）: ' + e)
    }
  }

  // ChunkLoader 是内存态，重启必丢 → 按登记表重挂
  let n = 0
  let cubes = c4Db().cubes
  for (let k in cubes) if (cubes[k] && cubes[k].provisioned) {
    c4ChunkLoader(server, cubes[k].slot)
    server.runCommandSilent(c4ForceloadBox(cubes[k].slot, true))   // 保证实体可被枚举
    n++
  }

  try { c4HealCubeNames() } catch (e) { console.warn('[C4] 基地名自愈失败: ' + e) }
  // 等区块/实体加载完再清大厅门
  server.scheduleInTicks(40, () => { try { c4PurgeLobbyPortals(server) } catch (e) {} })
  console.info('[C4] cw_cubes v4 已加载 | 登记 ' + Object.keys(cubes).length + ' 台 | ChunkLoader ' + n
    + ' | FTB Teams=' + (c4Ftb().ok ? 'OK' : 'no') + ' | worldStarted=' + C4_STATE.worldStarted)
  console.info('[C4] 前置：数据包的门操作应已被 v4_strip_portal_cmds.py 注释，否则会和 API 抢门。')

  // 自检延后 20 tick，逐项隔离（任何一个通道失败都不影响其它）
  server.scheduleInTicks(20, () => { try { c4SelfTest(server) } catch (e) { console.warn('[C4] 自检外层异常: ' + e) } })
})

// ---------------------------------------------------------------------------- 扩展器 / 拆除器
let C4_EXP_CLICK = {}

function c4ExpandDeny(p, msg) { try { p.tell(Text.of('⟢ ' + msg)) } catch (e) {} }

// 操控台在 +z 面中心（x+0.5, 98, 8），必须站在它前面 3.5 格内操作
function c4AtConsole(p, cube) {
  // 只要站在【本队最初那 15×15 的立方体内部】就能操作（不再要求贴控制台）
  let cx = c4CubeX(cube.slot) + 0.5
  return Math.abs(p.x - cx) <= 7.5 && Math.abs(p.z - (C4_Z + 0.5)) <= 7.5 && p.y >= 96 && p.y <= 101
}

// 优先【搬门】而不是删了重建：保留 entity 与目的地，只改位置/尺寸
function c4MovePortals(server, slot, idName, ext) {
  let cx = c4CubeX(slot) + 0.5, cy = C4_CORE_Y, cz = C4_Z + 0.5
  let T = c4FaceTargets(cx, cy, cz, ext)
  let moved = 0
  c4PortalsNear(server, cx, cy, cz).forEach(p => {
    if (c4HasTag(p.entity, 'cw_lobby')) return
    if (idName && !c4HasTag(p.entity, 'cw_id_' + idName)) return
    if (!p.dir || !T[p.dir]) return
    let f = T[p.dir]
    try {
      p.entity.setOriginPos(c4Vec(f.p[0], f.p[1], f.p[2]))
      p.entity.setPos(f.p[0], f.p[1], f.p[2])
      try { p.entity.setWidth(f.w); p.entity.setHeight(f.h) } catch (e2) { console.warn('[C4] 门尺寸设置失败: ' + e2) }
      try { p.entity.setIsVisible(true); c4Sync(p.entity) } catch (e3) {}
      moved++
    } catch (e) { console.warn('[C4] 搬门失败 ' + p.dir + ': ' + e) }
  })
  return moved
}

// 校验：6 个面必须各有一扇、且位置误差 < 1.6；不对就清掉重建（最多 2 次）
function c4EnsureSix(server, slot, idName, cx, cy, cz, ext, tries) {
  let ps = c4PortalsNear(server, cx, cy, cz)
  let T = c4FaceTargets(cx, cy, cz, ext)
  let miss = []
  for (let d in T) {
    let q = T[d].p
    let ok = false
    for (let i = 0; i < ps.length; i++) {
      let e = ps[i].entity
      if (Math.abs(e.x - q[0]) < 1.6 && Math.abs(e.y - q[1]) < 1.6 && Math.abs(e.z - q[2]) < 1.6) { ok = true; break }
    }
    if (!ok) miss.push(d)
  }
  if (miss.length === 0 && ps.length === 6) { console.info('[C4] 门校验 OK：6/6'); return true }
  console.warn('[C4] 门校验：实有 ' + ps.length + ' 扇，缺/偏 ' + (miss.join(',') || '无') + '（剩余重试 ' + tries + '）')
  if (tries <= 0) return false
  try { server.runCommandSilent('execute in minecraft:overworld run kill @e[type=immersive_portals:portal,tag=cw_id_' + idName + ']') } catch (e) {}
  server.scheduleInTicks(5, () => {
    try { c4MakeRoomPortals(server, slot, idName, ext) } catch (e) { console.warn('[C4] 重建门失败: ' + e) }
    c4EnsureSix(server, slot, idName, cx, cy, cz, ext, tries - 1)
  })
  return false
}

// 清掉某个 ext 尺寸对应的整个房间体积（y 分层，单条 fill 不超过 32768）
function c4ClearRoom(server, dimId, cx, cy, cz, ext) {
  let b = c4RoomBox(cx, cy, cz, ext)
  for (let y = b.Y0; y <= b.Y1; y += 8) {
    let y2 = Math.min(y + 7, b.Y1)
    try {
      server.runCommandSilent('execute in ' + dimId + ' run fill ' + b.X0 + ' ' + y + ' ' + b.Z0 + ' ' + b.X1 + ' ' + y2 + ' ' + b.Z1 + ' minecraft:air')
    } catch (e) { console.warn('[C4] 清房间失败: ' + e) }
  }
}

// 按当前 ext 重建：主世界房间 + 6 扇矩形门 + 目的地笼子（同 ext）+ 反向门
function c4ApplyExt(server, cube, ext, player, face, verb, oldExt) {
  cube.ext = ext
  c4Save()
  let slot = cube.slot
  let cx = c4CubeX(slot) + 0.5, cz = C4_Z + 0.5
  let CAGE = 'hexahedron:bedrock_bottom'
  let d = (cube.dest && cube.dest.dim)
    ? { dim: cube.dest.dim, x: cube.dest.x + 0.5, y: cube.dest.y, z: cube.dest.z + 0.5 }
    : { dim: CAGE, x: cx, y: C4_CORE_Y, z: cz }
  if (d.dim === 'minecraft:overworld' && Math.abs(d.x - cx) < 1 && Math.abs(d.z - cz) < 1) d = { dim: CAGE, x: cx, y: C4_CORE_Y, z: cz }

  let fx = Math.floor(cx), fz = Math.floor(cz)
  let dfx = Math.floor(d.x), dfz = Math.floor(d.z)
  server.runCommandSilent('execute in minecraft:overworld run forceload add ' + (fx - 40) + ' ' + (fz - 40) + ' ' + (fx + 40) + ' ' + (fz + 40))
  server.runCommandSilent('execute in ' + d.dim + ' run forceload add ' + (dfx - 40) + ' ' + (dfz - 40) + ' ' + (dfx + 40) + ' ' + (dfz + 40))

  // 只有门多于 6 扇（历史遗留重复）才清；正常情况【搬门】保留目的地
  let killByTag = (dim) => {
    try {
      server.runCommandSilent('execute in ' + dim + ' run kill @e[type=immersive_portals:portal,tag=cw_id_' + cube.id + ']')
      server.runCommandSilent('execute in ' + dim + ' run kill @e[type=immersive_portals:portal,tag=cw_rev_' + cube.id + ']')
    } catch (e) { console.warn('[C4] 清门失败(' + dim + '): ' + e) }
  }
  try {
    let cnt = c4PortalsNear(server, cx, C4_CORE_Y, cz).length
    if (cnt > 6) { killByTag('minecraft:overworld'); killByTag(d.dim) }
  } catch (e) {}

  server.scheduleInTicks(10, () => {
    try {
      // 先把旧尺寸（扩展前/拆除前）的整块体积清掉，再按新尺寸重建；
      // 否则拆除时旧的框梁/地板会留在原地（用户看到的"目的地框架没移除"）
      if (oldExt) c4ClearRoom(server, 'minecraft:overworld', cx, C4_CORE_Y, cz, oldExt)
      c4BuildRoom(server, 'minecraft:overworld', cx, C4_CORE_Y, cz, ext, false)
      // 先搬门（保留实体/目的地），一扇都没有时才新建
      let n = c4MovePortals(server, slot, cube.id, ext)
      if (n === 0) n = c4MakeRoomPortals(server, slot, cube.id, ext)
      if (oldExt) c4ClearRoom(server, d.dim, d.x, d.y, d.z, oldExt)
      c4BuildRoom(server, d.dim, d.x, d.y, d.z, ext, true)
      let aimed = c4Retarget(server, cx, C4_CORE_Y, cz, c4DimKey(d.dim), d.x, d.y, d.z, false, d.dim, cube.id, ext, true)
      server.scheduleInTicks(15, () => { try { c4EnsureSix(server, slot, cube.id, cx, C4_CORE_Y, cz, ext, 2) } catch (e) {} })
      try { c4MakeReverse(server, slot, d.dim, d.x, d.y, d.z, cube.id) } catch (e) { console.warn('[C4] 反向门失败: ' + e) }
      console.info('[C4] ' + verb + ' slot' + slot + ' ' + face + ' ext=' + JSON.stringify(ext) + ' 门=' + n + ' 指向=' + aimed)
      let sx = 17 + 16 * (ext.px + ext.nx), sz = 17 + 16 * (ext.pz + ext.nz), sy = 17 + 16 * ext.py
      c4ExpandDeny(player, verb + ' ' + face + ' 完成 · 立方体 ' + sx + '×' + sz + '×' + sy)
    } catch (e) { console.warn('[C4] ' + verb + '执行失败: ' + e); c4ExpandDeny(player, verb + '失败，见控制台') }
  })
}

function c4DoExpand(server, cube, face, player) {
  let ext = c4Ext(cube)
  let limit = { px: 1, nx: 1, nz: 2, py: 4 }
  if (face === 'px') { if (ext.px >= limit.px) { c4ExpandDeny(player, '+x 已到上限'); return } ext.px++ }
  else if (face === 'nx') { if (ext.nx >= limit.nx) { c4ExpandDeny(player, '-x 已到上限'); return } ext.nx++ }
  else if (face === 'nz') { if (ext.nz >= limit.nz) { c4ExpandDeny(player, '-z 已到上限'); return } ext.nz++ }
  else if (face === 'py') { if (ext.py >= limit.py) { c4ExpandDeny(player, '顶面已到上限'); return } ext.py++ }
  else { c4ExpandDeny(player, '该面不可扩展'); return }
  try {
    if (!player.isCreative()) {
      let st = player.mainHandItem
      if (!st || st.count <= 0 || String(st.id) !== 'kubejs:cube_expander') { c4ExpandDeny(player, '手里没有扩展器'); return }
      st.shrink(1)
    }
  } catch (e) { console.warn('[C4] 扣扩展器失败: ' + e) }
  c4ApplyExt(server, cube, ext, player, face, '扩展', c4Ext(cube))
}

function c4DoReduce(server, cube, face, player) {
  let ext = c4Ext(cube)
  if (face === 'px') { if (ext.px <= 0) { c4ExpandDeny(player, '+x 没有可拆的扩展'); return } ext.px-- }
  else if (face === 'nx') { if (ext.nx <= 0) { c4ExpandDeny(player, '-x 没有可拆的扩展'); return } ext.nx-- }
  else if (face === 'nz') { if (ext.nz <= 0) { c4ExpandDeny(player, '-z 没有可拆的扩展'); return } ext.nz-- }
  else if (face === 'py') { if (ext.py <= 0) { c4ExpandDeny(player, '顶面没有可拆的扩展'); return } ext.py-- }
  else { c4ExpandDeny(player, '该面不可拆除'); return }
  c4ApplyExt(server, cube, ext, player, face, '拆除', c4Ext(cube))   // 拆除不返还材料
}

function c4ToolUse(event, reduce) {
  try {
    let p = event.player, server = event.server
    let t = c4Team(p), key = t ? c4TeamKey(t) : null
    let cube = key ? c4CubeOfTeam(key) : null
    if (!cube) { c4ExpandDeny(p, '你还没有立方体'); return }
    if (!c4AtConsole(p, cube)) { c4ExpandDeny(p, '需要站在操控台前'); return }
    let yaw = ((Number(p.yaw) % 360) + 360) % 360
    let pitch = Number(p.pitch)
    let face = null
    // MC 的 XRot：正 = 低头，负 = 抬头
    if (pitch < -50) face = 'py'
    else if (pitch > 50) { c4ExpandDeny(p, '底面不可操作'); return }
    else face = ['z', 'nx', 'nz', 'px'][Math.round(yaw / 90) % 4]
    if (face === 'z') { c4ExpandDeny(p, '操控台这一面不能操作'); return }
    let now = Date.now(), k = (reduce ? 'r:' : 'e:') + c4Name(p)
    let last = C4_EXP_CLICK[k]
    if (!last || last.face !== face || now - last.t > 2000) {
      C4_EXP_CLICK[k] = { face: face, t: now }
      c4ExpandDeny(p, (reduce ? '拆除' : '扩展') + ' ' + face + '：再右键一次确认（2 秒内）')
      return
    }
    C4_EXP_CLICK[k] = null
    if (reduce) c4DoReduce(server, cube, face, p)
    else c4DoExpand(server, cube, face, p)
  } catch (e) { console.warn('[C4] 工具右键: ' + e) }
}

ItemEvents.rightClicked('kubejs:cube_expander', event => c4ToolUse(event, false))
ItemEvents.rightClicked('kubejs:cube_reducer', event => c4ToolUse(event, true))

// 没有基地的玩家（含新出生）：直接送进基岩维度 0,0 的出生笼子，走到配给台按按钮领基地
PlayerEvents.loggedIn(event => {
  try {
    let p = event.player, server = event.server
    let t = c4Team(p)
    let key = t ? c4TeamKey(t) : null
    let cube = key ? c4CubeOfTeam(key) : null
    if (cube) return
    server.scheduleInTicks(20, () => {
      try {
        if (p && p.isAlive()) c4Tp(server, p, 'hexahedron:bedrock_bottom', 0.5, 98.0, 5.5)
        console.info('[C4] 新玩家送入出生笼子: ' + c4Name(p))
      } catch (e) {}
    })
  } catch (e) {}
})

// ---------------------------------------------------------------------------- 启动复位
// 按钮现在从"按下"一直保持到动画结束；如果期间崩服/重载，世界里的 pressed 状态会残留。
// 服务端加载（含 /reload）时把各台车厢的按钮复位成普通态（只改确实处于 pressed 的那一格）。
// 优先用登记表里的 slot（加载早期实体可能还没进内存），再补上能枚举到的核心。
function c4RestoreButtons(server) {
  let slots = []
  try {
    let db = c4Db()
    for (let k in db.cubes) if (db.cubes[k]) {
      let s = Number(db.cubes[k].slot)
      if (slots.indexOf(s) < 0) slots.push(s)
    }
  } catch (e) {}
  try {
    c4Cores(server).forEach(c => {
      let s = Number(c.slot)
      if (slots.indexOf(s) < 0) slots.push(s)
    })
  } catch (e) {}
  let n = 0
  slots.forEach(slot => {
    let x = Math.floor(c4CubeX(slot))
    let y = Math.floor(C4_CORE_Y - 7)
    let z = c4SlotZ(slot) - 1
    try {
      server.runCommandSilent('execute in minecraft:overworld if block ' + x + ' ' + y + ' ' + z
        + ' kubejs:launch_button_pressed run setblock ' + x + ' ' + y + ' ' + z + ' kubejs:launch_button[facing=north]')
      n++
    } catch (e) {}
  })
  return n
}
// 脚本加载后的第一个 tick 复位一次（/reload 不会触发 ServerEvents.loaded，但一定会重新跑脚本）
let C4_BTN_RESTORED = false
ServerEvents.tick(event => {
  if (C4_BTN_RESTORED) return
  C4_BTN_RESTORED = true
  try {
    let n = c4RestoreButtons(event.server)
    console.info('[C4] 启动复位：检查 ' + n + ' 台车厢的按钮状态')
  } catch (e) { console.warn('[C4] 启动复位异常: ' + e) }
})

// 聊天框只在失败时说话（见 c4WarpBody / perform 的 abort 分支）
