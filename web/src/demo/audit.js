/* Журнал действий для демо-режима (пункт be-audit).
 *
 * Отдельным файлом от demo/seed.js нарочно: тот — дословный перенос наполнения
 * из прототипа, и его сверяет со схемой `server/scripts/check-model-sync.mts`.
 * Журнала в прототипе не было, он появился вместе с API, поэтому и лежит рядом,
 * а не внутри перенесённого блока.
 */

import { S, nameOf } from '../state.js';
import { addDays, iso, pad, today } from '../util.js';
import { rint } from './seed.js';

/* Журнал действий в демо-режиме.
 *
 * На сервере его пишет промежуточный слой по каждому запросу (server/src/api/audit.ts),
 * здесь писать нечего: демо ничего никуда не отправляет. Поэтому записи делаются
 * по уже разложенному наполнению — из тех же заявок, сотрудников и прайса, — и
 * экран показывает ровно то же, что покажет с базой: правки с разницей по полям,
 * входы, обращения к персональным данным и выгрузки. */
function seedAudit(){
  const ops = S.staff.filter(p=>p.role==='operator'||p.role==='senior').map(p=>p.id);
  const at = (backDays,h,m) => `${iso(addDays(today,-backDays))}T${pad(h)}:${pad(m)}:${pad(rint(0,59))}`;
  const ip = () => `10.8.${rint(0,3)}.${rint(10,240)}`;
  const AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141 Safari/537.36';
  const out = [];
  const add = (backDays,actor,action,entity,entityId,before,after) => out.push({
    id:'L'+(++S.seq), at:at(backDays,rint(9,19),rint(0,59)),
    actor_id:actor, actor_name:actor?nameOf(actor):null,
    actor_role:actor?(S.staff.find(p=>p.id===actor)?.role||null):null,
    action, entity, entity_id:entityId, before, after, ip:ip(), user_agent:AGENT});

  /* Заявки: приём, правка и перенос — по ним руководитель и разбирается,
     кто передвинул адрес и с какого числа. */
  const recent = S.requests.filter(r=>r.created && r.created>=iso(addDays(today,-7))).slice(0,26);
  recent.forEach((r,i)=>{
    const who = r.operator || ops[i%ops.length];
    const back = Math.min(7,Math.max(0,Math.round((today-new Date(r.created+'T00:00:00'))/86400000)));
    add(back,who,'создание','requests',r.id,null,
      {date:r.date,city:r.city,name:r.name,phone:r.phone,street:r.street,house:r.house,
       flat:r.flat,time_slot:r.time,svcs:r.svcs,status:'создана'});
    if(i%4===1) add(Math.max(0,back-1),who,'изменение','requests',r.id,
      {comment_operator:''},{comment_operator:'Звонить после 18:00'});
    if(i%7===3) add(Math.max(0,back-1),who,'изменение','requests',r.id,
      {date:r.date,route_id:r.routeId||null,status:'в маршруте'},
      {date:iso(addDays(new Date(r.date+'T00:00:00'),rint(2,6))),route_id:null,status:'создана'});
  });
  /* Прайс: цена и сдельная ставка — это деньги компании и заработок бригады,
     их правки должны быть видны поимённо. */
  add(2,'sv','изменение','services','wv',{price_person:900},{price_person:950});
  add(5,'sv','изменение','services','hv',{rate_verifier:900},{rate_verifier:950});
  /* Вход, выход и неудачные попытки. */
  [...ops,'sv','v0'].forEach((who,i)=>{ add(i%4,who,'вход','staff',who,null,null);
    if(i%3===0) add(i%4,who,'выход','staff',who,null,null); });
  add(1,null,'неудачный вход','staff','o2',null,{login:'o2',отказ:401});
  add(1,null,'неудачный вход','staff','o2',null,{login:'o2',отказ:401});
  add(3,null,'неудачный вход','staff','petrov',null,{login:'petrov',отказ:401});
  /* Обращения к персональным данным: карточка клиента по телефону, запись
     разговора и выгрузка самого журнала. */
  recent.slice(0,6).forEach((r,i)=>add(i%3,ops[i%ops.length],'просмотр','clients',r.phone,null,{phone:r.phone}));
  add(0,'sv','прослушивание','calls',String(rint(100,999)),null,null);
  add(4,'sv','выгрузка','audit_log',null,null,{отбор:{entity:'requests'}});
  add(6,'sv','удаление','photos',String(rint(100,999)),
    {name:'IMG_2841.jpg',storage_key:'acts/2026/09/R1042/1/9f3.jpg'},{deleted_by:'sv'});

  S.audit = out.sort((a,b)=>b.at.localeCompare(a.at));
  S.auditTotal = S.audit.length;
}

export { seedAudit };
