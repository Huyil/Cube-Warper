scoreboard objectives add hex_settings dummy
scoreboard players set warp_pull_players hex_settings 0
tellraw @a ["",{"translate":"cw.settings.prefix","color":"aqua","bold":true},{"translate":"cw.settings.outside_players_set_to","color":"gray"},{"translate":"cw.settings.leave_behind","color":"gold","bold":true},{"translate":"cw.settings.leave_behind_detail","color":"gray"}]
