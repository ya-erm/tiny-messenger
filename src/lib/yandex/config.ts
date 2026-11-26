import "server-only";
import type {YandexConfig} from "./protocol";
export function yandexConfig():YandexConfig{return {clientId:process.env.YANDEX_OAUTH_CLIENT_ID||"",clientSecret:process.env.YANDEX_OAUTH_CLIENT_SECRET||"",sessionKey:process.env.TM_WEB_SESSION_SECRET||"",origins:(process.env.TM_AUTH_ALLOWED_ORIGINS||"").split(",").map(v=>v.trim()).filter(Boolean)};}
