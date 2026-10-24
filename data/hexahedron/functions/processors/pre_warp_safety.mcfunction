### Ensure hex_settings objective exists and defaults to 0 (leave_behind)
scoreboard objectives add hex_settings dummy
execute unless score warp_pull_players hex_settings matches 0..1 run scoreboard players set warp_pull_players hex_settings 0

### Sever outer reverse portals & cluster binding immediately so ClientWorldLoader.tick() never hits ConcurrentModificationException

### If warp_pull_players == 1 (teleport_inside), pull all players outside the Hexahedron back inside
execute if score warp_pull_players hex_settings matches 1 in minecraft:overworld as @e[type=marker,tag=core] at @s run tag @a[distance=..50] add inside_cube
execute if score warp_pull_players hex_settings matches 1 in minecraft:overworld as @e[type=marker,tag=core] at @s if entity @a[tag=!inside_cube,tag=init] run function hexahedron:return_portal/portal_travel
tag @a remove inside_cube
