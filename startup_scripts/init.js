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
		.displayName(Text.translatable('cw.pack.vector_operator.empty'))
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
		.displayName(Text.translatable('cw.pack.vector_operator.old'))
		.fullBlock(false)
		.material("lantern")
		.soundType("lantern")
		.lightLevel(1.0)
		.box(4, 0, 4, 12, 10, 12)
		.renderType('translucent')
		.waterlogged()
		.hardness(0.0)
	event.create('vector_operator_charged')
		.displayName(Text.translatable('cw.pack.vector_operator.charged'))
		.fullBlock(false)
		.material("lantern")
		.soundType("lantern")
		.lightLevel(1.0)
		.box(4, 0, 4, 12, 10, 12)
		.renderType('translucent')
		.waterlogged()
		.hardness(0.0)
	event.create('vector_operator_fluix')
		.displayName(Text.translatable('cw.pack.vector_operator.fluix'))
		.fullBlock(false)
		.material("lantern")
		.soundType("lantern")
		.lightLevel(1.0)
		.box(4, 0, 4, 12, 10, 12)
		.renderType('translucent')
		.waterlogged()
		.hardness(0.0)
	event.create('vector_operator_nuclear')
		.displayName(Text.translatable('cw.pack.vector_operator.nuclear'))
		.fullBlock(false)
		.material("lantern")
		.soundType("lantern")
		.lightLevel(1.0)
		.box(4, 0, 4, 12, 10, 12)
		.renderType('translucent')
		.waterlogged()
		.hardness(0.0)
	event.create('vector_operator_blaze')
		.displayName(Text.translatable('cw.pack.vector_operator.blazing'))
		.fullBlock(false)
		.material("lantern")
		.soundType("lantern")
		.lightLevel(1.0)
		.box(4, 0, 4, 12, 10, 12)
		.renderType('translucent')
		.waterlogged()
		.hardness(0.0)
	event.create('vector_operator_lightning')
		.displayName(Text.translatable('cw.pack.vector_operator.lightning'))
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
		.displayName(Text.translatable('cw.pack.vector_operator.unknown'))
		.fullBlock(false)
		.material("lantern")
		.soundType("lantern")
		.box(4, 0, 4, 12, 10, 12)
		.renderType('translucent')
		.waterlogged()
		.hardness(0.0)

	event.create('vector_operator_infinite_empty')
		.displayName(Text.translatable('cw.pack.vector_operator.broken'))
		.fullBlock(false)
		.material("shroomlight")
		.soundType("shroomlight")
		.box(2, 0, 2, 14, 14, 14)
		.renderType('translucent')
		.waterlogged()
		.hardness(0.0)
		.lightLevel(1.0)

	event.create('vector_operator_infinite')
		.displayName(Text.translatable('cw.pack.vector_operator.infinity'))
		.fullBlock(false)
		.material("shroomlight")
		.soundType("shroomlight")
		.box(2, 0, 2, 14, 14, 14)
		.renderType('translucent')
		.waterlogged()
		.hardness(0.0)
		.lightLevel(1.0)


let eye = (id) => {
	event.create(id).waterlogged().displayName(Text.translatable('cw.pack.block.crimson_eye'))
	
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

	event.create('crimson_eye').waterlogged().displayName(Text.translatable('cw.pack.block.crimson_eye_red'))
		.fullBlock(true)
		.material("shroomlight")
		.soundType("shroomlight")
		.box (4, 0, 4, 12, 8, 12)

	event.create('hexahedron_filling').displayName(Text.translatable('cw.pack.block.hexahedron'))
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

	event.create('warping_frame').waterlogged().displayName(Text.translatable('cw.pack.block.warping_frame'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()

	event.create('stacked_warping_frame').waterlogged().displayName(Text.translatable('cw.pack.block.warping_frame_slab'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()

	event.create('warping_frame_platform').displayName(Text.translatable('cw.pack.block.warping_frame_platform'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()
		.box(0, 8, 0, 16, 16, 16)

	event.create('warping_frame_rusted_half').waterlogged().displayName(Text.translatable('cw.pack.block.rusted_warping_frame'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()

	event.create('warping_frame_rusted').waterlogged().displayName(Text.translatable('cw.pack.block.rusted_warping_frame'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()

	event.create('warping_frame_rusted_end').waterlogged().displayName(Text.translatable('cw.pack.block.rusted_warping_frame'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()

	event.create('warping_frame_rusted_half_end').waterlogged().displayName(Text.translatable('cw.pack.block.rusted_warping_frame'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()

	event.create('warping_vent').waterlogged().displayName(Text.translatable('cw.pack.block.warping_vent'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()

	event.create('warping_vent_rusted_half').waterlogged().displayName(Text.translatable('cw.pack.block.rusted_warping_vent'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()

	event.create('warping_vent_rusted').waterlogged().displayName(Text.translatable('cw.pack.block.rusted_warping_vent'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()

	event.create('crimson_statue').waterlogged().displayName(Text.translatable('cw.pack.block.crimson_statue'))
		.fullBlock(true)
		.material("calcite")
		.soundType("calcite")

	event.create('eye_pillar').waterlogged().displayName(Text.translatable('cw.pack.block.eye_pillar'))
		.fullBlock(true)
		.material("stone")
		.soundType("stone")
		.unbreakable()

	event.create('ancient_bricks').waterlogged().displayName(Text.translatable('cw.pack.block.ancient_bricks'))
		.fullBlock(true)
		.material("stone")
		.soundType("stone")
		.unbreakable()

	event.create('ancient_bricks_stairs', 'stairs').waterlogged().displayName(Text.translatable('cw.pack.block.ancient_brick_stairs'))
	    .textureAll('kubejs:block/ancient_bricks/ancient_bricks1')
		.fullBlock(true)
		.material("stone")
		.soundType("stone")
		.unbreakable()

	event.create('ancient_bricks_slab', 'slab').waterlogged().displayName(Text.translatable('cw.pack.block.ancient_brick_slab'))
	    .textureAll('kubejs:block/ancient_bricks/ancient_bricks1')
		.fullBlock(true)
		.material("stone")
		.soundType("stone")
		.unbreakable()

	event.create('ancient_bricks_wall', 'wall').waterlogged().displayName(Text.translatable('cw.pack.block.ancient_brick_wall'))
	    .textureAll('kubejs:block/ancient_bricks/ancient_bricks1')
		.fullBlock(true)
		.material("stone")
		.soundType("stone")
		.unbreakable()

	event.create('ancient_runes').waterlogged().displayName(Text.translatable('cw.pack.block.ancient_runes'))
		.fullBlock(true)
		.material("stone")
		.soundType("stone")
		.unbreakable()

	event.create('chiseled_ancient_bricks').waterlogged().displayName(Text.translatable('cw.pack.block.chiseled_ancient_bricks'))
		.fullBlock(true)
		.material("stone")
		.soundType("stone")
		.unbreakable()

	event.create('lightning_plinth').waterlogged().displayName(Text.translatable('cw.pack.block.lightning_plinth'))
		.fullBlock(true)
		.material("stone")
		.soundType("stone")
		.unbreakable()

	event.create('half_frame_bottom').waterlogged().displayName(Text.translatable('cw.pack.block.machine_frame_bottom'))
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

	event.create('half_frame_top').waterlogged().displayName(Text.translatable('cw.pack.block.machine_frame_top'))
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

	event.create('soul_cube').displayName(Text.translatable('cw.pack.block.soul_cube'))
		.material('shroomlight')
		.soundType("shroomlight")
		.lightLevel(1.0)
		.unbreakable()
		.box(4, 4, 4, 12, 12, 12, true)
		.waterlogged()

	event.create('ancient_core').waterlogged().displayName(Text.translatable('cw.pack.block.ancient_redstone_core'))
		.material('stone')
		.soundType("stone")
		.unbreakable()
		.lightLevel(1.0)

	event.create('emergency_fuses').waterlogged().displayName(Text.translatable('cw.pack.block.emergency_fuses'))
		.fullBlock(true)
		.material("wood")
		.soundType("cherry_wood")
		.hardness(0.5)

	event.create('coin_pile_gold').waterlogged().displayName(Text.translatable('cw.pack.block.gold_coins'))
		.fullBlock(true)
		.material("stone")
		.soundType("chain")
		.hardness(0.2)
		.tagBlock("mineable/shovel") 

	event.create('coin_bag_gold').waterlogged().displayName(Text.translatable('cw.pack.block.bag_of_gold_coins'))
		.fullBlock(true)
		.material("stone")
		.soundType("chain")
		.hardness(0.2)
		.tagBlock("mineable/shovel") 

	event.create('nuke_open').waterlogged().displayName(Text.translatable('cw.pack.block.opened_nuclear_bomb'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()

	event.create('computer').waterlogged().displayName(Text.translatable('cw.pack.block.computer'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")

	event.create('supercomputer').waterlogged().displayName(Text.translatable('cw.pack.block.supercomputer'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")

	event.create('recaptured_consciousness').waterlogged().displayName(Text.translatable('cw.pack.block.recaptured_consciousness'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")

	event.create('recaptured_consciousness_empty').waterlogged().displayName(Text.translatable('cw.pack.block.consciousness_container'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")

	event.create('modular_reactor').waterlogged().displayName(Text.translatable('cw.pack.block.modular_reactor'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")

	event.create('modular_reactor_empty').waterlogged().displayName(Text.translatable('cw.pack.block.empty_modular_reactor'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")

	event.create('vector_tuner').waterlogged().displayName(Text.translatable('cw.pack.block.vector_tuner'))
		.fullBlock(true)
		.material("netherite_block")
		.soundType("netherite_block")
		.unbreakable()

	event.create('block_shiny_ingot').waterlogged().displayName(Text.translatable('cw.pack.block.block_of_shiny_ingot'))
		.fullBlock(true)
		.material("metal")
		.soundType("metal")

	event.create('engineering_light_empty').waterlogged().displayName(Text.translatable('cw.pack.block.light_engineering_frame'))
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

	event.create('engineering_heavy_empty').waterlogged().displayName(Text.translatable('cw.pack.block.heavy_engineering_frame'))
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

	event.create('error_cube').displayName(Text.translatable('cw.pack.item.error_cube'))
	event.create('bottled_lightning').displayName(Text.translatable('cw.pack.item.lightning_in_a_bottle'))
	event.create('crowbar').displayName(Text.translatable('cw.pack.item.crowbar'))
	event.create('unbaked_guano_blast_brick').displayName(Text.translatable('cw.pack.item.unbaked_guano_blast_brick'))
	event.create('guano_blast_brick').displayName(Text.translatable('cw.pack.item.guano_blast_brick'))
	event.create('cooling_unit').displayName(Text.translatable('cw.pack.item.cooling_unit'))
	event.create('alpha_particles').displayName(Text.translatable('cw.pack.item.alpha_particles'))
	event.create('empty_shell').displayName(Text.translatable('cw.pack.item.empty_shell'))
	event.create('energized_redstone').displayName(Text.translatable('cw.pack.item.energized_redstone'))
	event.create('soul_fuse').displayName(Text.translatable('cw.pack.item.soul_tube'))
	event.create('portal_lantern').displayName(Text.translatable('cw.pack.item.recall_tube'))
	event.create('shiny_ingot').displayName(Text.translatable('cw.pack.item.shiny_ingot'))

	event.create('plastic').displayName(Text.translatable('cw.pack.item.plastic'))
	event.create('circuitboard_empty').displayName(Text.translatable('cw.pack.item.empty_circuit_board'))
	event.create('circuitboard').displayName(Text.translatable('cw.pack.item.high_tech_circuit_board'))
	event.create('peeking_circuit').displayName(Text.translatable('cw.pack.item.peeking_circuit'))
	event.create('seeking_circuit').displayName(Text.translatable('cw.pack.item.seeking_circuit'))
	event.create('grains_of_infinity').displayName(Text.translatable('cw.pack.item.grains_of_infinity')).modelJson({parent: 'enderio:item/grains_of_infinity'})

	event.create('party_popper').displayName(Text.translatable('cw.pack.item.party_popper'))
	event.create('tiny_party_popper').displayName(Text.translatable('cw.pack.item.tiny_confetti_popper'))

	event.create('adilette').displayName(Text.translatable('cw.pack.item.adilette'))

	event.create('chocolate_chip').displayName(Text.translatable('cw.pack.item.chocolate_chip'))
		.food(food => {
    		food
    			.hunger(8)
    			.saturation(0.5)
    			.effect('minecraft:speed', 200, 0, 1)
    			.alwaysEdible()
		})

})