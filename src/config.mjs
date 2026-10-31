import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_LEONARDO, RAIZ } from "./caminhos.mjs";

const padrao = () => JSON.parse(readFileSync(join(RAIZ, "config", "leonardo.json"), "utf8"));

// Chaves novas do padrão continuam valendo mesmo quando a cópia editável do
// usuário foi criada por uma versão anterior do app.
function mesclar(base, usuario) {
  if (Array.isArray(base) || typeof base !== "object" || base === null) return usuario ?? base;
  const resultado = { ...base };
  for (const [chave, valor] of Object.entries(usuario ?? {})) resultado[chave] = mesclar(base[chave], valor);
  return resultado;
}

export function lerConfig() {
  const base = padrao();
  const usuario = JSON.parse(readFileSync(CONFIG_LEONARDO, "utf8"));
  // Cópias criadas antes da versão 0.5 não tinham o "tipo" de cada controle.
  if (Array.isArray(usuario.configuracao) && !usuario.configuracao.some((c) => c.tipo)) delete usuario.configuracao;
  return mesclar(base, usuario);
}
