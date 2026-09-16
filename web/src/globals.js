/* Имена модулей в window.
 *
 * Разметка собирается строками, и обработчики в ней записаны как onclick="go(...)":
 * браузер ищет их в глобальной области. Модульная сборка такой области не даёт,
 * поэтому раздаём её сами — одним местом, а не россыпью присваиваний по файлам. */

import * as m0 from './demo/seed.js';
import * as m1 from './net.js';
import * as m2 from './refs.js';
import * as m3 from './rules.js';
import * as m4 from './screens/absence.js';
import * as m5 from './screens/intake.js';
import * as m6 from './screens/login.js';
import * as m7 from './screens/money.js';
import * as m8 from './screens/myroute.js';
import * as m9 from './screens/op-console.js';
import * as m10 from './screens/plan.js';
import * as m11 from './screens/route-builder.js';
import * as m12 from './screens/routes.js';
import * as m13 from './screens/schedule.js';
import * as m14 from './screens/services.js';
import * as m15 from './screens/support.js';
import * as m16 from './screens/wait-list.js';
import * as m17 from './state.js';
import * as m18 from './ui/brand.js';
import * as m19 from './ui/controls.js';
import * as m20 from './ui/icons.js';
import * as m21 from './ui/lightbox.js';
import * as m22 from './ui/modals.js';
import * as m23 from './ui/phone.js';
import * as m24 from './ui/render.js';
import * as m25 from './ui/shell.js';
import * as m26 from './util.js';

/* Слой api раздаётся в window не целиком: наружу нужно одно имя — «повторить
   загрузку» из полосы ошибки. Остальное экраны зовут импортом. */
import { reload } from './api/load.js';

for (const m of [m0, m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11, m12, m13, m14, m15, m16, m17, m18, m19, m20, m21, m22, m23, m24, m25, m26]) Object.assign(window, m);
Object.assign(window, { reload });
