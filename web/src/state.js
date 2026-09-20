/* Состояние вкладки. */

import { CITIES, ROLES, STREETS } from './refs.js';
import { TODAY } from './util.js';

/* ---------- состояние ---------- */
/* День планируется руководителем целиком: города приёма, смена поверителей,
   смена операторов и план заявок. Всё остальное считается от этой записи. */
const dayRec = ds => S.days.find(d=>d.date===ds);
const dayOrNew = ds => { let d=dayRec(ds); if(!d){ d={date:ds,cities:[],crew:[],ops:[],caps:{}}; S.days.push(d); } if(!d.caps) d.caps={}; return d; };
/* План приёма задаётся по каждому городу дня отдельно; план дня — их сумма. */
const capOf = (ds,c) => (dayRec(ds)?.caps||{})[c] ?? 0;
const dayCities = ds => dayRec(ds)?.cities || [];
/* Почта клиента пока только хранится: на неё уйдут чеки и уведомления,
   когда появятся эквайринг и рассылка. */
const blankIntake = () => ({ctype:'Физлицо',name:'',inn:'',phone:'',contact:'',phone2:'',contact2:'',email:'',
  city:'',street:STREETS[0],house:'',entrance:'',floor:'',flat:'',intercom:true,time:12,svcs:[],cmtOp:'',cmtVf:''});
/* Пульт оператора: смена, входящая линия, накопленные за день минуты.
   По этим двум счётчикам руководитель видит загрузку и решает, когда нанимать. */
const blankOp = () => ({on:false,from:null,shiftSec:0,talkSec:0,calls:0,missed:0,
  inc:null,live:null,acw:0,next:0,
  /* Рабочий режим: какая пауза последней ушла на сервер — слать смену состояния, а не каждую секунду. */
  sentPause:false});
const S = {
  view:'intake', page:0, auth:false, user:ROLES.operator.who, role:'operator', me:ROLES.operator.id,
  theme:'light', dd:null, ddM:null,
  city:CITIES[0], day:TODAY, staff:[], days:[], requests:[], routes:[], absences:[], waits:[], handovers:[], seq:1000,
  toast:null, openRoute:null, openStop:null, call:null, lb:null, ukCity:'', ukSeal:'', pMonth:TODAY.slice(0,7), planTab:'day',
  mMonth:TODAY.slice(0,7), meTab:'done', modal:null, edit:null, uns:null, ho:null, dupAsk:null, mchat:false,
  intake:blankIntake(), op:blankOp(),
  /* Эквайринг (пункт int-pay): подключён ли к контуру, открытый платёж на экране
     поверителя, сверка за день у руководителя и форма возврата. */
  payCfg:null, pay:null, acq:null, acqDay:TODAY, refund:null
};
const staffById = id => S.staff.find(s=>s.id===id);
const nameOf = id => staffById(id)?.name || '—';

export { S, blankIntake, blankOp, capOf, dayCities, dayOrNew, dayRec, nameOf, staffById };
