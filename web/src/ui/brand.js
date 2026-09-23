/* Знак приложения — счётчик в круге, линии утолщены под мелкий размер. */

const ICON = `<svg viewBox="0 0 512 512" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="255.5" cy="255.5" r="136" stroke-width="30"/>
  <path d="M56 203.5H134M56 295.5H128M378 203.5H456M384 295.5H456M216 155.5H295" stroke-width="30"/>
  <path d="M175.5 212v16M215.5 212v16M255.5 212v16M295.5 212v16M335.5 212v16" stroke-width="34"/>
  <circle cx="307.5" cy="315.5" r="28" stroke-width="28"/>
  <circle cx="255.5" cy="351.5" r="15" stroke-width="26"/></svg>`;
const iconAt = px => ICON.replace('<svg ',`<svg style="width:${px}px;height:${px}px;flex-shrink:0" `);

export { ICON, iconAt };
