export type SharedRoot = {
  remote: string;
  root: string;
  expectedOwner?: string;
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

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export type StorageJob = {
  id: string;
  type: 'copy-file';
  payload: CopyJobPayload;
  status: JobStatus;
  attempts: number;
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
};
