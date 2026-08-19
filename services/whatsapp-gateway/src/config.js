// Configuração do espelho. Falha CEDO e ALTO: um serviço que sobe com
// configuração pela metade só descobre o problema quando o aluno já escreveu.
import { existsSync, mkdirSync } from "node:fs";

function obrigatorio(nome) {
  const v = (process.env[nome] || "").trim();
  if (!v) {
    console.error(`[config] variavel obrigatoria ausente: ${nome}`);
    process.exit(1);
  }
  return v;
}

function numero(nome, padrao) {
  const v = Number(process.env[nome]);
  return Number.isFinite(v) && v > 0 ? v : padrao;
}

// SESSOES aceita "cobranca,comercial" ou JSON [{"chave":"cobranca","rotulo":"Cobranca"}]
function lerSessoes() {
  const bruto = obrigatorio("SESSOES");
  if (bruto.trim().startsWith("[")) {
    return JSON.parse(bruto).map((s) => ({
      chave: String(s.chave).trim().toLowerCase(),
      rotulo: s.rotulo || s.chave,
    }));
  }
  return bruto
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((chave) => ({ chave, rotulo: chave }));
}

const dadosDir = (process.env.DADOS_DIR || "/dados").trim();
if (!existsSync(dadosDir)) mkdirSync(dadosDir, { recursive: true });

export const config = {
  crmUrl: obrigatorio("CRM_URL").replace(/\/+$/, ""),
  crmSegredo: obrigatorio("CRM_SEGREDO"),
  gatewayToken: obrigatorio("GATEWAY_TOKEN"),
  sessoes: lerSessoes(),
  porta: numero("PORTA", 3000),
  dadosDir,
  heartbeatSeg: numero("HEARTBEAT_SEG", 30),
  syncInatividadeSeg: numero("SYNC_INATIVIDADE_SEG", 180),
  // Reconexão: espera crescente até o teto, para não martelar o WhatsApp quando
  // ele estiver recusando — insistir rápido demais é jeito conhecido de chamar
  // atenção e levar bloqueio.
  backoffInicialMs: 2_000,
  backoffMaximoMs: 5 * 60_000,
  // Quantas recusas seguidas do CRM sobre o MESMO item antes de tirá-lo da
  // frente. Baixo demais quarentena item que só pegou um soluço; alto demais
  // deixa a fila congelada por horas. Cinco cobre um erro transitório e ainda
  // destrava em minutos.
  tentativasAntesDeQuarentena: 5,
};

if (config.sessoes.length === 0) {
  console.error("[config] nenhuma sessao configurada em SESSOES");
  process.exit(1);
}
