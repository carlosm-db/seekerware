// Connector registry: common fetchJobs/isLive interface per ATS (TRD §2).

import type { Ats, Company, Job } from '../types';
import * as greenhouse from './greenhouse';
import * as lever from './lever';
import * as ashby from './ashby';
import * as successfactors from './successfactors';
import * as workday from './workday';
import * as workable from './workable';
import * as smartrecruiters from './smartrecruiters';
import * as bamboohr from './bamboohr';
import * as elempleo from './elempleo';
import * as magneto from './magneto';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface Connector {
  fetchJobs(company: Company, doFetch?: Fetcher): Promise<Job[]>;
  isLive(company: Company, job: Job, doFetch?: Fetcher): Promise<boolean>;
  /**
   * Optional: for connectors whose LIST feed lacks the job description
   * (SuccessFactors <urlset>, Workday CxS), fetch the per-job detail. The
   * pipeline calls this only for location-gate-passing new jobs, capped by
   * `max_detail_fetches_per_run`. Returns fields to merge onto the Job.
   */
  fetchDetail?(company: Company, job: Job, doFetch?: Fetcher): Promise<Partial<Job>>;
}

export const connectors: Record<Ats, Connector> = { greenhouse, lever, ashby, successfactors, workday, workable, smartrecruiters, bamboohr, elempleo, magneto };
