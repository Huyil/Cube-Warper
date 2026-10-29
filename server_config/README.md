# server_config/ —— 服务器游戏目录 config（不是 kubejs/config！）

本仓库根目录 = 测试服 `$INC/kubejs/`（KubeJS 实例目录）。
In Control! 等模组的配置在**游戏目录** `$INC/config/`（kubejs 的上一级）。

```text
本仓库 server_config/incontrol/*.json
  →  服务器 $INC = /opt/mcsmanager/daemon/data/InstanceData/3784f4dc2fa24b0bb6bb0de34de205cb
     $INC/config/incontrol/*.json
```

## 内容

- `spawner.json` —— 13 条维度刷怪规则（原作 12 条提频 + 维度18 silver_forest 刷猪），
  详见《会话协作与服务器API手册.md》§7
- `spawn.json` —— 禁止怪物生成在 `kubejs:hexahedron_filling`（原作舱内填充方块，防刷进舱）
- 其余 11 个是 In Control 默认空 `[]`（与原版一致，一般不用动）

## 部署（2026-10-29 定稿流程）

> `$INC` 已整体 chown 给 loli，config/ 可直接 scp。

```bash
INC=/opt/mcsmanager/daemon/data/InstanceData/3784f4dc2fa24b0bb6bb0de34de205cb
scp -q server_config/incontrol/spawner.json loli@192.168.1.41:$INC/config/incontrol/
# 然后重启实例——In Control 只在服务器启动早期读配置，KubeJS 的 /reload 无效
```

## 已证死路（别再试）

KubeJS 进程内读写游戏目录 config：

- `java.nio.file.Files` / `java.io.File` / `java.io.FileOutputStream` 全被
  KubeJS class filter 拦（"Class is not allowed by class filter"）；
- `JsonIO` 相对路径只认 kubejs 根（`config/...` 返回 null，`../...` 直接 NPE）；
- `JsonIO.write` 对 kubejs 外路径不报错但会**把目标文件删掉**（2026-10-29 实测两次，
  cw_incontrol_sync.js 初版因此闯祸，方案已废弃删除）。

结论：**scp + 重启是唯一通道**，不存在"配置自愈脚本"。
