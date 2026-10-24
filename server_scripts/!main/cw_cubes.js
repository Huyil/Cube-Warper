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
const C4_SPACING = 10000          // 槽位间距（格）；有 ChunkLoader 后可改小，512 也够
const C4_Z = 0
const C4_BASE_Y = 100.5           // 17x17 构建基准（地板 y=97，站立 y=98）
const C4_CORE_Y = 105.5
const C4_FACE = 8.45              // 目的地 6 个门面距 outer_core 的距离（与原包 unfold 一致）
const C4_HALF = 7.9
const C4_Y_MIN = 96.0
const C4_Y_MAX = 114.0
const C4_CFG = 'config/cubarper-cubes.json'
const C4_STATE_PATH = 'config/cubarper-state.json'
const C4_DEST_MIN_SEP = 1200   // 必须 > 1000：原包 hex_anchor 的复用半径是 1000，小于它就会偷到别人的落点
const C4_DEST_RETRY = 5        // 重新随机挑坐标最多 5 次
const C4_DEST_NUDGE = 1024     // 撞车 → 单调外移（+x 方向，第 i 次偏移 i*1024）
const C4_DEST_JITTER = 768     // 每次跃迁的随机抖动半径（原包只有 spreadplayers ±100，且会被 anchor 固定住）
const C4_PORTAL_SPAN = 17       // 门面边长（cb_make_portal 17 17）
const C4_PORTAL_INSET = 0.01 // 6 个门面各向内缩 1px（1/16 格），避免棱线处叠加导致闪烁；设 0 可关闭
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
function c4CubeX(slot) { return slot * C4_SPACING }
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
    if (c4Dist2(e.x, e.y, e.z, cx, cy, cz) > 900) return
    let dir = null
    ;['y', '-y', 'x', '-x', 'z', '-z'].forEach(d => { if (c4HasTag(e, d)) dir = d })
    out.push({ entity: e, dir: dir })
  })
  return out
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
  for (let s = 0; s < 128; s++) {
    let cx = c4CubeX(s)
    if (Math.abs(bx - cx) <= 8.6 && Math.abs(bz - C4_Z) <= 8.6) return s
  }
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
  let cube = { slot: Number(slot), id: cubeId, name: c4TeamLabel(team), x: c4CubeX(slot), z: C4_Z, provisioned: false, claimedAt: Date.now() }
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
  let x0 = Math.floor((x - 9) / 16) * 16, x1 = Math.floor((x + 9) / 16) * 16 + 15
  let z0 = Math.floor((C4_Z - 9) / 16) * 16, z1 = Math.floor((C4_Z + 9) / 16) * 16 + 15
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
  if (!outer) { console.warn('[C4] 最终预载：拿不到 outer_core'); return }
  let dimId = c4DimOf(outer)
  let x = Math.round(outer.x), y = Math.round(outer.y), z = Math.round(outer.z)
  let cx = Math.floor(x / 16) * 16, cz = Math.floor(z / 16) * 16
  server.runCommandSilent('execute in ' + dimId + ' run forceload add ' + cx + ' ' + cz)
  job.dest = { dim: dimId, x: x, y: y, z: z, cx: cx, cz: cz }
  console.info('[C4] 目的地最终预载 dim=' + dimId + ' @' + x + ',' + y + ',' + z + '（区块 ' + cx + ',' + cz + '）')
}

// 把 6 扇门指到 destCenter（目标维度 level），可选重建 6 个反向门
function c4Retarget(server, cx, cy, cz, destKey, dx, dy, dz, withReverse, destId) {
  if (!destKey) { console.error('[C4] retarget: destKey 为空'); return 0 }
  let off = {
    'y': [0, C4_FACE, 0], '-y': [0, -C4_FACE, 0],
    'x': [C4_FACE, 0, 0], '-x': [-C4_FACE, 0, 0],
    'z': [0, 0, C4_FACE], '-z': [0, 0, -C4_FACE]
  }
  let done = 0
  c4PortalsNear(server, cx, cy, cz).forEach(p => {
    if (!p.dir || !off[p.dir]) return
    let o = off[p.dir]
    let pos = c4Vec(dx + o[0], dy + o[1], dz + o[2])
    if (C4_PORTAL_INSET > 0) {
      // 目标侧同样内缩 1px：把落点沿该面法线朝中心收 0.0625
      let ax = String(p.dir).replace('-', '')
      let sg = (String(p.dir).charAt(0) === '-') ? -1 : 1
      if (ax === 'x') pos = c4Vec(dx + o[0] - sg * C4_PORTAL_INSET, dy + o[1], dz + o[2])
      if (ax === 'y') pos = c4Vec(dx + o[0], dy + o[1] - sg * C4_PORTAL_INSET, dz + o[2])
      if (ax === 'z') pos = c4Vec(dx + o[0], dy + o[1], dz + o[2] - sg * C4_PORTAL_INSET)
    }

    // 6 个门面各向内缩 1px（默认 1/16 格）：避免相邻面在棱线处叠加，导致传送瞬间的黑色闪烁/闪烁
    if (C4_PORTAL_INSET > 0) {
      try {
        let axis = String(p.dir).replace('-', '')
        let sgn = (String(p.dir).charAt(0) === '-') ? -1 : 1
        let cx0 = cx, cy0 = cy, cz0 = cz
        let nx = cx0, ny = cy0, nz = cz0
        if (axis === 'x') nx = cx0 + sgn * (C4_FACE - C4_PORTAL_INSET)
        if (axis === 'y') ny = cy0 + sgn * (C4_FACE - C4_PORTAL_INSET)
        if (axis === 'z') nz = cz0 + sgn * (C4_FACE - C4_PORTAL_INSET)
        p.entity.setOriginPos(c4Vec(nx, ny, nz))
        p.entity.setPos(nx, ny, nz)
        // Portal 实例上没有 getWidth（KubeJS 映射不到），用已知边长 17 直接设
        try {
          p.entity.setWidth(C4_PORTAL_SPAN - 2 * C4_PORTAL_INSET)
          p.entity.setHeight(C4_PORTAL_SPAN - 2 * C4_PORTAL_INSET)
        } catch (e2) { console.warn('[C4] 门面缩放不可用: ' + e2) }
      } catch (e) { console.warn('[C4] 门面内缩失败 ' + p.dir + ': ' + e) }
    }
    if (!c4ApplyPortal(server, p.entity, destId, destKey, pos, cx, cy, cz)) {
      console.error('[C4] retarget 失败 dir=' + p.dir)
      return
    }
    try { p.entity.setIsVisible(true); c4Sync(p.entity) } catch (e) { console.warn('[C4] show: ' + e) }
    done++
    // 反向门统一交给 c4MakeReverse（summon + 正确的 IP NBT 键：axisW/axisH/destPos）。
    // 旧实现用 PortalAPI.createReversePortal / portal complete_bi_way_portal，在这个
    // IP 3.0.7-forge 服务端上不生效，且失败被静默吞掉，已移除。
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
  if (n <= 1) return { x: cx, y: 98.0, z: cz + 6.0 }
  let r = n <= 4 ? 2.6 : (n <= 8 ? 3.6 : 5.0)
  let a = (2 * Math.PI * i) / n - Math.PI / 2
  return { x: cx + Math.cos(a) * r, y: 98.0, z: cz + Math.sin(a) * r }
}
function c4SendToCube(server, players, slot) {
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
  console.info('[C4] 建造槽位 ' + slot + ' @ x=' + x + ' id=' + idName)
  // 永久强制加载：server.entities 只枚举"已加载区块"里的实体，远端立方体一旦卸载，
  // 之后所有 /cwp、!cube 的实体查询都会"找不到核心"。每台只占 2×2 区块。
  server.runCommandSilent(c4ForceloadBox(slot, true))
  server.scheduleInTicks(2, () => {
    try { c4ProvisionBody(server, slot, teamName, idName) }
    catch (e) { console.error('[C4] 建造主体失败 slot=' + slot + ': ' + e) }
  })
}

// IP 3.0.7 的 portal cb_make_portal 在服务端是静默失败（命令存在但造不出门），
// 所以改成直接 summon 门实体：几何与 x=10000 那台原版立方体实测一致
// （中心 cubeX+0.5，各面偏移 ±(C4_FACE-C4_PORTAL_INSET)，边长 17-2*inset）。
function c4MakePortals(server, slot, idName) {
  let cx = c4CubeX(slot) + 0.5, cy = C4_CORE_Y, cz = C4_Z + 0.5
  let d = C4_FACE - C4_PORTAL_INSET
  let span = C4_PORTAL_SPAN - 2 * C4_PORTAL_INSET
  let faces = [
    ['y',  [1, 0, 0], [0, 0, 1],  [0,  d, 0]],
    ['-y', [1, 0, 0], [0, 0, -1], [0, -d, 0]],
    ['x',  [0, 0, 1], [0, 1, 0],  [d, 0, 0]],
    ['-x', [0, 0, -1], [0, 1, 0], [-d, 0, 0]],
    ['z',  [-1, 0, 0], [0, 1, 0], [0, 0,  d]],
    ['-z', [1, 0, 0], [0, 1, 0],  [0, 0, -d]]
  ]
  let made = 0
  faces.forEach(f => {
    let px = cx + f[3][0], py = cy + f[3][1], pz = cz + f[3][2]
    let nbt = '{width:' + span + 'd,height:' + span + 'd,'
      + 'axisWX:' + f[1][0] + '.0d,axisWY:' + f[1][1] + '.0d,axisWZ:' + f[1][2] + '.0d,'
      + 'axisHX:' + f[2][0] + '.0d,axisHY:' + f[2][1] + '.0d,axisHZ:' + f[2][2] + '.0d,'
      + 'bindCluster:1b,isVisible:1b,teleportable:1b,interactable:1b,hasCrossPortalCollision:1b,'
      + 'adjustPositionAfterTeleport:1b,teleportChangesScale:1b,teleportChangesGravity:0b,'
      + 'fuseView:0b,doRenderPlayer:1b,renderingMergable:0b,'
      + 'dimensionTo:"minecraft:overworld",destinationX:' + px + 'd,destinationY:' + py + 'd,destinationZ:' + pz + 'd,'
      + 'CustomName:\'{"text":"main_cube"}\','
      + 'Tags:["main_cube","' + f[0] + '","cw_id_' + idName + '"]}'
    try {
      if (server.runCommandSilent('execute in minecraft:overworld positioned ' + px + ' ' + py + ' ' + pz +
        ' run summon immersive_portals:portal ~ ~ ~ ' + nbt) > 0) made++
      else console.warn('[C4] 正向门 summon 未生效 ' + f[0] + ' @' + px + ',' + py + ',' + pz)
    } catch (e) { console.warn('[C4] 造门失败 ' + f[0] + ': ' + e) }
  })
  return made
}

// 在目标维度落点周围造 6 扇反向门，指回主世界的立方体。
// IP 的 createReversePortal / complete_bi_way_portal 在这个版本都不生效，
// 所以和正向门一样直接 summon。
function c4MakeReverse(server, slot, dimId, dx, dy, dz, idName) {
  let ow = c4CubeX(slot) + 0.5, oy = C4_CORE_Y, oz = C4_Z + 0.5
  let d = C4_FACE - C4_PORTAL_INSET
  let span = C4_PORTAL_SPAN - 2 * C4_PORTAL_INSET
  let faces = [
    ['y',  [1, 0, 0], [0, 0, 1],  [0,  d, 0], [0, 0]],
    ['-y', [1, 0, 0], [0, 0, -1], [0, -d, 0], [0, 0]],
    ['x',  [0, 0, 1], [0, 1, 0],  [d, 0, 0],  [0, 0]],
    ['-x', [0, 0, -1], [0, 1, 0], [-d, 0, 0], [0, 0]],
    ['z',  [-1, 0, 0], [0, 1, 0], [0, 0,  d], [0, 0]],
    ['-z', [1, 0, 0], [0, 1, 0],  [0, 0, -d], [0, 0]]
  ]
  let made = 0
  faces.forEach(f => {
    let px = dx + f[3][0], py = dy + f[3][1], pz = dz + f[3][2]
    // 目标：主世界立方体【同侧的面】（不是中心！指向中心会看到立方体的中截面 = 只看到一半）
    let tx = ow + f[3][0], ty = oy + f[3][1], tz = oz + f[3][2]
    let nbt = '{width:' + span + 'd,height:' + span + 'd,'
      + 'axisWX:' + (-f[1][0]) + '.0d,axisWY:' + (-f[1][1]) + '.0d,axisWZ:' + (-f[1][2]) + '.0d,'
      + 'axisHX:' + f[2][0] + '.0d,axisHY:' + f[2][1] + '.0d,axisHZ:' + f[2][2] + '.0d,'
      + 'bindCluster:1b,isVisible:1b,teleportable:1b,interactable:1b,hasCrossPortalCollision:1b,'
      + 'adjustPositionAfterTeleport:1b,teleportChangesScale:1b,teleportChangesGravity:0b,'
      + 'fuseView:0b,doRenderPlayer:1b,renderingMergable:0b,'
      + 'dimensionTo:"minecraft:overworld",destinationX:' + tx + 'd,destinationY:' + ty + 'd,destinationZ:' + tz + 'd,'
      + 'CustomName:\'{"text":"cw_return"}\','
      + 'Tags:["main_cube","cw_rev","cw_rev_' + idName + '","' + f[0] + '"]}'
    try {
      if (server.runCommandSilent('execute in ' + dimId + ' positioned ' + px + ' ' + py + ' ' + pz +
        ' run summon immersive_portals:portal ~ ~ ~ ' + nbt) > 0) made++
      else console.warn('[C4] 反向门 summon 未生效 ' + f[0] + ' @' + px + ',' + py + ',' + pz + ' dim=' + dimId)
    } catch (e) { console.warn('[C4] 反向门 summon 失败 ' + f[0] + ': ' + e) }
  })
  console.info('[C4] 反向门：落点周围造出 ' + made + ' 扇')
  return made
}

function c4ProvisionBody(server, slot, teamName, idName) {
  let x = c4CubeX(slot)
  // 幂等：清掉这一格附近的旧门/旧 marker（此时区块已加载，kill 才会命中）
  server.runCommandSilent(`execute in minecraft:overworld positioned ${x} ${C4_CORE_Y} ${C4_Z} run kill @e[type=immersive_portals:portal,distance=..30]`)
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
  let safeName = c4CleanName(teamName) || ('cube' + slot)
  let dj = JSON.stringify({ text: safeName })   // 单引号 SNBT 内不要转义双引号
  server.runCommandSilent(`execute positioned ${x} ${C4_CORE_Y} ${C4_Z} run summon marker ~ ~ ~ {CustomName:'${dj}',Rotation:[0.0f,-90.0f],NoGravity:1b,Tags:["core","cw_core","cw_slot${slot}","cw_id_${idName}"]}`)

  // 5) 清临时 marker
  server.runCommandSilent(`kill @e[type=marker,tag=${t}]`)

  // 6) 轮询等待 6 扇门就绪，再打身份 tag + 初次指向（bedrock_bottom，与原包开局一致）
  c4WaitPortals(server, x, C4_CORE_Y, C4_Z, 20, (n) => {
    console.info('[C4] 槽位 ' + slot + ' 门就绪数量 = ' + n)
    c4PortalsNear(server, x, C4_CORE_Y, C4_Z).forEach(p => {
      try { p.entity.addTag('cw_id_' + idName) } catch (e) {}
    })
    // 新建的立方体先指向主世界自身坐标：玩家在舱内看到的就是主世界（相当于窗外）
    let made = c4Retarget(server, x, C4_CORE_Y, C4_Z,
      c4DimKey('minecraft:overworld'), x, C4_CORE_Y, C4_Z, false, 'minecraft:overworld')
    console.info('[C4] 槽位 ' + slot + ' 初次指门完成 = ' + made + ' 扇')
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
    player.tell(c4t('cw.lobby.need_team'))
    player.tell(c4t('cw.lobby.gui'))
    player.tell(c4t('cw.lobby.cmd_blocked'))
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

  server.scheduleInTicks(6, () => {
    c4SendToCube(server, c4TeamOnline(t), slot)
    c4TeamOnline(t).forEach(m => {
      m.tell(c4t1('cw.lobby.ready', label))
    })
  })
}

// ---------------------------------------------------------------------------- 跃迁（串行队列）
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
  let hidden = c4Hide(server, core.x, core.y, core.z)
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
  console.info('[C4] 槽位 ' + slot + ' 乘客筛选完成：舱内 ' + riders.length + ' / 外待机 ' + absent.length + ' / 他队 ' + outsiders.length)
  job.riders = riders.map(x => c4Name(x))
  // 按下按钮不再把玩家拉去座位：跃迁是"门在动"，人留在原地即可
  c4TellTeam(server, slot, c4t1('cw.warp.ready', label))
  if (absent.length > 0) {
    let names = []
    absent.forEach(p => names.push(c4Name(p)))
    c4TellTeam(server, slot, c4t1('cw.warp.absent', names.join('、')))
  }
  if (outsiders.length > 0) {
    let names = []
    outsiders.forEach(p => names.push(c4Name(p)))
    c4TellTeam(server, slot, c4t1('cw.warp.outsiders', names.join('、')))
  }

  console.info('[C4] 槽位 ' + slot + ' → 交棒数据包')
  // ②.5 清掉所有遗留 outer_core，保证后面拿到的目的地核心是"本次"的
  let purged = c4PurgeOuterCores(server)
  if (purged > 0) console.info('[C4] 清掉遗留 outer_core ' + purged + ' 个')

  // ③ 交棒数据包（只给这台 core 打 pre_runtime）
  server.runCommandSilent(`execute in minecraft:overworld positioned ${c4CubeX(slot)} 98 7 run function hexahedron:first_init/world_start`)
  server.runCommandSilent(`tag @e[type=marker,tag=cw_slot${slot}] add pre_runtime`)

  // ③.5 撞车预判：从 t=90 起每 5 tick 看一次 outer_core 是否已经 summon 出来，
  //      出现就立刻判（必须在 t=185 unfold 之前完成），最多等到 t=180。
  let tries = 0
  let checkDest = () => {
    tries++
    let outer = null
    try { outer = c4OuterCore(server) } catch (e) {}
    if (!outer && tries < 19) { server.scheduleInTicks(5, checkDest); return }
    if (!outer) { console.warn('[C4] 目的地预判：到 t≈180 仍没有 outer_core，跳过撞车检查'); return }
    try { c4PrepareDest(server, slot, job) } catch (e) { console.error('[C4] 目的地预判失败: ' + e) }
  }
  server.scheduleInTicks(90, checkDest)

  // ③.6 t=186：unfold 已跑完，用最终落点做真实预载 + 记录
  server.scheduleInTicks(C4_T_PRELOAD, () => {
    try { c4PreloadFinal(server, slot, job) } catch (e) { console.error('[C4] 最终预载失败: ' + e) }
  })

  // ③.7 t=180：最终锁定落点（走 185 之前再清一次 hex_anchor，否则 standard_floor 会把
  //      outer_core tp 回 1000 格内的旧锚点，落点又变成老地方）
  server.scheduleInTicks(180, () => {
    try {
      let p = job.destPlan
      if (!p) return
      server.runCommandSilent('execute in ' + p.dim + ' run forceload add ' + p.cx + ' ' + p.cz)
      server.runCommandSilent('execute in ' + p.dim + ' positioned ' + (p.x + 0.5) + ' ' + p.y + ' ' + (p.z + 0.5) +
        ' run kill @e[type=marker,tag=hex_anchor,distance=..1000]')
      server.runCommandSilent('execute in ' + p.dim + ' run tp @e[type=marker,tag=outer_core] ' + (p.x + 0.5) + ' ' + p.y + ' ' + (p.z + 0.5))
      console.info('[C4] 落点锁定 @' + p.x + ',' + p.y + ',' + p.z + '（已清该处锚点）')
    } catch (e) { console.warn('[C4] 落点锁定失败: ' + e) }
  })

  // ④ t=190：数据包已定维度并建好笼子 → API 指门
  server.scheduleInTicks(C4_T_RETARGET, () => {
    let outer = c4OuterCore(server)
    if (!outer) {
      c4TellTeam(server, slot, c4t('cw.warp.no_dest'))
      c4WarpEnd(server, slot, label, job)
      return
    }
    let destId = c4DimOf(outer)
    let destKey = c4DimKey(destId)
    let cur = c4CoreOfSlot(server, slot)
    if (!cur) { c4WarpEnd(server, slot, label, job); return }
    console.info('[C4] 槽位 ' + slot + ' 目的地 = ' + destId + ' @ ' + Math.round(outer.x) + ',' + Math.round(outer.y) + ',' + Math.round(outer.z))

    let n = c4Retarget(server, cur.x, cur.y, cur.z, destKey,
      Number(outer.x), Number(outer.y), Number(outer.z), true, destId,
      (info && info.cube && info.cube.id) ? info.cube.id : ('cube' + slot))
    if (n === 0) c4TellTeam(server, slot, c4t('cw.warp.aim_fail'))
    // 目标侧造反向门（走回去用）
    try {
      c4MakeReverse(server, slot, destId, Number(outer.x), Number(outer.y), Number(outer.z), (info && info.cube && info.cube.id) ? info.cube.id : ('cube' + slot))
    } catch (e) { console.warn('[C4] 反向门创建异常: ' + e) }
    // 种子已经算好，趁 pre_runtime=215 清零之前读出来
    try { job.seed = c4SeedOf(server, slot) } catch (e) {}

    // v4 不再需要 unfold 的 *_outer marker
    ;['y_outer', '-y_outer', 'x_outer', '-x_outer', 'z_outer', '-z_outer'].forEach(tg => {
      server.runCommandSilent(`kill @e[type=marker,tag=${tg}]`)
    })
  })

  // ⑤ t=220 收尾
  server.scheduleInTicks(C4_T_END, () => c4WarpEnd(server, slot, label, job))
}

function c4WarpEnd(server, slot, label, job) {
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
  let sd = (job && job.seed !== undefined && job.seed !== null) ? job.seed : '?'
  c4TellTeam(server, slot, c4t2('cw.warp.done', label, sd))
  if (C4_Q.length > 0) c4TellTeam(server, slot, c4t1('cw.warp.queue_left', C4_Q.length))
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
  clicker.tell(c4t1('cw.button.queued', C4_Q.length + (C4_BUSY ? 1 : 0)))
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
    let names = ['cwp', 'cube']
    for (let i = 0; i < names.length; i++) {
      let root = cmdRoot.literal(names[i]).requires(src => true)
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
      x, C4_CORE_Y, C4_Z, false, 'hexahedron:bedrock_bottom', idName)
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

// ---------------------------------------------------------------------------- 启动
ServerEvents.loaded(event => {
  let server = event.server
  c4Db(); c4LoadState(); c4Ftb()
  c4SaveState()

  // 旧存档：给出生点那台 core 补身份 tag（幂等；原包只认 core，所以两个都留）
  server.runCommandSilent('tag @e[type=marker,tag=core] add cw_core')
  server.runCommandSilent('tag @e[type=marker,tag=core] add cw_slot0')
  server.runCommandSilent('tag @e[type=marker,tag=core] add cw_id_lobby')

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
