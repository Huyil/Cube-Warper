// 扩展器：2×basic + 2×charged + 1×fluix，无序合成
ServerEvents.recipes(event => {
  event.shapeless('kubejs:cube_expander', [
    '2x kubejs:vector_operator_basic',
    '2x kubejs:vector_operator_charged',
    'kubejs:vector_operator_fluix'
  ]).id('cw:cube_expander')
})
