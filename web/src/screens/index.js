/* Список экранов: имя страницы → функция, собирающая её разметку.
   Единственное место, где render() узнаёт, какие экраны вообще есть. */

import { addViews } from '../ui/render.js';
import { viewAbsence } from './absence.js';
import { viewAudit } from './audit.js';
import { viewIntake } from './intake.js';
import { viewLogin } from './login.js';
import { viewMe, viewPayroll } from './money.js';
import { viewMyRoute } from './myroute.js';
import { viewPassword } from './password.js';
import { viewPlan } from './plan.js';
import { viewRoutes } from './routes.js';
import { viewSchedule } from './schedule.js';
import { viewServices } from './services.js';
import { viewStaff } from './staff.js';
import { viewSupport } from './support.js';

addViews({
  login: viewLogin, password: viewPassword,
  intake: viewIntake, support: viewSupport, me: viewMe,
  plan: viewPlan, routes: viewRoutes, schedule: viewSchedule, payroll: viewPayroll,
  services: viewServices, myroute: viewMyRoute, absence: viewAbsence, audit: viewAudit,
  staff: viewStaff,
});
