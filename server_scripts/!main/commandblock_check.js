//Checks if command blocks are enabled

function commandBlocksEnabled(server) {
  try {
    return server.isCommandBlockEnabled()
  } catch (e) {
    console.error('Could not read command block setting: ' + e)
    return true
  }
}

const WARNING = [
  Text.red(Text.translatable('cw.warn.command_blocks_disabled')).bold(),
  Text.red(Text.translatable('cw.warn.enable_command_blocks')),
  Text.red(Text.translatable('cw.warn.set_command_block_property'))
]

ServerEvents.loaded(event => {
  if (!commandBlocksEnabled(event.server)) {
    console.warn('Command blocks are DISABLED (enable-command-block=false)')
  }
})

PlayerEvents.loggedIn(event => {
  if (!commandBlocksEnabled(event.server)) {
    event.server.scheduleInTicks(60, () => {
      WARNING.forEach(line => event.player.tell(line))
    })
  }
})