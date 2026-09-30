// Curtidas do Portal -- regras puras, sem React e sem Supabase.
//
// A contagem e a janela da semana moram no BANCO (portal_curtidas_da_semana e
// portal_musica_da_semana). Aqui fica so o que a tela precisa para desenhar:
// indexar o retorno da RPC e traduzir erro em mensagem.

export const ALVO_PLAYLIST = "playlist";

// A migration do A2 pode ainda nao ter sido aplicada no banco onde a tela roda.
// Nesse caso a Home NAO pode quebrar: o bloco de curtidas simplesmente nao
// aparece. Estes sao os codigos que significam "a estrutura ainda nao existe".
const AUSENTE = new Set([
  "42P01",    // undefined_table
  "42883",    // undefined_function
  "PGRST202", // PostgREST: funcao nao encontrada no schema cache
  "PGRST205", // PostgREST: tabela nao encontrada no schema cache
]);

export const estruturaAusente = (erro) => !!erro && AUSENTE.has(erro.code);

// Retorno de portal_curtidas_da_semana -> mapa por alvo_id.
export function indexarCurtidas(linhas) {
  const mapa = new Map();
  for (const l of linhas || []) {
    mapa.set(l.alvo_id, {
      curtidas: Number(l.curtidas_semana ?? 0),
      euCurti: l.eu_curti === true,
    });
  }
  return mapa;
}

export const curtidasDe = (mapa, alvoId) =>
  mapa?.get(alvoId) ?? { curtidas: 0, euCurti: false };

export function rotuloCurtidas(n) {
  const q = Number(n ?? 0);
  if (q === 0) return "Nenhuma curtida esta semana";
  return q === 1 ? "1 curtida esta semana" : `${q} curtidas esta semana`;
}

// Atualizacao otimista: a tela responde na hora e depois confirma com o banco.
export function alternarLocal(mapa, alvoId) {
  const atual = curtidasDe(mapa, alvoId);
  const novo = new Map(mapa);
  novo.set(alvoId, {
    curtidas: Math.max(0, atual.curtidas + (atual.euCurti ? -1 : 1)),
    euCurti: !atual.euCurti,
  });
  return novo;
}

export function mensagemErroCurtida(erro, jaCurtida) {
  if (!erro) return null;
  if (erro.code === "23505") return "Você já curtiu esta música.";
  if (erro.code === "42501") return "Sua conta não tem permissão para curtir. Avise a gestão.";
  if (estruturaAusente(erro)) return "As curtidas ainda não estão ativadas no banco. Avise a gestão.";
  return `Não foi possível ${jaCurtida ? "retirar a curtida" : "curtir"}. Código: ${erro.code || "sem código"}.`;
}
