/* Модель прототипа — перенесённый без правок браузерный код (см. prototype-model.mjs).
   Типизировать её построчно смысла нет: файл не редактируется руками, а переносится
   заново при изменении прототипа. Здесь описано только то, чем пользуется загрузчик. */

export interface DemoPhoto { src: string; name: string; t: string }

export interface DemoDevice {
  svc: string; type: string; grsi: string; carrier: string;
  serial: string; reading: string; room: string; seal: boolean; pens: boolean;
  photos: DemoPhoto[];
  bad?: boolean; badWhy?: string; badNote?: string;
  blank?: boolean; blankNo?: string;
  repl?: string | null; replW?: string;
  swap?: boolean; swapOf?: string;
}

export interface DemoRequest {
  id: string; date: string; created: string; city: string;
  clientType: string; name: string; inn: string; phone: string; contact: string;
  phone2: string; contact2: string; email: string;
  street: string; house: string; entrance: string; floor: string; flat: string;
  intercom: boolean; time: number; cmtOp: string; cmtVf: string;
  svcs: string[]; services: string[]; devices: DemoDevice[];
  status: string; routeId: string | null;
  operator: string | null; verifier?: string | null;
  pay?: { method: string; amount: number; at: string; by: string | null; manual: boolean; note: string };
}

export interface DemoStop {
  req: string; called: string | null; done: boolean;
  unserved?: { reason: string; note: string; at: string; by: string | null };
}

export interface DemoRoute {
  id: string; date: string; city: string;
  verifier: string | null; duty: string | null; status: string;
  stops: DemoStop[];
  chat: { who: string; vf: boolean; txt: string; t: string }[];
}

export interface DemoStaff {
  id: string; name: string; role: string;
  pattern?: string; anchor?: string; extra?: string[];
  svcs?: string[]; phone?: string; ext?: string;
}

export interface DemoDay { date: string; cities: string[]; crew: string[]; ops: string[]; caps: Record<string, number> }
export interface DemoAbsence { id: string; staff: string; from: string; to: string; reason: string; status: string; comment: string }
export interface DemoWait {
  id: string; req: string; route: string | null; city: string; kind?: string;
  reason: string; note: string; at: string; by: string | null; state: string; to: string | null;
}
export interface DemoHandover { id: string; staff: string; at: string; period: string; amount: number; by: string; note: string }

export interface DemoState {
  S: {
    staff: DemoStaff[]; days: DemoDay[]; requests: DemoRequest[]; routes: DemoRoute[];
    absences: DemoAbsence[]; waits: DemoWait[]; handovers: DemoHandover[];
  };
  SERVICES: { id: string; grp: string; name: string; sh: string;
              pF: number; pP: number; pU: number; rV: number; rO: number }[];
  SVC: Record<string, { id: string; grp: string; rV: number; rO: number }>;
  LOCS: { n: string; s: string; big?: boolean }[];
  DEV_TYPES: { v: string; grsi: string; mpi: number }[];
  TODAY: string;
  priceOfDev(request: DemoRequest, device: DemoDevice): number;
  priceOf(request: DemoRequest): number;
}

export function buildDemoState(): DemoState;
