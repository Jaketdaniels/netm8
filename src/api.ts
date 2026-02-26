import { hc } from "hono/client";
import type { AppType } from "../worker/index";

export const api = hc<AppType>("/");
