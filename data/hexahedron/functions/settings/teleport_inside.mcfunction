scoreboard objectives add hex_settings dummy
scoreboard players set warp_pull_players hex_settings 1
tellraw @a ["",{"translate":"cw.settings.prefix","color":"aqua","bold":true},{"translate":"cw.settings.outside_players_set_to","color":"gray"},{"translate":"cw.settings.teleport_inside","color":"green","bold":true},{"translate":"cw.settings.teleport_inside_detail","color":"gray"}]
