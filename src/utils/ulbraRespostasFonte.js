import { supabase } from "../services/supabase";
import { normalizarConversa } from "./ulbraRespostas";

// Fonte de dados e marcador de leitura do aviso "o aluno respondeu".
//
// Vive fora do componente porque exportar função de arquivo de componente
// quebra o fast refresh (`react-refresh/only-export-components`) e a catraca
// do lint reprova. `ulbraRespostas.js` segue PURO; o que toca o mundo externo
// mora aqui.
//
// ARQUITETURA — e esta é a correção de 08/11/2026.
//
// O navegador NÃO fala com a Mensageria. Ele lê o Postgres, que não consome o
// orçamento de 500 chamadas/dia. Quem fala com a Mensageria é UMA
// sincronização central, do lado do servidor, que escreve em
// `ulbra_mensagens_recebidas`.
//
// O motivo é medido, não preferência de estilo: hoje não existe nada
// compartilhado entre operadores — `ulbra-leads-pendentes` não tem cache
// nenhum, e o da `ulbra-atendimento` é um `Map` em memória de isolate
// (`index.ts:14`), que não atravessa isolates nem sobrevive à reciclagem. Com
// polling no navegador, 9 operadores a cada 10 min em 12h dariam 648
// chamadas/dia, acima do limite de 500.
//
// DEPENDE DA MIGRATION `20261108120000_ulbra_mensagens_e_leitura`, que está em
// `supabase/aguardando_aprovacao/` e **não foi aplicada**. Enquanto ela não
// for aprovada, `carregarReal` devolve lista vazia com `indisponivel: true` —
// falha fechado, sem inventar aviso e sem derrubar a barra lateral.

export const TABELA_MENSAGENS = "ulbra_mensagens_recebidas";
export const TABELA_LEITURA = "ulbra_leitura_usuario";

// Enquanto não há tabela, o marcador cai no localStorage. Ele vale para um
// NAVEGADOR, não para a pessoa: a mesma operadora noutra máquina recomeça com
// tudo não lido. É exatamente o que a migration resolve.
const LS_PREFIXO = "ulbra_respostas_lido_ate:";

export function chaveLeitura(email) {
  return LS_PREFIXO + String(email || "anonimo").toLowerCase();
}

function lerLocal(email) {
  try {
    return localStorage.getItem(chaveLeitura(email));
  } catch {
    return null;
  }
}

function gravarLocal(email, quando) {
  try {
    localStorage.setItem(chaveLeitura(email), quando);
  } catch {
    // storage bloqueado: segue sem persistir, a contagem volta inteira
  }
}

/**
 * Até quando este usuário já leu. Tenta a tabela; sem ela, o navegador.
 * Nunca levanta: marcador ausente só faz avisar demais, nunca de menos.
 */
export async function lerLidoAte(email) {
  const local = lerLocal(email);
  try {
    const { data, error } = await supabase
      .from(TABELA_LEITURA)
      .select("lido_ate")
      .eq("usuario_email", String(email || "").toLowerCase())
      .maybeSingle();
    if (error || !data?.lido_ate) return local;
    // O mais recente entre os dois: ler numa máquina não deve "des-ler" noutra.
    if (local && new Date(local) > new Date(data.lido_ate)) return local;
    return data.lido_ate;
  } catch {
    return local;
  }
}

/** Grava o marcador nos dois lugares, para funcionar antes e depois da migration. */
export async function gravarLidoAte(email, quando) {
  gravarLocal(email, quando);
  try {
    await supabase
      .from(TABELA_LEITURA)
      .upsert(
        { usuario_email: String(email || "").toLowerCase(), lido_ate: quando, atualizado_em: quando },
        { onConflict: "usuario_email" },
      );
  } catch {
    // tabela ainda não existe: o localStorage já segurou
  }
}

/**
 * Lê o cache compartilhado e devolve UMA LINHA POR CONVERSA, com quem falou
 * por último — que é o que decide "o aluno respondeu".
 *
 * A tabela guarda mensagens; a última de cada conversa é derivada aqui. Uma
 * view `ulbra_conversas_ultima_mensagem` faria isso no banco e seria melhor;
 * ficou de fora para a proposta de migration continuar mínima e revisável.
 *
 * Devolve `{ itens, indisponivel }`: `indisponivel` é verdadeiro quando a
 * tabela ainda não existe, e a tela usa isso para não fingir que está ligada.
 */
export async function carregarReal({ limite = 200 } = {}) {
  try {
    const { data, error } = await supabase
      .from(TABELA_MENSAGENS)
      .select("mensagem_id, conversa_id, ulbra_cliente_id, aluno_id, canal, quem, recebida_em")
      .order("recebida_em", { ascending: false })
      .limit(limite);
    if (error) return { itens: [], indisponivel: true, motivo: error.message };

    // Primeira ocorrência de cada conversa = mensagem mais recente dela,
    // porque a consulta já veio em ordem decrescente.
    const vistas = new Set();
    const itens = [];
    for (const m of data ?? []) {
      if (!m?.conversa_id || vistas.has(m.conversa_id)) continue;
      vistas.add(m.conversa_id);
      const c = normalizarConversa(
        {
          conversa_id: m.conversa_id,
          canal: m.canal,
          ulbra_cliente_id: m.ulbra_cliente_id,
          ultima_de: m.quem,
          ultima_mensagem_em: m.recebida_em,
        },
        { aluno_id: m.aluno_id },
      );
      if (c) itens.push(c);
    }
    return { itens, indisponivel: false };
  } catch (e) {
    return { itens: [], indisponivel: true, motivo: String(e?.message ?? e) };
  }
}
