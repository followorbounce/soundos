// Nine tuning presets adapted from Pulse Train — Stage II's interval-math
// presets (followorbounce.github.io/pulse-train-stage-ii). The mathematical
// core of each — the exact frequency ratio between the two tones — is ported
// verbatim; secondary knobs (Rhythm/Crush/Comb/etc.) are re-tuned to this
// project's own, differently-built versions of those nodes rather than
// copied number-for-number, since the underlying DSP isn't identical.
// `bypass`/`params` are keyed by role (see ROLES in main.js), not raw node
// ids, so a preset applies to whatever the current starter rack is.

export const PRESETS = [
  {
    id: 'unison-beat',
    name: 'Unison Beat — 4 Hz',
    note: 'Tone и Tone II расходятся на 4 Гц — медленное биение в тета-диапазоне, та же интерференция, что стоит за монауральными и бинауральными биениями.',
    bypass: { tone2: false, rhythm: true, crush: true, ring: true, field: false, freeze: true, comb: true, space: false, drive: true, shimmer: true },
    params: {
      tone: { freq: 220, level: 0.7 },
      tone2: { freq: 224, level: 0.65 },
      field: { rate: 0.3, steps: 2, depth: 1 },
      space: { size: 1.2, mix: 0.2 },
      output: { volume: 0.75 },
    },
  },
  {
    id: 'perfect-fifth',
    name: 'Perfect Fifth — 3∶2',
    note: 'Tone II зафиксирован на чистую квинту выше Tone (соотношение 3∶2, корень 196 Гц) — первый интервал за октавой, где два тона запираются в простое устойчивое отношение вместо ухода в дрейф.',
    bypass: { tone2: false, rhythm: true, crush: true, ring: true, field: false, freeze: true, comb: true, space: false, drive: true, shimmer: true },
    params: {
      tone: { freq: 196, level: 0.7 },
      tone2: { freq: 294, level: 0.65 },
      field: { rate: 0.25, steps: 2, depth: 1 },
      space: { size: 1.0, mix: 0.18 },
      output: { volume: 0.75 },
    },
  },
  {
    id: 'golden-ratio',
    name: 'Golden Ratio — φ',
    note: 'Tone II стоит выше Tone в φ ≈ 1.618… раз — единственное отношение, гарантированно не запирающееся ни в какое простое целочисленное соотношение, поэтому биение между двумя тонами никогда не разрешается в устойчивый пульс.',
    bypass: { tone2: false, rhythm: true, crush: false, ring: false, field: false, freeze: false, comb: true, space: false, drive: true, shimmer: true },
    params: {
      tone: { freq: 220, level: 0.7 },
      tone2: { freq: 356, level: 0.65 },
      crush: { bits: 6, mix: 0.35 },
      ring: { freq: 356, mix: 0.6 },
      field: { rate: 0.5, steps: 3, depth: 1 },
      freeze: { time: 0.618, feedback: 0.55, mix: 0.45 },
      space: { size: 1.6, mix: 0.4 },
      output: { volume: 0.72 },
    },
  },
  {
    id: 'harmonic-series',
    name: 'Harmonic Series — 1∶2∶3∶4',
    note: 'Tone на 110 Гц — основной тон; Tone II стоит ровно на октаву выше (2-я гармоника), Ring настроен на 3-ю, Comb — на 4-ю: аддитивный стек, стоящий за тембром любого высотного инструмента, разложенный по одной ноде на парциал.',
    bypass: { tone2: false, rhythm: true, crush: true, ring: false, field: false, freeze: false, comb: false, space: false, drive: true, shimmer: true },
    params: {
      tone: { freq: 110, level: 0.72 },
      tone2: { freq: 220, level: 0.6 },
      ring: { freq: 330, mix: 0.7 },
      freeze: { time: 0.09, feedback: 0.25, mix: 0.25 },
      comb: { freq: 440, resonance: 0.45, mix: 0.45 },
      field: { rate: 0.3, steps: 2, depth: 1 },
      space: { size: 1.2, mix: 0.3 },
      output: { volume: 0.75 },
    },
  },
  {
    id: 'tritone',
    name: 'Tritone — √2',
    note: 'Tone II стоит ровно на полоктавы выше Tone (2^(6/12), равномерно темперированный тритон) — интервал без простого отношения, к которому можно свестись, неоднозначный так же, как неоднозначен «парадокс тритона».',
    bypass: { tone2: false, rhythm: true, crush: true, ring: true, field: false, freeze: true, comb: true, space: false, drive: true, shimmer: true },
    params: {
      tone: { freq: 220, level: 0.7 },
      tone2: { freq: 311, level: 0.65 },
      field: { rate: 0.15, steps: 2, depth: 1 },
      space: { size: 2.0, mix: 0.25 },
      output: { volume: 0.72 },
    },
  },
  {
    id: 'pythagorean-comma',
    name: 'Pythagorean Comma',
    note: 'Двенадцать сложенных чистых квинт должны вернуться в исходную высоту семью октавами выше — они промахиваются на (3∶2)¹²⁄2⁷, около 23.5 цента. Comb настроен на ту же разницу над Tone, так что несостыковка проявляется как медленное мерцание, а не ошибка округления.',
    bypass: { tone2: true, rhythm: true, crush: true, ring: true, field: false, freeze: false, comb: false, space: false, drive: true, shimmer: true },
    params: {
      tone: { freq: 220, level: 0.72 },
      tone2: { freq: 220, level: 0.65 },
      field: { rate: 0.3, steps: 2, depth: 1 },
      freeze: { time: 0.6, feedback: 0.45, mix: 0.3 },
      comb: { freq: 223, resonance: 0.6, mix: 0.6 },
      space: { size: 1.0, mix: 0.25 },
      output: { volume: 0.75 },
    },
  },
  {
    id: 'critical-band',
    name: 'Critical Band Roughness',
    note: 'Tone и Tone II стоят на равномерно темперированный полутон друг от друга на 440 Гц — достаточно близко, чтобы биение перестало звучать как ритм и стало звучать как жужжание — гельмгольцево объяснение диссонанса, сделанное слышимым.',
    bypass: { tone2: false, rhythm: true, crush: true, ring: true, field: true, freeze: true, comb: true, space: false, drive: true, shimmer: true },
    params: {
      tone: { freq: 440, level: 0.7 },
      tone2: { freq: 466, level: 0.65 },
      space: { size: 0.6, mix: 0.15 },
      output: { volume: 0.7 },
    },
  },
  {
    id: 'fibonacci-pulse',
    name: 'Fibonacci Pulse',
    note: 'Rate/decay Rhythm-ноды и битность Crush заданы числами Фибоначчи, а Comb настроен на 377 Гц — число Фибоначчи, работающее заодно резонансной частотой.',
    bypass: { tone2: true, rhythm: false, crush: false, ring: true, field: false, freeze: false, comb: false, space: false, drive: true, shimmer: true },
    params: {
      tone: { freq: 233, level: 0.75 },
      tone2: { freq: 233, level: 0.65 },
      rhythm: { rate: 5, decay: 13, tone: 1300, level: 0.8 },
      crush: { bits: 5, mix: 1 },
      field: { rate: 1.3, steps: 3, depth: 1 },
      freeze: { time: 0.21, feedback: 0.6, mix: 0.35 },
      comb: { freq: 377, resonance: 0.45, mix: 0.35 },
      space: { size: 2.2, mix: 0.35 },
      output: { volume: 0.78 },
    },
  },
  {
    id: 'driven-shimmer',
    name: 'Driven Shimmer',
    note: 'Основной выход Tone II — не задействованный ни в одном другом пресете — наконец получает применение: через дисторшн Drive в модулированный дилей Shimmer, превращая чистую квинту над Tone в проведённое сквозь дисторшн хорусное марево.',
    bypass: { tone2: false, rhythm: true, crush: true, ring: true, field: false, freeze: true, comb: true, space: false, drive: false, shimmer: false },
    params: {
      tone: { freq: 196, level: 0.7 },
      tone2: { freq: 294, level: 0.65 },
      field: { rate: 0.25, steps: 2, depth: 1 },
      freeze: { time: 0.3, feedback: 0.2, mix: 0 },
      comb: { freq: 196, resonance: 0.6, mix: 0.5 },
      space: { size: 1.2, mix: 0.25 },
      drive: { amount: 55, mix: 1 },
      shimmer: { rate: 0.5, depth: 0.55, mix: 0.45 },
      output: { volume: 0.73 },
    },
  },
];
