import type { LucideIcon } from 'lucide-react';

export type FileTreeViewMode = 'simple' | 'compact' | 'detailed';

export type FileTreeItemType = 'file' | 'directory';

export interface FileTreeNode {
  name: string;
  type: FileTreeItemType;
  path: string;
  size?: number;
  modified?: string;
  permissionsRwx?: string;
  children?: FileTreeNode[];
  /** Directory exists but wasn't walked (depth cutoff or mount boundary) — its
   *  contents load on demand when expanded. */
  truncated?: boolean;
  [key: string]: unknown;
}

export interface FileTreeImageSelection {
  name: string;
  path: string;
  projectPath?: string;
  // DB projectId; used by ImageViewer to build the raw content URL.
  projectId: string;
}

export interface FileTreeVideoSelection {
  name: string;
  path: string;
  projectPath?: string;
  // DB projectId; used by VideoViewer to build the raw content URL.
  projectId: string;
}

export interface FileTreeAudioSelection {
  name: string;
  path: string;
  projectPath?: string;
  // DB projectId; used by AudioViewer to build the raw content URL.
  projectId: string;
}

export interface FileIconData {
  icon: LucideIcon;
  color: string;
}

export type FileIconMap = Record<string, FileIconData>;
