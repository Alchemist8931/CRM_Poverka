/* Демо-набор: тот же генератор с тем же зерном, что был в прототипе. */

import { BIG, DEV_TYPES, FAIL_REASONS, ROLES, ROOMS, SMALL, STREETS, isCheck, replSvcOf } from '../refs.js';
import { CUR_M, MN, TODAY, addDays, iso, pad, ru, today } from '../util.js';
import { S, dayCities, nameOf } from '../state.js';
import { build } from '../screens/routes.js';
import { crewOn, planFor, priceOf, subReport } from '../rules.js';

/* Генератор с фиксированным зерном: тестовое наполнение должно быть одинаковым
   при каждой загрузке. Умножение ведём через Math.imul — у обычного `*` результат
   вылетает за 2^53, младшие биты теряются, и поток чисел замыкается в цикл
   на десяти тысячах вызовов. Наполнению нужно на порядок больше, поэтому
   короткий цикл заново раздавал бы те же имена, адреса и телефоны. */
let sd = 20260803;
const rr = () => {
  sd = (sd + 0x6D2B79F5) | 0;
  let t = Math.imul(sd ^ sd>>>15, 1 | sd);
  t = (t + Math.imul(t ^ t>>>7, 61 | t)) ^ t;
  return ((t ^ t>>>14) >>> 0) / 4294967296;
};
const rnd = a => a[Math.floor(rr()*a.length)];
const rint = (a,b) => a+Math.floor(rr()*(b-a+1));
const randPhone = () => '+7 (9'+rint(10,99)+') '+rint(100,999)+'-'+rint(10,99)+'-'+rint(10,99);
/* Почта есть не у всех: у юрлица её называет бухгалтерия, у частника — далеко не всегда. */
const MAIL_HOSTS = ['mail.ru','yandex.ru','gmail.com','bk.ru'];
const MAIL_NAMES = ['t.smirnova','r.volkov','gareev','dyakonova','a.pshenichnikov','kirillova','abramov','mezentseva','polyakov','goncharova'];
const randMail = isU => isU
  ? (rr()<.85 ? rnd(['buh','info','office','director'])+rint(1,99)+'@'+rnd(MAIL_HOSTS) : '')
  : (rr()<.55 ? rnd(MAIL_NAMES)+rint(1,99)+'@'+rnd(MAIL_HOSTS) : '');

/* ============ ТЕСТОВЫЕ ДАННЫЕ ============ */
function seed(){
  ['Алимпиев И.','Ковалёв Д.','Ситников П.','Нурмухаметов Р.','Гладких А.','Бабенко С.',
   'Тарасов В.','Юсупов М.','Черных К.','Ложкин Е.','Демидов А.','Рогов Н.'].forEach((n,i)=>
    S.staff.push({id:'v'+i,name:n,role:'verifier',pattern:i%3===0?'5/2':'2/2',
      anchor:iso(addDays(today,-(i%4))),extra:i===2?[iso(addDays(today,3))]:[],
      /* Компетенции распределены неровно: вода почти у всех, поверка тепла — у трёх,
         монтаж — у двоих, демонтаж умеет один. Из-за этого часть услуг доступна
         не каждый день, а только когда нужный человек в смене. */
      svcs:['wv', ...(i%4!==3?['wr']:[]), ...([0,5,9].includes(i)?['hv']:[]),
        ...([0,9].includes(i)?['hm']:[]), ...(i===0?['hd']:[])],
      phone:randPhone()}));
  ['Кузнецова Е.','Панова М.','Ефимова О.','Салтыкова А.'].forEach((n,i)=>
    S.staff.push({id:'o'+i,name:n,role:i<2?'senior':'operator',pattern:i<2?'2/2':'5/2',
      anchor:iso(addDays(today,-(i%2))),extra:[],ext:'10'+(i+1)}));
  S.staff.push({id:'sv',name:'Панченко И.',role:'supervisor',pattern:'5/2',anchor:TODAY,extra:[],ext:'100'});

  S.absences = [
    {id:'A1',staff:'v4',from:iso(addDays(today,4)),to:iso(addDays(today,6)),reason:'Поездка к родителям, ремонт крыши',status:'на согласовании',comment:''},
    {id:'A2',staff:'v7',from:iso(addDays(today,8)),to:iso(addDays(today,9)),reason:'Плановый медосмотр',status:'на согласовании',comment:''},
    {id:'A3',staff:'v1',from:iso(addDays(today,2)),to:iso(addDays(today,3)),reason:'Семейные обстоятельства',status:'согласовано',comment:'Подменит Ложкин'},
    {id:'A4',staff:'v9',from:iso(addDays(today,-4)),to:iso(addDays(today,-3)),reason:'Больничный',status:'согласовано',comment:''},
    {id:'A5',staff:'v5',from:iso(addDays(today,1)),to:iso(addDays(today,5)),reason:'Отпуск за свой счёт',status:'отклонено',comment:'Пик набора, перенесите на конец месяца'},
    {id:'A6',staff:'v0',from:iso(addDays(today,11)),to:iso(addDays(today,12)),reason:'Личные дела',status:'на согласовании',comment:''}
  ];
  /* День планирует руководитель: города приёма, смена поверителей и операторов, план.
     Расписание намеренно рваное — покрытие по услугам и городам неполное. */
  const vers = S.staff.filter(p=>p.role==='verifier').map(p=>p.id);
  const opIds = S.staff.filter(p=>p.role==='operator'||p.role==='senior').map(p=>p.id);
  const mod = (a,n) => ((a%n)+n)%n;
  for(let i=-25;i<36;i++){
    const ds = iso(addDays(today,i));
    const dow = new Date(ds+'T00:00:00').getDay();
    const wknd = [0,6].includes(dow);
    const wk = Math.floor((i+70)/7);
    /* У операторов свой график: состав смены крутится по кругу, а не повторяется день в день. */
    const need = wknd?2:3;
    const ops = Array.from({length:need},(_,k)=>opIds[mod(i+k,opIds.length)]);
    /* Воскресенье через одно бригады не выезжают — линия при этом работает. */
    if(dow===0 && wk%2===0){ S.days.push({date:ds,cities:[],crew:[],ops,caps:{}}); continue; }
    /* Смена — скользящее окно по списку поверителей, а не случайная выборка:
       узкий специалист попадает в неё не каждый день, поэтому часть услуг
       в отдельные даты просто недоступна. */
    const n = wknd ? rint(2,3) : rint(4,6);
    const st = mod(i*5,vers.length);
    const crew = Array.from({length:n},(_,k)=>vers[mod(st+k,vers.length)]);
    /* У каждого города свой ритм. В крупные бригада ездит по своим дням недели —
       примерно полнедели, и то не каждую неделю; малые объезжает по кругу, раз
       в неделю-полторы. Полного покрытия нет ни по одному городу. */
    const cities = [];
    const bigDow = {1:0, 3:0, 5:0, 2:1, 4:1, 6:2};   // пн/ср/пт — ЕКБ, вт/чт — НТ, сб — КУ
    if(bigDow[dow]!==undefined && mod(wk+dow,4)!==0) cities.push(BIG[bigDow[dow]]);
    const cs = mod(i*7,SMALL.length);
    for(let k=0,m=wknd?1:2;k<m;k++) cities.push(SMALL[mod(cs+k*9,SMALL.length)]);
    /* План руководитель ставит руками по каждому городу — округлёнными числами. */
    const per = Math.max(5,Math.round(crew.length*25/cities.length/5)*5), caps = {};
    cities.forEach(c=>caps[c]=per);
    S.days.push({date:ds,cities,crew:crew.sort(),ops,caps});
  }
  const ops = S.staff.filter(s=>s.role==='operator'||s.role==='senior');
  let oi = 0;
  /* Набор идёт на две недели вперёд: ближние дни почти закрыты, дальние ещё добираются. */
  for(let i=-14;i<=14;i++){
    const ds = iso(addDays(today,i));
    const rate = i<0?0.98 : i===0?.95 : i<=2?.88 : i<=5?.78 : i<=8?.66 : i<=11?.54 : .44;
    const cs = dayCities(ds); if(!cs.length) continue;
    const n = Math.round(planFor(ds)*rate*(.85+rr()*.3));
    for(let k=0;k<n;k++){
      const r = mkReq(ds,cs[k%cs.length]);
      r.operator = ops[oi++%ops.length].id; S.requests.push(r);
    }
  }
  /* Маршруты собраны на несколько дней вперёд; на дальние дни поверитель ещё не назначен. */
  for(let i=-14;i<=5;i++){
    const ds = iso(addDays(today,i));
    dayCities(ds).forEach(c=>{
      const crew = crewOn(ds);
      build(ds,c).forEach((rt,k)=>{
        rt.verifier = (crew.length && i<=3) ? crew[(k+i+19)%crew.length].id : null;
        if(i<0) finishRoute(rt);
        else if(i===0){
          if(k===0) finishRoute(rt);
          else if(k===1){ callAll(rt); rt.status='в работе'; rt.duty=ops[1].id;
            rt.stops.forEach((s,j)=>{ if(j<Math.floor(rt.stops.length*.6) && s.called==='подтверждена') doneStop(rt,s); }); }
          else if(k===2){ callAll(rt); rt.status='обзвонен'; rt.duty=ops[0].id; }
          else rt.stops.forEach((s,j)=>{ if(j<Math.floor(rt.stops.length*.4)) s.called='подтверждена'; });
        }
        /* Ближайшие дни уже частично прозвонены, дальние ждут своей очереди. */
        else if(i<=2) rt.stops.forEach((s,j)=>{ if(j<Math.floor(rt.stops.length*(i===1?.45:.15))) s.called='подтверждена'; });
      });
    });
  }
  /* Демо-поверитель должен видеть сегодняшний маршрут: если круговое назначение его
     обошло, отдаём ему неначатый маршрут дня — по нему и отмечают не обслуженные точки. */
  if(!S.routes.some(r=>r.date===TODAY && r.verifier===ROLES.verifier.id)){
    const rt = S.routes.find(r=>r.date===TODAY && !r.stops.some(s=>s.done));
    if(rt) rt.verifier = ROLES.verifier.id;
  }
  /* Вчерашние срывы: пять точек бригада не закрыла — они ждут решения оператора.
     Причины разные, у «другого» — текст поверителя. */
  const yest = iso(addDays(today,-1));
  const yStops = S.routes.filter(r=>r.date===yest).flatMap(rt=>rt.stops.map(s=>({rt,s}))).filter(x=>x.s.done);
  const UNS = [['Нет дома',''],
    ['Отказ на месте','Клиент говорит, что поверку в июле уже делала другая контора'],
    ['Нет доступа к прибору',''],
    ['Перенос по просьбе клиента','Просит приехать в субботу до обеда'],
    ['Другое','УК перекрыла стояк до вечера, воды в доме нет']];
  const gap = Math.floor(yStops.length/UNS.length);
  UNS.forEach(([reason,note],k)=>{
    const x = gap ? yStops[k*gap] : null; if(!x) return;
    const r = S.requests.find(q=>q.id===x.s.req); if(!r) return;
    x.s.done = false; x.s.called = 'подтверждена';
    x.s.unserved = {reason,note,at:`${yest} ${pad(rint(10,19))}:${pad(rint(0,59))}`,by:x.rt.verifier};
    r.status = 'ожидание'; r.devices = []; r.services = []; r.verifier = null;
    S.waits.push({id:'W'+(++S.seq),req:r.id,route:x.rt.id,city:r.city,reason,note,
      at:x.s.unserved.at,by:x.rt.verifier,state:'не обработана',to:null});
  });
  /* Свежие звонки этого дня: приняты, но в маршрут ещё не поставлены. */
  dayCities(TODAY).forEach(c=>{
    for(let k=0;k<rint(2,4);k++){
      const r = mkReq(TODAY,c);
      r.created = TODAY; r.operator = ops[oi++%ops.length].id;
      r.time = rint(12,20); r.routeId = null; r.status = 'создана';
      S.requests.push(r);
    }
  });
  const chats = [
    [['v','Не открывают, Крауля 12 кв. 45. Жду 5 минут'],['o','Созвонилась, спускается — она в магазине была']],
    [['v','На Сурикова 8 пломбы УК нет. Снимать счётчик?'],['o','Нет, фиксируй в акте отсутствие пломбы и ставь свою'],['v','Принято']],
    [['v','Задерживаюсь на 40 минут, пробка на Малышева'],['o','Обзвонила три последние точки, перенесли окно'],['v','Спасибо']],
    [['v','Клиент хочет заодно замену на горячей. Считать?'],['o','Да, добавила услугу в заявку, цена 2600']]
  ];
  S.routes.filter(r=>r.date===TODAY||r.date===iso(addDays(today,-1))).slice(0,4).forEach((rt,i)=>{
    const v = nameOf(rt.verifier), o = nameOf(rt.duty||ops[0].id);
    rt.chat = chats[i%chats.length].map(([who,txt],j)=>({who:who==='v'?v:o,vf:who==='v',txt,t:pad(9+j*2)+':'+pad(rint(10,55))}));
    if(!rt.duty) rt.duty = ops[i%ops.length].id;
  });
  /* Отрицательный результат поверки: примерно каждый двадцатый поверенный прибор
     признан непригодным. Свидетельство о непригодности выписано от руки на бумажном
     бланке — в CRM от него остаётся только номер, нумерация у заказчика сквозная.
     Часть клиентов согласилась на замену сразу — тогда в акте стоит строка замены,
     остальные отложили: их адреса ждут звонка оператора в листе ожидания. Старые
     отложенные замены оператор уже разобрал, свежие ещё висят. */
  const FAIL_NOTES = ['Крыльчатка стоит, вода идёт мимо счёта','Стекло разбито, шкала не читается',
    'Корпус в известковом наросте, доступ к шкале закрыт','Счётчик установлен с нарушением, проливка невозможна'];
  let blankNo = 418;
  S.requests.filter(r=>r.status==='выполнена').forEach(r=>{
    const add = [];
    r.devices.forEach((d,i)=>{
      if(!isCheck(d) || rr()>=.05) return;
      d.bad = true;
      d.badWhy = rnd(FAIL_REASONS);
      d.badNote = d.badWhy==='Другое' ? rnd(FAIL_NOTES) : '';
      /* «Нечитаемый номер» — ровно тот случай, когда заводского номера в акте нет. */
      if(d.badWhy==='Нечитаемый номер' && rr()<.6) d.serial = '';
      d.blank = rr()<.85;
      d.blankNo = d.blank ? 'НП-'+(++blankNo) : '';
      if(rr()<.55){
        /* Клиент согласился менять на месте: в акте появилась платная строка замены. */
        d.repl = 'предложена';
        const svc = replSvcOf(d), ser = rint(10,99)+'-'+rint(100000,999999);
        add.push([i,{svc,type:d.type,grsi:d.grsi,carrier:d.carrier,serial:ser,reading:'0',room:d.room,
          seal:rr()<.9,pens:d.pens,
          photos:[{src:stubPhoto(ser,ru(r.date)+' · новый прибор'),name:'IMG_'+rint(1000,9999)+'.jpg',
            t:pad(rint(9,20))+':'+pad(rint(10,59))}],
          bad:false,badWhy:FAIL_REASONS[0],badNote:'',blank:false,blankNo:'',repl:null,
          swap:true,swapOf:d.serial||''}]);
      } else {
        d.repl = 'отложена';
        const fresh = r.date >= iso(addDays(today,-3));
        const w = {id:'W'+(++S.seq),req:r.id,route:r.routeId,city:r.city,kind:'замена',reason:'Нужна замена',
          note:`${d.serial?'Прибор №'+d.serial:'Прибор без читаемого номера'} непригоден · ${d.badWhy.toLowerCase()}`
            + (d.badNote?' · '+d.badNote:'') + '. Клиент отложил замену.',
          at:`${r.date} ${pad(rint(10,19))}:${pad(rint(0,59))}`,by:r.verifier,
          state:fresh?'не обработана':'снята',to:null};
        S.waits.push(w); d.replW = w.id;
      }
    });
    if(!add.length) return;
    /* Строки замены вставляем с конца, чтобы не сбить индексы непригодных приборов. */
    add.reverse().forEach(([i,nd])=>r.devices.splice(i+1,0,nd));
    r.services = [...new Set(r.devices.map(d=>d.svc))];
  });
  /* Деньги по выполненным работам. У физлиц примерно шесть заявок из десяти закрыты
     наличными, три — переводом на карту, одна остаётся без оплаты и висит долгом.
     Юрлицо платит по счёту: эти деньги через руки поверителя не проходят. */
  S.requests.filter(r=>r.status==='выполнена').forEach(r=>{
    const price = priceOf(r), u = r.clientType==='Юрлицо', x = rr();
    const method = u ? (rr()<.85?'по счёту':'не оплачено')
      : x<.6 ? 'наличные' : x<.9 ? 'перевод на карту' : 'не оплачено';
    /* Клиент округляет: то отдаёт без мелочи, то не добирает пару сотен и обещает довезти. */
    const y = rr();
    let amount = price;
    if(method==='не оплачено') amount = 0;
    else if(y<.08) amount = Math.max(0,Math.round(price/500)*500);
    else if(y<.15) amount = Math.max(0,price-100*rint(1,3));
    r.pay = {method,amount,at:`${r.date} ${pad(rint(10,19))}:${pad(rint(0,59))}`,by:r.verifier,manual:amount!==price,
      note: method==='не оплачено' ? rnd(['Нет наличных, обещал перевести на карту','Просит счёт на оплату','Платит УК, ждём подтверждения'])
        : amount<price ? 'Отдал без сдачи, разницу обещал довезти'
        : amount>price ? 'Округлил в большую сторону' : ''};
  });
  /* Сдача за прошлый месяц: часть бригады уже привезла собранное руководителю
     в первых числах текущего. Демо-данные начинаются с первого числа, поэтому
     сумму прошлого месяца берём по порядку величины от того, что человек собрал сейчас. */
  const prevEnd = iso(new Date(today.getFullYear(),today.getMonth(),0));
  const prevM = prevEnd.slice(0,7);
  vers.forEach((vid,i)=>{
    if(i%2) return;
    const now = subReport(vid,CUR_M);
    const amount = Math.round(Math.max(0,now.got-now.wage)*(.7+rr()*.5)/100)*100;
    if(!amount) return;
    S.handovers.push({id:'H'+(++S.seq),staff:vid,at:iso(addDays(new Date(prevEnd+'T00:00:00'),1+(i%3))),
      period:prevM,amount,by:'sv',note:'Сдача за '+MN[+prevM.slice(5)-1]});
  });
}
const CMT_OP = ['','','','Звонить только после 18:00, днём на работе','Второй перенос — уточнить актуальность',
  'Оплата по счёту, нужна закрывающая','Юрлицо: пропуск заказывать за сутки','Клиент просит смс за час до выезда'];
const CMT_VF = ['','','','Собака во дворе, звонить с калитки','Счётчик в нише за люком, нужен ключ',
  'Домофон не работает — звонить на подъезд','Пожилой клиент, стучать громче','Пломба УК сорвана — снять на фото',
  'Доступ к стояку через соседнюю квартиру'];
const CONTACTS = ['','','Муж, Сергей','Дочь, Ольга','Сын, Дмитрий','Сосед, Пётр','Секретарь, Анна',
  'Бухгалтер, Ирина','Завхоз, Николай','Председатель, Тамара'];
const SURNAMES = ['Смирнова','Волков','Гареев','Дьяконова','Пшеничников','Кириллова','Абрамов','Мезенцева',
  'Хайруллин','Гончарова','Поляков','Ерёмина','Костин','Лазарева','Юркин','Ситникова','Бабушкин','Трофимова',
  'Нечаев','Шаламова','Кузьмин','Игнатьева','Белов','Романова','Дёмин','Савельева','Панкратов','Ильина',
  'Чернов','Фомина','Аверьянов','Копылова','Зыков','Наумова','Щербаков','Кондратьева'];
const INITIALS = ['А. А.','Т. А.','И. М.','Л. С.','Р. П.','Н. В.','Д. Ю.','О. И.','С. Н.','Е. В.','М. К.','В. Г.'];
const ORG_NAMES = ['ООО «Стройсервис»','ООО «Гарант-Плюс»','ООО «Урал-Комфорт»','ООО «Теплодом»',
  'ООО «Ремстрой-Е»','ООО «Промснаб»','ООО «Жилсервис-2»','ООО «Атлант-Урал»'];
/* Клиент прототипа — это связка «номер телефона + адрес + кто платит».
   Отдельной карточки клиента в модели пока нет: базы контактов нет, и всё,
   что связывает заявки между собой, — совпадение номера. */
function mkClient(phone,isU,city){
  return {phone,city,ctype:isU?'Юрлицо':'Физлицо',
    name:isU ? (rr()<.6 ? rnd(ORG_NAMES) : rnd(['ТСЖ','ТСН'])+' «'+rnd(STREETS)+' '+rint(1,120)+'»')
             : rnd(SURNAMES)+' '+rnd(INITIALS),
    inn:isU?String(rint(6600000000,6699999999)):'',
    contact:isU?'Секретарь, Анна':rnd(CONTACTS),
    phone2:'',contact2:'',email:randMail(isU),
    street:rnd(STREETS),house:String(rint(1,120)),entrance:String(rint(1,6)),floor:String(rint(1,16)),
    flat:isU?'':String(rint(1,240)),intercom:rr()<.78};
}
/* Постоянные клиенты: две сотни номеров, с которых заявка приходит не в первый раз.
   В квартире счётчиков несколько, сроки поверки у них разъезжаются, после переноса
   человек звонит заново — такие обращения и должны узнаваться на приёме по номеру.
   Остальные заявки приходят с новых номеров: если бы весь набор шёл из пула,
   история была бы у каждого адреса и плашка перестала бы что-либо значить. */
const CLIENT_POOL = (()=>{
  const seen = new Set(), out = [];
  while(out.length<200){
    const phone = randPhone();
    if(seen.has(phone)) continue;
    seen.add(phone);
    /* Клиент живёт в одном городе: в крупные бригада ездит чаще, там и клиентов
       больше. Иначе один и тот же адрес всплывал бы в истории по трём городам. */
    const c = mkClient(phone,out.length%9===4,rr()<.45?rnd(BIG):rnd(SMALL));
    /* Сколько раз человек обратится за два месяца наполнения: два-четыре.
       Без потолка в малом городе весь набор ушёл бы на пять знакомых номеров. */
    c.cap = rint(2,4); c.used = 0;
    out.push(c);
  }
  return out;
})();
const POOL_BY_CITY = CLIENT_POOL.reduce((a,c)=>{ (a[c.city]=a[c.city]||[]).push(c); return a; },{});
function mkReq(ds,city){
  /* Примерно каждая четвёртая заявка в городе — от знакомого номера. */
  const local = (POOL_BY_CITY[city] || []).filter(x=>x.used<x.cap);
  const c = local.length && rr()<.3 ? rnd(local) : mkClient(randPhone(),rr()<.12,city);
  if(c.cap) c.used++;
  const svc = rr()<.7?'wv' : rr()<.55?'wr' : rnd(['hv','hm','hd']);
  const heat = svc[0]==='h';
  const back = rint(0,6);
  let cr = iso(addDays(new Date(ds+'T00:00:00'),-back));
  /* Заявку на будущую дату приняли раньше — раскидываем по прошедшей неделе,
     иначе весь будущий набор схлопнется в сегодня. */
  if(cr>TODAY) cr = iso(addDays(today,-rint(0,6)));
  const ph2 = rr()<.35;
  return {id:'R'+(++S.seq),date:ds,created:cr>TODAY?TODAY:cr,city,clientType:c.ctype,name:c.name,
    inn:c.inn,
    phone:c.phone,
    contact:c.contact,
    phone2:ph2?randPhone():'',
    contact2:ph2?rnd(CONTACTS):'',
    email:c.email,
    street:c.street,house:c.house,entrance:c.entrance,floor:c.floor,
    flat:c.flat,intercom:c.intercom,time:rint(10,20),
    cmtOp:rnd(CMT_OP),cmtVf:rnd(CMT_VF),
    svcs:[svc],services:[],devices:[],status:'создана',routeId:null,operator:null,from:null,
    expect:{svc,heat,nd:heat?1:rint(1,2)}};
}
/* Фото выполненных работ в демо-данных — заглушка вместо снимка с телефона. */
function stubPhoto(t1,t2){
  return 'data:image/svg+xml;utf8,'+encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="#1d1d1d"/>`+
    `<g stroke="#6b6b6b" fill="none" stroke-width="3"><circle cx="240" cy="168" r="86"/><circle cx="240" cy="168" r="62"/>`+
    `<path d="M40 140h114M40 200h108M326 140h114M332 200h108"/></g>`+
    `<text x="240" y="176" font-family="monospace" font-size="30" fill="#c9c9c9" text-anchor="middle">${t1}</text>`+
    `<text x="24" y="336" font-family="monospace" font-size="20" fill="#8d8d8d">${t2}</text></svg>`);
}
/* Показания на момент поверки: вода в кубометрах, тепло в гигакалориях. */
const mkReading = carrier => carrier==='Тепло'
  ? rint(1,60)+','+String(rint(0,999)).padStart(3,'0')
  : String(rint(8,940)).padStart(5,'0')+','+String(rint(0,999)).padStart(3,'0');
/* Акт материализуется в момент выполнения: приборы, услуга в строке прибора, фото. */
function actFor(r,ds){
  const {svc,heat,nd} = r.expect || {svc:'wv',heat:false,nd:1};
  r.devices = Array.from({length:nd},(_,j)=>{
    const t = heat?DEV_TYPES[5]:rnd(DEV_TYPES.slice(0,5));
    const sv = (j===1 && !heat && rr()<.3) ? 'wr' : svc;
    const serial = rint(10,99)+'-'+rint(100000,999999);
    const carrier = heat?'Тепло':(j===0?'ХВС':'ГВС');
    return {svc:sv,type:t.v,grsi:t.grsi,carrier,
      serial,reading:mkReading(carrier),room:rnd(ROOMS),seal:rr()<.86,
      pens:r.clientType!=='Юрлицо' && rr()<.22,
      photos:Array.from({length:rint(1,3)},(_,k)=>({src:stubPhoto(serial,ru(ds)+' · кадр '+(k+1)),
        name:'IMG_'+rint(1000,9999)+'.jpg',t:pad(rint(9,20))+':'+pad(rint(10,59))}))};
  });
  r.services = [...new Set(r.devices.map(d=>d.svc))];
}
function callAll(rt){ rt.stops.forEach(s=>{ if(!s.called) s.called = rr()<.9?'подтверждена':(rr()<.6?'перенос':'отказ'); }); }
function doneStop(rt,s){
  const r = S.requests.find(x=>x.id===s.req); if(!r) return;
  actFor(r,rt.date); s.done=true; r.status='выполнена'; r.verifier=rt.verifier;
}
function finishRoute(rt){
  callAll(rt); rt.status='выполнен';
  rt.stops.forEach(s=>{ const r=S.requests.find(x=>x.id===s.req); if(!r) return;
    if(s.called==='подтверждена') doneStop(rt,s);
    else r.status = s.called==='отказ'?'отменена':'перенос'; });
}

export { CLIENT_POOL, CMT_OP, CMT_VF, CONTACTS, INITIALS, MAIL_HOSTS, MAIL_NAMES, ORG_NAMES, POOL_BY_CITY, SURNAMES, actFor, callAll, doneStop, finishRoute, mkClient, mkReading, mkReq, randMail, randPhone, rint, rnd, rr, sd, seed, stubPhoto };
