# ============================================================================
# 已由 KubeJS 接管：server_scripts/!main/shrine_ritual_multi.js
# 本文件保留为空壳：原逻辑是扫脚下方块 -> 给 active_ritual marker 的计分板 +1
# -> setblock ~ ~ ~ air（方块直接湮灭）。现在由 JS 的 ritualConsume() 逐方位复刻，
# 计分只在内存里（job.scores），不再写全局 scoreboard。
# ============================================================================
