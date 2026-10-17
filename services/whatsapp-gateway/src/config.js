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

function lista(nome) {
  return (process.env[nome] || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Números APOSENTADOS. Ficam fora do ar mesmo que a chave continue em SESSOES.
//
// POR QUE EXISTE UMA SEGUNDA LISTA, em vez de só tirar a chave de SESSOES: em
// produção `SESSOES` vive como SECRET no Fly, e secret vence o `[env]` do
// fly.toml. Tirar a chave do arquivo, no repositório, NÃO derruba o canal —
// precisa de um `fly secrets set`, que é passo manual e esquecível. Esta lista
// não tem secret a sombrear: vale pelo deploy, e um secret desatualizado deixa
// de ser capaz de ressuscitar o número.
//
// O efeito é exatamente o que se espera de um número aposentado: sem sessão
// criada, o gateway não reconecta sozinho, não pede QR Code e não envia nada
// por ele. E NADA é apagado — a credencial continua no Postgres e o histórico
// continua no CRM. Tirar da lista devolve o número ao ar, sem reparear.
function lerAposentadas() {
  return new Set(lista("SESSOES_APOSENTADAS"));
}

// SESSOES aceita "cobranca,comercial" ou JSON [{"chave":"cobranca","rotulo":"Cobranca"}]
function lerSessoes() {
  const bruto = obrigatorio("SESSOES");
  const declaradas = bruto.trim().startsWith("[")
    ? JSON.parse(bruto).map((s) => ({
        chave: String(s.chave).trim().toLowerCase(),
        rotulo: s.rotulo || s.chave,
      }))
    : bruto
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .map((chave) => ({ chave, rotulo: chave }));

  const aposentadas = lerAposentadas();
  if (aposentadas.size === 0) return declaradas;

  const ativas = declaradas.filter((s) => !aposentadas.has(s.chave));
  // Em voz alta: quem abrir o log precisa ver POR QUE o número não subiu. Um
  // canal silenciosamente ausente é o tipo de coisa que se diagnostica por
  // horas — foi o que aconteceu quando o Cobranca não aparecia por estar fora
  // de SESSOES e o comando de conectar voltava 502 sem explicar.
  for (const { chave } of declaradas) {
    if (aposentadas.has(chave)) {
      console.warn(
        `[config] sessao "${chave}" esta APOSENTADA (SESSOES_APOSENTADAS): nao conecta, ` +
          "nao pede QR Code e nao envia. Credencial e historico seguem intactos.",
      );
    }
  }
  return ativas;
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
  // Distinguir as duas causas importa: "esqueci de configurar" se resolve
  // preenchendo SESSOES; "aposentei todos" é engano de operação, e subir um
  // gateway sem nenhum número no ar é pior em silêncio do que recusando.
  const motivo = lerAposentadas().size
    ? "todas as sessoes de SESSOES estao em SESSOES_APOSENTADAS"
    : "nenhuma sessao configurada em SESSOES";
  console.error(`[config] ${motivo}`);
  process.exit(1);
}
