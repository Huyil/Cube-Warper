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
//             找地表 + 重建"镜像笼子"（fill structure_void / light / 17x17）
//    KubeJS = 门指向 / 反向门 / 可见性 / 玩家传送 / 区块加载 / 槽位·大厅·队列
// =============================================================================================

// ---------------------------------------------------------------------------- 常量
const C4_SPACING = 4000           // 槽位间距（格）
const C4_X0 = 8                   // 槽位 1.. 的 x 基准偏移：让 17 格立方体近似落在区块中心
const C4_Z = 0
const C4_BASE_Y = 100.5           // 基地 17x17 构建基准（地板 y=97，站立 y=98）——S2 起只当"基地"用
const C4_CORE_Y = 105.5           // 基地核心（基地不再承载跃迁：按钮/操控台/门都搬去传送器）
// ── S2：传送器舱（17³）几何 ─────────────────────────────────────────────
// 底面 y=16、顶面 y=32、核心 y=24.5；x/z 与基地同（c4CubeX(slot), C4_Z）。
// 唯一真源是【启动按钮方块坐标】c4BtnPos(slot)，其余全部由它派生（不再"中心→面板→算子"链式推）。
const C4_TELE_FLOOR = 78          // 传送器默认底面 y（21³ 外壳 76..96，舱体 78..94，顶面 95；不碰基地地板 97）
const C4_TELE_Y = C4_TELE_FLOOR + 8.5   // 传送器核心 y = 18.5
const C4_TELE_HALF = 8.5          // 核心到地板/顶面
const C4_BASE_FLOOR = 97          // 基地默认底面 y（C4_CORE_Y - 8.5）
// 门面：原包就是「17×17、平面在开口外 0.01」。之前改成 16.98/内缩 0.06 后，
// 门面比开口小一圈又退进去 0.06，站在立方体里能沿门框看到一条 1px 的外部像素 → 现在改回贴平面。
const C4_DEST_FACE = 8.0          // 目的地平面 = 门面本身
const C4_HALF = 7.9
// 这些范围现在指【传送器内部】
const C4_Y_MIN = C4_TELE_Y - C4_TELE_HALF      // 10.0
const C4_Y_MAX = C4_TELE_Y + C4_TELE_HALF      // 27.0
// 立方体登记跟着【存档】走（world/），不要放 config/：删档 = 重新开始，不会带着幽灵立方体
const C4_CFG = 'world/cubarper-cubes.json'
const C4_STATE_PATH = 'world/cubarper-state.json'
const C4_DEST_MIN_SEP = 1200   // 必须 > 1000：原包 hex_anchor 的复用半径是 1000，小于它就会偷到别人的落点
const C4_DEST_NUDGE = 1024     // 撞车 → 单调外移（+x 方向，第 i 次偏移 i*1024）
const C4_DEST_JITTER = 768     // 兼容旧代码的旧参数（新逻辑走下面的环形随机）
const C4_DEST_RMIN = 640       // 首次/原地随机传送：离本台的最小距离（>600 格）
const C4_DEST_RMAX = 1600      // 首次/原地随机传送：最大距离（再大区块生成太慢）
// 门面边长：立方体 17 格里，四周框梁各占 1 格 → 真正的开口只有 15×15。
// 门做成 15×15 正好嵌在开口内（门边=框梁内侧面），侧面不会再压着框梁；
// 反向门由 IP 从正向门复制尺寸，重建正向门后必须一起重建反向门。
// ⚠ 实测：isVisible(false) 会把传送一起关掉（物品会直接穿过这扇门掉到下面那扇 17×17 门去），
//   所以 3×3 连接门必须保持可见；"看不到对面"只能靠别的方式（例如把它做深一点/只留一个洞口）。
const C4_LINK_RENDER = true        // 3×3 连接门是否渲染（false 会同时关闭传送，不要用）
const C4_PORTAL_SPAN = 15.0
// 剧场版时序：t=80 先指门 → 等这么多 tick（黑场：旅行音 + 三次排气）→ 再建目的地房间
const C4_PLANE_WAIT = 140   // 黑场窗口 = 140t（7s）：原包临界值是「指门后 ~78t 客户端才卸完旧世界」，
                            // 这里留 140t 余量，专门防客户端 ClientWorldLoader 并发崩溃；想更保险可加到 200

// ⚠ KubeJS 的 Rhino 里 Math.PI / Math.E 是 undefined（Math 只有方法，没有常量）→ 必须用字面量。
// 以前 c4Seat 里写 Math.PI：a 算出 NaN → 座位 x/z 全 NaN → 玩家被传到 (NaN,NaN)。
const C4_PI = 3.141592653589793

let C4_RL = null
let C4_J = {}
let C4_FTB = { tried: false, api: null, ok: false }
let C4_DB = null
// ⚠ 世代守卫：/reload 会新建脚本上下文，但【上一世代】排进 scheduleInTicks 的回调仍持着旧 C4_DB。
// 它们一旦写库，就会用旧数据覆盖新世代刚写的内容（表现：ext 永远从旧值开始、扩不上去）。
// 每次脚本加载时 +1；所有会写库/动方块的延迟回调都在开头比对，旧世代直接 return。
let C4_GEN = 1
try { C4_GEN = (Number(global.C4_GEN) || 0) + 1; global.C4_GEN = C4_GEN } catch (eGen) {}
let C4_Q = []
let C4_BUSY = null
let C4_STATE = { worldStarted: false }
let C4_WARNED = {}

// ---------------------------------------------------------------------------- Java 类
function c4Cls(name) {
  if (!C4_J[name]) C4_J[name] = Java.loadClass(name)
  return C4_J[name]
}
function c4Iat() { return c4Cls('com.mojang.brigadier.arguments.IntegerArgumentType') }
function c4Vec(x, y, z) { return new (c4Cls('net.minecraft.world.phys.Vec3'))(x, y, z) }
function c4PortalAPI() { return c4Cls('qouteall.imm_ptl.core.api.PortalAPI') }
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
// ── S2：传送器锚点（唯一真源 = 启动按钮方块）──────────────────────────────
// DB 里 cube.tele 记的是【底面方块坐标】(x, floorY, z)；按钮 = (x, floorY+1, z+7)。
// 没有登记时退回默认位置：x/z 跟基地同，floor=C4_TELE_FLOOR。
// 按钮锚点：DB 里的 cube.btn 是唯一真源（/cube admin bind 写入）。
// 没绑定的老存档：用旧逻辑由中心推出的按钮位置 (cubeX, 98, 7) 当默认值 → 10 台不用迁移。
function c4BtnPos(slot) {
  let b = null
  try { let h = c4TeamOfSlot(slot); if (h && h.cube && h.cube.btn) b = h.cube.btn } catch (e) {}
  if (b && b.x !== undefined && b.y !== undefined && b.z !== undefined) {
    return { x: Math.floor(Number(b.x)), y: Math.floor(Number(b.y)), z: Math.floor(Number(b.z)) }
  }
  return { x: Math.floor(c4CubeX(slot)), y: Math.floor(C4_TELE_FLOOR) + 1, z: Math.floor(C4_Z) + 7 }
}
// 兼容旧调用：anchor = 按钮对应的"地板基准" (btn.y-1, btn.z-7)
function c4TeleAnchor(slot) {
  let b = c4BtnPos(slot)
  return { x: b.x, y: b.y - 1, z: b.z - 7 }
}
// ── 基地锚点：旧立方体（住人/可扩展），默认仍在地面 y=97 ──────────────────
// DB 里 cube.base 是唯一真源（老存档没有 → 退回默认 (cubeX, 97, 0)）。
function c4BaseAnchor(slot) {
  try {
    let h = c4TeamOfSlot(slot)
    let b = h && h.cube && h.cube.base
    if (b && b.x !== undefined && b.y !== undefined && b.z !== undefined) {
      return { x: Math.floor(Number(b.x)), y: Math.floor(Number(b.y)), z: Math.floor(Number(b.z)) }
    }
  } catch (e) {}
  return { x: Math.floor(c4CubeX(slot)), y: C4_BASE_FLOOR, z: Math.floor(C4_Z) }
}
function c4BaseCore(slot) {
  let a = c4BaseAnchor(slot)
  return { x: a.x + 0.5, y: a.y + 8.5, z: a.z + 0.5 }
}
// 启动按钮方块坐标：面板/算子位/舱体 box/门面全部从它派生
// 舱体核心（门面/房间用）：按钮在 +z 内壁 y=btn.y 处 → 中心 = (btn.x+0.5, btn.y+7.5, btn.z-6.5)
function c4TeleCore(slot) {
  let b = c4BtnPos(slot)
  return { x: b.x + 0.5, y: b.y + 7.5, z: b.z - 6.5 }
}
function c4InCube(p, slot) {
  if (c4DimOf(p) !== 'minecraft:overworld') return false
  let b = c4BtnPos(slot)
  let cx = b.x + 0.5, cz = b.z - 6.5
  return Math.abs(p.x - cx) <= C4_HALF && Math.abs(p.z - cz) <= C4_HALF
         && p.y >= b.y - 1 && p.y <= b.y + 15
}
// 按【当前 ext 真实尺寸】判定：同维度 + 在房间 box 内，tol=容差。
// 收尾召回只认这个范围 —— 走出舱体/去别的维度的人一律不动（否则会被强行拉回主世界）。
function c4InCubeExt(p, slot, ext, tol) {
  if (c4DimOf(p) !== 'minecraft:overworld') return false
  let t = Number(tol) || 0
  let bp = c4BtnPos(slot)
  let b = c4RoomBox(bp.x + 0.5, bp.y + 7.5, bp.z - 6.5, ext || {})
  return p.x >= b.X0 - t && p.x <= b.X1 + 1 + t &&
         p.z >= b.Z0 - t && p.z <= b.Z1 + 1 + t &&
         p.y >= b.Y0 - t && p.y <= b.Y1 + 1 + t
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
  let want = c4CubeX(slot)
  let fallback = null
  // 优先"槽位 tag 对得上、坐标也在这个槽位的立方体范围内"的核心：
  // 历史数据里出现过别的槽位位置上带着 cw_slotN 的假 core，只按 tag 找会拿错坐标（门被指到别的台）。
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].slot !== Number(slot)) continue
    if (Math.abs(arr[i].x - want) <= 32) return arr[i]
    if (!fallback) fallback = arr[i]
  }
  return fallback
}
// 按钮归属：只按"按钮坐标是否落在某台传送器范围内"判定。
// S2 起 C4_Y_MIN/C4_Y_MAX = 传送器 y 16~33：基地 y96~114 的旧按钮一律返回 null（不再触发跃迁/领车）。
// x/z 半宽 8.6 覆盖内壁 ±8.3875。
function c4SlotForButton(bx, by, bz) {
  // 出生大厅固定 x=0（原包那台，仍在 y97~113 的基地区）
  if (by >= 96 && by <= 114 && Math.abs(bx) <= 8.6 && Math.abs(bz - C4_Z) <= 8.6) return 0
  // 其余：按各台【按钮锚点派生的 17³ 盒】判定（bind 后旧位置的按钮自然失效）
  let db = null
  try { db = c4Db() } catch (e) { db = null }
  let cubes = (db && db.cubes) ? db.cubes : {}
  for (let k in cubes) {
    let c = cubes[k]
    if (!c || !c.provisioned) continue
    let b = c4BtnPos(Number(c.slot))
    let cx = b.x + 0.5, cz = b.z - 6.5
    if (Math.abs(bx - cx) <= 8.6 && Math.abs(bz - cz) <= 8.6 && by >= b.y - 1 && by <= b.y + 15) return Number(c.slot)
  }
  // 旧存档兜底：只按 y 轴判断（旧按钮在基地层 y=98；新按钮在 y=11），z 不再写死 7
  if (by === C4_BASE_FLOOR + 1) {
    for (let k in cubes) {
      let c = cubes[k]
      if (!c || !c.provisioned) continue
      if (Math.abs(bx - c4CubeX(Number(c.slot))) <= 1) return Number(c.slot)
    }
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
// KubeJS 2001.6.5 的 JsonIO.read 会把 JSON 里所有原始值都包成 Gson LazilyParsedNumber
// （连 "01" 这种字符串也会被当成数字），直接 JsonIO.write 回去时 Gson 报
// "not a valid JSON number: 01" 并把库文件写成半截。所以读进来后立刻归一化成 JS 原始值：
//   · 规范 JSON 数字文本（4008 / -1 / 1.5）→ Number
//   · 其余（"01"、队名、维度 id、uuid…）→ String
//   · 列表 → JS 数组，映射 → 普通对象
// 存档从此只含 JS 原始值；c4Save 再兜底归一化一次，避免外部塞进来的包装对象。
function c4Norm(v) {
  if (v === null || v === undefined) return v
  let t = typeof v
  if (t !== 'object') return v
  let cn = ''
  try { cn = String(v.getClass().getName()) } catch (e) {}
  if (cn === 'com.google.gson.internal.LazilyParsedNumber') {
    let str = String(v)
    return /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(str) ? Number(str) : str
  }
  if (cn === 'java.lang.String') return String(v)
  if (cn === 'java.lang.Boolean') return Boolean(v)
  if (Array.isArray(v)) {
    let a = []
    for (let i = 0; i < v.length; i++) a.push(c4Norm(v[i]))
    return a
  }
  let o = {}
  for (let k in v) { try { o[k] = c4Norm(v[k]) } catch (e) {} }
  return o
}
function c4Db() {
  if (C4_DB) return C4_DB
  let d = null
  try { d = c4Norm(JsonIO.read(C4_CFG)) } catch (e) { d = null }
  // ⚠ 不再从 config/ 旧位置自动迁移：删档后会把幽灵立方体（旧 config 里的 3 台）重新灌回新世界。
  // 真要迁移老存档，手动把 config/cubarper-cubes.json 复制到 world/ 即可。
  if (!d || typeof d !== 'object') d = {}
  if (d.nextSlot === undefined) d.nextSlot = 1
  if (!d.cubes || typeof d.cubes !== 'object') d.cubes = {}
  if (d.requireParty === undefined) d.requireParty = true
  d._comment = '键 = FTB 队伍 UUID；slot 决定坐标 (slot*spacing, ?, z)。slot 0 = 出生点大厅/领车台。'
  C4_DB = d
  return d
}
function c4Save() { try { JsonIO.write(C4_CFG, c4Norm(c4Db())) } catch (e) { console.error('[C4] 写库失败 ' + e) } }
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
      server.runCommandSilent('execute in ' + dimId + ' positioned ' + bx + ' ' + by + ' ' + bz + ' run fill ~-1 ~-3 ~-1 ~1 ~-3 ~1 minecraft:structure_void')
      console.info('[C4] 目的地笼子补建 @' + bx + ',' + by + ',' + bz + ' dim=' + dimId)
    } catch (e) { console.warn('[C4] 目的地笼子补建失败: ' + e) }
  })
  job.dest = { dim: dimId, x: x, y: y, z: z, cx: cx, cz: cz }
  console.info('[C4] 目的地最终预载 dim=' + dimId + ' @' + x + ',' + y + ',' + z + '（区块 ' + cx + ',' + cz + '）')
}

// 把 6 扇门指到 destCenter（目标维度 level）。ext 必须传：扩展过的门面会外移 16*n、
// 门面中心会随房间几何中心平移 8*n，用固定 ±8.51 会把第二次扩展的门又拽回去。
// S1：门的定位改为按 cw_face_* tag（slot 用于补 cw_team_*/cw_slot*，onlyDir 用于单面调试）
function c4Retarget(server, cx, cy, cz, destKey, dx, dy, dz, withReverse, destId, idName, ext, moveSrc, slot, onlyDir) {
  if (!destKey) { console.error('[C4] retarget: destKey 为空'); return 0 }
  // S4：门的源/目标坐标全部由 c4FacePos 推导（ext 感知）；目的地固定 17³ → ext0
  let extZ = { px: 0, nx: 0, pz: 0, nz: 0, py: 0 }
  let srcPos = {}, dstPos = {}
  ;['y', '-y', 'x', '-x', 'z', '-z'].forEach(dd => {
    let sp = c4FacePos(cx, cy, cz, ext, dd)
    let dp = c4FacePos(dx, dy, dz, extZ, dd)
    srcPos[dd] = [sp.x, sp.y, sp.z]
    dstPos[dd] = [dp.x, dp.y, dp.z]
  })
  let done = 0
  // S1：不再按 ±8.51 几何猜门 —— 先把 tag 补齐（老门按几何 + cw_id_ 推断，幂等），再按 cw_face_* 找门
  try { c4SyncDoorTags(server, 'minecraft:overworld', cx, cy, cz, ext, slot, idName, false, 96) }
  catch (e) { console.warn('[C4] retarget 前打 tag 失败: ' + e) }
  let own = []
  c4PortalsInDim(server, 'minecraft:overworld', cx, cy, cz, 96).forEach(e => {
    try {
      if (c4HasTag(e, 'cw_lobby')) return
      let d = c4FaceOf(e)
      if (!d || !srcPos[d]) return
      if (onlyDir && d !== onlyDir) return
      own.push(e)
    } catch (err) {}
  })
  if (own.length === 0) console.warn('[C4] retarget: 没找到门 @ ' + cx + ',' + cy + ',' + cz)
  own.forEach(e => {
    let d = c4FaceOf(e)
    let sp = srcPos[d], dp = dstPos[d]
    // 只有【扩展/拆除】才挪主世界的门；跃迁只改 destination，主世界的门必须原地不动
    if (moveSrc) {
      try {
        e.setOriginPos(c4Vec(sp[0], sp[1], sp[2]))
        e.setPos(sp[0], sp[1], sp[2])
      } catch (e2) { console.warn('[C4] 门面落位失败 ' + d + ': ' + e2) }
    }
    let pos = c4Vec(dp[0], dp[1], dp[2])
    if (!c4ApplyPortal(server, e, destId, destKey, pos, cx, cy, cz)) {
      console.error('[C4] retarget 失败 dir=' + d)
      return
    }
    try { e.setIsVisible(true); c4Sync(e) } catch (e3) { console.warn('[C4] show: ' + e3) }
    done++
  })
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
  let bp = c4BtnPos(slot)
  let cx = bp.x + 0.5, cz = bp.z - 6.5
  let by = bp.y
  // 落点抬高 1 格：新建立方体是异步建造的（forceload 20 tick + 建房间），
  // 传送太早/贴地会被卡进未建好的地板，甚至直接掉进虚空。
  if (n <= 1) return { x: cx, y: by + 1.0, z: cz + 6.0 }
  let r = n <= 4 ? 2.6 : (n <= 8 ? 3.6 : 5.0)
  let a = (2 * C4_PI * i) / n - C4_PI / 2
  return { x: cx + Math.cos(a) * r, y: by + 0.5, z: cz + Math.sin(a) * r }
}
// 家（/cube home）落点：传送器按钮正前方 3 格、离地 1 格（脚踩地板，y = 地板方块 +1）。
// 按钮统一 facing=north（各处 setblock 都是 north），玩家按它时站在 -z 一侧 → 「前方」= -z。
// 用按钮派生而不是基地锚点：传送器搬下去（旧存档迁移 / relocate）后自动跟着走。
// 没登记 btn 的（旧存档还没按按钮迁移的 13 台）保持原行为回基地，避免把人丢进还没建好的 y=10 空腔。
function c4HomeSeat(slot) {
  let h = null
  try { h = c4TeamOfSlot(slot) } catch (e) { h = null }
  let b = h && h.cube && h.cube.btn
  if (!b || b.x === undefined || b.y === undefined || b.z === undefined) return c4BaseSeat(slot, 0, 1)
  let bp = c4BtnPos(slot)
  return { x: bp.x + 0.5, y: bp.y, z: bp.z - 3.0 + 0.5 }
}
function c4BaseSeat(slot, i, n) {
  let a = c4BaseAnchor(slot)
  let cx = a.x + 0.5, cz = a.z + 0.5
  if (n <= 1) return { x: cx, y: a.y + 1.0, z: cz + 5.0 }
  let r = n <= 4 ? 2.6 : (n <= 8 ? 3.6 : 5.0)
  let an = (2 * C4_PI * i) / n - C4_PI / 2
  return { x: cx + Math.cos(an) * r, y: a.y + 1.0, z: cz + Math.sin(an) * r }
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

  // cb_make_portal 不带方向 tag：S1 起统一由 c4SyncDoorTags 按几何推断方位，
  // 一次性打齐 cw_face_*/cw_team_*/cw_slot*/cw_id_* 并按面去重（幂等，老存档也能补）。
  let synced = { total: 0, killed: 0, faces: {} }
  try { synced = c4SyncDoorTags(server, 'minecraft:overworld', cx, cy, cz, c4Ext((c4TeamOfSlot(slot) || {}).cube), slot, idName, false, 96) }
  catch (e) { console.warn('[C4] 建门后打 tag 失败: ' + e) }
  console.info('[C4] 建门 tag 同步 slot' + slot + '：' + synced.total + ' 扇，faces=' + c4FaceSummary(synced.faces))
  return synced.total
}

// 反向门交给 IP 自己：portal complete_bi_way_portal。
// IP 按 createReversePortal 的规则在 destPos 生成另一侧（axisW 取反、parallelPortalId 互链、cluster 归属），
// 和手写 NBT summon 出来的门不是一回事。
function c4MakeReverse(server, slot, dimId, dx, dy, dz, idName) {
  let hs = c4TeamOfSlot(slot)
  let ext = c4Ext(hs && hs.cube ? hs.cube : null)
  // 先清掉落点附近的旧反向门：complete_bi_way_portal 只增不删，重建几次就会叠出 6×N 扇
  try {
    server.runCommandSilent('execute in ' + dimId + ' positioned ' + dx + ' ' + dy + ' ' + dz + ' run kill @e[type=immersive_portals:portal,distance=..100,tag=!cw_lobby]')
  } catch (e) { console.warn('[C4] 清旧反向门失败: ' + e) }
  // ⚠ 只对【6 面门】造反向门：3×3 连接门（cw_link*）也是 cw_id_ 成员，
  //   对它 complete_bi_way_portal 会在落点凭空生出一扇 3×3 反向门，
  //   随后被 c4SyncDoorTags 按几何误标成 cw_face_*，去重时反而把真正的顶/底门顶掉。
  try {
    server.runCommandSilent('execute as @e[type=immersive_portals:portal,tag=cw_id_' + idName
      + ',tag=!cw_link,tag=!cw_link_up,tag=!cw_link_down,tag=!cw_face_link,tag=!cw_face_link_base] at @s run portal complete_bi_way_portal')
  } catch (e) { console.warn('[C4] complete_bi_way_portal 失败: ' + e) }
  // S1：IP 异步造门 —— complete 直后通常还看不到门，所以 tag 必须过几 tick 再补，不能在这里立刻打。
  // 分 5/15/40/80/120 tick 轮询：门出现后补 cw_face_*/cw_team_*/cw_slot*/cw_id_*/cw_rev_*，并按面去重。
  // ⚠ 不能先 setIsVisible(false)（之后 KubeJS 枚举不到门，tag 就永远打不上）。
  let tries = [5, 15, 40, 80, 120]
  tries.forEach((t, i) => {
    server.scheduleInTicks(t, () => {
      try {
        let synced = c4SyncDoorTags(server, dimId, dx, dy, dz, ext, slot, idName, true, 120)
        let missing = 0
        for (let k = 0; k < C4_FACE_DIRS.length; k++) {
          if (!synced.faces[C4_FACE_DIRS[k]]) missing++
        }
        // 一扇都没造出来（区块刚加载/IP 漏了）→ 再 complete 一次补造；已经有门就绝不重复，避免叠门
        if (missing > 0 && synced.total === 0 && i >= 1) {
          server.runCommandSilent('execute as @e[type=immersive_portals:portal,tag=cw_id_' + idName
            + ',tag=!cw_link,tag=!cw_link_up,tag=!cw_link_down,tag=!cw_face_link,tag=!cw_face_link_base] at @s run portal complete_bi_way_portal')
          console.warn('[C4] 反向门仍为 0 → 再 complete 一次（' + t + 't）')
        }
        if (missing === 0 || i === tries.length - 1) {
          console.info('[C4] 反向门 tag 同步 ' + dimId + '：' + synced.total + ' 扇，去重 ' + synced.killed
            + '，faces=' + c4FaceSummary(synced.faces))
        }
      } catch (e) { console.warn('[C4] 反向门 tag 同步失败: ' + e) }
    })
  })
  return 0
}

function c4ProvisionBody(server, slot, teamName, idName) {
  let x = c4CubeX(slot)
  // 幂等：清掉这一格附近的旧门/旧 marker（此时区块已加载，kill 才会命中）
  server.runCommandSilent(`execute in minecraft:overworld positioned ${x} ${C4_CORE_Y} ${C4_Z} run kill @e[type=immersive_portals:portal,distance=..30,tag=!cw_lobby]`)
  server.runCommandSilent(`kill @e[type=marker,tag=cw_p${slot}]`)
  server.runCommandSilent(`kill @e[type=marker,tag=cw_slot${slot}]`)

  // ★ 整块清空：把 19×21×19 的立方体体积全部变空气
  //   原因：structure_void（原 hexahedron_filling） 只是"生成瞬间遮住主世界"的临时遮挡；
  //   不清掉的话玩家进舱后会被一层隐形方块包住（看起来就是一堵"屏障"），
  //   而且目标坐标若有地形/旧外壳残留也会卡在里面。清空后由 17x17 重建外壳+地板+面板+按钮。
  //   19×21×19 = 7581 格，远低于 fill 上限 32768。
  server.runCommandSilent(
    `execute in minecraft:overworld positioned ${x} ${C4_BASE_Y} ${C4_Z} run fill ~-9 ~-5 ~-9 ~9 ~14 ~9 air`)
  c4ChunkLoader(server, slot)

  // 1) 外壳/地板/面板/按钮/排气口（在刚清空的体积里重建；17x17 里的 structure_void 只补地板 3×3 洞）
  server.runCommandSilent(`execute positioned ${x} ${C4_BASE_Y} ${C4_Z} run function hexahedron:build_hexahedron/17x17`)
  // 1.4) 隐藏光源（基地这间也要，否则对比目的地副本会明显偏暗）
  try {
    server.runCommandSilent('execute in minecraft:overworld run setblock ' + x + ' ' + (Math.round(C4_BASE_Y) - 5 + 8) + ' ' + C4_Z + ' minecraft:light[level=15]')
    console.info('[C4] 基地隐藏光源 @' + x + ',' + (Math.round(C4_BASE_Y) - 5 + 8) + ',' + C4_Z)
  } catch (eL) {}
  // 1.5) 把 3×3 地板洞下方那格 structure_void 之外的残余再清一次内部（保险）
  server.runCommandSilent(`execute in minecraft:overworld positioned ${x} ${C4_BASE_Y} ${C4_Z} run fill ~-7 ~-2 ~-7 ~7 ~12 ~7 air replace minecraft:structure_void`)
  // 1.6) 外壳（贴着框梁外表面那一格）整体替换成 structure_void —— 与 c4BuildRoom(false) 同一套几何，
  //      17x17 只负责房间内部，外层在这里补，门边才不会和框梁 z-fighting。
  if (Number(slot) > 0) {
    try {
      c4ShellFill(server, 'minecraft:overworld', c4RoomBox(x + 0.5, C4_CORE_Y, C4_Z + 0.5, { px: 0, nx: 0, pz: 0, nz: 0, py: 0 }), 'minecraft:structure_void')
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
        server.runCommandSilent('execute in ' + CAGE + ' positioned ' + MX + ' ' + (C4_CORE_Y - 5) + ' ' + MZ + ' run fill ~-1 ~-3 ~-1 ~1 ~-3 ~1 minecraft:structure_void')
        // 目的地外壳清成 air（与 c4BuildRoom(true) 一致：目的地不放 filling）
        try { c4ShellFill(server, CAGE, c4RoomBox(MX, C4_CORE_Y, MZ, { px: 0, nx: 0, pz: 0, nz: 0, py: 0 }), 'minecraft:air') } catch (e) {}
        console.info('[C4] 槽位 ' + slot + ' 起点笼子已建 @' + MX + ',105.5,' + MZ + ' dim=' + CAGE)
      } catch (e) { console.warn('[C4] 起点笼子建造失败: ' + e) }
      let made = c4Retarget(server, MX, C4_CORE_Y, MZ, c4DimKey(CAGE), MX, C4_CORE_Y, MZ, false, CAGE, idName, { px: 0, nx: 0, pz: 0, nz: 0, py: 0 }, true, slot)
      try { c4MakeReverse(server, slot, CAGE, MX, C4_CORE_Y, MZ, idName) } catch (e) { console.warn('[C4] 起点反向门失败: ' + e) }
      console.info('[C4] 槽位 ' + slot + ' 初次指门完成 = ' + made + ' 扇 → ' + CAGE)
    })
  })

  // 7) forceload 常驻（不要撤销，见上面的注释）

  // 8) S2：新舱 = 基地（住人）+ 传送器（跃迁机器）。等基地/门都建好后错峰建传送器，再 strip 基地按钮
  server.scheduleInTicks(80, () => {
    try {
      let a = c4TeleAnchor(slot)
      c4BuildTeleporter(server, slot, a)
      let h2 = c4TeamOfSlot(slot)
      if (h2 && h2.cube) { h2.cube.tele = { x: a.x, y: a.y, z: a.z }; c4Save() }
      c4StripCabin(server, slot, true)
      // 3×3 洞不自动生成：由玩家手持扩展器朝下右键二次确认（或 /cube admin hole）才建
      console.info('[C4] 新舱迁移完成 slot' + slot + '：传送器 @' + a.x + ',' + a.y + ',' + a.z + '（按钮 ' + a.x + ',' + (a.y + 1) + ',' + (a.z + 7) + '），基地按钮已清')
    } catch (e) { console.warn('[C4] 新舱传送器迁移失败: ' + e) }
  })
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
  13: 'hexahedron:dusk_islands', 14: 'hexahedron:endless_rainbows', 16: 'hexahedron:blood_ocean',
  17: 'hexahedron:forsaken_planes', 18: 'hexahedron:silver_forest', 24: 'hexahedron:the_sugarscape',
  32: 'hexahedron:the_azurewood', 36: 'hexahedron:soul_valley', 48: 'hexahedron:the_umbral_sea',
  64: 'hexahedron:carrion_485', 72: 'hexahedron:gronglegrowth', 96: 'hexahedron:lavender_fields',
  128: 'hexahedron:alpha_islands',
  // 原包 ticket_selection 的两个特殊分支：eye = 999.. → the_edge_of_reality，infinite = ..-999 → overworld
  999: 'hexahedron:the_edge_of_reality',
  '-999': 'minecraft:overworld'
}

// 固定落点 core y（仅用于「高度图不可用 / 没有连续地表 / 天花板世界」的维度；
// 其余维度一律按局部真实地表 +9 —— 见 c4ResolveY）。
// 单位 = 方块 y，代表立方体核心（门面中心）；房间 = y-8 .. y+8，站立面 y-7。
const C4_DIM_Y = {
  'hexahedron:magnetic_ceiling': 40,       // 天花板世界：0..~45 是空腔，原包 ticket 固定 40.5
  'hexahedron:stacked_rocks': 58,          // 原包 under_50（under 51）+ 8.5
  'hexahedron:dark_rocks': 100,            // 无连续地表（浮岛）
  'hexahedron:carrion_485': 162,
  'hexahedron:the_sugarscape': 133,
  'hexahedron:forsaken_planes': 134,
  'hexahedron:lavender_fields': 134,
  'hexahedron:the_edge_of_reality': 100,   // flat 97 层 nothing，不阻挡 motion
  'minecraft:overworld': 100               // 256 层 filling，靠 fill 挖房间，必须保持 100
}

// ---------------------------------------------------------------------------- 三格插槽（原包 runtime_effects）
// 台面（warping_controls/interface/disc_drive）在 y=98，算子方块坐在它上面一格 y=99，z=+8。
// 原包读取/消耗顺序（pre_runtime=20/40/60）：x=+1（界面）→ x=0（控制台）→ x=-1（光盘驱动器）。
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
function c4SlotX(slot, i) { return c4BtnPos(slot).x + i }   // 算子位由按钮坐标派生
// 操控台贴着 +z 内壁（Z1）：基础 z=8。
// 注意：+z 面不可扩展（cw_expand 的 cmdExpand 明确拒绝 "+z 是操控台"），所以 Z1 永远 = 8；
// 这里的偏移必须用 pz、不能是 nz —— 之前写 nz 会让 -z 每扩一级把读位往 +z 推 16 格，
// 而操控台根本没动，于是算子全读成空气、种子恒为 0，跃迁起不来。
function c4SlotZ(slot) {
  // 算子位贴着 +z 内壁 = 按钮 z + 1
  return Math.floor(c4BtnPos(slot).z + 1)
}
// 算子层 y = 按钮 y + 1
function c4SlotY(slot) { return Math.floor(c4BtnPos(slot).y + 1) }
// 读一格插槽：返回 {id, key, op}；op 只覆盖 #kubejs:vector 的 8 个成员
function c4OpAt(server, slot, i) {
  let lv = c4OwLevel(server)
  let id = ''
  if (lv) { try { id = String(lv.getBlock(c4SlotX(slot, i), c4SlotY(slot), c4SlotZ(slot)).id) } catch (e) { id = '' } }
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
  let at = 'execute in minecraft:overworld positioned ' + (x + 0.5) + ' ' + (c4SlotY(slot) + 0.5) + ' ' + (c4SlotZ(slot) + 0.5) + ' run '
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
// 维度显示名（中文；没有就退回 id 末段）
const C4_DIM_NAMES = {
  'hexahedron:hexahedron_graveyard': '墓园',
  'hexahedron:dry_ocean': '干涸之海',
  'hexahedron:stacked_rocks': '叠石',
  'hexahedron:copper_remains': '铜之遗骸',
  'hexahedron:dark_rocks': '暗岩',
  'hexahedron:toxic_caves': '毒洞',
  'hexahedron:magnetic_ceiling': '磁力天穹',
  'hexahedron:endless_hoard': '无尽藏',
  'hexahedron:pine_forrest': '松林',
  'hexahedron:magma_plateau': '岩浆高原',
  'hexahedron:brimstone_veil': '硫磺帷幕',
  'hexahedron:snowstorm': '暴风雪',
  'hexahedron:dusk_islands': '暮色群岛',
  'hexahedron:endless_rainbows': '无尽虹',
  'hexahedron:blood_ocean': '血海'
}
function c4DimName(id) {
  let s = String(id || '')
  if (C4_DIM_NAMES[s]) return C4_DIM_NAMES[s]
  let i = s.indexOf(':')
  return i >= 0 ? s.substring(i + 1) : s
}
function c4TravelText(job) {
  let q = C4_Q.length
  let seed = (job && job.seedShown !== undefined) ? job.seedShown : 0
  let name = (job && job.dimShown) ? String(job.dimShown) : null
  return (q > 0 ? ('排队 ' + q + ' · ') : '') + (name ? ('正在前往 ' + name) : ('正在前往 seed #' + seed))
}
// 给队伍发动作条（拿不到动作条就退回聊天）
function c4BarTeam(server, slot, msg) {
  try {
    let hs = c4TeamOfSlot(slot)
    let team = hs ? c4TeamByKey(hs.key) : null
    if (!team) return
    c4TeamOnline(team).forEach(m => {
      try { m.displayClientMessage(Text.of(msg), true) } catch (e) { try { m.tell(Text.of(msg)) } catch (e2) {} }
    })
  } catch (e3) {}
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
// 以本台为圆心、随机角度、半径 [RMIN,RMAX] 的落点偏移（保证"传送 >600 格远"且方位均匀）
function c4RandDestOffset() {
  let ang = Math.random() * 2 * C4_PI
  let r = C4_DEST_RMIN + Math.random() * (C4_DEST_RMAX - C4_DEST_RMIN)
  return { x: Math.round(Math.cos(ang) * r), z: Math.round(Math.sin(ang) * r) }
}
// 已经算出 seed 时用它选目的地（消耗是逐 tick 的，t=60 的最终 seed 才是权威值）
function c4PickDestForSeed(server, slot, seed) {
  let dim = C4_SEED_DIMS[seed] || C4_SEED_DIMS[0]
  if (!C4_SEED_DIMS[seed]) console.warn('[C4] 未知 seed=' + seed + '，回退 seed 0（graveyard）')
  console.info('[C4] 槽位 ' + slot + ' 运算符 seed=' + seed + ' → ' + dim)
  let off = c4RandDestOffset()
  let x = c4CubeX(slot) + off.x
  let z = C4_Z + off.z
  // 注意：这里【不再】读 heightmap 定 y。此刻目标区块八成还没加载，getHeight 会返回 0，
  // 于是回退 y=100 —— 那正是"浮空 / 埋进基岩"的老 bug。y 只作占位/日志，
  // 真正取值在 perform() 里（forceload 之后）由 c4ResolveY 决定。
  let y = (C4_DIM_Y[dim] !== undefined) ? Number(C4_DIM_Y[dim]) : 100
  return { dim: dim, x: x, y: y, z: z, seed: seed }
}

// 最终落点 core y —— 全链路唯一的 y 决策点，只在目标区块已 forceload 之后调用。
// 只信「合法区间内的真实地表」，排掉两类坏 heightmap：
//   ① 0（区块没生成 / 全空柱），② 顶到世界顶（天花板世界，如 magnetic_ceiling，h=255/256）。
// 返回整数 core y：房间 = y-8..y+8（含外壳 y-9..y+9 必须落在维度可建范围内）。
function c4ResolveY(server, dim, x, z) {
  let fixed = (C4_DIM_Y[dim] !== undefined) ? Number(C4_DIM_Y[dim]) : null
  let lv = null, minY = 0, maxY = 256, h = null
  try { lv = c4Level(server, dim) } catch (e) { console.warn('[C4] 落点 y: 取维度失败 ' + dim + ': ' + e) }
  if (lv) {
    try { minY = Number(lv.getMinBuildHeight()); maxY = Number(lv.getMaxBuildHeight()) } catch (e) {}
    try {
      let HM = c4Cls('net.minecraft.world.level.levelgen.Heightmap$Types')
      h = Number(lv.getHeight(HM.MOTION_BLOCKING, Math.floor(x), Math.floor(z)))
    } catch (e) { h = null; console.warn('[C4] 高度图不可用 ' + dim + ': ' + e) }
  }
  if (!isFinite(minY)) minY = 0
  if (!isFinite(maxY)) maxY = minY + 256
  let lo = minY + 9, hi = maxY - 10
  // 合法高度：(minY+1, maxY-2) 之间。h=0（未加载）与 h≥maxY-2（天花板/顶到世界顶）都判废。
  let hOk = (h !== null && isFinite(h) && h > minY + 1 && h < maxY - 2)
  let y
  if (fixed !== null) y = fixed
  else if (hOk) y = h + 9          // heightmap 指向第一格空气 → 房间地板正好压在地表上（core = 地表 +9）
  else y = 100
  y = Math.round(Math.max(lo, Math.min(hi, y)))
  console.info('[C4] 落点 y: dim=' + dim + ' h=' + (h === null ? 'n/a' : h) + ' fixed=' + (fixed === null ? '-' : fixed) +
    ' → core=' + y + ' (房间 ' + (y - 8) + '..' + (y + 8) + ', 合法 ' + lo + '..' + hi + ')')
  return y
}

// ---------------------------------------------------------------------------- 跃迁（串行队列）
// 这台车是否正在跃迁/排队：按钮按下期间不再接受第二次触发
function c4SlotInFlight(slot) {
  if (C4_BUSY && Number(C4_BUSY.slot) === Number(slot)) return true
  for (let i = 0; i < C4_Q.length; i++) if (Number(C4_Q[i].slot) === Number(slot)) return true
  return false
}
function c4Enqueue(server, slot, teamKey, clickerName, forceRandom, randomDim) {
  for (let i = 0; i < C4_Q.length; i++) if (C4_Q[i].slot === slot) { C4_Q.splice(i, 1); break }
  C4_Q.push({ slot: slot, teamKey: teamKey, clicker: clickerName || null, riders: [], forceRandom: !!forceRandom, randomDim: randomDim || null, gen: C4_GEN })
  c4Pump(server)
}
// S5：同维度二次确认（纯内存，10s 有效；不写库、不动 time 计分板）
let C4_RANDOM_PENDING = {}
// S5：每队一张 dim → {x,y,z} 表（cube.dests）；老 cube.dest 一次性迁入（幂等）
function c4Dests(cube) { return (cube && cube.dests && typeof cube.dests === 'object') ? cube.dests : {} }
function c4DestOf(cube, dim) {
  let t = c4Dests(cube)
  let e = t[String(dim)]
  if (!e || e.x === undefined || e.y === undefined || e.z === undefined) return null
  return { dim: String(dim), x: Number(e.x), y: Number(e.y), z: Number(e.z) }
}
function c4DestSet(cube, dim, x, y, z) {
  if (!cube) return
  if (!cube.dests || typeof cube.dests !== 'object') cube.dests = {}
  cube.dests[String(dim)] = { x: Math.round(Number(x)), y: Math.round(Number(y)), z: Math.round(Number(z)) }
}
function c4MigrateDests() {
  let db = c4Db(), cubes = db.cubes || {}, n = 0
  for (let k in cubes) {
    let c = cubes[k]
    if (!c) continue
    if (c.dest && c.dest.dim) {
      if (!c.dests || typeof c.dests !== 'object') c.dests = {}
      if (!c.dests[String(c.dest.dim)]) {
        c.dests[String(c.dest.dim)] = { x: Math.round(Number(c.dest.x)), y: Math.round(Number(c.dest.y)), z: Math.round(Number(c.dest.z)) }
        n++
      }
      delete c.dest
    }
  }
  if (n > 0) { c4Save(); console.info('[C4] dest → dests[dim] 迁移：' + n + ' 条（一次性/幂等）') }
  return n
}
function c4DestValid(server, d) {
  if (!d || !d.dim) return false
  let lv = c4Level(server, d.dim)
  if (!lv) return false
  try {
    let minY = Number(lv.getMinBuildHeight()), maxY = Number(lv.getMaxBuildHeight())
    if (Number(d.y) - 9 < minY || Number(d.y) + 10 > maxY) return false
  } catch (e) {}
  return true
}
function c4DestRoomExists(server, d) {
  // 探针（不信 DB 标记）：地板必须是 platform，四角立柱是 frame，中心上方 3 格是空气
  try {
    let lv = c4Level(server, d.dim)
    if (!lv) return false
    let x = Math.floor(Number(d.x)), y = Math.floor(Number(d.y)), z = Math.floor(Number(d.z))
    let bl = (bx, by, bz) => {
      try { let b = lv.getBlock(bx, by, bz); return b ? String(b.id) : '' } catch (e) { return '' }
    }
    // 地板 Y0 = y-8（中心 3×3 是 structure_void，取 ±2 处的平台）
    let floorOk = false
    ;[y - 8, y - 7].forEach(fy => {
      if (floorOk) return
      if (bl(x - 2, fy, z) === 'kubejs:warping_frame_platform') { floorOk = true; return }
      if (bl(x + 2, fy, z) === 'kubejs:warping_frame_platform') { floorOk = true; return }
      if (bl(x, fy, z - 2) === 'kubejs:warping_frame_platform') { floorOk = true; return }
      if (bl(x, fy, z + 2) === 'kubejs:warping_frame_platform') { floorOk = true; return }
    })
    if (!floorOk) {
      console.warn('[C4] 落点探针失败 @' + x + ',' + y + ',' + z + ' 地板 @Y0=' + (y - 8) + ' 不是 platform'
        + '（采样 ' + bl(x - 2, y - 8, z) + ' / ' + bl(x + 2, y - 8, z) + ' / ' + bl(x, y - 8, z - 2) + ' / ' + bl(x, y - 8, z + 2) + '）')
      return false
    }
    // 四角立柱（房间外框），至少 2 个存在
    let wall = 0
    if (bl(x - 8, y, z - 8) === 'kubejs:warping_frame') wall++
    if (bl(x + 8, y, z - 8) === 'kubejs:warping_frame') wall++
    if (bl(x - 8, y, z + 8) === 'kubejs:warping_frame') wall++
    if (bl(x + 8, y, z + 8) === 'kubejs:warping_frame') wall++
    if (wall < 2) {
      console.warn('[C4] 落点探针失败 @' + x + ',' + y + ',' + z + ' 四角 frame 只有 ' + wall + '/4')
      return false
    }
    // 中心上方 3 格必须是空气/封洞
    let airOk = 0
    for (let dy = 1; dy <= 3; dy++) {
      let id = bl(x, y + dy, z)
      if (id === 'minecraft:air' || id === 'minecraft:structure_void' || id === 'minecraft:cave_air') airOk++
    }
    if (airOk < 2) return false
    return true
  } catch (e) { return false }
}
// 反向门兜底：complete_bi_way_portal 之后按目的地维度点数，<6 则补（最多 2 轮，间隔 20t）
function c4CheckDest(server, slot, idName, d, dx, dy, dz, attempt, cb) {
  let g = C4_GEN
  let rev = 0
  try { rev = c4CountPortals(server, d.dim, dx, dy, dz, 90) } catch (e) {}
  let tp = c4TeleCore(slot)
  let fwdAll = 0, fwdOwn = 0
  try { fwdAll = c4PortalsInDim(server, 'minecraft:overworld', tp.x, tp.y, tp.z, 240).length } catch (e2) {}
  try { fwdOwn = c4CountFaceDoors(server, tp.x, tp.y, tp.z, 240) } catch (e3) {}
  console.info('[C4] 目的地校验 rev=' + rev + '/6 正向在场=' + fwdAll + ' 本队正向=' + fwdOwn + ' 轮=' + attempt)
  if (rev >= 6) { cb(true, rev, fwdOwn, fwdAll); return }
  if (attempt >= 2) {
    console.warn('[C4] 反向门 rev=' + rev + ' 补建后仍不足')
    cb(false, rev, fwdOwn, fwdAll)
    return
  }
  try { c4MakeReverse(server, slot, d.dim, dx, dy, dz, idName) } catch (e4) { console.warn('[C4] 反向门补建失败: ' + e4) }
  server.scheduleInTicks(20, () => {
    if (g !== C4_GEN) return
    c4CheckDest(server, slot, idName, d, dx, dy, dz, attempt + 1, cb)
  })
}
function c4EnsureReverse(server, slot, dimId, dx, dy, dz, idName, round) {
  let g = C4_GEN
  let hs = c4TeamOfSlot(slot)
  let ext = c4Ext(hs && hs.cube ? hs.cube : null)
  let cnt = 0
  try { cnt = c4PortalsInDim(server, dimId, dx, dy, dz, 200).length } catch (e) {}
  if (cnt >= 6 || round >= 2) {
    console.info('[C4] 反向门 rev=' + cnt + '/6 重试=' + round + '（' + dimId + ' @' + Math.floor(dx) + ',' + Math.floor(dy) + ',' + Math.floor(dz) + '）')
    return cnt
  }
  try {
    server.runCommandSilent('execute as @e[type=immersive_portals:portal,tag=cw_id_' + idName + '] at @s run portal complete_bi_way_portal')
  } catch (e2) { console.warn('[C4] 反向门补建失败: ' + e2) }
  server.scheduleInTicks(20, () => {
    if (g !== C4_GEN) return
    try { c4SyncDoorTags(server, dimId, dx, dy, dz, ext, slot, idName, true, 240) } catch (e3) {}
    c4EnsureReverse(server, slot, dimId, dx, dy, dz, idName, round + 1)
  })
  return cnt
}
function c4PickTempDest(server, slot, dimId) {
  let dim = String(dimId || 'minecraft:overworld')
  let off = c4RandDestOffset()
  let x = Math.floor(c4CubeX(slot) + off.x)
  let z = Math.floor(C4_Z + off.z)
  console.info('[C4] 原地随机落点 slot' + slot + ' 偏移 ' + off.x + ',' + off.z
    + '（距本台 ' + Math.round(Math.sqrt(off.x * off.x + off.z * off.z)) + ' 格）')
  let y = 100
  try { y = c4ResolveY(server, dim, x, z) } catch (e) {}
  return { dim: dim, x: x, y: y, z: z, seed: -1, temp: true }
}
function c4Pump(server) {
  if (C4_BUSY) return
  if (C4_Q.length === 0) return
  let job = C4_Q.shift()
  C4_BUSY = job
  c4Warp(server, job)
}

function c4Warp(server, job) {
  if (job && job.gen !== undefined && job.gen !== C4_GEN) {
    console.warn('[C4] 旧世代跃迁作业丢弃 slot=' + (job && job.slot))
    C4_BUSY = null
    return
  }
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

  // ⓪.5 旧落点快照在选点后按【目标维度】写进 job.oldDest（见下面 dests 查表）

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
  // S5：目标维度由 seed 决定 → 查 dests[目标维度]。有且房间在 → 复用（只指门，不重建）；
  // 没有/房间坏了 → 分配一次（坏的允许重建一次）；同维度随机 → 临时落点（不写表）。
  let seedNow = 0
  try { seedNow = c4ReadSeed(server, slot) } catch (eSeed) { seedNow = 0 }
  let targetDim = String(C4_SEED_DIMS[seedNow] || C4_SEED_DIMS[0])
  let prevDest = (info && info.cube) ? c4DestOf(info.cube, targetDim) : null
  let useFixed = false, rebuildFixed = false
  if (!job.forceRandom && prevDest && c4DestValid(server, prevDest)) {
    if (c4DestRoomExists(server, prevDest)) useFixed = true
    else { rebuildFixed = true; console.warn('[C4] 落点房间缺失，重建 @' + prevDest.x + ',' + prevDest.y + ',' + prevDest.z + ' dim=' + prevDest.dim) }
  }
  job.useFixedDest = useFixed
  job.rebuildFixed = rebuildFixed
  job.dimShown = c4DimName(targetDim)
  job.oldDest = (info && info.cube && !job.tempDest) ? prevDest : null
  let d
  if (useFixed || rebuildFixed) {
    d = { dim: targetDim, x: prevDest.x, y: prevDest.y, z: prevDest.z, seed: seedNow }
    console.info('[C4] 槽位 ' + slot + (useFixed ? ' 复用固定目的地 ' : ' 重建固定目的地 ') + d.dim + ' @' + d.x + ',' + d.y + ',' + d.z)
  } else if (job.forceRandom) {
    d = c4PickTempDest(server, slot, job.randomDim || targetDim)
    job.tempDest = true
    console.info('[C4] 槽位 ' + slot + ' 同维度随机传送（临时落点，不写表）→ ' + d.dim + ' @' + d.x + ',' + d.y + ',' + d.z)
  } else {
    d = c4PickDestForSeed(server, slot, seedNow)
  }
  // 高度图给的是整数方块 y；核心必须落在方块中心（x.5），否则 ±8.51 会整体低半格，
  // 表现就是"目的地门比框架低半格"。
  let dx = d.x + 0.5, dz = d.z + 0.5, dy = d.y + 0.5
  let fx = Math.floor(dx), fz = Math.floor(dz)
  server.runCommandSilent('execute in ' + d.dim + ' run forceload add ' + (fx - 40) + ' ' + (fz - 40) + ' ' + (fx + 40) + ' ' + (fz + 40))
  // 剧场版时间轴（对齐原包 processors/runtime）：按键音已在右键那一刻播过，这里只做
  // 按下动画 + 动作条，“t=20/40/60 逐格结算+消耗，t=80 粒子爆发后进入自主跃迁”。
  let bx = c4CubeX(slot)
  // S2：动画/音效/按下面板都在【传送器】里，基地不再有按钮/接口
  let tpA = c4TeleAnchor(slot)
  let tpCore = { x: tpA.x + 0.5, y: tpA.y + 8.5, z: tpA.z + 0.5 }
  let tpBtn = { x: tpA.x, y: tpA.y + 1, z: tpA.z + 7 }
  let atCore = `execute in minecraft:overworld positioned ${tpCore.x} ${tpCore.y} ${tpCore.z} run `
  server.scheduleInTicks(1, () => {
    if (C4_BUSY !== job) return
    try {
      server.runCommandSilent('execute in minecraft:overworld run setblock ' + tpBtn.x + ' ' + tpBtn.y + ' ' + tpBtn.z + ' kubejs:launch_button_pressed')
      server.runCommandSilent('execute in minecraft:overworld run setblock ' + (tpBtn.x + 1) + ' ' + tpBtn.y + ' ' + (tpBtn.z + 1) + ' kubejs:warping_interface_running')
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
    job.dimShown = c4DimName(d.dim)
    console.info('[C4] 槽位 ' + slot + ' 最终 seed=' + seedAcc + '，动作条：' + c4TravelText(job))
  })
  console.info('[C4] 槽位 ' + slot + ' 剧场版时间轴：t=1 按下 / t=20,40,60 消耗 / t=80 跃迁（seed=' + d.seed + '）')
  console.info('[C4] 槽位 ' + slot + ' 自主跃迁 → ' + d.dim + ' @' + d.x + ',' + d.y + ',' + d.z)

// 成功收尾：写 dests/curDestDim、记 job.dest、日志、10t 后 c4WarpEnd
// 落点纠偏：玩家若不在房间 box（±9）内，直接 tp 到中心上方 2 格
function c4CorrectLanding(server, slot, job, d) {
  try {
    let cx = Number(d.x) + 0.5, cz = Number(d.z) + 0.5, cy = Number(d.y) + 0.5
    if (!job || !job.riders || job.riders.length === 0) return
    server.players.forEach(p => {
      try {
        if (job.riders.indexOf(c4Name(p)) < 0) return
        if (c4DimOf(p) !== String(d.dim)) return
        let inside = Math.abs(p.x - cx) <= 9 && Math.abs(p.z - cz) <= 9 && p.y >= cy - 9 && p.y <= cy + 10
        if (inside) return
        console.info('[C4] 落点纠偏：玩家在房间外 → tp 回中心 ' + c4Name(p)
          + ' (' + Math.floor(p.x) + ',' + Math.floor(p.y) + ',' + Math.floor(p.z) + ') → '
          + Math.floor(cx) + ',' + Math.floor(cy + 2) + ',' + Math.floor(cz))
        c4Tp(server, p, d.dim, cx, cy + 2, cz)
      } catch (e) {}
    })
  } catch (e2) { console.warn('[C4] 落点纠偏异常: ' + e2) }
}

function c4FinishWarp(server, slot, label, job, info, d, idName) {
  try {
    if (!job.tempDest && info && info.cube) {
      c4DestSet(info.cube, d.dim, d.x, d.y, d.z)
      info.cube.curDestDim = d.dim
      c4Save()
      console.info('[C4] curDestDim 更新 slot=' + slot + ' → ' + d.dim)
    }
  } catch (e) {}
  job.dest = { dim: d.dim, x: d.x, y: d.y, z: d.z, cx: Math.floor(d.x / 16) * 16, cz: Math.floor(d.z / 16) * 16 }
  job.destOK = true
  console.info('[C4] 剧场版 e 校验通过 → 跃迁完成 ' + d.dim + ' @' + d.x + ',' + d.y + ',' + d.z)
  server.scheduleInTicks(30, () => c4CorrectLanding(server, slot, job, d))
  server.scheduleInTicks(100, () => c4CorrectLanding(server, slot, job, d))
  server.scheduleInTicks(10, () => c4WarpEnd(server, slot, label, job))
}

  let perform = (phase) => {
    try {
      try { server.runCommandSilent(c4ForceloadBox(slot, true)) } catch (e0) {}
      let cur = c4CoreOfSlot(server, slot)
      if (!cur) {
        c4TellTeam(server, slot, c4t('cw.warp.abort'))
        c4WarpEnd(server, slot, label, job)
        return
      }
      // S2：跃迁机器在传送器里（基地只住人）→ 门/校验/指门全部用传送器核心
      let tp = c4TeleCore(slot)
      let ext0 = { px: 0, nx: 0, pz: 0, nz: 0, py: 0 }
      let extNow = (info && info.cube) ? c4Ext(info.cube) : ext0

      // S1：按面 tag 校验（不再只看"有没有门"）。少于 6 扇/缺面 → 整组重建后再继续，别直接判失败
      let have = 0
      let faceBad = 0
      try {
        let synced0 = c4SyncDoorTags(server, 'minecraft:overworld', tp.x, tp.y, tp.z, ext0, slot, idName, false, 260)
        have = c4CountFaceDoors(server, tp.x, tp.y, tp.z, 160)
        for (let di2 = 0; di2 < C4_FACE_DIRS.length; di2++) {
          if (Number(synced0.faces[C4_FACE_DIRS[di2]] || 0) !== 1) faceBad++
        }
      } catch (e) { have = c4CountFaceDoors(server, tp.x, tp.y, tp.z, 96) }
      if ((have < 6 || faceBad > 0) && phase < 2) {
        console.warn('[C4] 传送器门不完整（实有 ' + have + ' 扇，异常面 ' + faceBad + '）→ 重建后重试（phase ' + phase + '）')
        try { c4MakeRoomPortals(server, slot, idName, ext0, tp) } catch (e) { console.warn('[C4] 重建门失败: ' + e) }
        server.scheduleInTicks(20, () => perform(phase + 1))
        return
      }

      // —— 落点 y：固定目的地沿用库里的 y；只有临时/首次落点才按 heightmap 重新取 ——
      if (!job.useFixedDest && !job.rebuildFixed) {
        d.y = c4ResolveY(server, d.dim, d.x, d.z)
        dy = c4ClampCoreY(server, d.dim, d.y + 0.5, ext0)
        d.y = Math.round(dy - 0.5)
      } else {
        // 固定落点/重建固定落点：一律保留库里的 y（heightmap 在别的维度不可信）
        dy = Number(d.y) + 0.5
      }

      // ═══ 剧场版：a 先指门 → b 黑场窗口 → c 建房间 → d 反向门 → e 校验 ═══
      // a) 只改 destination（moveSrc=false，主世界的门原地不动）。此刻门后是还没建房间的新维度 → 黑/虚空。
      let n = c4Retarget(server, tp.x, tp.y, tp.z, c4DimKey(d.dim), dx, dy, dz, false, d.dim, idName, ext0, false, slot)
      console.info('[C4] 剧场版 a 指门 ' + n + '/6 → ' + d.dim + ' @' + d.x + ',' + d.y + ',' + d.z
        + '（黑场 ' + C4_PLANE_WAIT + 't 后建房间）')

      // b) 黑场窗口：原包 runtime=1 的四连音 + runtime=30/70/100 的排气（不依赖数据包 running）
      c4TravelSounds(server, atCore)
      ;[10, 30, 50].forEach(t => server.scheduleInTicks(t, () => {
        if (C4_BUSY !== job) return
        c4VentBurst(server, slot)
      }))

      // c/d/e) 黑场播完才建房间 → 反向门 → 校验（失败仍回滚私有笼子）
      server.scheduleInTicks(C4_PLANE_WAIT, () => {
        if (C4_BUSY !== job) return
        try {
          if (!job.useFixedDest) {
            let room = c4BuildRoom(server, d.dim, dx, dy, dz, ext, true)
            if (room && Math.floor(dy - 8) !== room.Y0) {
              dy = room.Y0 + 8.5
              d.y = Math.round(dy - 0.5)
              console.warn('[C4] 剧场版 c 房间 y 被夹取 → core=' + d.y + '（房间 ' + room.Y0 + '..' + room.Y1 + '）')
            }
            console.info('[C4] 剧场版 c 建房间 ' + d.dim + ' @' + d.x + ',' + d.y + ',' + d.z)
            try { c4MakeReverse(server, slot, d.dim, dx, dy, dz, idName) } catch (e) { console.warn('[C4] 反向门失败: ' + e) }
            // 反向门补建交给 c4CheckDest（最多 2 轮，不立刻回滚）
          } else {
            console.info('[C4] 剧场版 c 复用固定房间（不重建） ' + d.dim + ' @' + d.x + ',' + d.y + ',' + d.z)
          }
          c4CheckDest(server, slot, idName, d, dx, dy, dz, 0, (ok, rev, fwdOwn, fwdAll) => {
            if (!ok || n < 6 || fwdOwn < 6) {
              console.warn('[C4] 剧场版 e 校验失败：指门=' + n + '/6 本队正向=' + fwdOwn + ' 反向=' + rev
                + '（在场门=' + fwdAll + '） → 回滚到私有笼子')
              c4TellTeam(server, slot, c4t('cw.warp.abort'))
              try { c4BarTeam(server, slot, '跃迁失败：目的地未就绪，已回到起点') } catch (e7) {}
              try { c4RestoreHome(server, slot, idName) } catch (e2) {}
              c4WarpEnd(server, slot, label, job)
              return
            }
            c4FinishWarp(server, slot, label, job, info, d, idName)
          })
          return
          // 临时落点（同维度随机）不写库；固定目的地原样写回也无害
          try { if (!job.tempDest && info && info.cube) { c4DestSet(info.cube, d.dim, d.x, d.y, d.z); c4Save() } } catch (e) {}
          // 成功落点写进 job：c4WarpEnd 要拿它判断"新旧是不是同一处"，并据此决定拆不拆旧笼子。
          // （job.dest 以前只在没人调用的 c4PreloadFinal 里赋值，所以"落点已记录"从来没打印过）
          job.dest = { dim: d.dim, x: d.x, y: d.y, z: d.z, cx: Math.floor(d.x / 16) * 16, cz: Math.floor(d.z / 16) * 16 }
          job.destOK = true
          console.info('[C4] 剧场版 e 校验通过：正向=' + n + ' 反向=' + rev + ' → 跃迁完成 ' + d.dim + ' @' + d.x + ',' + d.y + ',' + d.z)
          server.scheduleInTicks(10, () => c4WarpEnd(server, slot, label, job))
        } catch (e) {
          console.warn('[C4] 剧场版 c/d 失败: ' + e)
          c4TellTeam(server, slot, c4t('cw.warp.abort'))
          try { c4RestoreHome(server, slot, idName) } catch (e2) {}
          c4WarpEnd(server, slot, label, job)
        }
      })
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
      // S2：粒子/传送音都在传送器中心播
      server.runCommandSilent(`execute in minecraft:overworld positioned ${tpCore.x} ${tpCore.y} ${tpCore.z} run particle minecraft:portal ~ ~ ~ 8 8 8 0.5 200 force`)
      server.runCommandSilent(`execute in minecraft:overworld positioned ${tpCore.x} ${tpCore.y} ${tpCore.z} run particle minecraft:end_rod ~ ~ ~ 6 6 6 0.2 120 force`)
      server.runCommandSilent(`execute in minecraft:overworld positioned ${tpCore.x} ${tpCore.y} ${tpCore.z} run playsound minecraft:entity.enderman.teleport master @a ~ ~ ~ 1 0.8`)
    } catch (e) {}
    perform(0)
  })
}

// —— 剧场版演出用（不依赖数据包的 running 标签 / travel_runtime）——

// 原包 travel_runtime runtime=1 的四连旅行音
function c4TravelSounds(server, atCore) {
  try {
    server.runCommandSilent(atCore + 'playsound block.respawn_anchor.ambient master @a ~ ~ ~ 10 0')
    server.runCommandSilent(atCore + 'playsound minecraft:block.respawn_anchor.charge master @a ~ ~ ~ 1 1')
    server.runCommandSilent(atCore + 'playsound block.respawn_anchor.set_spawn master @a ~ ~ ~ 10 1')
    server.runCommandSilent(atCore + 'playsound minecraft:block.portal.trigger master @a ~ ~ ~ 1 0')
    console.info('[C4] 旅行音效：respawn_anchor ×3 + portal.trigger')
  } catch (e) { console.warn('[C4] 旅行音效失败: ' + e) }
}

// 原包 runtime=30/70/100 的排气：排气孔位置的灭火声 + effects/vents 的六向尘
function c4VentBurst(server, slot) {
  try {
    let a = c4TeleAnchor(slot)
    let core = (a.x + 0.5) + ' ' + (a.y + 8.5) + ' ' + (a.z + 0.5)
    let at = 'execute in minecraft:overworld positioned ' + core + ' run '
    // 只对本台（30 格内）的 vent marker 生效，避免多台立方体一起喷
    server.runCommandSilent(at + 'execute as @e[type=marker,tag=vent,distance=..30] at @s run playsound minecraft:block.candle.extinguish master @a ~ ~ ~ 0.35 1')
    server.runCommandSilent(at + 'execute as @e[type=marker,tag=vent,distance=..30] at @s run particle minecraft:dust_color_transition 0.3 1 1 3 0 0 0.3 ~ ~1 ~ 0.25 0.25 0.25 0.02 8 force')
    server.runCommandSilent(at + 'execute as @e[type=marker,tag=vent,distance=..30] at @s run particle minecraft:dust_color_transition 0.3 1 1 3 0 0 0.3 ~ ~-1 ~ 0.25 0.25 0.25 0.02 8 force')
    console.info('[C4] 排气孔喷气 @' + core)
  } catch (e) { console.warn('[C4] 排气失败: ' + e) }
}

// 与 c4BuildRoom 的越界夹取同一套算法：先指门时就用"最终"的核心 y，避免门和房间差半格
function c4ClampCoreY(server, dimId, cy, ext) {
  try {
    let b = c4RoomBox(0, cy, 0, ext)
    let lv = c4Level(server, dimId)
    if (lv) {
      let minY = Number(lv.getMinBuildHeight()), maxY = Number(lv.getMaxBuildHeight())
      if (b.Y0 - 1 < minY || b.Y1 + 1 >= maxY) {
        let py = Math.max(0, (ext && Number(ext.py)) | 0)
        let i = Math.round(cy - 0.5)
        i = Math.max(minY + 9, Math.min(maxY - 10 - 16 * py, i))
        console.warn('[C4] 房间越界 dim=' + dimId + ' cy=' + cy + ' → 核心 y 夹到 ' + (i + 0.5))
        return i + 0.5
      }
    }
  } catch (e) { console.warn('[C4] 夹取核心 y 失败: ' + e) }
  return cy
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
      let made = c4Retarget(server, cx, C4_CORE_Y, cz, c4DimKey(CAGE), cx, C4_CORE_Y, cz, false, CAGE, idName, ext, true, slot)
      try { c4MakeReverse(server, slot, CAGE, cx, C4_CORE_Y, cz, idName) } catch (e) {}
      console.info('[C4] 跃迁失败 → 门已指回私有笼子（' + made + ' 扇）')
    } catch (e) { console.warn('[C4] 指回笼子失败: ' + e) }
  })
}

function c4WarpEnd(server, slot, label, job) {
  if (job && job.gen !== undefined && job.gen !== C4_GEN) {
    console.warn('[C4] 旧世代跃迁收尾丢弃 slot=' + slot)
    return
  }
  // 动画/跃迁彻底结束才把按钮、界面弹回来（按下期间按钮一直是 pressed，右键不会再触发）
  try {
    let bp = c4BtnPos(slot)
    server.runCommandSilent('execute in minecraft:overworld run setblock ' + bp.x + ' ' + bp.y + ' ' + bp.z + ' kubejs:launch_button[facing=north]')
    server.runCommandSilent('execute in minecraft:overworld run setblock ' + (bp.x + 1) + ' ' + bp.y + ' ' + (bp.z + 1) + ' kubejs:warping_interface')
  } catch (e) {}
  // 清掉数据包残留的"正在前往维度"actionbar 状态（否则聊天框/动作条会一直显示"维度:"）
  try {
    server.runCommandSilent('tag @a remove travel_actionbar')
    server.runCommandSilent('scoreboard players set @a travel_actionbar 0')
  } catch (e) {}
  server.runCommandSilent(`tag @e[type=marker,tag=cw_slot${slot}] remove pre_runtime`)
  server.runCommandSilent(`scoreboard players set @e[type=marker,tag=cw_slot${slot}] pre_runtime 0`)
  server.runCommandSilent(`scoreboard players set @e[type=marker,tag=cw_slot${slot}] dimension_seed 0`)
  // 防延迟丢人：只把【仍在舱体范围内】的登船者按回座位（同维度 + 按 ext 真实 box 判 ±10 容差）。
  // 以前无条件对 job.riders 全员 c4SendToCube：已经走出舱体、甚至去了别的维度的人会被硬拉回主世界。
  try {
    if (job && job.riders && job.riders.length > 0) {
      let hs = c4TeamOfSlot(slot)
      let extNow = { px: 0, nx: 0, pz: 0, nz: 0, py: 0 }   // 传送器固定 17³（基地 ext 不参与）
      let ps = []
      let left = 0
      server.players.forEach(p => {
        if (job.riders.indexOf(c4Name(p)) < 0) return
        if (!c4InCubeExt(p, slot, extNow, 10)) { left++; return }   // 已走出舱体/在别的维度：不动他
        if (c4InCubeExt(p, slot, extNow, 0)) return                  // 人就在舱内：也不用折腾
        ps.push(p)
      })
      let n = ps.length > 0 ? c4SendToCube(server, ps, slot) : 0
      if (n > 0) console.info('[C4] 收尾：把 ' + n + ' 人拉回舱内（登船 ' + job.riders.length + ' 人，' + left + ' 人已离开舱体不处理）')
      else if (left > 0) console.info('[C4] 收尾：登船 ' + job.riders.length + ' 人，' + left + ' 人已离开舱体，不召回')
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
      if (info2 && info2.cube && !job.tempDest) {
        c4DestSet(info2.cube, job.dest.dim, job.dest.x, job.dest.y, job.dest.z)
        info2.cube.curDestDim = job.dest.dim
        c4Save()
        console.info('[C4] curDestDim 更新 slot=' + slot + ' → ' + job.dest.dim)
      }
      let d = job.dest
      server.runCommandSilent('execute in ' + d.dim + ' run forceload add ' + d.cx + ' ' + d.cz)
      console.info('[C4] 落点已记录 dim=' + d.dim + ' @' + d.x + ',' + d.y + ',' + d.z)
      server.scheduleInTicks(1200, () => {
        try { server.runCommandSilent('execute in ' + d.dim + ' run forceload remove ' + d.cx + ' ' + d.cz) } catch (e) {}
      })
    }
  } catch (e) { console.warn('[C4] 落点记录失败: ' + e) }
  // S5：同维度随机出的临时落点 → 玩家离开 20s 后按旧落点清理（不写 cube.dest）
  try {
    if (job && job.tempDest && job.dest) {
      let td = { dim: job.dest.dim, x: job.dest.x, y: job.dest.y, z: job.dest.z }
      console.info('[C4] 临时落点 20s 后清理 ' + td.dim + ' @' + td.x + ',' + td.y + ',' + td.z)
      server.scheduleInTicks(1200, () => {
        try { c4CleanOldDest(server, slot, { oldDest: td, dest: { dim: 'minecraft:the_nether', x: 0, y: 64, z: 0 }, destOK: true }) } catch (e2) {}
      })
    }
  } catch (e3) {}

  // 拆掉【上一次】的落点笼子：此刻新房间已建好、玩家已在新落点，旧房间才是可丢的。
  // 只有本次真的校验通过（job.destOK）才动，失败/取消路径一律不碰旧落点。
  try { if (job && job.destOK) c4CleanOldDest(server, slot, job) } catch (e) { console.warn('[C4] 清理旧落点失败: ' + e) }

  C4_BUSY = null
  // 成功路径不往聊天框发任何东西（倒计时/排队都在动作条），失败提示已在各自分支发出
  c4Pump(server)
}

// ---------------------------------------------------------------------------- 旧落点清理
// 每跃迁一次就换一个落点，旧房间（地板/顶圈/洞口封/操控台 + 反向门）不拆的话会在每个维度里
// 越堆越多。这里在新房间建好、玩家已到新落点之后，按【精确坐标 + 只 Replace 自己放的方块】
// 的方式拆旧房间，绝不无参 fill air —— 旧落点周围可能已经被玩家当成基地来用。
function c4DimNorm(id) {
  let s = String(id === null || id === undefined ? '' : id)
  return s.indexOf(':') >= 0 ? s : ('minecraft:' + s)
}
// 旧落点 32 格内的在线玩家（按维度 + 距离）：有人就跳过清理，等人走了下一跳再说
function c4OldDestBusy(server, od) {
  let names = []
  try {
    server.players.forEach(p => {
      try {
        if (c4DimNorm(c4DimOf(p)) !== c4DimNorm(od.dim)) return
        if (c4Dist2(p.x, p.y, p.z, od.x, od.y, od.z) > 32 * 32) return
        names.push(c4Name(p))
      } catch (e) {}
    })
  } catch (e) {}
  return names
}
function c4CleanOldDest(server, slot, job) {
  let od = job ? job.oldDest : null
  let nd = job ? job.dest : null
  if (!od || !od.dim || !nd || !nd.dim) return
  let ox = Math.floor(Number(od.x)), oy = Math.floor(Number(od.y)), oz = Math.floor(Number(od.z))
  if (isNaN(ox) || isNaN(oy) || isNaN(oz)) return
  let odc = { dim: od.dim, x: ox, y: oy, z: oz }
  let where = odc.dim + ' @' + ox + ',' + oy + ',' + oz
  let hs = c4TeamOfSlot(slot)
  let idName = (hs && hs.cube && hs.cube.id) ? hs.cube.id : ('cube' + slot)
  let ext = c4Ext(hs && hs.cube ? hs.cube : null)
  let b = c4RoomBox(ox, oy, oz, ext)
  // 范围 = 房间 box 四周各放 1 格（外壳/洞口封可能在外侧一格）
  let x0 = b.X0 - 1, x1 = b.X1 + 1, z0 = b.Z0 - 1, z1 = b.Z1 + 1
  let y0 = b.Y0 - 1, y1 = b.Y1 + 1
  let roomW = b.X1 - b.X0 + 1, roomD = b.Z1 - b.Z0 + 1
  // ②-a 新旧同一处（同维度 + x/z 差 ≤2）→ 这就是新落点，不能拆
  //      另外两个房间若近到会互相重叠（< 房间宽度），也不拆：那是刚建好的新房间
  if (c4DimNorm(od.dim) === c4DimNorm(nd.dim)) {
    let ndx = Math.floor(Number(nd.x)), ndz = Math.floor(Number(nd.z))
    let adx = Math.abs(ox - ndx), adz = Math.abs(oz - ndz)
    if (adx <= 2 && adz <= 2) {
      console.info('[C4] 旧落点与新落点同一处，跳过清理 ' + where)
      return
    }
    if (adx < roomW + 2 && adz < roomD + 2) {
      console.info('[C4] 新旧落点过近（房间会重叠），跳过清理 ' + where + ' → ' + ndx + ',' + ndz)
      return
    }
  }
  // ②-d 每队私有的起始笼（hexahedron:bedrock_bottom）永不清理
  if (c4DimNorm(od.dim) === 'hexahedron:bedrock_bottom') {
    console.info('[C4] 旧落点是起始笼，保留不清理 ' + where)
    return
  }
  // ②-a 安全闸：旧落点有人就不动
  let who = c4OldDestBusy(server, odc)
  if (who.length > 0) {
    console.info('[C4] 旧落点有人，暂不清理 ' + where + '（' + who.join(',') + '）')
    return
  }

  // 旧落点的区块大概率早就卸载了（上一跳的 forceload 也释放了）：fill/kill 只对已加载区块生效
  try {
    server.runCommandSilent('execute in ' + odc.dim + ' run forceload add ' + x0 + ' ' + z0 + ' ' + x1 + ' ' + z1)
  } catch (e) { console.warn('[C4] 旧落点 forceload 失败: ' + e) }

  server.scheduleInTicks(5, () => {
    try {
      // 5 tick 后再确认一次：这期间有人跑回旧落点就放弃（这个房间会留着，不做无人值守的补拆）
      let who2 = c4OldDestBusy(server, odc)
      if (who2.length > 0) {
        console.info('[C4] 旧落点有人，暂不清理 ' + where + '（' + who2.join(',') + '）')
        return
      }
      // ②-b 门：只杀带本台 tag 的（旧目的地那侧的门同时带 cw_rev_<id> 和 cw_id_<id>）
      let pos = 'execute in ' + odc.dim + ' positioned ' + ox + ' ' + oy + ' ' + oz + ' run '
      let doors = 0
      ;['cw_rev_' + idName, 'cw_id_' + idName].forEach(t => {
        try {
          let r = Number(server.runCommandSilent(pos + 'kill @e[type=immersive_portals:portal,tag=' + t + ',distance=..48]'))
          if (!isNaN(r)) doors += r
        } catch (e) { console.warn('[C4] 清旧门失败 ' + t + ': ' + e) }
      })
      // 兜底：背后那侧的门是 IP 异步造出来的，c4MakeReverse 打 tag 时它们往往还没生成 → 没 tag，
      // 只按 tag 杀会留下一圈"幽灵门"。这里把这个房间几何范围内、且明确不属于任何队伍
      // （tag=!cw_rev 且 tag=!cw_id）的门一并清掉；别的队伍的门都带 tag，不会被误伤。
      try {
        let bx0 = b.X0 - 9, by0 = b.Y0 - 1, bz0 = b.Z0 - 9
        let bw = (b.X1 + 9) - bx0 + 1, bh = (b.Y1 + 1) - by0 + 1, bd = (b.Z1 + 9) - bz0 + 1
        let boxSel = 'x=' + bx0 + ',y=' + by0 + ',z=' + bz0 + ',dx=' + bw + ',dy=' + bh + ',dz=' + bd
        let r2 = Number(server.runCommandSilent('execute in ' + odc.dim + ' run kill @e[type=immersive_portals:portal,' + boxSel + ',tag=!cw_rev,tag=!cw_id]'))
        if (!isNaN(r2)) doors += r2
      } catch (e) { console.warn('[C4] 清旧门兜底失败: ' + e) }
      // ②-c 方块：逐类 replace（只替换这些方块，玩家在旧落点搭的别的东西一格都不动）
      let blocks = [
        'kubejs:warping_frame', 'kubejs:warping_frame_platform', 'kubejs:warping_frame_slab',
        'kubejs:hexahedron_filling', 'minecraft:structure_void',
        'kubejs:warping_controls', 'kubejs:warping_interface', 'kubejs:warping_interface_running',
        'kubejs:launch_button', 'kubejs:launch_button_pressed',
        'kubejs:warping_disc_drive', 'kubejs:warping_vent', 'minecraft:light'
      ]
      let w = x1 - x0 + 1, d = z1 - z0 + 1
      let step = Math.max(1, Math.floor(30000 / Math.max(1, w * d)))   // 按 y 分片，单条不超过 32768
      let n = 0
      blocks.forEach(bl => {
        for (let y = y0; y <= y1; y += step) {
          let y2 = Math.min(y + step - 1, y1)
          try {
            let r = Number(server.runCommandSilent('execute in ' + odc.dim + ' run fill ' + x0 + ' ' + y + ' ' + z0 + ' ' + x1 + ' ' + y2 + ' ' + z1 + ' minecraft:air replace ' + bl))
            if (!isNaN(r)) n += r
          } catch (e) { console.warn('[C4] 清旧方块失败 ' + bl + ': ' + e) }
        }
      })
      console.info('[C4] 清理旧落点 ' + where + ' 框架块=' + n + ' 门=' + doors + '（范围 ' + x0 + ',' + y0 + ',' + z0 + '..' + x1 + ',' + y1 + ',' + z1 + '）')
    } catch (e) { console.warn('[C4] 清理旧落点失败: ' + e) }
    // 释放这一步临时加的 forceload（多留 10 秒，避免区块刚清完就被卸掉）
    server.scheduleInTicks(200, () => {
      try { server.runCommandSilent('execute in ' + odc.dim + ' run forceload remove ' + x0 + ' ' + z0 + ' ' + x1 + ' ' + z1) } catch (e) {}
    })
  })
}

// ---------------------------------------------------------------------------- 事件：按钮
// ── 保护立方体的"家具"：创造模式也拆不掉（取消事件 + 1t 兜底补回）──────────
// 只保护按钮/操控台/接口/唱片机这一类"机器零件"；框梁/地板仍留给玩家自由改。
const C4_PROTECTED_BLOCKS = [
  'kubejs:launch_button', 'kubejs:launch_button_pressed',
  'kubejs:warping_controls', 'kubejs:warping_interface', 'kubejs:warping_disc_drive',
  'kubejs:warping_interface_running'
]
BlockEvents.broken(event => {
  try {
    let id = String(event.block.id)
    if (C4_PROTECTED_BLOCKS.indexOf(id) < 0) return
    event.cancel()
    let server = event.server, bx = event.block.x, by = event.block.y, bz = event.block.z
    let dim = 'minecraft:overworld'
    try { dim = String(event.player.level.dimension) } catch (e0) {}
    let state = (id === 'kubejs:launch_button') ? 'kubejs:launch_button[facing=north]' : id
    server.scheduleInTicks(1, () => {
      try {
        server.runCommandSilent('execute in ' + dim + ' if block ' + bx + ' ' + by + ' ' + bz + ' minecraft:air run setblock ' + bx + ' ' + by + ' ' + bz + ' ' + state)
        console.info('[C4] 保护方块被破坏已还原：' + id + ' @' + bx + ',' + by + ',' + bz)
      } catch (e1) {}
    })
    try { event.player.tell(Text.of('⟢ 这是立方体的机器零件，拆不掉（要用拆除器朝下双击来拆 3×3 门）')) } catch (e2) {}
  } catch (e) { console.warn('[C4] 保护方块检查失败: ' + e) }
})

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

  // 旧存档过渡：按钮还在基地层（只看 y 轴 = C4_BASE_FLOOR+1）→ 提示 + 自动迁移 + 自动连通 3×3。
  // 等价 /cube admin relocate + /cube admin hole，本次不跃迁。
  if (by === C4_BASE_FLOOR + 1) {
    let ts = c4TeamOfSlot(slot)
    if (ts) {
      let nx = Math.floor(c4CubeX(slot)), ny = C4_TELE_FLOOR + 1, nz = Math.floor(C4_Z) + 7
      console.info('[C4] 旧存档按钮迁移 slot' + slot + '：' + bx + ',' + by + ',' + bz + ' → ' + nx + ',' + ny + ',' + nz)
      try {
        clicker.tell(Text.of('⟢ 检测到旧基地按钮（y=' + by + '）：正在下层 y=' + C4_TELE_FLOOR + ' 新建传送器、绑定队伍并清掉旧按钮/操控台…'))
      } catch (e0) {}
      try { c4Relocate(server, slot, nx, ny, nz) } catch (eM) { console.warn('[C4] 旧存档按钮迁移失败: ' + eM) }
      // 老按钮/操控台钉在基地 97 层，不在 relocate 的 oldBtn 上 → 单独 strip 掉（旧存档过渡）
      try { c4StripCabin(server, slot, true) } catch (eS) { console.warn('[C4] 旧按钮清理失败: ' + eS) }
      // 迁移完成后自动把 3×3 洞连通（降级：等门/舱都落位）
      server.scheduleInTicks(60, () => {
        let n = 0
        try { n = c4ActivateHole(server, slot, null) } catch (eH) { console.warn('[C4] 迁移后自动连通 3×3 失败: ' + eH) }
        try {
          clicker.tell(Text.of('⟢ 迁移完成：3×3 洞' + (n > 0 ? '已连通' : '未连通（请手持扩展器朝下双击）') + '。请从洞口下去，到 y=' + C4_TELE_FLOOR + ' 的新按钮启动。'))
        } catch (e1) {}
      })
      return
    }
  }

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

  // S5：目的地与当前维度相同（通常主世界）→ 第一次只提示，10s 内再按才随机传送一次
  let forceRandom = false, randomDim = null
  try {
    // 同维度 = 本次跃迁的目标维度 === 玩家此刻所在维度（不是"传送器在哪个维度"，也不写死主世界）
    let sd0 = 0
    try { sd0 = c4ReadSeed(server, slot) } catch (e0) { sd0 = 0 }
    let targetDim = String(C4_SEED_DIMS[sd0] || C4_SEED_DIMS[0])
    // 固定房间已坏（探针判定）→ 必须先走重建，不能被"同维度二次确认"拦下来
    let fixedEntry0 = c4DestOf(info.cube, targetDim)
    let fixedBad = !!(fixedEntry0 && !c4DestRoomExists(server, fixedEntry0))
    let curDim = (info.cube && info.cube.curDestDim) ? String(info.cube.curDestDim) : null
    if (fixedBad) {
      curDim = null
      console.info('[C4] 固定落点缺失 slot=' + slot + ' @' + fixedEntry0.x + ',' + fixedEntry0.y + ',' + fixedEntry0.z + ' → 本次直接重建（跳过二次确认）')
    }
    console.info('[C4] 同维度判定 slot=' + slot + ' newDim=' + targetDim + ' curDestDim=' + curDim
      + ' → ' + ((curDim && targetDim === curDim) ? '触发确认' : '正常跃迁'))
    if (curDim && targetDim === curDim) {
      let now = Date.now()
      let pend = C4_RANDOM_PENDING[slot]
      if (!pend || now > pend.deadline || String(pend.dim) !== targetDim) {
        C4_RANDOM_PENDING[slot] = { deadline: now + 10000, dim: targetDim }
        c4BtnLog(false, clicker, slot, '同维度：等待第二次确认 ' + targetDim)
        try { clicker.tell(Text.of('⟢ 已连接到 ' + targetDim + ' · 再按一次可随机传送一次（10 秒内）')) } catch (e1) {}
        return
      }
      C4_RANDOM_PENDING[slot] = null
      forceRandom = true
      randomDim = targetDim
    } else {
      C4_RANDOM_PENDING[slot] = null
    }
  } catch (e) { C4_RANDOM_PENDING[slot] = null }

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
    let bp = c4BtnPos(slot)
    server.runCommandSilent('execute in minecraft:overworld run setblock ' + bp.x + ' ' + bp.y + ' ' + bp.z + ' kubejs:launch_button_pressed')
  } catch (e) {}
  c4Enqueue(server, slot, info.key, c4Name(clicker), forceRandom, randomDim)
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
      // /cube 本身对所有人开放（info/home/spawn）；管理命令在 /cube admin 下单独要求权限 4
      let root = cmdRoot.literal(names[i])
      c4AttachSubs(root, cmdRoot, IAT, names[i])
      event.register(root)
    }
    console.info('[C4] 已注册 /cwp 与 /cube')
  } catch (e) {
    console.warn('[C4] 注册命令失败: ' + e)
  }
})

// 扩建命令委托给 cw_expand.js（global.CWE）。模块没加载时就地报错，不影响其它命令。
function c4CweExpand(ctx, face, force) {
  if (!global.CWE || !global.CWE.cmdExpand) { c4Reply(ctx, '扩建模块未加载（cw_expand.js）'); return 0 }
  return global.CWE.cmdExpand(ctx, face, force)
}
function c4CweRebuild(ctx) {
  if (!global.CWE || !global.CWE.cmdRebuild) { c4Reply(ctx, '扩建模块未加载（cw_expand.js）'); return 0 }
  return global.CWE.cmdRebuild(ctx)
}

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

  // 兼容旧入口：/cube admin expand <slot> <face> [force]（保留为别名，实现在 cw_expand.js）
  root.then(cmdRoot.literal('expand').requires(src => src.hasPermission(4))
    .then(cmdRoot.argument('slot', IAT.integer(0))
      .then(cmdRoot.literal('py').executes(ctx => { c4CweExpand(ctx, 'py'); return 1 })
        .then(cmdRoot.literal('force').executes(ctx => { c4CweExpand(ctx, 'py', true); return 1 })))
      .then(cmdRoot.literal('px').executes(ctx => { c4CweExpand(ctx, 'px'); return 1 })
        .then(cmdRoot.literal('force').executes(ctx => { c4CweExpand(ctx, 'px', true); return 1 })))
      .then(cmdRoot.literal('nx').executes(ctx => { c4CweExpand(ctx, 'nx'); return 1 })
        .then(cmdRoot.literal('force').executes(ctx => { c4CweExpand(ctx, 'nx', true); return 1 })))
      .then(cmdRoot.literal('nz').executes(ctx => { c4CweExpand(ctx, 'nz'); return 1 })
        .then(cmdRoot.literal('force').executes(ctx => { c4CweExpand(ctx, 'nz', true); return 1 })))
      .then(cmdRoot.literal('pz').executes(ctx => { c4CweExpand(ctx, 'pz'); return 1 })
        .then(cmdRoot.literal('force').executes(ctx => { c4CweExpand(ctx, 'pz', true); return 1 })))))

  // /cube admin rebuild <slot>：按当前 cells 重算外边界（地板/框梁/屏障/灯），幂等自愈
  root.then(cmdRoot.literal('rebuild').requires(src => src.hasPermission(4))
    .then(cmdRoot.argument('slot', IAT.integer(0)).executes(ctx => { c4CweRebuild(ctx); return 1 })))

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

  // S1 调试：/cube admin face <slot> <up|down|n|s|e|w> <dim> —— 按 tag 点名，只改这一面
  root.then(cmdRoot.literal('face').requires(src => src.hasPermission(4))
    .then(cmdRoot.argument('slot', IAT.integer(0))
      .then(cmdRoot.argument('face', SAT.word())
        .then(cmdRoot.argument('dim', SAT.greedyString()).executes(ctx => {
          c4CmdRetargetFace(ctx, IAT.getInteger(ctx, 'slot'),
            String(SAT.getString(ctx, 'face')), String(SAT.getString(ctx, 'dim')))
          return 1
        })))))


  // 整舱搬迁：/cube admin relocate <slot> <x> <y(按钮)> <z>
  root.then(cmdRoot.literal('relocate').requires(src => src.hasPermission(4))
    .then(cmdRoot.argument('slot', IAT.integer(0))
      .then(cmdRoot.argument('x', IAT.integer(-30000000, 30000000))
        .then(cmdRoot.argument('y', IAT.integer(-30000000, 30000000))
          .then(cmdRoot.argument('z', IAT.integer(-30000000, 30000000)).executes(ctx => {
            c4CmdRelocate(ctx, IAT.getInteger(ctx, 'slot'), IAT.getInteger(ctx, 'x'),
              IAT.getInteger(ctx, 'y'), IAT.getInteger(ctx, 'z'))
            return 1
          }))))))

  // 调试：/cube admin ipcfg on —— 打开 IP looseMovementCheck（root 配置文件，靠服务端进程写）
  root.then(cmdRoot.literal('ipcfg').requires(src => src.hasPermission(4))
    .then(cmdRoot.literal('on').executes(ctx => {
      try {
        let FileCls = Java.loadClass('java.io.File')
        let FilesCls = Java.loadClass('java.nio.file.Files')
        let CharsetCls = Java.loadClass('java.nio.charset.StandardCharsets')
        let f = new FileCls('config/immersive_portals.json')
        let txt = String(FilesCls.readString(f.toPath(), CharsetCls.UTF_8))
        let obj = JSON.parse(txt)
        obj.looseMovementCheck = true
        FilesCls.writeString(f.toPath(), JSON.stringify(obj, null, 2), CharsetCls.UTF_8)
        console.info('[C4] ipcfg: looseMovementCheck=true 已写入（需重启生效）')
        c4Reply(ctx, 'ipcfg: looseMovementCheck=true 已写入（重启后生效）')
      } catch (e) { console.warn('[C4] ipcfg 失败: ' + e); c4Reply(ctx, 'ipcfg 失败: ' + e) }
      return 1
    })))

  // 搬传送器：/cube admin tele <slot> <floorY>（只动传送器，基地不动）
  root.then(cmdRoot.literal('tele').requires(src => src.hasPermission(4))
    .then(cmdRoot.argument('slot', IAT.integer(0))
      .then(cmdRoot.argument('y', IAT.integer(-512, 512)).executes(ctx => {
        c4CmdTele(ctx, IAT.getInteger(ctx, 'slot'), IAT.getInteger(ctx, 'y')); return 1
      }))))

  // 调试：/cube admin hole <slot> —— 直接激活 3×3 基地门（等价朝下双击）
  root.then(cmdRoot.literal('hole').requires(src => src.hasPermission(4))
    .then(cmdRoot.argument('slot', IAT.integer(0)).executes(ctx => {
      c4ActivateHole(ctx.source.server, IAT.getInteger(ctx, 'slot'), null); return 1
    })))

  // 临时解锁：/cube admin ext reset <slot> —— ext 清零并按 17³ 重建舱体+6 门
  root.then(cmdRoot.literal('ext').requires(src => src.hasPermission(4))
    .then(cmdRoot.literal('reset')
      .then(cmdRoot.argument('slot', IAT.integer(0)).executes(ctx => {
        c4CmdExtReset(ctx, IAT.getInteger(ctx, 'slot')); return 1
      }))))

  // S5：/cube admin dest set|show —— 固定目的地管理
  root.then(cmdRoot.literal('dest').requires(src => src.hasPermission(4))
    .then(cmdRoot.literal('set')
      .then(cmdRoot.argument('slot', IAT.integer(0))
        .then(cmdRoot.argument('dim', SAT.string())
          .then(cmdRoot.argument('x', IAT.integer(-30000000, 30000000))
            .then(cmdRoot.argument('y', IAT.integer(-30000000, 30000000))
              .then(cmdRoot.argument('z', IAT.integer(-30000000, 30000000)).executes(ctx => {
                c4CmdDestSet(ctx, IAT.getInteger(ctx, 'slot'), String(SAT.getString(ctx, 'dim')),
                  IAT.getInteger(ctx, 'x'), IAT.getInteger(ctx, 'y'), IAT.getInteger(ctx, 'z'))
                return 1
              })))))))
    .then(cmdRoot.literal('show')
      .then(cmdRoot.argument('slot', IAT.integer(0)).executes(ctx => {
        c4CmdDestShow(ctx, IAT.getInteger(ctx, 'slot')); return 1
      }))))

  // 缩小版：/cube admin bind <slot> <x> <y> <z> —— 按钮锚点（唯一真源），重定义 6 面门生成坐标
  root.then(cmdRoot.literal('bind').requires(src => src.hasPermission(4))
    .then(cmdRoot.argument('slot', IAT.integer(0))
      .then(cmdRoot.argument('x', IAT.integer(-30000000, 30000000))
        .then(cmdRoot.argument('y', IAT.integer(-30000000, 30000000))
          .then(cmdRoot.argument('z', IAT.integer(-30000000, 30000000)).executes(ctx => {
            c4CmdBind(ctx, IAT.getInteger(ctx, 'slot'), IAT.getInteger(ctx, 'x'),
              IAT.getInteger(ctx, 'y'), IAT.getInteger(ctx, 'z'))
            return 1
          }))))))

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
  let s = c4HomeSeat(cube.slot)
  if (c4Tp(ctx.source.server, p, 'minecraft:overworld', s.x, s.y, s.z)) c4ReplyT(ctx, 'cw.home.ok', [cube.name])
  else c4ReplyT(ctx, 'cw.home.fail')
}

function c4CmdHomeSlot(ctx, slot) {
  let p = c4SrcPlayer(ctx)
  if (!p) { c4ReplyT(ctx, 'cw.cmd.need_player'); return }
  let s = c4HomeSeat(slot)
  if (c4Tp(ctx.source.server, p, 'minecraft:overworld', s.x, s.y, s.z)) c4ReplyT(ctx, 'cw.cmd.tp_ok', [])
  else c4ReplyT(ctx, 'cw.cmd.tp_fail')
}

// —— flag=2（UPDATE_CLIENTS）逐块放置：不触发邻接更新，海底砌壳/清内不会倒灌 ——
let C4_BPCls = null
let C4_RLCls = null
let C4_BIRCls = null
function c4Flag2State(id) {
  try {
    if (!C4_BIRCls) C4_BIRCls = Java.loadClass('net.minecraft.core.registries.BuiltInRegistries')
    if (!C4_RLCls) C4_RLCls = Java.loadClass('net.minecraft.resources.ResourceLocation')
    let bl = C4_BIRCls.BLOCK.get(new C4_RLCls(String(id)))
    if (!bl) return null
    let real = String(bl.id || '')
    if (real && real !== String(id)) {
      console.warn('[C4] flag2 解析 ' + id + ' 实际得到 ' + real + ' → 退回命令放置')
      return null
    }
    return bl.defaultBlockState()
  } catch (e) { console.warn('[C4] flag2 解析异常 ' + id + ': ' + e); return null }
}
function c4Flag2Place(lv, x, y, z, state) {
  try {
    if (!C4_BPCls) C4_BPCls = Java.loadClass('net.minecraft.core.BlockPos')
    return lv.setBlock(new C4_BPCls(x | 0, y | 0, z | 0), state, 2) ? 1 : 0
  } catch (e) { return 0 }
}
function c4Flag2One(lv, x, y, z, id) {
  let st = c4Flag2State(id)
  if (!st) return 0
  return c4Flag2Place(lv, x, y, z, st)
}
// 用 flag=2 填一个 box（逐块）；返回实际放置数
function c4Flag2Fill(lv, x0, y0, z0, x1, y1, z1, id) {
  let st = c4Flag2State(id)
  if (!st) {
    // 兜底：拿不到状态就退回命令（区块已加载，命令能正常放置）
    let n = 0
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++)
        for (let z = z0; z <= z1; z++) {
          try { lv.server.runCommandSilent('execute in ' + lv.dimension().location() + ' run setblock ' + x + ' ' + y + ' ' + z + ' ' + id); n++ } catch (e) {}
        }
    console.warn('[C4] flag2 退回命令放置 ' + id + '：' + n + ' 块')
    return n
  }
  let n = 0
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      for (let z = z0; z <= z1; z++) n += c4Flag2Place(lv, x, y, z, st)
  return n
}

// flag2 放置房间内部（地板留 3×3 洞、顶圈、四角、家具、光源）；不碰外壳
function c4PlaceRoomFlag2(lv, b, btn) {
  if (!lv) return
  let FX = Math.floor(b.X0 + 8), FZ = Math.floor(b.Z0 + 8)
  c4Flag2Fill(lv, b.X0, b.Y0, b.Z0, b.X1, b.Y0, b.Z1, 'kubejs:warping_frame_platform')
  c4Flag2Fill(lv, FX - 1, b.Y0, FZ - 1, FX + 1, b.Y0, FZ + 1, 'minecraft:air')
  c4Flag2Fill(lv, b.X0, b.Y1, b.Z0, b.X1, b.Y1, b.Z0, 'kubejs:warping_frame')
  c4Flag2Fill(lv, b.X0, b.Y1, b.Z1, b.X1, b.Y1, b.Z1, 'kubejs:warping_frame')
  c4Flag2Fill(lv, b.X0, b.Y1, b.Z0, b.X0, b.Y1, b.Z1, 'kubejs:warping_frame')
  c4Flag2Fill(lv, b.X1, b.Y1, b.Z0, b.X1, b.Y1, b.Z1, 'kubejs:warping_frame')
  c4Flag2Fill(lv, b.X0, b.Y0, b.Z0, b.X0, b.Y1, b.Z0, 'kubejs:warping_frame')
  c4Flag2Fill(lv, b.X1, b.Y0, b.Z1, b.X1, b.Y1, b.Z1, 'kubejs:warping_frame')
  c4Flag2Fill(lv, b.X0, b.Y0, b.Z1, b.X0, b.Y1, b.Z1, 'kubejs:warping_frame')
  c4Flag2Fill(lv, b.X1, b.Y0, b.Z0, b.X1, b.Y1, b.Z0, 'kubejs:warping_frame')
  c4Flag2One(lv, btn.x, btn.y, btn.z + 1, 'kubejs:warping_controls')
  c4Flag2One(lv, btn.x + 1, btn.y, btn.z + 1, 'kubejs:warping_interface')
  c4Flag2One(lv, btn.x - 1, btn.y, btn.z + 1, 'kubejs:warping_disc_drive')
  c4Flag2One(lv, btn.x, btn.y, btn.z, 'kubejs:launch_button')
  c4Flag2One(lv, FX, b.Y0 + 8, FZ, 'minecraft:light')
}

// 整舱搬迁：先砌封闭外壳 → 清内腔 → 补上下 2 层空气 → 建地板/家具/门 → 清旧锚点
function c4Relocate(server, slot, bx2, by2, bz2) {
  let info = c4TeamOfSlot(slot)
  if (!info || !info.cube) { console.warn('[C4] relocate：槽位 ' + slot + ' 没有登记'); return }
  let cubeId = info.cube.id || ('cube' + slot)
  let ext = c4Ext(info.cube)
  let oldBtn = c4BtnPos(slot)
  let hadLink = false
  try {
    c4PortalsInDim(server, 'minecraft:overworld', oldBtn.x, oldBtn.y, oldBtn.z, 40).forEach(e => {
      if (c4HasTag(e, 'cw_face_link')) hadLink = true
    })
  } catch (eHL) {}
  // 核心由新按钮派生（按钮在 +z 内壁、地板上一格）
  let cx = bx2 + 0.5, cy = by2 + 7.5, cz = bz2 - 6.5
  let b = c4RoomBox(cx, cy, cz, ext)
  let dim = 'minecraft:overworld'
  let run = (cmd) => { try { server.runCommandSilent('execute in ' + dim + ' run ' + cmd) } catch (e) { console.warn('[C4] relocate: ' + e) } }
  console.info('[C4] relocate slot=' + slot + ' 旧btn=' + oldBtn.x + ',' + oldBtn.y + ',' + oldBtn.z
    + ' 新btn=' + bx2 + ',' + by2 + ',' + bz2 + ' box=' + b.X0 + '..' + b.X1 + '/' + b.Y0 + '..' + b.Y1 + '/' + b.Z0 + '..' + b.Z1)
  // ⓪ 先 forceload 目标范围（整数）
  try { server.runCommandSilent('execute in ' + dim + ' run forceload add ' + (b.X0 - 32) + ' ' + (b.Z0 - 32) + ' ' + (b.X1 + 32) + ' ' + (b.Z1 + 32)) } catch (e0) {}
  // ⓪ 密封外箱：box 各边外扩 3 格，flag=2 砌完整外壳（断水），壳与舱之间 3 格空腔清 air
  let lvOw2 = c4OwLevel(server) || c4Level(server, dim)
  if (lvOw2) {
    let XA = b.X0 - 3, XB = b.X1 + 3, YA = b.Y0 - 3, YB = b.Y1 + 3, ZA = b.Z0 - 3, ZB = b.Z1 + 3
    let shellN = c4Flag2Fill(lvOw2, XA, YA, ZA, XB, YB, ZB, 'kubejs:warping_frame')
    c4Flag2Fill(lvOw2, XA + 1, YA + 1, ZA + 1, XB - 1, YB - 1, ZB - 1, 'minecraft:air')
    // 壳外 2 格也清 air（避免水贴在壳上）
    c4Flag2Fill(lvOw2, XA - 2, YA - 2, ZA - 2, XB + 2, YA - 1, ZB + 2, 'minecraft:air')
    c4Flag2Fill(lvOw2, XA - 2, YB + 1, ZA - 2, XB + 2, YB + 2, ZB + 2, 'minecraft:air')
    c4Flag2Fill(lvOw2, XA - 2, YA - 2, ZA - 2, XA - 1, YB + 2, ZB + 2, 'minecraft:air')
    c4Flag2Fill(lvOw2, XB + 1, YA - 2, ZA - 2, XB + 2, YB + 2, ZB + 2, 'minecraft:air')
    c4Flag2Fill(lvOw2, XA - 2, YA - 2, ZA - 2, XB + 2, YB + 2, ZA - 1, 'minecraft:air')
    c4Flag2Fill(lvOw2, XA - 2, YA - 2, ZB + 1, XB + 2, YB + 2, ZB + 2, 'minecraft:air')
    console.info('[C4] 密封外箱=建成 壳内空腔=清空 shell=' + shellN + ' water=0')
  }
  // ① 先清 21×21×21 为 air，再把 17³ 模板放到 -2 偏移（等价“21³ 立方体居中”）
  if (lvOw2) {
    c4Flag2Fill(lvOw2, b.X0 - 2, b.Y0 - 2, b.Z0 - 2, b.X1 + 2, b.Y1 + 2, b.Z1 + 2, 'minecraft:air')
  }
  // 21×21×21 模板：17³ 传送舱居中（偏移 +2），四周 air —— 复制粘贴时整块 21³ 一起搬
  run('place template hexahedron:cw_teleporter21 ' + (b.X0 - 2) + ' ' + (b.Y0 - 2) + ' ' + (b.Z0 - 2))
  // ② 中心 3×3 洞保持 air（默认通向下方的 17×17 跃迁门）
  let FXh = Math.floor(cx), FZh = Math.floor(cz)
  try {
    server.runCommandSilent('execute in ' + dim + ' run fill ' + (FXh - 1) + ' ' + b.Y0 + ' ' + (FZh - 1) + ' ' + (FXh + 1) + ' ' + b.Y0 + ' ' + (FZh + 1) + ' minecraft:air')
  } catch (eLock) {}
  // ③ 洞正下方 1 格深水池（3×3 水源，落点防摔）
  let lvW = c4OwLevel(server) || c4Level(server, dim)
  if (lvW) {
    // 水池会泡住 3×3 门平面（实测导致实体不传送）→ 改为空气，保持门面畅通
    try { c4Flag2Fill(lvW, FXh - 1, b.Y0 - 1, FZh - 1, FXh + 1, b.Y0 - 1, FZh + 1, 'minecraft:air') } catch (eW) {}
    console.info('[C4] relocate 舱内洞下方=air（无水池，3×3 门面畅通）')
  }
  // ④ 补光源（模板未必带）
  if (lvW) { try { c4Flag2One(lvW, FXh, b.Y0 + 8, FZh, 'minecraft:light') } catch (eL) {} }
  // ⑤ 清旧锚点：旧 6 门 + 旧按钮/操控台/接口/唱片机（旧房间壳保留）
  let killed = 0
  try {
    c4All(server).forEach(e => {
      try {
        if (!c4IsPortal(e)) return
        if (c4DimOf(e) !== dim) return
        if (c4HasTag(e, 'cw_lobby') || c4HasTag(e, 'cw_link') || c4HasTag(e, 'cw_face_link')) return
        if (!(c4HasTag(e, 'cw_id_' + cubeId) || c4HasTag(e, 'cw_slot' + slot))) return
        e.discard(); killed++
      } catch (err) {}
    })
  } catch (e3) {}
  // 旧位置的老门可能没有 cw_id_/cw_slot tag（数据包直接 cb_make_portal 建的）→ 按几何再清一次
  try {
    let oc = { x: c4CubeX(slot) + 0.5, y: C4_CORE_Y, z: C4_Z + 0.5 }
    server.runCommandSilent('execute in minecraft:overworld positioned ' + oc.x + ' ' + oc.y + ' ' + oc.z
      + ' run kill @e[type=immersive_portals:portal,distance=..40,tag=!cw_lobby,tag=!cw_link,tag=!cw_face_link,tag=!cw_face_link_base]')
  } catch (eKillOld) {}
  // 只有新旧锚点不同才清旧家具（同一位置时不能把刚放好的擦掉）
  try {
    let same = (oldBtn.x === bx2 && oldBtn.y === by2 && oldBtn.z === bz2)
    if (!same) {
      server.runCommandSilent('execute in ' + dim + ' run setblock ' + oldBtn.x + ' ' + oldBtn.y + ' ' + oldBtn.z + ' minecraft:air')
      server.runCommandSilent('execute in ' + dim + ' run setblock ' + oldBtn.x + ' ' + oldBtn.y + ' ' + (oldBtn.z + 1) + ' minecraft:air')
      server.runCommandSilent('execute in ' + dim + ' run setblock ' + (oldBtn.x + 1) + ' ' + oldBtn.y + ' ' + (oldBtn.z + 1) + ' minecraft:air')
      server.runCommandSilent('execute in ' + dim + ' run setblock ' + (oldBtn.x - 1) + ' ' + oldBtn.y + ' ' + (oldBtn.z + 1) + ' minecraft:air')
    }
  } catch (e4) {}
  // ⑥ 写锚点 + 在新位置建 6 门并指固定目的地
  info.cube.btn = { x: bx2, y: by2, z: bz2 }
  info.cube.tele = { x: bx2, y: by2 - 1, z: bz2 - 7 }
  c4Save()
  let tp = { x: cx, y: cy, z: cz }
  let made = 0
  try { made = c4MakeRoomPortals(server, slot, cubeId, ext, tp) } catch (e5) { console.warn('[C4] relocate 建门失败: ' + e5) }
  let seed = 0
  try { seed = c4ReadSeed(server, slot) } catch (e6) { seed = 0 }
  let dest = c4DestOf(info.cube, C4_SEED_DIMS[seed] || C4_SEED_DIMS[0])
  let bc1 = c4BaseCore(slot)
  let rDimId = dest ? String(dest.dim) : 'hexahedron:bedrock_bottom'
  let rpx = dest ? (Number(dest.x) + 0.5) : bc1.x
  let rpy = dest ? (Number(dest.y) + 0.5) : bc1.y
  let rpz = dest ? (Number(dest.z) + 0.5) : bc1.z
  try {
    c4Retarget(server, tp.x, tp.y, tp.z, c4DimKey(rDimId), rpx, rpy, rpz, false, rDimId, cubeId, ext, false, slot)
  } catch (e7) {}
  // 搬家/第一次指门后同样补反向门（否则到了目的地回不来）
  server.scheduleInTicks(20, () => {
    try { c4MakeReverse(server, slot, rDimId, rpx, rpy, rpz, cubeId) }
    catch (eR1) { console.warn('[C4] relocate 反向门失败: ' + eR1) }
  })
  // 门洞清理会把 down/up 面整层 17×17 清掉（含地板/操控台/按钮）→ 建完门后立刻补回来
  try { c4PlaceRoomFlag2(c4OwLevel(server) || c4Level(server, dim), b, { x: bx2, y: by2, z: bz2 }) } catch (e9) {}
  // 外壳那圈 structure_void（防止透视/放置漏到结构体外）
  try { c4ShellFill(server, dim, b, 'minecraft:structure_void') } catch (eSh2) { console.warn('[C4] relocate 外壳失败: ' + eSh2) }
  server.scheduleInTicks(20, () => {
    try { c4EnsureSix(server, slot, cubeId, tp.x, tp.y, tp.z, ext, 2) } catch (e8) {}
    try { c4PlaceRoomFlag2(c4OwLevel(server) || c4Level(server, dim), b, { x: bx2, y: by2, z: bz2 }) } catch (e10) {}
  })
  // down 门 destination 对齐库里 dests（防止沿用过期落点）
  try {
    let seedD = 0
    try { seedD = c4ReadSeed(server, slot) } catch (eS) { seedD = 0 }
    let dd = c4DestOf(info.cube, C4_SEED_DIMS[seedD] || C4_SEED_DIMS[0])
    if (dd) {
      server.runCommandSilent('execute in minecraft:overworld positioned ' + tp.x + ' ' + tp.y + ' ' + tp.z
        + ' run data merge entity @e[type=immersive_portals:portal,tag=cw_face_down,distance=..12,limit=1] '
        + '{destinationX:' + (Number(dd.x) + 0.5) + 'd,destinationY:' + (Number(dd.y) + 0.5) + 'd,destinationZ:' + (Number(dd.z) + 0.5) + 'd,dimensionTo:"' + String(dd.dim) + '"}')
      console.info('[C4] down dest=' + dd.dim + ' @' + (Number(dd.x) + 0.5) + ',' + (Number(dd.y) + 0.5) + ',' + (Number(dd.z) + 0.5))
    }
  } catch (eDD) {}
  // 3×3 洞不自动生成：搬家后保留玩家自己激活的那对门（要重建就 /cube admin hole）
  console.info('[C4] relocate 完成 slot=' + slot + ' 旧=' + oldBtn.x + ',' + oldBtn.y + ',' + oldBtn.z
    + ' → 新=' + bx2 + ',' + by2 + ',' + bz2 + ' 门=' + made + ' 旧门清=' + killed + ' link恢复=' + hadLink)
}

function c4CmdRelocate(ctx, slot, x, y, z) {
  let server = ctx.source.server
  let info = c4TeamOfSlot(slot)
  if (!info || !info.cube) { c4Reply(ctx, '槽位 ' + slot + ' 没有登记'); return }
  let lv = c4Level(server, 'minecraft:overworld')
  let minY = -64, maxY = 320
  try { if (lv) { minY = Number(lv.getMinBuildHeight()); maxY = Number(lv.getMaxBuildHeight()) } } catch (e0) {}
  let by2 = Math.floor(Number(y))
  let ext = c4Ext(info.cube)
  if (by2 - 4 < minY || by2 + 18 + 16 * ext.py > maxY - 1) { c4Reply(ctx, 'y 不合法（含扩展高度）：' + minY + '..' + maxY); return }
  let bx3 = Math.floor(Number(x)), bz3 = Math.floor(Number(z))
  // 先同步 forceload 目标区，20t 后再真正搬迁（等区块加载完成，flag=2 setBlock 才写得进去）
  try {
    server.runCommandSilent('execute in minecraft:overworld run forceload add ' + (bx3 - 48) + ' ' + (bz3 - 48) + ' ' + (bx3 + 48) + ' ' + (bz3 + 48))
  } catch (eF) {}
  let g = C4_GEN
  server.scheduleInTicks(20, () => {
    if (g !== C4_GEN) { console.info('[C4] 旧世代回调丢弃（relocate）'); return }
    c4Relocate(server, slot, bx3, by2, bz3)
  })
  c4Reply(ctx, 'relocate 已排队：slot=' + slot + ' → btn=' + bx3 + ',' + by2 + ',' + bz3 + '（20t 后执行）')
}

function c4CmdExtReset(ctx, slot) {
  let server = ctx.source.server
  let info = c4TeamOfSlot(slot)
  if (!info || !info.cube) { c4Reply(ctx, '槽位 ' + slot + ' 没有登记'); return }
  let old = c4Ext(info.cube)
  let zero = { px: 0, nx: 0, pz: 0, nz: 0, py: 0 }
  info.cube.ext = zero
  c4Save()
  let tp = c4TeleCore(slot)
  try { c4DoorPreload(server, zero, tp) } catch (e0) {}
  // 完整重建（测试服清内腔无所谓）：地板/墙/操控台/按钮/光源全部补齐，再重建门
  try { c4BuildRoom(server, 'minecraft:overworld', tp.x, tp.y, tp.z, zero, false, 'all', null, slot) }
  catch (e1) { console.warn('[C4] ext reset 重建舱体失败: ' + e1) }
  console.info('[C4] ext reset slot=' + slot + ' 旧=' + JSON.stringify(old) + ' → {0,0,0,0,0}')
  c4CmdDoors(ctx, slot)
  // 兜底：20t 后探测地板/操控台/按钮/光源，缺哪个补哪个（不依赖前面的顺序）
  server.scheduleInTicks(20, () => {
    try {
      let b2 = c4RoomBox(tp.x, tp.y, tp.z, zero)
      let FX2 = Math.floor(tp.x), FZ2 = Math.floor(tp.z)
      let bp2 = c4BtnPos(slot)
      let at = 'execute in minecraft:overworld positioned '
      server.runCommandSilent(at + (FX2 - 3) + ' ' + b2.Y0 + ' ' + FZ2
        + ' if block ~ ~ ~ minecraft:air run fill ' + b2.X0 + ' ' + b2.Y0 + ' ' + b2.Z0 + ' ' + b2.X1 + ' ' + b2.Y0 + ' ' + b2.Z1 + ' kubejs:warping_frame_platform')
      server.runCommandSilent(at + (bp2.x) + ' ' + bp2.y + ' ' + (bp2.z + 1)
        + ' if block ~ ~ ~ minecraft:air run setblock ~ ~ ~ kubejs:warping_controls')
      server.runCommandSilent(at + (bp2.x + 1) + ' ' + bp2.y + ' ' + (bp2.z + 1)
        + ' if block ~ ~ ~ minecraft:air run setblock ~ ~ ~ kubejs:warping_interface')
      server.runCommandSilent(at + (bp2.x) + ' ' + bp2.y + ' ' + bp2.z
        + ' if block ~ ~ ~ minecraft:air run setblock ~ ~ ~ kubejs:launch_button[facing=north]')
      server.runCommandSilent(at + (FX2) + ' ' + (b2.Y0 + 8) + ' ' + FZ2
        + ' if block ~ ~ ~ minecraft:air run setblock ~ ~ ~ minecraft:light[level=15]')
      console.info('[C4] ext reset 兜底补建 slot=' + slot + '（floor/ctrl/interface/btn/light 缺则补）')
    } catch (eF) { console.warn('[C4] ext reset 兜底失败: ' + eF) }
  })
}

// 只搬传送器（基地/方块都不动）：清旧舱 → 换绑 → 新位置建舱 → 重建 3×3 隧道
function c4CmdTele(ctx, slot, floorY) {
  let server = ctx.source.server
  let h = c4TeamOfSlot(slot)
  if (!h || !h.cube) { c4Reply(ctx, '槽位 ' + slot + ' 没有登记'); return }
  // 范围限制：传送器只能放在基地【下方 <=78】或【上方 >=180】（基地本体占 97..113）
  let fy = Math.floor(Number(floorY))
  if (isNaN(fy) || !(fy <= 78 || fy >= 180)) {
    c4Reply(ctx, 'y 只能 <=78（基地下方）或 >=180（基地上方）；基地本体占 97..113')
    return
  }
  let oldA = c4TeleAnchor(slot)
  let bx = Math.floor(c4CubeX(slot)), bz = Math.floor(C4_Z) + 7
  let by = fy + 1
  // ⓪ 清旧舱（17³）+ 旧链接门 + 旧玻璃
  try {
    server.runCommandSilent('execute in minecraft:overworld run fill ' + (oldA.x - 8) + ' ' + oldA.y + ' ' + (oldA.z - 8)
      + ' ' + (oldA.x + 8) + ' ' + (oldA.y + 16) + ' ' + (oldA.z + 8) + ' minecraft:air')
    server.runCommandSilent('execute in minecraft:overworld positioned ' + (oldA.x + 0.5) + ' ' + (oldA.y + 0.5) + ' ' + (oldA.z + 0.5)
      + ' run kill @e[type=immersive_portals:portal,tag=cw_link,distance=..12]')
    console.info('[C4] tele 清旧舱 @' + oldA.x + ',' + oldA.y + ',' + oldA.z)
  } catch (e0) {}
  // ① 换绑 + 落库
  h.cube.btn = { x: bx, y: by, z: bz }
  h.cube.tele = { x: bx, y: by - 1, z: bz - 7 }
  c4Save()
  // ② 新位置建舱（17³ 模板 + 6 门 + 反向门）
  let a = c4TeleAnchor(slot)
  try { c4BuildTeleporter(server, slot, a) } catch (e1) { console.warn('[C4] tele 建舱失败: ' + e1) }
  // ③ 40t 后重建 3×3 隧道（等门/舱落位）
  server.scheduleInTicks(40, () => {
    try { c4ActivateHole(server, slot, null) } catch (e2) { console.warn('[C4] tele 隧道失败: ' + e2) }
  })
  console.info('[C4] tele slot=' + slot + ' 旧=' + oldA.x + ',' + oldA.y + ',' + oldA.z + ' → 新=' + a.x + ',' + a.y + ',' + a.z + '（按钮 ' + bx + ',' + by + ',' + bz + '）')
  c4Reply(ctx, '传送器 slot' + slot + ' → floor=' + (by - 1) + ' 按钮=' + bx + ',' + by + ',' + bz)
}

function c4CmdDoors(ctx, slot) {
  let server = ctx.source.server
  let h = c4TeamOfSlot(slot)
  if (!h || !h.cube) { c4Reply(ctx, '槽位 ' + slot + ' 没有登记'); return }
  let cubeId = h.cube.id || ('cube' + slot)
  let ext = c4Ext(h.cube)
  let ext0 = { px: 0, nx: 0, pz: 0, nz: 0, py: 0 }   // 传送器固定 17³
  let tp = c4TeleCore(slot)
  let chunks = c4DoorPreload(server, ext0, tp)
  // 只杀本台的门（portal 实体），绝不碰方块/别人的门/大厅门
  let killed = 0
  try {
    c4All(server).forEach(e => {
      try {
        if (!c4IsPortal(e)) return
        if (c4DimOf(e) !== 'minecraft:overworld') return
        if (c4HasTag(e, 'cw_lobby') || c4HasTag(e, 'cw_link') || c4HasTag(e, 'cw_face_link')) return
        if (!(c4HasTag(e, 'cw_id_' + cubeId) || c4HasTag(e, 'cw_slot' + slot))) return
        e.discard(); killed++
      } catch (err) {}
    })
  } catch (e1) {}
  let made = 0
  try { made = c4MakeRoomPortals(server, slot, cubeId, ext0, tp) } catch (e2) { console.warn('[C4] 造门失败: ' + e2) }
  let seed = 0
  try { seed = c4ReadSeed(server, slot) } catch (e3) { seed = 0 }
  let dest = c4DestOf(h.cube, C4_SEED_DIMS[seed] || C4_SEED_DIMS[0])
  let aimed = 0
  let bc = c4BaseCore(slot)
  let rDimId = dest ? String(dest.dim) : 'hexahedron:bedrock_bottom'
  let rpx = dest ? (dest.x + 0.5) : bc.x
  let rpy = dest ? (dest.y + 0.5) : bc.y
  let rpz = dest ? (dest.z + 0.5) : bc.z
  try {
    aimed = c4Retarget(server, tp.x, tp.y, tp.z, c4DimKey(rDimId), rpx, rpy, rpz, false, rDimId, cubeId, ext0, false, slot)
  } catch (e4) { console.warn('[C4] 指门失败: ' + e4) }
  server.scheduleInTicks(20, () => {
    try { c4EnsureSix(server, slot, cubeId, tp.x, tp.y, tp.z, ext0, 2) } catch (e5) {}
  })
  // 反向门尺寸是从正向门复制的：正向门重建后必须一起重建，否则反向门还是旧尺寸。
  // 另外要把【历史目的地】上的旧反向门也清掉（几何改过好几轮，那些是 17×17/8.51 的残留）。
  server.scheduleInTicks(30, () => {
    try { c4MakeReverse(server, slot, rDimId, rpx, rpy, rpz, cubeId) } catch (e6) { console.warn('[C4] doors 反向门失败: ' + e6) }
    try {
      let ds = (h.cube && h.cube.dests) || {}
      for (let dk in ds) {
        let de = ds[dk]
        if (!de || de.x === undefined) continue
        if (String(dk) === String(rDimId)) continue
        try {
          server.runCommandSilent('execute in ' + dk + ' positioned ' + (Number(de.x) + 0.5) + ' ' + (Number(de.y) + 0.5) + ' ' + (Number(de.z) + 0.5)
            + ' run kill @e[type=immersive_portals:portal,name=!main_cube,distance=..100]')
          console.info('[C4] 清理历史反向门 slot=' + slot + ' dim=' + dk + ' @' + de.x + ',' + de.y + ',' + de.z)
        } catch (e7) {}
      }
    } catch (e8) {}
  })
  console.info('[C4] /cwp doors ' + slot + ' ext=' + JSON.stringify(ext) + ' 预载=' + chunks + ' chunks 清旧门=' + killed + ' 重建=' + made + ' 指向=' + aimed)
  c4Reply(ctx, '槽位 ' + slot + ' 门重建：清 ' + killed + ' / 建 ' + made + ' / 指 ' + aimed + '（ext=' + JSON.stringify(ext) + '）')
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
    let dkeys = Object.keys(c4Dests(c))
    let dd = dkeys.length ? ('  落点表 ' + dkeys.length + ' 个维度') : ''
    c4Reply(ctx, 'slot' + c.slot + ' id=' + (c.id || '?') + ' x=' + c.x + ' 《' + c.name + '》' + (c.provisioned ? '' : ' [未建造]') + dd)
  }
  let orphans = c4OrphanSlots()
  if (orphans.length > 0) c4Reply(ctx, '孤儿车厢 ' + orphans.length + ' 台: ' + orphans.map(o => 'slot' + o.cube.slot).join(' '))
  c4Reply(ctx, '队列 ' + C4_Q.length + (C4_BUSY ? (' · 正在飞 slot' + C4_BUSY.slot) : ''))
}

function c4CmdPortals(ctx, slot) {
  let server = ctx.source.server
  let tp = c4TeleCore(slot)
  let ps = c4PortalsNear(server, tp.x, tp.y, tp.z)
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
// clearMode：'all'  = 首次创建/重建，整块内腔清空；其它值 = 不清
// oldExt 参数保留只为兼容旧调用点，已不再使用（扩建/拆除已改走 cw_expand.js 的格子模型）
function c4BuildRoom(server, dimId, cx, cy, cz, ext, fillHole, clearMode, oldExt, slot) {
  let b = c4RoomBox(cx, cy, cz, ext)
  // —— 越界防御（只报警 + 夹取核心 y，不中断流程）——
  // 房间连外壳占 Y0-1..Y1+1；越界时 fill/setblock 会被 runCommandSilent 静默拒绝，
  // 表现就是"门在、笼子只有一半、里面全黑、玩家卡在基岩里"。所以宁可把整间房平移进合法区间。
  try {
    let lv = c4Level(server, dimId)
    if (lv) {
      let minY = Number(lv.getMinBuildHeight()), maxY = Number(lv.getMaxBuildHeight())
      if (b.Y0 - 1 < minY || b.Y1 + 1 >= maxY) {
        let py = Math.max(0, (ext && Number(ext.py)) | 0)
        // 房间几何：Y0 = i-8, Y1 = i+8+16py（i = 核心整数 y）→ 含外壳解出 i 的合法区间
        let iLo = minY + 9, iHi = maxY - 10 - 16 * py
        let i = Math.round(cy - 0.5)
        i = Math.max(iLo, Math.min(iHi, i))
        console.warn('[C4] 房间越界 dim=' + dimId + ' cy=' + cy + ' Y0=' + b.Y0 + ' Y1=' + b.Y1 +
          '（含外壳需 ' + (minY + 1) + '..' + (maxY - 2) + '）→ 核心 y 夹到 ' + (i + 0.5))
        cy = i + 0.5
        b = c4RoomBox(cx, cy, cz, ext)
      }
    }
  } catch (e) { console.warn('[C4] 房间越界检查失败: ' + e) }
  let FX = Math.floor(cx), FZ = Math.floor(cz)
  let run = (cmd) => {
    console.info('[C4-BUILD] ' + cmd)
    try { server.runCommandSilent('execute in ' + dimId + ' run ' + cmd) } catch (e) { console.warn('[C4] 房间: ' + e) }
  }
  // 大尺寸房间整块 fill 会超过 32768 上限（49×17×49=40817）→ 命令静默失败、旧方块留在原地。
  // 按 8 格一层清，单条最大 49×8×49=19208。
  // 扩建/拆除已改走 cw_expand.js 的格子模型；这里只保留 'all'（首次创建/重建）。
  // oldExt 参数保留只为兼容旧调用点，已不再使用。
  let mode = clearMode || 'all'
  if (mode === 'all') {
    for (let yy = b.Y0; yy <= b.Y1; yy += 8) {
      let y2 = Math.min(yy + 7, b.Y1)
      run(`fill ${b.X0} ${yy} ${b.Z0} ${b.X1} ${y2} ${b.Z1} minecraft:air`)
    }
  }
  if (slot !== undefined && slot !== null && slot >= 0) {
    console.info('[BUILD] slot=' + slot + ' core=' + cx + ',' + cy + ',' + cz
      + ' box=' + b.X0 + '..' + b.X1 + ' / ' + b.Y0 + '..' + b.Y1 + ' / ' + b.Z0 + '..' + b.Z1)
  }
  let floorCmd = 'fill ' + b.X0 + ' ' + b.Y0 + ' ' + b.Z0 + ' ' + b.X1 + ' ' + b.Y0 + ' ' + b.Z1 + ' kubejs:warping_frame_platform'
  let floorRet = -1
  try { floorRet = Number(server.runCommandSilent('execute in ' + dimId + ' run ' + floorCmd)) } catch (eF) { floorRet = -2 }
  if (slot !== undefined && slot !== null && slot >= 0) {
    console.info('[BUILD] floor 命令=' + floorCmd + ' ret=' + floorRet)
  }
  // 目的地那一侧必须把 3×3 洞口封上（原包用 filling，这里用 structure_void）：否则从天花板落进来的人
  // 会继续穿过地板洞 → 反向门 → 又被送回起点，形成"一直下落"的死循环。起飞侧保持洞口敞开。
  if (fillHole) run(`fill ${FX - 1} ${b.Y0} ${FZ - 1} ${FX + 1} ${b.Y0} ${FZ + 1} minecraft:structure_void`)
  else run(`fill ${FX - 1} ${b.Y0} ${FZ - 1} ${FX + 1} ${b.Y0} ${FZ + 1} minecraft:air`)
  run(`fill ${b.X0} ${b.Y1} ${b.Z0} ${b.X1} ${b.Y1} ${b.Z0} kubejs:warping_frame`)
  run(`fill ${b.X0} ${b.Y1} ${b.Z1} ${b.X1} ${b.Y1} ${b.Z1} kubejs:warping_frame`)
  run(`fill ${b.X0} ${b.Y1} ${b.Z0} ${b.X0} ${b.Y1} ${b.Z1} kubejs:warping_frame`)
  run(`fill ${b.X1} ${b.Y1} ${b.Z0} ${b.X1} ${b.Y1} ${b.Z1} kubejs:warping_frame`)
  run(`fill ${b.X0} ${b.Y0} ${b.Z0} ${b.X0} ${b.Y1} ${b.Z0} kubejs:warping_frame`)
  run(`fill ${b.X1} ${b.Y0} ${b.Z1} ${b.X1} ${b.Y1} ${b.Z1} kubejs:warping_frame`)
  run(`fill ${b.X0} ${b.Y0} ${b.Z1} ${b.X0} ${b.Y1} ${b.Z1} kubejs:warping_frame`)
  run(`fill ${b.X1} ${b.Y0} ${b.Z0} ${b.X1} ${b.Y1} ${b.Z0} kubejs:warping_frame`)
  // S4：有按钮锚点时，操控台/按钮固定在锚点（+z 墙面外移也不会带着它们走）
  let bpx = FX, bpy = b.Y0 + 1, bpz = b.Z1
  try {
    if (slot !== undefined && slot !== null && slot >= 0) {
      let bb = c4BtnPos(slot)
      bpx = bb.x; bpy = bb.y; bpz = bb.z + 1
    }
  } catch (e0) {}
  if (slot !== undefined && slot !== null && slot >= 0) {
    console.info('[BUILD] c4BtnPos=' + c4BtnPos(slot).x + ',' + c4BtnPos(slot).y + ',' + c4BtnPos(slot).z
      + ' → 面板=' + bpx + ',' + bpy + ',' + bpz + ' 按钮=' + bpx + ',' + bpy + ',' + (bpz - 1))
  }
  run(`setblock ${bpx} ${bpy} ${bpz} kubejs:warping_controls`)
  run(`setblock ${bpx + 1} ${bpy} ${bpz} kubejs:warping_interface`)
  run(`setblock ${bpx - 1} ${bpy} ${bpz} kubejs:warping_disc_drive`)
  run(`setblock ${bpx} ${bpy} ${bpz - 1} kubejs:launch_button[facing=north]`)
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
    // 排气孔要配 marker：数据包 effects/vents 是按 tag=vent 的 marker 喷粒子的
    let vents = [
      [b.X1, b.Y0 + 1, b.Z1], [b.X0, b.Y0 + 5, b.Z1], [b.X1, b.Y1 - 5, b.Z0],
      [b.X0, b.Y1, FZ], [FX + 4, b.Y1, b.Z1], [b.X0, b.Y0, FZ - 4]
    ]
    if (slot !== undefined && slot !== null && slot >= 0) {
      run(`kill @e[type=marker,tag=c4vent${slot}]`)
      vents.forEach(q => run(`summon marker ${q[0]} ${q[1]} ${q[2]} {Tags:["vent","c4vent${slot}"]}`))
    }
  } catch (e) {}
  if (fillHole) {
    // 目的地：内侧墙面只把框梁之间的空气补成 filling（不动框梁/地板/面板/门）
    run(`fill ${b.X1} ${b.Y0 + 1} ${b.Z0 + 1} ${b.X1} ${b.Y1 - 1} ${b.Z1 - 1} minecraft:structure_void replace minecraft:air`)
    run(`fill ${b.X0} ${b.Y0 + 1} ${b.Z0 + 1} ${b.X0} ${b.Y1 - 1} ${b.Z1 - 1} minecraft:structure_void replace minecraft:air`)
    run(`fill ${b.X0 + 1} ${b.Y0 + 1} ${b.Z1} ${b.X1 - 1} ${b.Y1 - 1} ${b.Z1} minecraft:structure_void replace minecraft:air`)
    run(`fill ${b.X0 + 1} ${b.Y0 + 1} ${b.Z0} ${b.X1 - 1} ${b.Y1 - 1} ${b.Z0} minecraft:structure_void replace minecraft:air`)
    run(`fill ${b.X0 + 1} ${b.Y1} ${b.Z0 + 1} ${b.X1 - 1} ${b.Y1} ${b.Z1 - 1} minecraft:structure_void replace minecraft:air`)
  }
  // 外壳（贴着框梁外表面的那一格，6 面 + 12 棱 + 8 角）：
  //   主世界 → structure_void（不是只填空气，门边不会和框梁 z-fighting）
  //   目的地 → 不再铺 air 外壳：目的地副本就是纯净 17³（少一圈 19³ 的挖掘，省事也省性能）
  if (!fillHole) {
    try { c4ShellFill(server, dimId, b, 'minecraft:structure_void') }
    catch (e) { console.warn('[C4] 外壳填充失败: ' + e) }
  }
  return b
}
// 6 扇门：位置/尺寸都按当前 ext 算（矩形门）
// 6 个门面的期望坐标/尺寸（扩展/校验/建门共用同一张表）
// ext 感知的六面门面中心：一律由 c4RoomBox 推导（外壳外 0.51）
// 每面独立偏移表（相对【按钮方块坐标】，方块中心坐标系；每级扩展 ±16）
// 方向键：w=-x e=+x n=-z s=+z d=-y u=+y
// 门面平面 = 框梁方块【厚度的一半】（±8.0 而不是贴外表面的 ±8.51）：
// 面往里退半格后，门的边缘被框梁包住，从里面看不到"门边和框梁之间漏出外面"的缝。
// 门面平面 = 立方体外表面【再往外 1/16 格】（±8.5625）。
// 之前退到框梁中点（±8.0）时，+z 面的门面正好切在操控台那一格（z=8）里，
// 导致那一格的运算符放不进去（IP 的跨门碰撞挡住了）。
// 四面统一：门面 = 立方体外表面【再往外 1/16】（±8.5625）＝「内 15/16、外 1/16」
// 侧面：门面 = 立方体【外表面往内 1/16 格】（核心 ±8.4375）。
// 这样 15×15 的门边正好落在框梁内侧面，且往内退 1/16 → 斜看时射线先撞到框梁内侧面，
// 不会从门边缝里看到主世界外部；来源门与反向门用同一张表 → 两侧严格对齐。
const C4_FACES = {
  w: { x: -7.9375, y: 7.50, z: -6.50, ext: 'nx', sign: -1 },
  e: { x: 8.9375, y: 7.50, z: -6.50, ext: 'px', sign: 1 },
  n: { x: 0.50, y: 7.50, z: -14.9375, ext: 'nz', sign: -1 },
  s: { x: 0.50, y: 7.50, z: 1.9375, ext: 'pz', sign: 1 },
  d: { x: 0.50, y: -0.75, z: -6.50, ext: null, sign: 0 },
  u: { x: 0.50, y: 15.75, z: -6.50, ext: 'py', sign: 1 }
}
const C4_DIR2FACE = { 'x': 'e', '-x': 'w', 'z': 's', '-z': 'n', 'y': 'u', '-y': 'd' }
// 核心 → 按钮方块坐标（表以按钮为基准）
function c4CoreToBtn(cx, cy, cz) { return { x: cx - 0.5, y: cy - 7.5, z: cz + 6.5 } }
// 门面中心：只走 C4_FACES 表 + ext 距离（不再由 core 推导、也不再用 box 边界）
function c4FacePos(cx, cy, cz, ext, dir) {
  let b = c4CoreToBtn(cx, cy, cz)
  return c4FacePosByBtn(b, ext, dir)
}
function c4FacePosByBtn(b, ext, dir) {
  let f = C4_FACES[C4_DIR2FACE[dir]]
  if (!f) return null
  let e = ext || {}
  let lv = f.ext ? (Number(e[f.ext]) || 0) : 0
  let dd = lv * (f.sign || 0) * 16
  let x = b.x + f.x, y = b.y + f.y, z = b.z + f.z
  if (f.ext === 'nx' || f.ext === 'px') x += dd
  else if (f.ext === 'nz' || f.ext === 'pz') z += dd
  else if (f.ext === 'py') y += dd
  return { x: x, y: y, z: z }
}
function c4FaceTargets(cx, cy, cz, ext) {
  let e = ext || { px: 0, nx: 0, pz: 0, nz: 0, py: 0 }
  let b = c4RoomBox(cx, cy, cz, e)
  let wx = b.X1 - b.X0 + 1, wz = b.Z1 - b.Z0 + 1, wy = b.Y1 - b.Y0 + 1
  return {
    'y':  { p: (function () { let q = c4FacePos(cx, cy, cz, e, 'y'); return [q.x, q.y, q.z] })(), w: wx, h: wz, rot: [0, -90] },
    '-y': { p: (function () { let q = c4FacePos(cx, cy, cz, e, '-y'); return [q.x, q.y, q.z] })(), w: wx, h: wz, rot: [0, 90] },
    'x':  { p: (function () { let q = c4FacePos(cx, cy, cz, e, 'x'); return [q.x, q.y, q.z] })(), w: wz, h: wy, rot: [270, 0] },
    '-x': { p: (function () { let q = c4FacePos(cx, cy, cz, e, '-x'); return [q.x, q.y, q.z] })(), w: wz, h: wy, rot: [90, 0] },
    'z':  { p: (function () { let q = c4FacePos(cx, cy, cz, e, 'z'); return [q.x, q.y, q.z] })(), w: wx, h: wy, rot: [0, 0] },
    '-z': { p: (function () { let q = c4FacePos(cx, cy, cz, e, '-z'); return [q.x, q.y, q.z] })(), w: wx, h: wy, rot: [180, 0] }
  }
}

// ---------------------------------------------------------------------------- S1 门 ID（稳定 tag）
// 每扇门都必须带齐：cw_face_up|down|n|s|e|w、cw_team_<清洗后的队伍主键>、cw_slot<slot>、cw_id_<cubeId>；
// 反向门额外 cw_rev（兼容 c4KillReverses）与 cw_rev_<cubeId>。
// 约定：North=-z，South=+z，West=-x，East=+x，Up=+y，Down=-y。
// 有了这套 tag，建门/校验/指门/搬门都不再靠 ±8.51 几何猜。
const C4_FACE_DIRS = ['y', '-y', '-z', 'z', 'x', '-x']   // up / down / n / s / e / w
const C4_FACE_TAGS = {
  'y': 'cw_face_up', '-y': 'cw_face_down',
  '-z': 'cw_face_n', 'z': 'cw_face_s',
  'x': 'cw_face_e', '-x': 'cw_face_w'
}
const C4_FACE_TAG_LIST = ['cw_face_up', 'cw_face_down', 'cw_face_n', 'cw_face_s', 'cw_face_e', 'cw_face_w']
const C4_FACE_BY_TAG = {
  'cw_face_up': 'y', 'cw_face_down': '-y',
  'cw_face_n': '-z', 'cw_face_s': 'z',
  'cw_face_e': 'x', 'cw_face_w': '-x'
}
function c4FaceTag(d) { return C4_FACE_TAGS[d] || null }
// 接受 up/down/n/s/e/w（也接受内部的 y/-y/x/-x/z/-z）
function c4FaceKey(arg) {
  let s = String(arg === null || arg === undefined ? '' : arg).toLowerCase()
  if (C4_FACE_TAGS[s]) return s
  if (s === 'up') return 'y'
  if (s === 'down') return '-y'
  if (s === 'n' || s === 'north') return '-z'
  if (s === 's' || s === 'south') return 'z'
  if (s === 'e' || s === 'east') return 'x'
  if (s === 'w' || s === 'west') return '-x'
  return null
}
function c4TagHash(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
// tag 里不能有空格/特殊字符：只留 [a-z0-9_]，被替换或截断时补短哈希防撞
function c4TagSafe(s) {
  let raw = String(s === null || s === undefined ? '' : s).toLowerCase()
  let out = raw.replace(/[^a-z0-9_]/g, '_')
  let dirty = (out !== raw)
  if (out.length > 20) { out = out.substring(0, 20); dirty = true }
  if (dirty || out.length === 0) out = (out || 'x') + '_' + c4TagHash(raw)
  return out
}
// 队伍主键（FTB 队伍 UUID，DB 的键）→ 合法 tag；没有队伍时退回 cubeId/slot，保证始终有归属
function c4TeamTagOf(slot) {
  let h = c4TeamOfSlot(slot)
  if (h && h.key) return 'cw_team_' + c4TagSafe(h.key)
  if (h && h.cube && h.cube.id) return 'cw_team_' + c4TagSafe(h.cube.id)
  return 'cw_team_slot' + slot
}
// 门属于哪个面：优先 cw_face_*，其次历史裸 tag（y/-y/x/-x/z/-z）；都没有返回 null
function c4FaceOf(e) {
  for (let i = 0; i < C4_FACE_TAG_LIST.length; i++) {
    if (c4HasTag(e, C4_FACE_TAG_LIST[i])) return C4_FACE_BY_TAG[C4_FACE_TAG_LIST[i]]
  }
  for (let i = 0; i < C4_FACE_DIRS.length; i++) {
    if (c4HasTag(e, C4_FACE_DIRS[i])) return C4_FACE_DIRS[i]
  }
  return null
}
// 没有任何方位 tag 时的兜底：按相对核心的主轴方向推断
function c4GuessFace(e, cx, cy, cz) {
  let dx = e.x - cx, dy = e.y - cy, dz = e.z - cz
  let ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz)
  return (ay >= ax && ay >= az) ? (dy > 0 ? 'y' : '-y') : (ax >= az ? (dx > 0 ? 'x' : '-x') : (dz > 0 ? 'z' : '-z'))
}
// 某维度内、离某点 r 格内的门（只覆盖已加载区块 —— 调用前确保 forceload 过）
function c4PortalsInDim(server, dimId, x, y, z, r) {
  let out = []
  let rr = r * r
  c4All(server).forEach(e => {
    try {
      if (!c4IsPortal(e)) return
      if (c4DimOf(e) !== dimId) return
      if (c4Dist2(e.x, e.y, e.z, x, y, z) > rr) return
      out.push(e)
    } catch (err) {}
  })
  return out
}
function c4TagDoor(e, slot, cubeId, dir, isRev) {
  try {
    let wantTeam = c4TeamTagOf(slot)
    let wantSlot = 'cw_slot' + slot
    if (dir) {
      try { e.addTag(dir) } catch (e1) {}
      let ft = c4FaceTag(dir)
      if (ft) { try { e.addTag(ft) } catch (e2) {} }
    }
    try { e.addTag(wantTeam) } catch (e3) {}
    try { e.addTag(wantSlot) } catch (e4) {}
    if (cubeId) { try { e.addTag('cw_id_' + cubeId) } catch (e5) {} }
    if (isRev) {
      try { e.addTag('cw_rev') } catch (e6) {}
      if (cubeId) { try { e.addTag('cw_rev_' + cubeId) } catch (e7) {} }
    }
    // 换绑/迁槽后清掉旧归属，避免一扇门同时挂两个 cw_team_*/cw_slot*
    try {
      let rm = []
      let wantId = cubeId ? ('cw_id_' + cubeId) : null
      let wantRev = cubeId ? ('cw_rev_' + cubeId) : null
      e.getTags().forEach(t => {
        let s = String(t)
        if (s.indexOf('cw_team_') === 0 && s !== wantTeam) rm.push(s)
        if (s.indexOf('cw_slot') === 0 && s !== wantSlot) rm.push(s)
        // 历史串台：某次错误 retarget 会把 cw_id_cubeN 打到别的台门上 → 这里按当前 cubeId 清掉
        if (wantId && s.indexOf('cw_id_') === 0 && s !== wantId) rm.push(s)
        if (wantRev && s.indexOf('cw_rev_') === 0 && s !== wantRev) rm.push(s)
      })
      for (let i = 0; i < rm.length; i++) { try { e.removeTag(rm[i]) } catch (e8) {} }
    } catch (err2) {}
  } catch (err) { console.warn('[C4] 门打 tag 失败: ' + err) }
}
// 同一 (队伍, 面) 只允许一扇：保留离期望门面最近的（位置相同则保留先枚举到的），其余 kill
function c4DedupeDoors(server, doors, T) {
  let byFace = {}
  doors.forEach(e => {
    let d = c4FaceOf(e)
    if (!d) return
    if (!byFace[d]) byFace[d] = []
    byFace[d].push(e)
  })
  let killed = 0
  let dead = []
  for (let i = 0; i < C4_FACE_DIRS.length; i++) {
    let d = C4_FACE_DIRS[i]
    let arr = byFace[d]
    if (!arr || arr.length <= 1) continue
    let q = (T && T[d]) ? T[d].p : null
    let keep = arr[0]
    let best = q ? c4Dist2(arr[0].x, arr[0].y, arr[0].z, q[0], q[1], q[2]) : 0
    for (let j = 1; q && j < arr.length; j++) {
      let dd = c4Dist2(arr[j].x, arr[j].y, arr[j].z, q[0], q[1], q[2])
      if (dd < best) { keep = arr[j]; best = dd }
    }
    for (let j = 0; j < arr.length; j++) {
      if (arr[j] === keep) continue
      try { arr[j].discard() } catch (e1) { try { arr[j].kill() } catch (e2) {} }
      dead.push(arr[j])
      killed++
    }
    console.info('[C4] 门去重 face=' + d + '：' + arr.length + ' → 1（保留 @'
      + Math.round(keep.x) + ',' + Math.round(keep.y) + ',' + Math.round(keep.z) + '）')
  }
  // 把被 kill 的门从 doors 数组里剔除：否则后面按门统计 faces 会把死门也算进去（日志数字会骗人）
  for (let i = doors.length - 1; i >= 0; i--) {
    for (let j = 0; j < dead.length; j++) {
      if (doors[i] === dead[j]) { doors.splice(i, 1); break }
    }
  }
  return killed
}
// 给一侧房间（舱体 or 目的地）的门补齐 tag 并去重；返回 { total, killed, faces, T }
function c4SyncDoorTags(server, dimId, cx, cy, cz, ext, slot, cubeId, isRev, radius) {
  let T = c4FaceTargets(cx, cy, cz, ext)
  let r = radius || 120
  let doors = []
  c4PortalsInDim(server, dimId, cx, cy, cz, r).forEach(e => {
    try {
      if (c4HasTag(e, 'cw_lobby')) return       // 出生点那 6 扇锁死，谁的 tag 都不打
      if (c4HasTag(e, 'cw_link')) return        // S3 竖直链接门不算 6 面门（不参与去重/tag 同步）
      let d = c4FaceOf(e)
      let g = c4GuessFace(e, cx, cy, cz)
      // 几何纠偏：老门可能带着上一次扩展的旧方位 tag。如果几何上它明确贴着另一个门面（≤4 格），
      // 以几何为准，并把矛盾的老 face/裸方向 tag 摘掉（只在这一种情况下改 tag，不靠几何当唯一依据）。
      let qg = T[g] ? T[g].p : null
      let nearG = qg ? Math.sqrt(c4Dist2(e.x, e.y, e.z, qg[0], qg[1], qg[2])) <= 4 : false
      if (!d || (g && d !== g && nearG)) {
        if (d && g && d !== g) {
          let oldFaceTag = c4FaceTag(d)
          if (oldFaceTag) { try { e.removeTag(oldFaceTag) } catch (e0) {} }
          try { e.removeTag(d) } catch (e0) {}
        }
        d = g
      }
      if (!d) return
      c4TagDoor(e, slot, cubeId, d, isRev)
      doors.push(e)
    } catch (err) {}
  })
  let killed = c4DedupeDoors(server, doors, T)
  let faces = {}
  for (let i = 0; i < C4_FACE_DIRS.length; i++) faces[C4_FACE_DIRS[i]] = 0
  doors.forEach(e => {
    let d = c4FaceOf(e)
    if (d && faces[d] !== undefined) faces[d]++
  })
  return { total: doors.length, killed: killed, faces: faces, T: T }
}
// 按 face tag 点名一扇门（S1 单面调试/校验用）
function c4CountFaceDoors(server, cx, cy, cz, r) {
  let n = 0
  c4PortalsInDim(server, 'minecraft:overworld', cx, cy, cz, r || 96).forEach(e => {
    if (c4HasTag(e, 'cw_lobby') || c4HasTag(e, 'cw_link') || c4HasTag(e, 'cw_face_link')) return
    if (c4FaceOf(e)) n++
  })
  return n
}
function c4FaceDoor(server, dimId, cx, cy, cz, ext, dir) {
  let tag = c4FaceTag(dir)
  if (!tag) return null
  let out = null
  c4PortalsInDim(server, dimId, cx, cy, cz, 120).forEach(e => {
    if (out) return
    if (c4HasTag(e, 'cw_lobby')) return
    if (c4HasTag(e, tag)) out = e
  })
  return out
}
function c4DoorDest(e) {
  try { return String(e.getDestDim().location()) } catch (e1) {
    try { return String(e.getDestDim()) } catch (e2) { return '?' }
  }
}
function c4FaceSummary(faces) {
  let out = []
  for (let i = 0; i < C4_FACE_DIRS.length; i++) {
    let d = C4_FACE_DIRS[i]
    out.push(d + ':' + ((faces && faces[d] !== undefined) ? faces[d] : 0))
  }
  return out.join(' ')
}

function c4MakeRoomPortals(server, slot, idName, ext, core) {
  let c0 = core || { x: c4CubeX(slot) + 0.5, y: C4_CORE_Y, z: C4_Z + 0.5 }
  let cx = c0.x, cz = c0.z, cy = c0.y
  let T = c4FaceTargets(cx, cy, cz, ext)
  let box0 = c4RoomBox(cx, cy, cz, ext || { px: 0, nx: 0, pz: 0, nz: 0, py: 0 })
  // 门尺寸固定 17×17（不随 ext 变）：墙变大后门仍是墙中心那一块
  let span = C4_PORTAL_SPAN
  server.runCommandSilent(`execute in minecraft:overworld positioned ${cx} ${cy} ${cz} run kill @e[type=immersive_portals:portal,distance=..80,tag=!cw_lobby,tag=!cw_link]`)
  let t = 'c4rm' + slot + Date.now()
  let failed = []
  ;['y', '-y', 'x', '-x', 'z', '-z'].forEach(d => {
    let f = T[d], q = f.p
    let mk = t + '_' + d.replace('-', 'n')
    if (slot !== undefined && slot !== null) {
      let bb = c4RoomBox(cx, cy, cz, ext || { px: 0, nx: 0, pz: 0, nz: 0, py: 0 })
      let edge = (d === 'x') ? ('X1=' + bb.X1) : (d === '-x') ? ('X0=' + bb.X0)
        : (d === 'z') ? ('Z1=' + bb.Z1) : (d === '-z') ? ('Z0=' + bb.Z0)
        : (d === 'y') ? ('Y1=' + bb.Y1) : ('Y0=' + bb.Y0)
      console.info('[BUILD] face=' + d + ' 表=' + q[0].toFixed(2) + ',' + q[1].toFixed(2) + ',' + q[2].toFixed(2)
        + ' box边界=' + edge)
    }
    let ret = -1
    // 先把墙外 2 层清成 air（bind 的成功经验）；down/up 的门面在地板/天花板外侧，不清
    if (d !== 'y' && d !== '-y') c4ClearDoorHole(server, box0, d)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let mk2 = mk + '_' + attempt
        server.runCommandSilent(`execute in minecraft:overworld positioned ${q[0]} ${q[1]} ${q[2]} run summon marker ~ ~ ~ {Rotation:[${f.rot[0]}.0f,${f.rot[1]}.0f],NoGravity:1b,Tags:["${mk2}"]}`)
        ret = Number(server.runCommandSilent(`execute in minecraft:overworld as @e[type=marker,tag=${mk2}] at @s run portal cb_make_portal ${span} ${span} @s @s main_cube`))
        server.runCommandSilent(`execute in minecraft:overworld run kill @e[type=marker,tag=${mk2}]`)
      } catch (e1) { ret = -2 }
      if (c4PortalNearPoint(server, q[0], q[1], q[2], 2)) break
      if (attempt === 0) c4ClearDoorHole(server, box0, d)
    }
    if (!c4PortalNearPoint(server, q[0], q[1], q[2], 2)) {
      failed.push(d)
      console.warn('[C4] 建门失败 face=' + d + ' 期望 @' + q[0].toFixed(2) + ',' + q[1].toFixed(2) + ',' + q[2].toFixed(2) + ' span=' + span + ' ret=' + ret + ' fallback=summon-unsupported')
    }
  })
  let synced = { total: 0, killed: 0, faces: {} }
  try { synced = c4SyncDoorTags(server, 'minecraft:overworld', cx, cy, cz, ext, slot, idName, false, 260) }
  catch (e) { console.warn('[C4] 建门后打 tag 失败: ' + e) }
  console.info('[C4] 建门 slot' + slot + ' ext=' + JSON.stringify(ext) + ' span=' + span + ' 成功=' + (6 - failed.length) + '/6'
    + (failed.length ? ' 失败=' + failed.join(',') : '') + ' faces=' + c4FaceSummary(synced.faces))
  return synced.total
}
// 把某面中心的 17×17×2 门洞清成 air（只清门洞，不动整面墙）
function c4ClearDoorHole(server, b, dir) {
  // 门面现在贴平（开口外 0.01）：再按"门面 ±1 格"往内清，会把框梁/操控台一起铲掉。
  // 只清「墙外」两格 —— 墙内（框梁、面板、按钮）一格都不碰。
  try {
    let r = null
    if (dir === '-x') r = [b.X0 - 2, b.Y0, b.Z0, b.X0 - 1, b.Y1, b.Z1]
    else if (dir === 'x') r = [b.X1 + 1, b.Y0, b.Z0, b.X1 + 2, b.Y1, b.Z1]
    else if (dir === '-z') r = [b.X0, b.Y0, b.Z0 - 2, b.X1, b.Y1, b.Z0 - 1]
    else if (dir === 'z') r = [b.X0, b.Y0, b.Z1 + 1, b.X1, b.Y1, b.Z1 + 2]
    else return
    server.runCommandSilent('execute in minecraft:overworld run fill ' + r[0] + ' ' + r[1] + ' ' + r[2]
      + ' ' + r[3] + ' ' + r[4] + ' ' + r[5] + ' minecraft:air')
  } catch (e) { console.warn('[C4] 清门洞失败: ' + e) }
}
// 某点附近有没有 portal（判定单面建门是否成功）
function c4PortalNearPoint(server, x, y, z, r) {
  let n = 0
  try { n = c4PortalsInDim(server, 'minecraft:overworld', x, y, z, r).length } catch (e) {}
  return n > 0
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

// ---------------------------------------------------------------------------- 扩展器 / 拆除器（实现在 cw_expand.js）
function c4ExpandDeny(p, msg) { try { p.tell(Text.of('⟢ ' + msg)) } catch (e) {} }


// 优先【搬门】而不是删了重建：保留 entity 与目的地，只改位置/尺寸

// 校验：6 个面必须各有一扇、且位置误差 < 1.6；不对就清掉重建（最多 2 次）
function c4EnsureSix(server, slot, idName, cx, cy, cz, ext, tries) {
  let T = c4FaceTargets(cx, cy, cz, ext)
  let box0 = c4RoomBox(cx, cy, cz, ext || { px: 0, nx: 0, pz: 0, nz: 0, py: 0 })
  let synced = { total: 0, killed: 0, faces: {} }
  try { synced = c4SyncDoorTags(server, 'minecraft:overworld', cx, cy, cz, ext, slot, idName, false, 260) }
  catch (e) { console.warn('[C4] 门校验前 tag 同步失败: ' + e) }
  let have = synced.faces || {}
  let miss = [], dup = []
  for (let i = 0; i < C4_FACE_DIRS.length; i++) {
    let d = C4_FACE_DIRS[i]
    let n = Number(have[d] || 0)
    if (n === 0) miss.push(d)
    else if (n > 1) dup.push(d + '×' + n)
  }
  if (miss.length === 0 && dup.length === 0) {
    console.info('[C4] 门校验 OK：6/6 面各 1 扇（tag 驱动，去重 ' + synced.killed + '）')
    return true
  }
  console.warn('[C4] 门校验：faces=' + c4FaceSummary(have) + '，缺 ' + (miss.join(',') || '无') + '，多 ' + (dup.join(',') || '无'))
  // 只补缺失的面：先建新，建成功再打 tag/去重；全程不删旧门
  if (miss.length > 0) {
    let span = C4_PORTAL_SPAN
    for (let i = 0; i < miss.length; i++) {
      let d = miss[i], f = T[d], q = f.p
      let mk = 'c4ens' + slot + Date.now() + '_' + d.replace('-', 'n')
      let ret = -1
      if (d !== 'y' && d !== '-y') c4ClearDoorHole(server, box0, d)
      try {
        server.runCommandSilent(`execute in minecraft:overworld positioned ${q[0]} ${q[1]} ${q[2]} run summon marker ~ ~ ~ {Rotation:[${f.rot[0]}.0f,${f.rot[1]}.0f],NoGravity:1b,Tags:["${mk}"]}`)
        ret = Number(server.runCommandSilent(`execute in minecraft:overworld as @e[type=marker,tag=${mk}] at @s run portal cb_make_portal ${span} ${span} @s @s main_cube`))
        server.runCommandSilent(`execute in minecraft:overworld run kill @e[type=marker,tag=${mk}]`)
      } catch (e2) { ret = -2 }
      let ok = c4PortalNearPoint(server, q[0], q[1], q[2], 3)
      if (!ok) console.warn('[C4] 建门失败 face=' + d + ' 期望 @' + q[0].toFixed(2) + ',' + q[1].toFixed(2) + ',' + q[2].toFixed(2) + ' span=' + span + ' ret=' + ret)
    }
  }
  server.scheduleInTicks(10, () => {
    try {
      let s2 = c4SyncDoorTags(server, 'minecraft:overworld', cx, cy, cz, ext, slot, idName, false, 260)
      let bad = []
      for (let i = 0; i < C4_FACE_DIRS.length; i++) {
        let d = C4_FACE_DIRS[i]
        if (Number(s2.faces[d] || 0) !== 1) bad.push(d + ':' + Number(s2.faces[d] || 0))
      }
      if (bad.length === 0) console.info('[C4] 门校验 OK：6/6（补建后）')
      else console.warn('[C4] 门校验仍不齐：' + bad.join(' ') + '（旧门保留，期望中心 ' + JSON.stringify({
        up: T['y'].p, down: T['-y'].p, n: T['-z'].p, s: T['z'].p, e: T['x'].p, w: T['-x'].p
      }) + '）')
    } catch (e3) {}
  })
  return false
}

// —— S1 辅助：6 面目的地一览 / 老存档补 tag / 单面调试 ——
function c4FaceDestSummary(server, cx, cy, cz, ext) {
  let out = []
  c4PortalsInDim(server, 'minecraft:overworld', cx, cy, cz, 96).forEach(e => {
    try {
      if (c4HasTag(e, 'cw_lobby')) return
      let d = c4FaceOf(e)
      if (!d) return
      out.push(d + '=' + c4DoorDest(e))
    } catch (err) {}
  })
  return out.join(' ')
}
// 老存档兼容：按 cw_id_* + 几何推断补一次 tag（幂等，/reload 后第一 tick 跑一次）
function c4MigrateDoorTags(server) {
  let db = c4Db(), cubes = db.cubes || {}
  let total = 0, tagged = 0
  for (let k in cubes) {
    let c = cubes[k]
    if (!c || !c.provisioned) continue
    try {
      let slot = Number(c.slot)
      let cx = c4CubeX(slot) + 0.5, cz = C4_Z + 0.5, cy = C4_CORE_Y
      let r = c4SyncDoorTags(server, 'minecraft:overworld', cx, cy, cz, c4Ext(c), slot, c.id, false, 96)
      total += r.total
      if (r.total > 0) {
        tagged++
        console.info('[C4] 门 tag 迁移 slot' + slot + '：' + r.total + ' 扇，faces=' + c4FaceSummary(r.faces)
          + '，去重 ' + r.killed)
      }
    } catch (e) { console.warn('[C4] 门 tag 迁移 slot' + (c && c.slot) + ' 失败: ' + e) }
  }
  console.info('[C4] 门 tag 迁移完成：' + tagged + ' 台 / ' + total + ' 扇（幂等，可重复跑）')
  return total
}
// /cube admin face <slot> <face> <dim>：S1 调试 —— 按 tag 点名，只把这一面指到另一维度
function c4CmdRetargetFace(ctx, slot, faceArg, dimId) {
  let server = ctx.source.server
  let dir = c4FaceKey(faceArg)
  if (!dir) { c4Reply(ctx, 'face 只接受 up/down/n/s/e/w'); return }
  let info = c4TeamOfSlot(slot)
  let cubeId = (info && info.cube && info.cube.id) ? info.cube.id : ('cube' + slot)
  let ext = info ? c4Ext(info.cube) : c4Ext(null)
  let tp = c4TeleCore(slot)
  let cx = tp.x, cz = tp.z, cy = tp.y
  try { c4SyncDoorTags(server, 'minecraft:overworld', cx, cy, cz, ext, slot, cubeId, false, 96) } catch (e) {}
  let door = c4FaceDoor(server, 'minecraft:overworld', cx, cy, cz, ext, dir)
  if (!door) { c4Reply(ctx, '没找到 face=' + dir + ' 的门'); return }
  let before = c4FaceDestSummary(server, cx, cy, cz, ext)
  // 目标位置用该维度里这台的门面中心（调试用；正式换维度走 S2 的 teleporter 命令）
  let n = c4Retarget(server, cx, cy, cz, c4DimKey(dimId), Math.floor(cx), C4_CORE_Y, Math.floor(cz), false, dimId, cubeId, ext, false, slot, dir)
  let after = c4FaceDestSummary(server, cx, cy, cz, ext)
  console.info('[C4] 单面 retarget slot' + slot + ' face=' + dir + '（' + c4FaceTag(dir) + '）→ ' + dimId
    + ' 命中=' + n + ' 前[' + before + '] 后[' + after + ']')
  c4Reply(ctx, 'face=' + dir + ' → ' + dimId + '（命中 ' + n + '）')
}

// ════════════════════════════════════════════════════════════════════════════
// S2：传送器舱（17³，y16~32）——基地只住人，跃迁机器独立
// ════════════════════════════════════════════════════════════════════════════
const C4_TELE_BLOCKS = [
  'kubejs:warping_frame', 'kubejs:warping_frame_platform', 'kubejs:warping_frame_slab',
  'kubejs:hexahedron_filling', 'minecraft:structure_void',
  'kubejs:warping_controls', 'kubejs:warping_interface', 'kubejs:warping_interface_running',
  'kubejs:launch_button', 'kubejs:launch_button_pressed',
  'kubejs:warping_disc_drive', 'kubejs:warping_vent', 'minecraft:light'
]
// 只清本模组放的方块（绝不无参 fill air），并清掉旧中心附近残留的门
function c4ClearTeleBox(server, a) {
  let ext0 = { px: 0, nx: 0, pz: 0, nz: 0, py: 0 }
  let b = c4RoomBox(a.x + 0.5, a.y + 8.5, a.z + 0.5, ext0)
  let x0 = b.X0 - 1, y0 = b.Y0 - 1, z0 = b.Z0 - 1, x1 = b.X1 + 1, y1 = b.Y1 + 1, z1 = b.Z1 + 1
  let n = 0
  C4_TELE_BLOCKS.forEach(bl => {
    try {
      let r = Number(server.runCommandSilent('execute in minecraft:overworld run fill ' + x0 + ' ' + y0 + ' ' + z0 + ' ' + x1 + ' ' + y1 + ' ' + z1 + ' minecraft:air replace ' + bl))
      if (!isNaN(r)) n += r
    } catch (e) {}
  })
  try {
    server.runCommandSilent('execute in minecraft:overworld positioned ' + (a.x + 0.5) + ' ' + (a.y + 8.5) + ' ' + (a.z + 0.5) + ' run kill @e[type=immersive_portals:portal,distance=..24,tag=!cw_lobby,tag=!cw_link]')
  } catch (e2) {}
  return n
}
// 把本台的门（按 cw_id_/cw_team_ tag 全局找，不受旧位置距离限制）搬到指定舱体的 6 个门面
// 建（或重建）一台传送器：舱体 + 6 面门 + 操控台/按钮/算子位（c4BuildRoom 已含面板/按钮）
// 按 box 全量 forceload（按 16×16 区块逐个 add，覆盖四个角与六面中心）
function c4DoorPreload(server, ext, core) {
  let b = c4RoomBox(core.x, core.y, core.z, ext)
  let cx0 = Math.floor((b.X0 - 17) / 16), cx1 = Math.floor((b.X1 + 17) / 16)
  let cz0 = Math.floor((b.Z0 - 17) / 16), cz1 = Math.floor((b.Z1 + 17) / 16)
  let n = 0
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      try {
        server.runCommandSilent('execute in minecraft:overworld run forceload add ' + (cx * 16) + ' ' + (cz * 16))
        n++
      } catch (e) {}
    }
  }
  return n
}
// 建门统一入口：先全量预载 → 延后 ≥20t 再搬/建 → 10t 后按 face tag 校验，不足再补一轮
function c4BuildTeleporter(server, slot, a, logIt) {
  let info = c4TeamOfSlot(slot)
  let idName = (info && info.cube && info.cube.id) ? info.cube.id : ('cube' + slot)
  let ext0 = { px: 0, nx: 0, pz: 0, nz: 0, py: 0 }
  let cx = a.x + 0.5, cy = a.y + 8.5, cz = a.z + 0.5
  try {
    server.runCommandSilent('execute in minecraft:overworld run forceload add ' + (a.x - 24) + ' ' + (a.z - 24) + ' ' + (a.x + 24) + ' ' + (a.z + 24))
  } catch (e) {}
  let bb = c4RoomBox(cx, cy, cz, ext0)
  let tmpl = 0
  try {
    // 21³ 模板：17³ 舱居中（偏移 +2），四周 2 格 air 留边；要求 Y0+18 < 基地地板（78+18=96 < 97）
    server.runCommandSilent('execute in minecraft:overworld run fill ' + (bb.X0 - 2) + ' ' + (bb.Y0 - 2) + ' ' + (bb.Z0 - 2)
      + ' ' + (bb.X1 + 2) + ' ' + (bb.Y1 + 2) + ' ' + (bb.Z1 + 2) + ' minecraft:air')
    tmpl = Number(server.runCommandSilent('execute in minecraft:overworld run place template hexahedron:cw_teleporter21 '
      + (bb.X0 - 2) + ' ' + (bb.Y0 - 2) + ' ' + (bb.Z0 - 2)))
  } catch (eT) { console.warn('[C4] 传送器模板放置失败: ' + eT) }
  if (!(tmpl > 0)) {
    console.warn('[C4] 模板 hexahedron:cw_teleporter21 不可用（ret=' + tmpl + '）→ 退回程序化建舱')
    try { c4BuildRoom(server, 'minecraft:overworld', cx, cy, cz, ext0, false, 'all') }
    catch (e) { console.warn('[C4] 传送器舱体失败: ' + e) }
  } else {
    // 中心 3×3 洞保持 air（模板里本来就是 air，这里只做保险）
    try {
      server.runCommandSilent('execute in minecraft:overworld run fill ' + (bb.X0 + 7) + ' ' + bb.Y0 + ' ' + (bb.Z0 + 7)
        + ' ' + (bb.X0 + 9) + ' ' + bb.Y0 + ' ' + (bb.Z0 + 9) + ' minecraft:air')
    } catch (eH) {}
  }
  // 排气孔 marker：模板里 7 个 warping_vent 是死方块，数据包靠 tag=vent 的 marker 喷粒子
  try {
    server.runCommandSilent('execute in minecraft:overworld run kill @e[type=marker,tag=c4vent' + slot + ']')
    ;[[4, 0, 0], [16, 0, 10], [16, 4, 16], [0, 8, 16], [16, 12, 0], [0, 16, 5], [11, 16, 16]].forEach(o => {
      server.runCommandSilent('execute in minecraft:overworld run summon marker ' + (bb.X0 + o[0]) + ' ' + (bb.Y0 + o[1]) + ' ' + (bb.Z0 + o[2])
        + ' {Tags:["vent","c4vent' + slot + '"]}')
    })
  } catch (eV) { console.warn('[C4] 排气 marker 失败: ' + eV) }

  // 传送器也要套一圈 structure_void 外壳；但【顶面贴着基地地板时跳过】，
  // 否则 Y1+1 那一层会把基地地板换成 structure_void。
  try {
    let basY = c4BaseAnchor(slot).y
    if (bb.Y1 + 1 < basY) c4ShellFill(server, 'minecraft:overworld', bb, 'minecraft:structure_void')
    else console.info('[C4] 传送器顶面贴基地地板（Y1+1=' + (bb.Y1 + 1) + ' >= ' + basY + '）→ 跳过外壳')
  } catch (eSh) { console.warn('[C4] 传送器外壳填充失败: ' + eSh) }
  // 基地不再持有 6 面门：先清旧位置（基地核心）附近的门，再在传送器核心整组重建
  try {
    let bc0 = c4BaseCore(slot)
    server.runCommandSilent('execute in minecraft:overworld positioned ' + bc0.x + ' ' + bc0.y + ' ' + bc0.z
      + ' run kill @e[type=immersive_portals:portal,distance=..40,tag=!cw_lobby,tag=!cw_link,tag=!cw_face_link,tag=!cw_face_link_base]')
  } catch (eK) {}
  let moved = 0
  try { moved = c4MakeRoomPortals(server, slot, idName, ext0, { x: cx, y: cy, z: cz }) } catch (e) { console.warn('[C4] 传送器建门失败: ' + e) }
  // 门按原目的地重指（有固定落点指落点，没有指【起始笼子】——注意不是传送器自己的坐标！）
  let dest = (info && info.cube && info.cube.dest && info.cube.dest.dim) ? info.cube.dest : null
  let bc = c4BaseCore(slot)   // 起始笼子核心 (x+0.5, 105.5, 0.5)
  let destDimId = dest ? String(dest.dim) : 'hexahedron:bedrock_bottom'
  let destKey = c4DimKey(destDimId)
  let dpx = dest ? (Number(dest.x) + 0.5) : bc.x
  let dpy = dest ? (Number(dest.y) + 0.5) : bc.y
  let dpz = dest ? (Number(dest.z) + 0.5) : bc.z
  try {
    c4Retarget(server, cx, cy, cz, destKey, dpx, dpy, dpz, false, destDimId, idName, ext0, false, slot)
  } catch (e) { console.warn('[C4] 传送器指门失败: ' + e) }
  // 第一次指门必须同时造【反向门】，否则到了目的地回不来（原来这里完全没有）
  server.scheduleInTicks(20, () => {
    try { c4MakeReverse(server, slot, destDimId, dpx, dpy, dpz, idName) }
    catch (eR) { console.warn('[C4] 传送器反向门失败: ' + eR) }
  })
  server.scheduleInTicks(10, () => {
    try { c4EnsureSix(server, slot, idName, cx, cy, cz, ext0, 2) } catch (e) {}
  })
  if (logIt !== false) {
    console.info('[C4] 传送器建成 slot' + slot + ' floor=' + a.y + ' core=' + cy + ' @' + a.x + ',' + a.y + ',' + a.z
      + ' 搬门=' + moved + ' 按钮=' + (a.x) + ',' + (a.y + 1) + ',' + (a.z + 7))
  }
  return moved
}
// 基地 strip：只删 5 类"跃迁家具"，其它方块一格不动
function c4StripCabin(server, slot, logIt) {
  let info = c4TeamOfSlot(slot)
  let ext = info ? c4Ext(info.cube) : c4Ext(null)
  let bc = c4BaseCore(slot)
  let b = c4RoomBox(bc.x, bc.y, bc.z, ext)
  let x0 = b.X0 - 1, y0 = b.Y0 - 1, z0 = b.Z0 - 1, x1 = b.X1 + 1, y1 = b.Y1 + 1, z1 = b.Z1 + 1
  // ⚠ 传送器和基地同址（老存档 / 还没 relocate）时绝不 strip：会把传送器的按钮+操控台一起擦掉
  try {
    let ta = c4TeleAnchor(slot)
    let tb = c4RoomBox(ta.x + 0.5, ta.y + 8.5, ta.z + 0.5, { px: 0, nx: 0, pz: 0, nz: 0, py: 0 })
    let overlap = !(tb.Y1 + 1 < y0 || tb.Y0 - 1 > y1 || tb.X1 + 1 < x0 || tb.X0 - 1 > x1 || tb.Z1 + 1 < z0 || tb.Z0 - 1 > z1)
    if (overlap) {
      if (logIt !== false) console.info('[C4] cabin strip slot' + slot + '：传送器与基地同址 → 跳过（保留按钮/操控台）')
      return 0
    }
  } catch (eOv) {}
  let types = ['kubejs:launch_button', 'kubejs:launch_button_pressed', 'kubejs:warping_controls', 'kubejs:warping_interface', 'kubejs:warping_disc_drive']
  // 大基地（py/±x/±z 扩过）整块 fill 会超过 32768 → 命令静默失败；按 y 分片保证单条 < 30000
  let w = x1 - x0 + 1, d = z1 - z0 + 1
  let step = Math.max(1, Math.floor(28000 / Math.max(1, w * d)))
  let n = 0
  types.forEach(t => {
    for (let y = y0; y <= y1; y += step) {
      let y2 = Math.min(y + step - 1, y1)
      try {
        let r = Number(server.runCommandSilent('execute in minecraft:overworld run fill ' + x0 + ' ' + y + ' ' + z0 + ' ' + x1 + ' ' + y2 + ' ' + z1 + ' minecraft:air replace ' + t))
        if (!isNaN(r)) n += r
      } catch (e) {}
    }
  })
  if (logIt !== false) console.info('[C4] cabin strip slot' + slot + '：删除 ' + n + ' 格（box ' + x0 + ',' + y0 + ',' + z0 + '..' + x1 + ',' + y1 + ',' + z1 + '）')
  return n
}
// 整舱平移：新位建房 + 门按 tag 跟随 + 旧位清理 + 锚点写库
// 启动迁移：已有 10 台 → 建传送器（搬走基地的门）+ strip 基地按钮（幂等）
// ════════════════════════════════════════════════════════════════════════════
// S3：基地地板中央 3×3 ↔ 传送器顶部中央 3×3（竖直门，落点不偏移）
// 只用一扇门 A：基地地板 (x, 97, z) → 传送器顶部上方 (x, teleTop+1, z)，x/z 完全相同。
// tag：cw_link（总类）+ cw_link_a（方向）+ cw_slot*/cw_id_*/cw_team_*；不参与 6 面门逻辑。
// ════════════════════════════════════════════════════════════════════════════
let C4_LINK_CD = {}
let C4_LINK_TICK = 0
function c4LinkPoints(slot) {
  let a = c4TeleAnchor(slot)
  let fx = c4CubeX(slot)          // 基地地板中心（基地不随传送器移动）
  return {
    src: { x: fx + 0.5, y: C4_CORE_Y - 8.5, z: C4_Z + 0.5 },   // 基地地板 97
    dst: { x: fx + 0.5, y: a.y + 17, z: C4_Z + 0.5 }            // 传送器顶部上方（floor+17）
  }
}
// 在 pos 处生成一扇 3×3 水平门；用"生成前后 UUID 差集"精确认领新门（附近还有 6 面门）
function c4SpawnLinkPortal(server, pos, size, rot) {
  let r = (rot === undefined || rot === null) ? -90.0 : Number(rot)
  let before = {}
  try { c4PortalsInDim(server, 'minecraft:overworld', pos.x, pos.y, pos.z, 10).forEach(e => { before[String(e.uuid)] = true }) } catch (e) {}
  let t = 'c4lnk' + Date.now() + Math.floor(Math.random() * 999)
  try {
    server.runCommandSilent('execute in minecraft:overworld positioned ' + pos.x + ' ' + pos.y + ' ' + pos.z
      + ' run summon marker ~ ~ ~ {Rotation:[0.0f,' + r.toFixed(1) + 'f],NoGravity:1b,Tags:["' + t + '"]}')
    server.runCommandSilent('execute in minecraft:overworld as @e[type=marker,tag=' + t + '] at @s run portal cb_make_portal ' + size + ' ' + size + ' @s @s main_cube')
    server.runCommandSilent('execute in minecraft:overworld run kill @e[type=marker,tag=' + t + ']')
  } catch (e) { console.warn('[C4] 链接门生成失败: ' + e) }
  let best = null, bd = 1e9
  try {
    c4PortalsInDim(server, 'minecraft:overworld', pos.x, pos.y, pos.z, 10).forEach(e => {
      if (before[String(e.uuid)]) return
      let d = c4Dist2(e.x, e.y, e.z, pos.x, pos.y, pos.z)
      if (d < bd) { bd = d; best = e }
    })
  } catch (e2) {}
  return best
}
function c4BuildVerticalLinks(server, slot, noRetry) {
  let info = c4TeamOfSlot(slot)
  let idName = (info && info.cube && info.cube.id) ? info.cube.id : ('cube' + slot)
  let P = c4LinkPoints(slot)
  // 区块没加载时 summon/portal 会静默失败 → 先把这两点周围 forceload 起来
  // forceload 只吃整数坐标：x.5 必须取整，否则整条命令失败、区块不加载 → 门/标记全落空
  let flx = Math.floor(P.src.x), flz = Math.floor(P.src.z)
  try { server.runCommandSilent('execute in minecraft:overworld run forceload add ' + (flx - 24) + ' ' + (flz - 24) + ' ' + (flx + 24) + ' ' + (flz + 24)) } catch (e0) {}
  // 先清掉这两点附近旧的链接门（绝不碰 6 面门：只杀带 cw_link 的）
  try { server.runCommandSilent('execute in minecraft:overworld positioned ' + P.src.x + ' ' + P.src.y + ' ' + P.src.z + ' run kill @e[type=immersive_portals:portal,tag=cw_link,distance=..8]') } catch (e) {}
  try { server.runCommandSilent('execute in minecraft:overworld positioned ' + P.dst.x + ' ' + P.dst.y + ' ' + P.dst.z + ' run kill @e[type=immersive_portals:portal,tag=cw_link,distance=..8]') } catch (e2) {}
  // 基地地板中央 3×3 必须是洞（否则门被地板挡住）
  try { server.runCommandSilent('execute in minecraft:overworld run fill ' + (P.src.x - 1) + ' ' + P.src.y + ' ' + (P.src.z - 1) + ' ' + (P.src.x + 1) + ' ' + P.src.y + ' ' + (P.src.z + 1) + ' minecraft:air') } catch (e3) {}
  let e = c4SpawnLinkPortal(server, P.src, 3)
  if (!e) {
    if (!noRetry) {
      console.warn('[C4] 竖直链接门创建失败 slot' + slot + '（20t 后重试一次）')
      server.scheduleInTicks(20, () => { try { c4BuildVerticalLinks(server, slot, true) } catch (e4) { console.warn('[C4] 链接门重试失败: ' + e4) } })
    } else {
      console.warn('[C4] 竖直链接门创建失败 slot' + slot + '（已重试，放弃）')
    }
    return 0
  }
  try {
    e.addTag('cw_link'); e.addTag('cw_link_a')
    e.addTag('cw_slot' + slot); e.addTag('cw_id_' + idName); e.addTag(c4TeamTagOf(slot))
  } catch (err) {}
  let ok = false
  try {
    ok = c4ApplyPortal(server, e, 'minecraft:overworld', c4DimKey('minecraft:overworld'),
      c4Vec(P.dst.x, P.dst.y, P.dst.z), P.src.x, P.src.y, P.src.z)
  } catch (err2) { console.warn('[C4] 链接门指门失败: ' + err2) }
  console.info('[C4] 竖直链接门 slot' + slot + '：基地地板(' + P.src.x + ',' + P.src.y + ',' + P.src.z + ') → 传送器顶('
    + P.dst.x + ',' + P.dst.y + ',' + P.dst.z + ') tag=cw_link/cw_link_a 落点不偏移=' + (P.src.x === P.dst.x && P.src.z === P.dst.z) + ' 指门=' + ok)
  return ok ? 1 : 0
}
// 3 秒穿越冷却：同一玩家 3s 内再次贴到链接门面 → 抬回门面上方（IP 没有 per-entity 冷却接口）
function c4CmdDestSet(ctx, slot, dim, x, y, z) {
  let info = c4TeamOfSlot(slot)
  if (!info || !info.cube) { c4Reply(ctx, '槽位 ' + slot + ' 没有登记'); return }
  let d = { dim: String(dim), x: Math.floor(Number(x)), y: Math.floor(Number(y)), z: Math.floor(Number(z)) }
  if (!c4DestValid(ctx.source.server, d)) { c4Reply(ctx, '目的地不合法（维度不存在/超出可建高度）'); return }
  c4DestSet(info.cube, d.dim, d.x, d.y, d.z)
  c4Save()
  console.info('[C4] dest set slot=' + slot + ' [' + d.dim + '] = ' + d.x + ',' + d.y + ',' + d.z)
  c4Reply(ctx, 'dest set slot=' + slot + ' [' + d.dim + '] = ' + d.x + ',' + d.y + ',' + d.z)
}
function c4CmdDestShow(ctx, slot) {
  let info = c4TeamOfSlot(slot)
  if (!info || !info.cube) { c4Reply(ctx, '槽位 ' + slot + ' 没有登记'); return }
  let t = c4Dests(info.cube)
  let keys = Object.keys(t)
  if (keys.length === 0) { c4Reply(ctx, 'slot' + slot + ' 目的地表：空（首次跃迁分配）'); return }
  c4Reply(ctx, 'slot' + slot + ' 目的地表（' + keys.length + ' 个维度）：')
  for (let i = 0; i < keys.length; i++) {
    let k = keys[i], e = t[k]
    let dd = { dim: k, x: Number(e.x), y: Number(e.y), z: Number(e.z) }
    c4Reply(ctx, '  ' + k + ' @' + dd.x + ',' + dd.y + ',' + dd.z + '（房间' + (c4DestRoomExists(ctx.source.server, dd) ? '存在' : '缺失') + '）')
  }
}
// /cube admin bind <slot> <x> <y> <z>：写 cube.btn，清旧 6 面门，按新按钮原点重建 6 门并校验
function c4CmdBind(ctx, slot, x, y, z) {
  let server = ctx.source.server
  let info = c4TeamOfSlot(slot)
  if (!info || !info.cube) { c4Reply(ctx, '槽位 ' + slot + ' 没有登记'); return }
  let cubeId = info.cube.id || ('cube' + slot)
  let oldCore = c4TeleCore(slot)
  let bx = Math.floor(Number(x)), by = Math.floor(Number(y)), bz = Math.floor(Number(z))
  if (isNaN(bx) || isNaN(by) || isNaN(bz)) { c4Reply(ctx, '坐标不合法'); return }
  let lv = c4Level(server, 'minecraft:overworld')
  let minY = -64, maxY = 320
  try { if (lv) { minY = Number(lv.getMinBuildHeight()); maxY = Number(lv.getMaxBuildHeight()) } } catch (e0) {}
  if (by - 1 < minY || by + 15 > maxY - 1) { c4Reply(ctx, 'y 不合法：' + minY + '..' + maxY); return }

  // ⓪ 新旧位置都 forceload（否则实体枚举/建门落空；forceload 只吃整数）
  try {
    let ofx = Math.floor(oldCore.x), ofz = Math.floor(oldCore.z)
    server.runCommandSilent('execute in minecraft:overworld run forceload add ' + (ofx - 24) + ' ' + (ofz - 24) + ' ' + (ofx + 24) + ' ' + (ofz + 24))
    server.runCommandSilent('execute in minecraft:overworld run forceload add ' + (bx - 24) + ' ' + (bz - 24) + ' ' + (bx + 24) + ' ' + (bz + 24))
  } catch (e9) {}
  // ① 清旧门：按 cube 归属 + face tag（不用 cw_team_* 单独匹配，同队多台会误删别人的门）
  let killed = 0
  try {
    c4All(server).forEach(e => {
      try {
        if (!c4IsPortal(e)) return
        if (c4DimOf(e) !== 'minecraft:overworld') return
        if (c4HasTag(e, 'cw_lobby') || c4HasTag(e, 'cw_link') || c4HasTag(e, 'cw_face_link')) return
        if (!c4FaceOf(e)) return
        let own = c4HasTag(e, 'cw_id_' + cubeId) || c4HasTag(e, 'cw_slot' + slot)
        if (!own) {
          // 旧原点附近的无归属老门也一并清（半径 96）
          let d2 = c4Dist2(e.x, e.y, e.z, oldCore.x, oldCore.y, oldCore.z)
          if (d2 > 96 * 96) return
        }
        try { e.discard(); killed++ } catch (e1) {}
      } catch (e2) {}
    })
  } catch (e3) { console.warn('[C4] bind 清旧门失败: ' + e3) }

  // ② 写锚点
  info.cube.btn = { x: bx, y: by, z: bz }
  c4Save()
  // ②.5 先把 6 个门面前 2 格清成 air（只清 3×3 中心 × 厚度 2，不挖大范围）
  let clearedFaces = 0
  try {
    let ext0c = { px: 0, nx: 0, pz: 0, nz: 0, py: 0 }
    let c0 = { x: bx + 0.5, y: by + 7.5, z: bz - 6.5 }
    let T0 = c4FaceTargets(c0.x, c0.y, c0.z, ext0c)
    for (let di = 0; di < C4_FACE_DIRS.length; di++) {
      let dd = C4_FACE_DIRS[di]
      let q = T0[dd].p
      let x0, x1, y0, y1, z0, z1
      if (dd === 'y' || dd === '-y') { x0 = q[0] - 1; x1 = q[0] + 1; z0 = q[2] - 1; z1 = q[2] + 1; y0 = q[1]; y1 = q[1] }
      else if (dd === 'x' || dd === '-x') { z0 = q[2] - 1; z1 = q[2] + 1; y0 = q[1] - 1; y1 = q[1] + 1; x0 = q[0]; x1 = q[0] }
      else { x0 = q[0] - 1; x1 = q[0] + 1; y0 = q[1] - 1; y1 = q[1] + 1; z0 = q[2]; z1 = q[2] }
      let nx = (dd === 'x') ? -1 : (dd === '-x') ? 1 : 0
      let ny = (dd === 'y') ? -1 : (dd === '-y') ? 1 : 0
      let nz = (dd === 'z') ? -1 : (dd === '-z') ? 1 : 0
      let ok = 0
      for (let t = 0; t < 2; t++) {
        try {
          let r = Number(server.runCommandSilent('execute in minecraft:overworld run fill '
            + Math.floor(x0 + nx * t) + ' ' + Math.floor(y0 + ny * t) + ' ' + Math.floor(z0 + nz * t) + ' '
            + Math.floor(x1 + nx * t) + ' ' + Math.floor(y1 + ny * t) + ' ' + Math.floor(z1 + nz * t) + ' minecraft:air'))
          if (!isNaN(r)) ok++
        } catch (e) {}
      }
      if (ok >= 2) clearedFaces++
    }
  } catch (e) {}

  // ③ 按新按钮原点重建 6 面门 + 指门 + 校验
  let core = { x: bx + 0.5, y: by + 7.5, z: bz - 6.5 }
  let ext0 = { px: 0, nx: 0, pz: 0, nz: 0, py: 0 }
  let made = 0
  try { made = c4MakeRoomPortals(server, slot, cubeId, ext0, core) }
  catch (e4) { console.warn('[C4] bind 建门失败: ' + e4) }
  let sdd2 = 0
  try { sdd2 = c4ReadSeed(server, slot) } catch (e0) { sdd2 = 0 }
  let dest = c4DestOf(info.cube, C4_SEED_DIMS[sdd2] || C4_SEED_DIMS[0])
  try {
    if (dest) {
      c4Retarget(server, core.x, core.y, core.z, c4DimKey(dest.dim),
        Number(dest.x) + 0.5, Number(dest.y) + 0.5, Number(dest.z) + 0.5, false, dest.dim, cubeId, ext0, false, slot)
    } else {
      c4Retarget(server, core.x, core.y, core.z, c4DimKey('hexahedron:bedrock_bottom'),
        core.x, core.y, core.z, false, 'hexahedron:bedrock_bottom', cubeId, ext0, false, slot)
    }
  } catch (e5) { console.warn('[C4] bind 指门失败: ' + e5) }
  server.scheduleInTicks(10, () => {
    try {
      let synced = c4SyncDoorTags(server, 'minecraft:overworld', core.x, core.y, core.z, ext0, slot, cubeId, false, 96)
      console.info('[C4] bind 校验 slot=' + slot + ' faces=' + c4FaceSummary(synced.faces))
    } catch (e6) {}
  })
  console.info('[C4] bind slot=' + slot + ' btn=' + bx + ',' + by + ',' + bz + ' 门=' + made + ' 旧门清=' + killed + ' 清面=' + clearedFaces + '/6')
  c4Reply(ctx, 'bind slot=' + slot + ' btn=' + bx + ',' + by + ',' + bz + ' 门=' + made + ' 旧门清=' + killed + ' 清面=' + clearedFaces + '/6')
}

// 3×3 连接洞激活：基地洞 ↔ 传送器洞，各一扇「从上方跳下」的单向水平门
//   基地洞   (bas.x+0.5, bas.y+0.80, bas.z+0.5) → 传送器地板上 4 格、洞口旁 -z2 格
//   传送器洞 (tel.x+0.5, tel.y+0.80, tel.z+0.5) → 基地地板上 4 格、洞口旁 -z2 格
// cb_make_portal 直接生成、不建反向门 = 单向；重复激活先杀旧门再建（幂等）。
function c4ActivateHole(server, slot, player) {
  try {
    let info = c4TeamOfSlot(slot)
    if (!info || !info.cube) return 0
    let cubeId = info.cube.id || ('cube' + slot)
    let tel = c4TeleAnchor(slot)          // 传送器底面 (x, 10, z)
    let bas = c4BaseAnchor(slot)          // 基地底面 (x, 97, z)
    if (tel.y === bas.y && tel.x === bas.x && tel.z === bas.z) {
      console.warn('[C4] 3×3 洞：传送器与基地同址（slot' + slot + '）→ 先 /cube admin relocate 把传送器搬下去')
      try { c4BarTeam(server, slot, '隧道: 传送器还没搬下去（先按旧按钮迁移）') } catch (eB) {}
      return 0
    }
    let tx = tel.x + 0.5, tz = tel.z + 0.5
    let bx = bas.x + 0.5, bz = bas.z + 0.5
    // ① forceload 两处
    ;[[tel.x, tel.z], [bas.x, bas.z]].forEach(q => {
      try { server.runCommandSilent('execute in minecraft:overworld run forceload add ' + (q[0] - 24) + ' ' + (q[1] - 24) + ' ' + (q[0] + 24) + ' ' + (q[1] + 24)) } catch (e0) {}
    })
    // ② 清旧 3×3 门（历史三代 tag 都清；绝不碰 6 面门 cw_face_*）
    ;['cw_link', 'cw_face_link', 'cw_face_link_base'].forEach(tg => {
      ;[[bx, bas.y + 0.5, bz], [tx, tel.y + 0.5, tz]].forEach(p => {
        try { server.runCommandSilent('execute in minecraft:overworld positioned ' + p[0] + ' ' + p[1] + ' ' + p[2]
          + ' run kill @e[type=immersive_portals:portal,tag=' + tg + ',distance=..10]') } catch (e1) {}
      })
    })
    // ③ 两个洞打通（连同洞下一格，清掉历史遗留玻璃/水/封块）
    ;[[bx, bas.y, bz], [tx, tel.y, tz]].forEach(p => {
      ;[0, -1].forEach(dy0 => {
        try { server.runCommandSilent('execute in minecraft:overworld run fill ' + (p[0] - 1) + ' ' + (p[1] + dy0) + ' ' + (p[2] - 1) + ' '
          + (p[0] + 1) + ' ' + (p[1] + dy0) + ' ' + (p[2] + 1) + ' minecraft:air destroy') } catch (e2) {}
      })
    })
    // ③.6 5×5 管道：基地地板洞 → 传送室顶部之间，环形补框梁（中间 3×3 保持畅通）
    try {
      let px0 = Math.floor(bx), pz0 = Math.floor(bz)
      let top = bas.y + 1, bot = tel.y + 16      // 98 → 94（从基地地板面上方一格，一直填到舱顶）
      for (let py = top; py >= bot; py--) {
        // 5×5 环 = 5×5 填框梁后再把中间 3×3 挖回空气
        server.runCommandSilent('execute in minecraft:overworld run fill ' + (px0 - 2) + ' ' + py + ' ' + (pz0 - 2) + ' '
          + (px0 + 2) + ' ' + py + ' ' + (pz0 + 2) + ' kubejs:warping_frame')
        server.runCommandSilent('execute in minecraft:overworld run fill ' + (px0 - 1) + ' ' + py + ' ' + (pz0 - 1) + ' '
          + (px0 + 1) + ' ' + py + ' ' + (pz0 + 1) + ' minecraft:air')
      }
      console.info('[C4] 5×5 管道：y ' + top + '..' + bot + ' @' + px0 + ',' + pz0 + '（中间 3×3 畅通）')
    } catch (ePipe) { console.warn('[C4] 5×5 管道失败: ' + ePipe) }

    // ③.5 只给【传送器洞口】盖 3×3 玻璃（基地洞口保持敞开）：
    //      这条玻璃同时把下面的 B 门埋住，掉下来的人落玻璃上，不会被弹回基地
    try {
      let gtx = Math.floor(tx), gtz = Math.floor(tz)
      server.runCommandSilent('execute in minecraft:overworld run fill ' + (gtx - 1) + ' ' + tel.y + ' ' + (gtz - 1) + ' '
        + (gtx + 1) + ' ' + tel.y + ' ' + (gtz + 1) + ' minecraft:glass')
      console.info('[C4] 隧道玻璃盖（仅传送器洞口）：' + gtx + ',' + tel.y + ',' + gtz + ' 3×3')
    } catch (eGl) { console.warn('[C4] 传送器玻璃盖失败: ' + eGl) }

    // ④ 建两扇门（rot=90 = 从上方落下穿过；无反向门）
    // 门面沉在洞里「离地板顶 1/5 格」处（= 地板方块底 +0.8）：站洞口边缘不会误触，掉下去才过门
    // 按玩家站的位置决定建哪一侧：
    //   站在传送器洞口 → 只建「底部通往基地」那一扇（B）
    //   站在基地洞口   → 只建基地侧那一扇（A）
    //   管理员命令（player=null）→ 两侧都建
    let wantBase = true, wantTele = true
    if (player) {
      let near = (a) => {
        let dx = player.x - (a.x + 0.5), dz = player.z - (a.z + 0.5)
        return Math.sqrt(dx * dx + dz * dz) < 6.0 && Math.abs(player.y - a.y) < 9
      }
      let nb = near(bas), nt = near(tel)
      if (nb || nt) { wantBase = nb; wantTele = nt }
      else { wantBase = false; wantTele = true }
      console.info('[C4] 隧道激活定位：base=' + nb + ' tele=' + nt + ' → 建 ' + (wantBase ? 'A ' : '') + (wantTele ? 'B' : ''))
    }
    let A = wantBase ? c4SpawnLinkPortal(server, { x: bx, y: bas.y + 0.80, z: bz }, 3, 90) : null
    let B = wantTele ? c4SpawnLinkPortal(server, { x: tx, y: tel.y + 0.50, z: tz }, 3, 90) : null

    let aim = (e, tag, dx, dy, dz) => {
      if (!e) return false
      try {
        e.addTag('cw_link'); e.addTag(tag); e.addTag('cw_slot' + slot); e.addTag('cw_id_' + cubeId)
        e.addTag(c4TeamTagOf(slot))
      } catch (e0) {}
      let ok = false
      try {
        ok = c4ApplyPortal(server, e, 'minecraft:overworld', c4DimKey('minecraft:overworld'),
          c4Vec(dx, dy, dz), e.x, e.y, e.z)
      } catch (e1) { ok = false }
      // ⚠ 关键：直接改字段/走 API 之后必须 reloadAndSyncToClient，否则【客户端没有这扇门】：
      //    玩家看不到门（"像普通洞"），而且玩家的传送是客户端预测 + 服务端校验 → 也不会触发。
      //    （物品/村民是纯服务端实体，所以它们能正常传送，玩家不能——这就是之前现象不一致的原因）
      try { e.setIsVisible(!!C4_LINK_RENDER) } catch (e2) {}
      try { c4Sync(e) } catch (e3) {}
      return ok
    }
    // 落点 = 地板上 4 格 + 横向让开洞口 2 格（-z 一侧）：
    //   洞口半径 1.5（3×3）+ 玩家半宽 0.3 → 至少让开 1.8 才不会一落地又掉回去；2 格是贴边值。
    // 出口改到各自目标房间的【天花板下 0.5 格】（tel/bas 底面 +16.5 = 天花板平面 -0.5）
    let okA = wantBase ? aim(A, 'cw_link_down', tx, tel.y + 16.5, tz) : false   // 基地 → 传送器天花板
    let okB = wantTele ? aim(B, 'cw_link_up', bx, bas.y + 16.5, bz) : false     // 传送器 → 基地天花板
    console.info('[C4] 隧道 slot=' + slot + ' 建门 A=' + (wantBase ? (okA ? 'OK' : '失败') : '跳过')
      + ' B=' + (wantTele ? (okB ? 'OK' : '失败') : '跳过')
      + '（基地洞@' + bx + ',' + (bas.y + 0.80) + ',' + bz + ' / 传送器洞@' + tx + ',' + (tel.y + 0.50) + ',' + tz + '）')
    try { c4BarTeam(server, slot, '隧道: 基地 ↔ 传送器 已连通') } catch (e3) {}
    return (okA ? 1 : 0) + (okB ? 1 : 0)
  } catch (e) { console.warn('[C4] 3×3 连接洞激活失败: ' + e); return 0 }
}

// 拆掉 3×3 连接门（两处洞都清；只杀 cw_link 系列，不碰 6 面门）
function c4DeactivateHole(server, slot, player) {
  try {
    let bas = c4BaseAnchor(slot), tel = c4TeleAnchor(slot)
    let n = 0
    ;[[bas.x + 0.5, bas.y + 0.5, bas.z + 0.5], [tel.x + 0.5, tel.y + 0.5, tel.z + 0.5]].forEach(pt => {
      ;['cw_link', 'cw_link_up', 'cw_link_down', 'cw_face_link', 'cw_face_link_base'].forEach(tg => {
        try {
          server.runCommandSilent('execute in minecraft:overworld positioned ' + pt[0] + ' ' + pt[1] + ' ' + pt[2]
            + ' run kill @e[type=immersive_portals:portal,tag=' + tg + ',distance=..10]')
          n++
        } catch (e) {}
      })
    })
    console.info('[C4] 隧道已拆除 slot=' + slot + '（基地洞/传送器洞两处）')
    try { c4BarTeam(server, slot, '隧道: 已拆除') } catch (e2) {}
    return n
  } catch (e) { console.warn('[C4] 3×3 拆除失败: ' + e); return 0 }
}

// 新玩家登录：不再强制传送（原来会把第一次进服的人直接扔进基岩维度 0,0 的出生笼子，
// 和原包开场流程打架，看起来就像"被意外传送"）。出生点交给原版 respawn / 数据包 first_init。
PlayerEvents.loggedIn(event => {
  try {
    let p = event.player
    let t = c4Team(p)
    let key = t ? c4TeamKey(t) : null
    let cube = key ? c4CubeOfTeam(key) : null
    console.info('[C4] 登录：' + c4Name(p) + ' 队伍=' + (key || '-') + ' 立方体=' + (cube ? ('slot' + cube.slot) : '无') + '（不强制传送）')
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
    let bp = c4BtnPos(slot)
    try {
      server.runCommandSilent('execute in minecraft:overworld if block ' + bp.x + ' ' + bp.y + ' ' + bp.z
        + ' kubejs:launch_button_pressed run setblock ' + bp.x + ' ' + bp.y + ' ' + bp.z + ' kubejs:launch_button[facing=north]')
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
  // S5：老 cube.dest → cube.dests[dim]（一次性、幂等）
  try { c4MigrateDests() } catch (eD) { console.warn('[C4] dest 迁移异常: ' + eD) }

  // 传送器布局迁移：老存档把按钮绑在地面（y>50）→ 清掉锚点，走默认（传送器在基地下方 y=10）
  try {
    let db0 = c4Db(), cb0 = db0.cubes || {}, nT = 0
    for (let k0 in cb0) {
      let c0 = cb0[k0]
      if (c0 && c0.btn && Number(c0.btn.y) > 50) { delete c0.btn; nT++ }
    }
    if (nT > 0) { c4Save(); console.info('[C4] 传送器布局迁移：清理 ' + nT + ' 个地面按钮锚点（默认改到基地下方 y=10）') }
  } catch (eTl) { console.warn('[C4] 传送器布局迁移异常: ' + eTl) }
  // S1：老存档的门没有 cw_face_*/cw_team_* → 第一个 tick 按 cw_id_* + 几何补一次（幂等，等下次操作也会补）
  try { c4MigrateDoorTags(event.server) } catch (e) { console.warn('[C4] 门 tag 迁移异常: ' + e) }
})

// 聊天框只在失败时说话（见 c4WarpBody / perform 的 abort 分支）

// ════════════════════════════════════════════════════════════════════════════
// 脚本桥：cw_expand.js（后加载）通过 global.CWC 读这边的常量/数据/建造函数。
//   · 只在函数体内部被调用（运行时），放在文件末尾即可
//   · cw_expand.js 加载后填 global.CWE；本文件只通过它转调扩建命令
//   · 禁止在 cw_expand.js 顶层解构（KubeJS 每个脚本是独立作用域）
// ════════════════════════════════════════════════════════════════════════════
global.CWC = {
  // 常量
  TELE_FLOOR: C4_TELE_FLOOR, BASE_FLOOR: C4_BASE_FLOOR, CORE_Y: C4_CORE_Y, CELL: 16,
  // 数据
  db: () => c4Db(), save: () => c4Save(), teamOfSlot: (s) => c4TeamOfSlot(s),
  baseAnchor: (s) => c4BaseAnchor(s), baseCore: (s) => c4BaseCore(s),
  teleAnchor: (s) => c4TeleAnchor(s), btnPos: (s) => c4BtnPos(s),
  dimOf: (e) => c4DimOf(e), ext: (c) => c4Ext(c),
  team: (p) => c4Team(p), teamKey: (t) => c4TeamKey(t), cubeOfTeam: (k) => c4CubeOfTeam(k),
  name: (p) => c4Name(p),
  // 建造
  shellFill: (server, dim, box, block) => c4ShellFill(server, dim, box, block),
  owLevel: (server) => c4OwLevel(server),
  // 交互
  activateHole: (server, slot, player) => c4ActivateHole(server, slot, player),
  deactivateHole: (server, slot, player) => c4DeactivateHole(server, slot, player),
  deny: (p, msg) => c4ExpandDeny(p, msg),
  reply: (ctx, msg) => c4Reply(ctx, msg),
  notify: (server, slot, msg) => { try { c4BarTeam(server, slot, msg) } catch (e) {} },
  refreshDb: () => { C4_DB = null },
  // 命令参数（cw_expand.js 的 cmdExpand/cmdRebuild 从 ctx 里读 slot）
  slot: (ctx) => c4Iat().getInteger(ctx, 'slot'),
  iat: (v) => c4Iat().integer(v),
}
global.CWE = null   // cw_expand.js 加载后填自己的 API
