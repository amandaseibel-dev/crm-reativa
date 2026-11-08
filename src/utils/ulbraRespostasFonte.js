import { supabase } from "../services/supabase";
import {
  EQUIPE_REATIVA,
  SITUACAO_ESPERANDO,
  normalizarAtendimento,
} from "./ulbraRespostas";

// Fonte de dados e marcador de leitura do aviso "o aluno respondeu".
//
// Vive fora do componente de propósito: exportar função de um arquivo de
// componente quebra o fast refresh do Vite (`react-refresh/only-export-components`),
// e a catraca do lint deste repositório reprova isso. Separar também deixa a
// lógica testável sem montar React.
//
// `ulbraRespostas.js` continua PURO (sem rede, sem storage); o que toca o
// mundo externo mora aqui.

// Marcador de leitura, por usuário. Ele é NOSSO: a Mensageria não tem noção
// de "lido" — não expõe mensagens. Em etapa 1 vive no localStorage, então
// serve a um NAVEGADOR, não à pessoa: a mesma operadora em outra máquina
// recomeça com tudo não lido. Marcador durável por usuário é tabela, e tabela
// exige autorização própria — está anotado como pendência da etapa 2.
const LS_PREFIXO = "ulbra_respostas_visto_em:";

export function chaveVisto(email) {
  return LS_PREFIXO + String(email || "anonimo").toLowerCase();
}

export function lerVistoEm(email) {
  try {
    return localStorage.getItem(chaveVisto(email));
  } catch {
    return null; // storage bloqueado: segue sem marcador, avisa demais
  }
}

export function gravarVistoEm(email, quando) {
  try {
    localStorage.setItem(chaveVisto(email), quando);
  } catch {
    // sem persistência; a contagem volta inteira no próximo carregamento
  }
}

/**
 * Fonte real, usada a partir da etapa 2. A `ulbra-leads-pendentes` devolve
 * hoje só id, nome e data — **sem responsável** —, então estes itens ficam
 * visíveis para quem o portão da própria função já autorizou (`receptivo` da
 * linha do usuário ou `usuario_e_gestao()`). Amarrar atendimento a
 * responsável é o trabalho da etapa 2.
 *
 * Custa 1 chamada à Mensageria por tick, para a equipe inteira — não uma por
 * aluno nem uma por operador. Ver `orcamentoSincronizacao`.
 */
export async function carregarReal() {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return [];
  const resp = await fetch(
    `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ulbra-leads-pendentes`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const dados = await resp.json();
  if (dados?.motivo === "NAO_RECEPTIVO") return [];
  return (dados?.leads ?? [])
    .map((l) =>
      normalizarAtendimento({
        id: l.id,
        aluno_nome: l.nome,
        equipe: EQUIPE_REATIVA,
        situacao: SITUACAO_ESPERANDO,
        entrou_em: l.criado_em,
        atualizado_em: l.atualizado_em ?? l.criado_em,
      }),
    )
    .filter(Boolean);
}
