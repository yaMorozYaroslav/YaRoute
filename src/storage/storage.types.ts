export type StorageProvider = 'google-drive' | 'mega' | 'other';

export type SharedRoot = {
  remote: string;
  root: string;
  expectedOwner?: string;
  provider?: StorageProvider;
};

export type FileRef = {
  area: string;
  path: string;
};

export type CopyJobPayload = {
  source: FileRef;
  destination: FileRef;
  verify?: boolean;
};

export type GlobalIndexJobPayload = {
  snapshot?: boolean;
};

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type StorageJobType = 'copy-file' | 'global-index';

export type StorageJob = {
  id: string;
  type: StorageJobType;
  payload: CopyJobPayload | GlobalIndexJobPayload;
  status: JobStatus;
  attempts: number;
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
};
