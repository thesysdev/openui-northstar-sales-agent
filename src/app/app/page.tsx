import App from "../../components/app";
import { BASE_PATH } from "../../lib/base-path";

export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ ask?: string }>;
}) {
  const { ask } = await searchParams;
  // With THESYS_BASE_URL set, the browser calls OpenUI Cloud on this origin, under the base path,
  // which next.config.ts forwards there. Otherwise it calls https://api.thesys.dev directly.
  return <App apiBaseUrl={process.env.THESYS_BASE_URL ? BASE_PATH : undefined} ask={ask} />;
}
