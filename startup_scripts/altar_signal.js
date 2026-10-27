// 祭坛信号块：红石充能即触发祭坛仪式
//
// 为什么不用红石灯/按钮：
//   KubeJS 6 没有通用的 neighbor/redstone 事件，普通方块收不到"红石更新"。
//   detector 是 KubeJS 内置的方块类型，受红石信号时自己发事件：
//     BlockEvents.detectorPowered / detectorUnpowered / detectorChanged
//
// 用法：把它放在祭坛上（原石按钮的位置），接任意红石信号（拉杆/红石块/中继器/红石钟）。
//       上升沿触发一次；右键它也可以手动触发。

StartupEvents.registry('block', event => {
  event.create('altar_signal', 'detector')
    .detectorId('altar_signal')
    .displayName('祭坛信号')
})
