# server_config/ —— 服务器游戏目录 config（不是 kubejs/config！）

本仓库根目录 = 测试服 `$INC/kubejs/`（KubeJS 实例目录）。
但 In Control! 等模组的配置在**游戏目录** `$INC/config/`（kubejs 的上一级），
kubejs 部署流程（只 scp `server_scripts/!main/cw_cubes.js`）**覆盖不到这里**——
这就是原作维度刷怪失效的根源。

## 目录对应关系

```text
本仓库 server_config/incontrol/*.json
  →  服务器 /opt/mcsmanager/daemon/data/InstanceData/3784f4dc2fa24b0bb6bb0de34de205cb/config/incontrol/*.json
```

## 部署（一次性，改完需重启实例或等世界重载）

```bash
INC=/opt/mcsmanager/daemon/data/InstanceData/3784f4dc2fa24b0bb6bb0de34de205cb
scp -q -r server_config/incontrol loli@192.168.1.41:$INC/config/
ssh loli@192.168.1.41 "ls $INC/config/incontrol/ | wc -l"   # 应为 13
```

配置在**世界加载时**读取，KubeJS 的 `/reload` 不生效，需要重启实例。

## 内容来源

逐字节复制自原版整合包 `Cube Warper-version 1.14.zip` 内
`overrides/config/incontrol/`（与 1.13 / 1.14Edit / 本机客户端完全一致，md5 已核对）。
有实际内容的只有两个文件，其余 11 个是默认空 `[]`：

- `spawner.json` —— 12 条维度专属刷怪规则（详见《会话协作与服务器API手册.md》§7）
- `spawn.json` —— 禁止怪物生成在 `kubejs:hexahedron_filling`（原作舱内填充方块，防刷进舱）
