### UNFOLD
execute as @e[tag=outer_core] at @s run summon marker ~ ~8.45 ~ {Rotation:[0.0f,-90.0f],NoGravity:1b,Tags:["portal","y_outer"]}
execute as @e[tag=outer_core] at @s run summon marker ~ ~-8.45 ~ {Rotation:[0.0f,90.0f],NoGravity:1b,Tags:["portal","-y_outer"]}

execute as @e[tag=outer_core] at @s run summon marker ~8.45 ~ ~ {Rotation:[270.0f,0.0f],NoGravity:1b,Tags:["portal","x_outer"]}
execute as @e[tag=outer_core] at @s run summon marker ~-8.45 ~ ~ {Rotation:[90.0f,0.0f],NoGravity:1b,Tags:["portal","-x_outer"]}

execute as @e[tag=outer_core] at @s run summon marker ~ ~ ~8.45 {Rotation:[0.0f,0.0f],NoGravity:1b,Tags:["portal","z_outer"]}
execute as @e[tag=outer_core] at @s run summon marker ~ ~ ~-8.45 {Rotation:[180.0f,0.0f],NoGravity:1b,Tags:["portal","-z_outer"]}


### MOVE




### COMPLETE




### BUILD HEXAHEDRON
execute as @e[type=minecraft:marker,tag=outer_core] at @s positioned ~ ~-5 ~ run function hexahedron:build_hexahedron/17x17

function hexahedron:tickets/cleanup