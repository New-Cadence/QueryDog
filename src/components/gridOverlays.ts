// Spread into every AgGridReact so loading and empty grids look like the rest
// of the app. Pass noRowsOverlayComponentParams={{ title }} for a specific message.
import { GridLoadingOverlay, GridNoRowsOverlay } from './ui';

export const GRID_OVERLAYS = {
  loadingOverlayComponent: GridLoadingOverlay,
  noRowsOverlayComponent: GridNoRowsOverlay,
} as const;
