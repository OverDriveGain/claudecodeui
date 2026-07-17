import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../utils/api';
import type { Project } from '../../../types/app';
import type { FileTreeNode } from '../types/types';

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  loading: boolean;
  refreshFiles: () => void;
  loadSubtree: (dirPath: string) => Promise<void>;
};

// Initial fetch walks this many levels; deeper directories come back `truncated`
// and load on demand via loadSubtree. Keeps the first paint fast even for huge
// working directories (the old eager depth-10 walk shipped multi-MB trees and
// crawled/hung on network mounts).
const INITIAL_DEPTH = 3;
const SUBTREE_DEPTH = 3;

/** Replace the children of the node at `dirPath`, immutably along the path. */
function graftChildren(nodes: FileTreeNode[], dirPath: string, children: FileTreeNode[]): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.path === dirPath) {
      return { ...node, children, truncated: false };
    }
    if (node.type === 'directory' && node.children && dirPath.startsWith(`${node.path}/`)) {
      return { ...node, children: graftChildren(node.children, dirPath, children) };
    }
    return node;
  });
}

export function useFileTreeData(selectedProject: Project | null): UseFileTreeDataResult {
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const subtreeInFlightRef = useRef<Set<string>>(new Set());

  const refreshFiles = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  // Fetch a truncated directory's contents and graft them into the tree.
  const loadSubtree = useCallback(async (dirPath: string) => {
    const projectId = selectedProject?.projectId;
    if (!projectId || subtreeInFlightRef.current.has(dirPath)) return;
    subtreeInFlightRef.current.add(dirPath);
    try {
      const response = await api.getFiles(projectId, { path: dirPath, depth: SUBTREE_DEPTH });
      if (!response.ok) return;
      const children = (await response.json()) as FileTreeNode[];
      setFiles((prev) => graftChildren(prev, dirPath, children));
    } catch (error) {
      console.error('Error loading subtree:', error);
    } finally {
      subtreeInFlightRef.current.delete(dirPath);
    }
  }, [selectedProject?.projectId]);

  useEffect(() => {
    // File-tree requests use the DB projectId; the backend resolves it to the
    // project's absolute path through the projects table.
    const projectId = selectedProject?.projectId;

    if (!projectId) {
      setFiles([]);
      setLoading(false);
      return;
    }

    // Abort previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    // Track mount state so aborted or late responses do not enqueue stale state updates.
    let isActive = true;

    const fetchFiles = async () => {
      if (isActive) {
        setLoading(true);
      }
      try {
        const response = await api.getFiles(projectId, {
          depth: INITIAL_DEPTH,
          signal: abortControllerRef.current!.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('File fetch failed:', response.status, errorText);
          if (isActive) {
            setFiles([]);
          }
          return;
        }

        const data = (await response.json()) as FileTreeNode[];
        if (isActive) {
          setFiles(data);
        }
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') {
          return;
        }

        console.error('Error fetching files:', error);
        if (isActive) {
          setFiles([]);
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    };

    void fetchFiles();

    return () => {
      isActive = false;
      abortControllerRef.current?.abort();
    };
  }, [selectedProject?.projectId, refreshKey]);

  return {
    files,
    loading,
    refreshFiles,
    loadSubtree,
  };
}
