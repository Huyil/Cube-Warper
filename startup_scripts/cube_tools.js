// Cube Warper · 扩展/拆除工具（物品注册必须在 startup_scripts，/reload 不生效）
StartupEvents.registry('item', event => {
  event.create('cube_expander')
    .displayName('立方体扩展器')
    .maxStackSize(16)
    .glow(true)
  event.create('cube_reducer')
    .displayName('立方体拆除器')
    .maxStackSize(1)
    .glow(true)
})
