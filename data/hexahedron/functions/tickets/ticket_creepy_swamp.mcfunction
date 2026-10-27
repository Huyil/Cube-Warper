### TEMINATE CURRENT POSITION
execute as @e[tag=outer_core] at @s run fill ~-8 ~-8 ~-8 ~8 ~8 ~8 air
kill @e[type=marker,tag=outer_core]

### INITIATE CONNECTION
execute at @s as @e[type=immersive_portals:portal,name=main_cube,distance=..96,tag=!cw_lobby] at @s run portal set_portal_destination hexahedron:creepy_swamp ~ ~ ~
execute at @s in hexahedron:creepy_swamp run summon marker ~ ~ ~ {NoGravity:1b,Tags:["outer_core"]}

### QUE REPOSITIONING
schedule function hexahedron:repositioning/standard_floor 5s

### START TELEPORTATION
tag @s add running

### KEEP YOUR FRIENDS INSIDE THE VEHICLE AT ALL TIMES
execute if score warp_pull_players hex_settings matches 1 in minecraft:overworld as @e[type=marker,tag=core] at @s run tag @a[distance=..50] add inside_cube
tag @a remove inside_cube