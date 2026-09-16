/* Даты, деньги, экранирование. */

/* ---------- утилиты ---------- */
const pad = n => String(n).padStart(2,'0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const today = new Date(); today.setHours(0,0,0,0);
const TODAY = iso(today);
/* Текущий месяц: по нему считается подотчёт поверителей у руководителя. */
const CUR_M = TODAY.slice(0,7);
const addDays = (d,n)=>{const x=new Date(d);x.setDate(x.getDate()+n);return x;};
const WD = ['вс','пн','вт','ср','чт','пт','сб'];
const MN = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
/* Не больше пяти городов на день: столько строк помещается в ячейку ленты ёмкости. */
const MAX_CITIES = 5;
/* Столько операторов помещается в столбец на миниатюре дня. */
const MAX_OPS = 4;
const MNG = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const ru = s => s.split('-').reverse().join('.');
/* Полная дата прописью: «02 сентября 2026 г.» */
const ruLong = s => { const [y,m,d] = s.split('-'); return `${d} ${MNG[+m-1]} ${y} г.`; };
const money = n => Math.round(n).toLocaleString('ru-RU')+' ₽';
const esc = s => String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

export { CUR_M, MAX_CITIES, MAX_OPS, MN, MNG, TODAY, WD, addDays, esc, iso, money, pad, ru, ruLong, today };
