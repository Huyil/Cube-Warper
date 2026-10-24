scoreboard objectives add hex_settings dummy
execute unless score warp_pull_players hex_settings matches 0..1 run scoreboard players set warp_pull_players hex_settings 0
execute if score warp_pull_players hex_settings matches 0 run tellraw @s ["",{"translate":"cw.settings.prefix","color":"aqua","bold":true},{"translate":"cw.settings.current_warp_mode","color":"gray"},{"translate":"cw.settings.leave_behind_0","color":"gold","bold":true}]
execute if score warp_pull_players hex_settings matches 1 run tellraw @s ["",{"translate":"cw.settings.prefix","color":"aqua","bold":true},{"translate":"cw.settings.current_warp_mode","color":"gray"},{"translate":"cw.settings.teleport_inside_1","color":"green","bold":true}]
