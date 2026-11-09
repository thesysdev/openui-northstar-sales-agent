import type { DataTool } from "@openuidev/server";
import { salesTools } from "./sales";

// The tools dashboards load their data from. Each Query() in a dashboard calls one of these
// through /api/interpreter, every time the dashboard is opened, so numbers are always live
// from the Neon sales database.
export const dataTools: Record<string, DataTool> = { ...salesTools };
