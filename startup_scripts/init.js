StartupEvents.registry('block', event => {

let rotatable = (id, name, configure) => {
    let block = event.create(id).waterlogged()
        .displayName(name)
        .property(BlockProperties.FACING)
        .placementState(c => {
            c.set(BlockProperties.FACING, c.nearestLookingDirection.opposite)
        })

    configure(block)
    block.blockstateJson = {
        variants: {
            "facing=up":    { model: `kubejs:block/${id}`, y: 0 },
            "facing=down":  { model: `kubejs:block/${id}`, y: 0 },
            "facing=north": { model: `kubejs:block/${id}`, y: 0 },
            "facing=east":  { model: `kubejs:block/${id}`, y: 90 },
            "facing=south": { model: `kubejs:block/${id}`, y: 180 },
            "facing=west":  { model: `kubejs:block/${id}`, y: 270 }
        }
    }
}

let rotatable_side = (id, name, configure) => {
    let block = event.create(id).waterlogged()
        .displayName(name)
        .property(BlockProperties.FACING)
        .placementState(c => {
            c.set(BlockProperties.FACING, c.nearestLookingDirection.opposite)
        })

    configure(block)
	block.blockstateJson = {
    	variants: {
    	    "facing=up":    { model: `kubejs:block/${id}`,x: 180,y: 0 },
    	    "facing=down":  { model: `kubejs:block/${id}`,x: 90, y: 0 },
    	    "facing=north": { model: `kubejs:block/${id}`,x: 90, y: 180 },
    	    "facing=east":  { model: `kubejs:block/${id}`,x: 90, y: 270 },
    	    "facing=south": { model: `kubejs:block/${id}`,x: 90, y: 0 },
    	    "facing=west":  { model: `kubejs:block/${id}`,x: 90, y: 90 }
    	}
	}
}

	rotatable("warping_interface", Text.translatable('cw.pack.block.warping_interface'), block => {block
	    .fullBlock(true)
	    .material("netherite_block")
	    .soundType("netherite_block")
	    .unbreakable()
	})

	rotatable("warping_interface_running", Text.translatable('cw.pack.block.warping_interface'), block => {block
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()
	})

	rotatable("warping_interface_cracked", Text.translatable('cw.pack.block.broken_warping_interface'), block => {block
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()
	})

	rotatable("warping_disc_drive", Text.translatable('cw.pack.block.warping_exhaust'), block => {block
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()
	})

	rotatable("warping_controls", Text.translatable('cw.pack.block.warping_controls'), block => {block
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()
	})

	rotatable("launch_button", Text.translatable('cw.pack.block.launch_button'), block => {block
		.fullBlock(false)
		.material("shroomlight")
		.soundType("shroomlight")
		.unbreakable()
		.box(5, 5, 14, 11, 11, 16 )
		.renderType('translucent')
		.waterlogged()
	})

	rotatable("launch_button_pressed", Text.translatable('cw.pack.block.launch_button'), block => {block
		.fullBlock(false)
		.material("shroomlight")
		.soundType("shroomlight")
		.unbreakable()
		.box(5, 5, 15, 11, 11, 16 )
		.renderType('translucent')
		.waterlogged()
	})

	rotatable("warping_controls_pressed", Text.translatable('cw.pack.block.warping_controls'), block => {block
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()
	})

	rotatable("time_warper", Text.translatable('cw.pack.block.time_warper'), block => {block
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()
	})

	rotatable_side("eye_breaker", Text.translatable('cw.pack.block.eye_breaker'), block => {block
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
	})

	event.create(`vector_operator_empty`)
		.displayName(Text.of('§f空向量算符'))
		.fullBlock(false)
		.material("lantern")
		.soundType("lantern")
		.lightLevel(1.0)
		.box(4, 0, 4, 12, 10, 12)
		.renderType('translucent')
		.waterlogged()
		.hardness(0.0)
		//.noDrops()

	event.create('vector_operator_basic')
		.displayName(Text.of('§f§l旧向量算符'))
		.fullBlock(false)
		.material("lantern")
		.soundType("lantern")
		.lightLevel(1.0)
		.box(4, 0, 4, 12, 10, 12)
		.renderType('translucent')
		.waterlogged()
		.hardness(0.0)
	event.create('vector_operator_charged')
		.displayName(Text.of('§e§l充能向量算符'))
		.fullBlock(false)
		.material("lantern")
		.soundType("lantern")
		.lightLevel(1.0)
		.box(4, 0, 4, 12, 10, 12)
		.renderType('translucent')
		.waterlogged()
		.hardness(0.0)
	event.create('vector_operator_fluix')
		.displayName(Text.of('§5§l福鲁伊克斯向量算符'))
		.fullBlock(false)
		.material("lantern")
		.soundType("lantern")
		.lightLevel(1.0)
		.box(4, 0, 4, 12, 10, 12)
		.renderType('translucent')
		.waterlogged()
		.hardness(0.0)
	event.create('vector_operator_nuclear')
		.displayName(Text.of('§a§l核能向量算符'))
		.fullBlock(false)
		.material("lantern")
		.soundType("lantern")
		.lightLevel(1.0)
		.box(4, 0, 4, 12, 10, 12)
		.renderType('translucent')
		.waterlogged()
		.hardness(0.0)
	event.create('vector_operator_blaze')
		.displayName(Text.of('§6§l烈焰向量算符'))
		.fullBlock(false)
		.material("lantern")
		.soundType("lantern")
		.lightLevel(1.0)
		.box(4, 0, 4, 12, 10, 12)
		.renderType('translucent')
		.waterlogged()
		.hardness(0.0)
	event.create('vector_operator_lightning')
		.displayName(Text.of('§b§l闪电向量算符'))
		.fullBlock(false)
		.material("lantern")
		.soundType("lantern")
		.lightLevel(1.0)
		.box(4, 0, 4, 12, 10, 12)
		.renderType('translucent')
		.waterlogged()
		.hardness(0.0)

	//§0 black
	//§1 dark blue
	//§2 dark green
	//§3 dark aqua
	//§4 dark red
	//§5 dark purple
	//§6 gold
	//§7 gray
	//§8 dark gray
	//§9 blue
	//§a green
	//§b aqua
	//§c red
	//§d light purple
	//§e yellow
	//§f white

	//§l = bold
	//§o = italic
	//§n = underline
	//§m = strikethrough
	//§k = obfuscated/magic text
	//§r = reset

	event.create('vector_operator_eye')
		.displayName(Text.of('§4§l§k未知§r§4§l 向量算符'))
		.fullBlock(false)
		.material("lantern")
		.soundType("lantern")
		.box(4, 0, 4, 12, 10, 12)
		.renderType('translucent')
		.waterlogged()
		.hardness(0.0)

	event.create('vector_operator_infinite_empty')
		.displayName(Text.of('§8§l损坏的向量算符'))
		.fullBlock(false)
		.material("shroomlight")
		.soundType("shroomlight")
		.box(2, 0, 2, 14, 14, 14)
		.renderType('translucent')
		.waterlogged()
		.hardness(0.0)
		.lightLevel(1.0)

	event.create('vector_operator_infinite')
		.displayName(Text.of('§f§l无限向量算符'))
		.fullBlock(false)
		.material("shroomlight")
		.soundType("shroomlight")
		.box(2, 0, 2, 14, 14, 14)
		.renderType('translucent')
		.waterlogged()
		.hardness(0.0)
		.lightLevel(1.0)


let eye = (id) => {
	event.create(id).waterlogged().displayName(Text.of('绯红之眼'))
	
		.fullBlock(true)
		.material("stone")
		.soundType("stone")
		.unbreakable()

		.property(BlockProperties.FACING)
		.placementState(c =>{
			  c.set(BlockProperties.FACING, c.nearestLookingDirection.opposite)}
		)
    	.blockstateJson = {
    	    variants: {
    	        "facing=up":    { model: `kubejs:block/${id}`, y: 0 },
    	        "facing=down":  { model: `kubejs:block/${id}`, y: 0 },
    	        "facing=north": { model: `kubejs:block/${id}`, y: 0 },
    	        "facing=east":  { model: `kubejs:block/${id}`, y: 90 },
    	        "facing=south": { model: `kubejs:block/${id}`, y: 180 },
    	        "facing=west":  { model: `kubejs:block/${id}`, y: 270 }
    	    }
		}
	}

	eye("eye_closed")
	eye("eye_open")
	eye("eye_stage_1")
	eye("eye_stage_2")
	eye("eye_stage_3")
	eye("eye_stage_4")

	event.create('crimson_eye').waterlogged().displayName(Text.of('§c绯红之眼'))
		.fullBlock(true)
		.material("shroomlight")
		.soundType("shroomlight")
		.box (4, 0, 4, 12, 8, 12)

	event.create('hexahedron_filling').displayName(Text.of('正方体'))
		.fullBlock(true)
		.material("stone")
		.soundType("stone")
		.unbreakable()
		.transparent(true)
		.defaultCutout()
		.noCollision()
    	.notSolid() 
		.noDrops()
		.noValidSpawns(true)

	event.create('warping_frame').waterlogged().displayName(Text.of('诡异框架'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()

	event.create('stacked_warping_frame').waterlogged().displayName(Text.of('诡异框架台阶'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()

	event.create('warping_frame_platform').displayName(Text.of('诡异框架平台'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()
		.box(0, 8, 0, 16, 16, 16)

	event.create('warping_frame_rusted_half').waterlogged().displayName(Text.of('锈蚀诡异框架'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()

	event.create('warping_frame_rusted').waterlogged().displayName(Text.of('锈蚀诡异框架'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()

	event.create('warping_frame_rusted_end').waterlogged().displayName(Text.of('锈蚀诡异框架'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()

	event.create('warping_frame_rusted_half_end').waterlogged().displayName(Text.of('锈蚀诡异框架'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()

	event.create('warping_vent').waterlogged().displayName(Text.of('诡异通风口'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()

	event.create('warping_vent_rusted_half').waterlogged().displayName(Text.of('锈蚀诡异通风口'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()

	event.create('warping_vent_rusted').waterlogged().displayName(Text.of('锈蚀诡异通风口'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()

	event.create('crimson_statue').waterlogged().displayName(Text.of('绯红雕像'))
		.fullBlock(true)
		.material("calcite")
		.soundType("calcite")

	event.create('eye_pillar').waterlogged().displayName(Text.of('眼球之柱'))
		.fullBlock(true)
		.material("stone")
		.soundType("stone")
		.unbreakable()

	event.create('ancient_bricks').waterlogged().displayName(Text.of('远古砖块'))
		.fullBlock(true)
		.material("stone")
		.soundType("stone")
		.unbreakable()

	event.create('ancient_bricks_stairs', 'stairs').waterlogged().displayName(Text.of('远古砖楼梯'))
	    .textureAll('kubejs:block/ancient_bricks/ancient_bricks1')
		.fullBlock(true)
		.material("stone")
		.soundType("stone")
		.unbreakable()

	event.create('ancient_bricks_slab', 'slab').waterlogged().displayName(Text.of('远古砖台阶'))
	    .textureAll('kubejs:block/ancient_bricks/ancient_bricks1')
		.fullBlock(true)
		.material("stone")
		.soundType("stone")
		.unbreakable()

	event.create('ancient_bricks_wall', 'wall').waterlogged().displayName(Text.of('远古砖墙'))
	    .textureAll('kubejs:block/ancient_bricks/ancient_bricks1')
		.fullBlock(true)
		.material("stone")
		.soundType("stone")
		.unbreakable()

	event.create('ancient_runes').waterlogged().displayName(Text.of('远古符文'))
		.fullBlock(true)
		.material("stone")
		.soundType("stone")
		.unbreakable()

	event.create('chiseled_ancient_bricks').waterlogged().displayName(Text.of('錾制远古砖块'))
		.fullBlock(true)
		.material("stone")
		.soundType("stone")
		.unbreakable()

	event.create('lightning_plinth').waterlogged().displayName(Text.of('闪电基座'))
		.fullBlock(true)
		.material("stone")
		.soundType("stone")
		.unbreakable()

	event.create('half_frame_bottom').waterlogged().displayName(Text.of('机器框架底部'))
		.material('lantern').hardness(1.5)
		.tagBlock('minecraft:mineable/pickaxe')
		.soundType("lantern")
		.box(11, 5, 11, 16, 8, 16, true)
		.box(0, 5, 11, 5, 8, 16, true)
		.box(11, 5, 0, 16, 8, 5, true)
		.box(0, 5, 0, 5, 8, 5, true)
		.box(5, 0, 11, 11, 5, 16, true)
		.box(5, 0, 0, 11, 5, 5, true)
		.box(11, 0, 0, 16, 5, 16, true)
		.box(0, 0, 0, 5, 5, 16, true)

	event.create('half_frame_top').waterlogged().displayName(Text.of('机器框架顶部'))
		.material('lantern').hardness(1.5)
		.tagBlock('minecraft:mineable/pickaxe')
		.soundType("lantern")
		.box(11, 0, 0, 16, 5, 5, true)
		.box(0, 0, 0, 5, 5, 5, true)
		.box(11, 0, 11, 16, 5, 16, true)
		.box(0, 0, 11, 5, 5, 16, true)
		.box(5, 5, 0, 11, 10, 5, true)
		.box(5, 5, 11, 11, 10, 16, true)
		.box(11, 5, 0, 16, 10, 16, true)
		.box(0, 5, 0, 5, 10, 16, true)

	event.create('soul_cube').displayName(Text.of('灵魂方块'))
		.material('shroomlight')
		.soundType("shroomlight")
		.lightLevel(1.0)
		.unbreakable()
		.box(4, 4, 4, 12, 12, 12, true)
		.waterlogged()

	event.create('ancient_core').waterlogged().displayName(Text.of('远古红石核心'))
		.material('stone')
		.soundType("stone")
		.unbreakable()
		.lightLevel(1.0)

	event.create('emergency_fuses').waterlogged().displayName(Text.of('应急保险丝'))
		.fullBlock(true)
		.material("wood")
		.soundType("cherry_wood")
		.hardness(0.5)

	event.create('coin_pile_gold').waterlogged().displayName(Text.of('金币'))
		.fullBlock(true)
		.material("stone")
		.soundType("chain")
		.hardness(0.2)
		.tagBlock("mineable/shovel") 

	event.create('coin_bag_gold').waterlogged().displayName(Text.of('金币袋'))
		.fullBlock(true)
		.material("stone")
		.soundType("chain")
		.hardness(0.2)
		.tagBlock("mineable/shovel") 

	event.create('nuke_open').waterlogged().displayName(Text.of('已打开的核弹'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()

	event.create('computer').waterlogged().displayName(Text.of('电脑'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")

	event.create('supercomputer').waterlogged().displayName(Text.of('超级计算机'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")

	event.create('recaptured_consciousness').waterlogged().displayName(Text.of('被重新捕获的意识'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")

	event.create('recaptured_consciousness_empty').waterlogged().displayName(Text.of('意识容器'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")

	event.create('modular_reactor').waterlogged().displayName(Text.of('模块化反应堆'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")

	event.create('modular_reactor_empty').waterlogged().displayName(Text.of('空模块化反应堆'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")

	event.create('vector_tuner').waterlogged().displayName(Text.of('向量调谐器'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()

	event.create('block_shiny_ingot').waterlogged().displayName(Text.of('§e闪亮锭块'))
		.fullBlock(true)
		.material("metal")
		.soundType("metal")

	event.create('engineering_light_empty').waterlogged().displayName(Text.of('轻型工程框架'))
		.material('lantern').hardness(1.5)
		.soundType("lantern")
		.tagBlock('minecraft:mineable/pickaxe')
		.renderType("cutout")
		.box(0, 0, 0, 3, 3, 16)
		.box(13, 0, 0, 16, 3, 16)
		.box(0, 13, 0, 3, 16, 16)
		.box(13, 13, 0, 16, 16, 16)
		.box(0, 3, 0, 3, 13, 3)
		.box(0, 3, 13, 3, 13, 16)
		.box(13, 3, 13, 16, 13, 16)
		.box(13, 3, 0, 16, 13, 3)
		.box(3, 13, 0, 13, 16, 3)
		.box(3, 0, 0, 13, 3, 3)
		.box(3, 0, 13, 13, 3, 16)
		.box(3, 13, 13, 13, 16, 16)
		.tagBlock('minecraft:mineable/pickaxe')

	event.create('engineering_heavy_empty').waterlogged().displayName(Text.of('重型工程框架'))
		.material('lantern').hardness(1.5)
		.soundType("lantern")
		.renderType("cutout")
		.box(0, 0, 0, 3, 3, 16)
		.box(13, 0, 0, 16, 3, 16)
		.box(0, 13, 0, 3, 16, 16)
		.box(13, 13, 0, 16, 16, 16)
		.box(0, 3, 0, 3, 13, 3)
		.box(0, 3, 13, 3, 13, 16)
		.box(13, 3, 13, 16, 13, 16)
		.box(13, 3, 0, 16, 13, 3)
		.box(3, 13, 0, 13, 16, 3)
		.box(3, 0, 0, 13, 3, 3)
		.box(3, 0, 13, 13, 3, 16)
		.box(3, 13, 13, 13, 16, 16)
		.tagBlock('minecraft:mineable/pickaxe')

})

StartupEvents.registry('item', event => {

	event.create('error_cube').displayName(Text.of('错误方块'))
	event.create('bottled_lightning').displayName(Text.of('瓶中闪电'))
	event.create('crowbar').displayName(Text.of('撬棍'))
	event.create('unbaked_guano_blast_brick').displayName(Text.of('未烧制的鸟粪爆破砖'))
	event.create('guano_blast_brick').displayName(Text.of('鸟粪爆破砖'))
	event.create('cooling_unit').displayName(Text.of('冷却单元'))
	event.create('alpha_particles').displayName(Text.of('α粒子'))
	event.create('empty_shell').displayName(Text.of('空壳'))
	event.create('energized_redstone').displayName(Text.of('充能红石'))
	event.create('soul_fuse').displayName(Text.of('灵魂管道'))
	event.create('portal_lantern').displayName(Text.of('召回管道'))
	event.create('shiny_ingot').displayName(Text.of('§e闪亮锭'))

	event.create('plastic').displayName(Text.of('塑料'))
	event.create('circuitboard_empty').displayName(Text.of('空电路板'))
	event.create('circuitboard').displayName(Text.of('高科技电路板'))
	event.create('peeking_circuit').displayName(Text.of('窥探电路'))
	event.create('seeking_circuit').displayName(Text.of('搜寻电路'))
	event.create('grains_of_infinity').displayName(Text.of('无限微粒')).modelJson({parent: 'enderio:item/grains_of_infinity'})

	event.create('party_popper').displayName(Text.of('派对礼花筒'))
	event.create('tiny_party_popper').displayName(Text.of('微型彩纸礼花筒'))

	event.create('adilette').displayName(Text.of('浴室拖鞋'))

	event.create('chocolate_chip').displayName(Text.of('巧克力碎'))
		.food(food => {
    		food
    			.hunger(8)
    			.saturation(0.5)
    			.effect('minecraft:speed', 200, 0, 1)
    			.alwaysEdible()
		})

})