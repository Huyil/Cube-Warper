StartupEvents.registry('block', event => {

	event.create('cobblestone_ancient').displayName(Text.translatable('cw.pack.block.cobblestone'))
		.textureAll('kubejs:block/old_minecraft_textures/cobblestone_ancient')
		.fullBlock(true)
		.material("stone")
		.soundType("stone")

	event.create('cobblestone').displayName(Text.translatable('cw.pack.block.cobblestone'))
		.textureAll('kubejs:block/old_minecraft_textures/cobblestone')
		.fullBlock(true)
		.material("stone")
		.soundType("stone")

	event.create('mossy_cobblestone').displayName(Text.translatable('cw.pack.block.mossy_cobblestone'))
		.textureAll('kubejs:block/old_minecraft_textures/mossy_cobblestone')
		.fullBlock(true)
		.material("stone")
		.soundType("stone")

	event.create('bricks_ancient').displayName(Text.translatable('cw.pack.block.bricks'))
		.textureAll('kubejs:block/old_minecraft_textures/bricks_ancient')
		.fullBlock(true)
		.material("stone")
		.soundType("stone")

	event.create('bricks').displayName(Text.translatable('cw.pack.block.bricks'))
		.textureAll('kubejs:block/old_minecraft_textures/bricks')
		.fullBlock(true)
		.material("stone")
		.soundType("stone")

})