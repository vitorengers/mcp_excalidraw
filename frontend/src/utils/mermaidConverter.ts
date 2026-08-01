import { parseMermaidToExcalidraw, MermaidConfig } from '@excalidraw/mermaid-to-excalidraw';
import type { MermaidToExcalidrawResult } from '@excalidraw/mermaid-to-excalidraw/dist/interfaces';
import type { BinaryFiles } from '@excalidraw/excalidraw/types';

export interface MermaidConversionResult {
  /**
   * Skeletons, not elements. `parseMermaidToExcalidraw` hands back what
   * `convertToExcalidrawElements` takes, and the only caller passes it straight there; saying
   * `ExcalidrawElement` here claimed a conversion that never happened.
   */
  elements: MermaidToExcalidrawResult['elements'];
  files?: BinaryFiles;
  error?: string;
}

/**
 * Converts a Mermaid diagram definition to Excalidraw elements
 * This function needs to run in the browser context as it requires DOM access
 */
export const convertMermaidToExcalidraw = async (
  mermaidDefinition: string,
  config?: MermaidConfig
): Promise<MermaidConversionResult> => {
  try {
    // Parse the Mermaid diagram to Excalidraw elements
    const result = await parseMermaidToExcalidraw(mermaidDefinition, config);
    
    return {
      elements: result.elements,
      files: result.files,
    };
  } catch (error) {
    console.error('Error converting Mermaid to Excalidraw:', error);
    return {
      elements: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * Default Mermaid configuration for Excalidraw conversion
 */
export const DEFAULT_MERMAID_CONFIG: MermaidConfig = {
  startOnLoad: false,
  flowchart: {
    curve: 'linear',
  },
  themeVariables: {
    fontSize: '20px',
  },
  maxEdges: 500,
  maxTextSize: 50000,
};
