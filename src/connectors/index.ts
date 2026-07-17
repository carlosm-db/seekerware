// Registro de connectors: interfaz comun fetchJobs/isLive por ATS (TRD §2).

import type { Ats, Company, Job } from '../types';
import * as greenhouse from './greenhouse';
import * as lever from './lever';
import * as ashby from './ashby';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface Connector {
  fetchJobs(company: Company, doFetch?: Fetcher): Promise<Job[]>;
  isLive(company: Company, job: Job, doFetch?: Fetcher): Promise<boolean>;
}

export const connectors: Record<Ats, Connector> = { greenhouse, lever, ashby };
