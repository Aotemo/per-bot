export type SyncedFile = {
  path: string;
  content: string;
};

export type RepositorySyncResult = {
  branch: string;
  changedFiles: SyncedFile[];
  deletedFiles: string[];
};

export type RepositorySyncPort = {
  sync(repository: string): Promise<RepositorySyncResult>;
};
