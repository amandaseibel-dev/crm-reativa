// ===========================================================================
// LEITURA SOB DEMANDA do histórico de uma conversa, para a ficha do aluno.
//
// Portão, nesta ordem:
//  1. identidade confirmada (aluno vinculado por CPF). Sem isso, nada é lido;
//  2. permissão: o operador é o dono da carteira do aluno OU o responsável
//     pelo atendimento. Gestão tem acesso pela própria tela, não por este caminho;
//  3. só então a conversa é lida na Mensageria, uma página por vez.
//
// Nada é gravado em massa: o texto volta para a tela e não é persistido aqui.
// ===========================================================================

export const LIMITE_PAGINA_MENSAGENS = 20;

export type Direcao = "ENTRADA" | "SAIDA" | "AUTOMATICA" | "SISTEMA";

export interface MensagemExibida {
  direcao: Direcao;
  em: string;
  texto: string;
  /** Nome do autor quando a Mensageria informa. Mensagens de operador podem vir sem autor. */
  autor: string | null;
  anexos: string[];
}

export interface PaginaMensagens {
  mensagens: MensagemExibida[];
  /** Cursor para a página anterior (mais antiga), ou null se acabou. */
  antes_de: string | null;
}

export interface ContextoLeitura {
  operador: string;
  identidade_confirmada: boolean;
  dono_carteira: string | null;
  responsavel_atendimento: string | null;
}

export type ResultadoPermissao =
  | { ok: true }
  | { ok: false; motivo: "IDENTIDADE_NAO_CONFIRMADA" | "SEM_PERMISSAO_NA_CONVERSA" };

export function permitirLeitura(c: ContextoLeitura): ResultadoPermissao {
  if (!c.identidade_confirmada) return { ok: false, motivo: "IDENTIDADE_NAO_CONFIRMADA" };
  const op = c.operador.toLowerCase();
  const eDono = (c.dono_carteira ?? "").toLowerCase() === op;
  const eResponsavel = (c.responsavel_atendimento ?? "").toLowerCase() === op;
  if (!eDono && !eResponsavel) return { ok: false, motivo: "SEM_PERMISSAO_NA_CONVERSA" };
  return { ok: true };
}

function direcaoDe(quem: string | undefined): Direcao | null {
  switch (quem) {
    case "cliente": return "ENTRADA";
    case "operador": return "SAIDA";
    case "bot": return "AUTOMATICA";
    case "sistema": return "SISTEMA";
    default: return null;
  }
}

/** Converte a resposta de `ler_conversa` (mais nova primeiro) em mensagens na ordem cronológica. */
export function mapearPagina(resposta: unknown): PaginaMensagens {
  const corpo = resposta as {
    mensagens?: Array<{ quem?: string; em?: string; texto?: string | null; autor?: string | null;
      anexos?: Array<{ nome?: string }> }>;
    paginacao?: { maisAntigas?: boolean; antesDe?: string };
  } | null;
  const itens = Array.isArray(corpo?.mensagens) ? corpo!.mensagens! : [];
  const mensagens: MensagemExibida[] = [];
  for (const m of itens) {
    const direcao = direcaoDe(m?.quem);
    if (!direcao || typeof m.em !== "string") continue; // item sem direção ou sem horário: não exibe
    mensagens.push({
      direcao,
      em: m.em,
      texto: typeof m.texto === "string" ? m.texto : "",
      autor: m.autor ?? null,
      anexos: (m.anexos ?? []).map((a) => a?.nome ?? "anexo").filter(Boolean),
    });
  }
  mensagens.sort((a, b) => (a.em < b.em ? -1 : a.em > b.em ? 1 : 0));
  const antesDe = corpo?.paginacao?.maisAntigas && corpo.paginacao.antesDe ? corpo.paginacao.antesDe : null;
  return { mensagens, antes_de: antesDe };
}

export interface ProvedorLeitura {
  lerConversa(conversaId: string, antesDe: string | null): Promise<unknown>;
}

/** Lê uma página, depois de passar pelo portão. Sem permissão, não chama a Mensageria. */
export async function lerHistorico(
  contexto: ContextoLeitura,
  conversaId: string,
  antesDe: string | null,
  provedor: ProvedorLeitura,
): Promise<{ ok: true; pagina: PaginaMensagens } | { ok: false; motivo: string }> {
  const p = permitirLeitura(contexto);
  if (!p.ok) return { ok: false, motivo: p.motivo };
  const resposta = await provedor.lerConversa(conversaId, antesDe);
  return { ok: true, pagina: mapearPagina(resposta) };
}
