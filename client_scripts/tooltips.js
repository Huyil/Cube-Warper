ItemEvents.tooltip(event => {

  event.addAdvanced('kubejs:vector_operator_basic', (item, advanced, text) => {
    text.add(1, Text.gray(Text.translatable('cw.ui.tooltip.add_1')).bold(true))  
  })

  event.addAdvanced('kubejs:vector_operator_charged', (item, advanced, text) => {
    text.add(1, Text.gray(Text.translatable('cw.ui.tooltip.multiply_by_3')).bold(true))  
  })

  event.addAdvanced('kubejs:vector_operator_fluix', (item, advanced, text) => {
    text.add(1, Text.gray(Text.translatable('cw.ui.tooltip.add_2')).bold(true))  
  })

  event.addAdvanced('kubejs:vector_operator_nuclear', (item, advanced, text) => {
    text.add(1, Text.gray(Text.translatable('cw.ui.tooltip.multiply_by_4')).bold(true))  
  })

  event.addAdvanced('kubejs:vector_operator_blaze', (item, advanced, text) => {
    text.add(1, Text.gray(Text.translatable('cw.ui.tooltip.multiply_by_6')).bold(true))  
  })

  event.addAdvanced('kubejs:vector_operator_lightning', (item, advanced, text) => {
    text.add(1, Text.gray(Text.translatable('cw.ui.tooltip.multiply_by_8')).bold(true))  
  })

  event.addAdvanced('kubejs:vector_operator_eye', (item, advanced, text) => {
    text.add(1, Text.red(Text.translatable('cw.ui.tooltip.divide_by_0')).bold(true))  
  })

  event.addAdvanced('kubejs:vector_operator_infinite', (item, advanced, text) => {
    text.add(1, Text.red(Text.translatable('cw.ui.tooltip.collapse_destinations')).bold(true))  
  })

  event.addAdvanced('alexscaves:frostmint', (item, advanced, text) => {
    text.add(1, Text.blue(Text.translatable('cw.ui.tooltip.chiller_not_consumed')))  
  })

//Final Vectors
  event.addAdvanced('kubejs:vector_operator_infinite_empty', (item, advanced, text) => {text.add(1, Text.gray(Text.translatable('cw.ui.tooltip.step_1_ancient_redstone')).bold(true))  })
  event.addAdvanced('kubejs:vector_operator_step2', (item, advanced, text) => {text.add(1, Text.gray(Text.translatable('cw.ui.tooltip.step_2_shrine_dimension_8')).bold(true))  })
  event.addAdvanced('kubejs:vector_operator_step3', (item, advanced, text) => {text.add(1, Text.gray(Text.translatable('cw.ui.tooltip.step_3_spout_lumisene')).bold(true))  })
  event.addAdvanced('kubejs:vector_operator_step4', (item, advanced, text) => {text.add(1, Text.gray(Text.translatable('cw.ui.tooltip.step_4_spirit_altar')).bold(true))  })
  event.addAdvanced('kubejs:vector_operator_step5', (item, advanced, text) => {text.add(1, Text.gray(Text.translatable('cw.ui.tooltip.step_5_blaze_fuel')).bold(true))  })
  event.addAdvanced('kubejs:vector_operator_step6', (item, advanced, text) => {text.add(1, Text.gray(Text.translatable('cw.ui.tooltip.step_6_lightning_shrine')).bold(true))  })
  event.addAdvanced('kubejs:vector_operator_step7', (item, advanced, text) => {text.add(1, Text.gray(Text.translatable('cw.ui.tooltip.step_7_arc_furnace')).bold(true))  })
  event.addAdvanced('kubejs:vector_operator_step8', (item, advanced, text) => {text.add(1, Text.gray(Text.translatable('cw.ui.tooltip.step_8_weeping_well')).bold(true))  })
  event.addAdvanced('kubejs:vector_operator_step9', (item, advanced, text) => {text.add(1, Text.gray(Text.translatable('cw.ui.tooltip.step_9_modular_reactors')).bold(true))  })
  event.addAdvanced('kubejs:vector_operator_step10', (item, advanced, text) => {text.add(1, Text.gray(Text.translatable('cw.ui.tooltip.step_10_forsaken_idols')).bold(true))  })
  event.addAdvanced('kubejs:vector_operator_step11', (item, advanced, text) => {text.add(1, Text.gray(Text.translatable('cw.ui.tooltip.step_11_super_computers')).bold(true))  })
  event.addAdvanced('kubejs:vector_operator_step12', (item, advanced, text) => {text.add(1, Text.gray(Text.translatable('cw.ui.tooltip.step_12_vector_tuner')).bold(true))  })


  //(1) +1 → total 3  → +3 → [1, 2, 3]
  //(2) *3 → total 6  → +3 → [4, 6, 9]
  //(3) +2 → total 11 → +5 → [5, 7, 8, 12, 18]
  //(4) *4 → total 15 → +4 → [10, 16, 24, 32]
  //(5) *6 → total 20 → +5 → [13, 14, 36, 48, 72]
  //(6) *8 → total 24 → +4 → [17, 64, 96, 128]
  //(7) /0 → total 26 → +1 → [undifined]

  //(8) *5 → total 33 → +7 → [20, 25, 30, 40, 50, 60, 80]
  //(9) *7 → total 43 → +10 → [21, 28, 35, 42, 49, 56, 70, 84, 98, 112]

})